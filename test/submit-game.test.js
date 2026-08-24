import fs from "fs";
import path from "path";
import assert from "assert";
import { fileURLToPath } from "url";
import { validate, isEditable, getSubmittedAt, EDIT_WINDOW_MS } from "../public/lib/submit-game.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "public", "data");
const players = JSON.parse(fs.readFileSync(path.join(dataDir, "players.json"), "utf-8"));
const knownKeys = players.map((p) => p.key);

console.log("--- validate() ---");

assert.deepStrictEqual(
  validate({ date: "2026-08-01", team1: ["robby", "kyle"], team1Score: 12, team2: ["doug", "sean"] }, knownKeys),
  [],
  "valid payload should have no errors"
);

assert.ok(validate({ date: "not-a-date", team1: ["robby"], team1Score: 5, team2: ["doug"] }, knownKeys).length > 0, "bad date rejected");
assert.ok(validate({ date: "2026-08-01", team1: [], team1Score: 5, team2: ["doug"] }, knownKeys).length > 0, "empty team rejected");
assert.ok(validate({ date: "2026-08-01", team1: ["robby", "robby", "robby", "robby", "robby"], team1Score: 5, team2: ["doug"] }, knownKeys).length > 0, "team too large rejected");
assert.ok(validate({ date: "2026-08-01", team1: ["notaplayer"], team1Score: 5, team2: ["doug"] }, knownKeys).length > 0, "unknown player rejected");
assert.ok(validate({ date: "2026-08-01", team1: ["robby"], team1Score: -1, team2: ["doug"] }, knownKeys).length > 0, "negative score rejected");
assert.ok(validate({ date: "2026-08-01", team1: ["robby"], team1Score: 5, team2: ["robby"] }, knownKeys).length > 0, "same player on both teams rejected");

console.log("All validate() checks passed.");

// End-to-end pipeline test with an in-memory mock of the GitHub file layer,
// so we can exercise the full submit -> resolve -> commit flow (the same
// path the browser takes) without needing real GitHub credentials.
console.log("\n--- end-to-end submit pipeline (mocked GitHub) ---");

const config = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf-8"));
const games = JSON.parse(fs.readFileSync(path.join(dataDir, "games.json"), "utf-8"));
const hcHistory = JSON.parse(fs.readFileSync(path.join(dataDir, "hc-history.json"), "utf-8"));

// Synthetic player outside ROSTER_ORDER (e.g. someone not yet added to the
// solver roster) - used below to check a recompute leaves non-roster
// players exactly as-is, not corrupted to null/NaN. Was previously tested
// against "kman", but he's a real roster member now (added once he started
// playing for real), so this stands in for that scenario going forward.
const nonRosterPlayer = { key: "zzznonroster", alias: "Nonroster Test", realName: "Nonroster", active: true, baseHC: 5, strFac: 0, publishedHC: 5, seasonArchive: {} };
const playersWithNonRoster = [...players, nonRosterPlayer];

const mockFiles = {
  "public/data/config.json": JSON.stringify(config),
  "public/data/players.json": JSON.stringify(playersWithNonRoster),
  "public/data/games.json": JSON.stringify(games),
  "public/data/hc-history.json": JSON.stringify(hcHistory),
};

// Minimal fetch mock intercepting the GitHub Contents API calls made by public/lib/github.js
const originalFetch = global.fetch;
global.fetch = async (url, options = {}) => {
  const match = String(url).match(/contents\/([^?]+)/);
  const filePath = decodeURIComponent(match[1]);
  if (!options.method || options.method === "GET") {
    const content = mockFiles[filePath];
    return {
      ok: true,
      json: async () => ({ content: Buffer.from(content).toString("base64"), sha: "fake-sha" }),
    };
  }
  if (options.method === "PUT") {
    const body = JSON.parse(options.body);
    mockFiles[filePath] = Buffer.from(body.content, "base64").toString("utf-8");
    return { ok: true, json: async () => ({ commit: { sha: "fake-new-sha" } }) };
  }
  throw new Error("unexpected fetch in mock: " + url);
};

const { submitGame } = await import("../public/lib/submit-game.js");

const testRepoConfig = { GITHUB_TOKEN: "fake", GITHUB_OWNER: "robbyho-aoe2", GITHUB_REPO: "fortnite", GITHUB_BRANCH: "main" };
const requestBody = { date: "2026-08-01", team1: ["robby", "kyle"], team1Score: 13, team2: ["doug", "sean"] };

const result = await submitGame(requestBody, testRepoConfig);

assert.ok(result.game, "result should include the new game");
assert.ok(result.players.length === playersWithNonRoster.length, "result should include full updated roster");

const persistedGames = JSON.parse(mockFiles["public/data/games.json"]);
assert.strictEqual(persistedGames.length, games.length + 1, "new game should be persisted");
assert.ok(persistedGames.some((g) => g.id === result.game.id), "persisted log should contain the new game");

const persistedPlayers = JSON.parse(mockFiles["public/data/players.json"]);
const robbyBefore = players.find((p) => p.key === "robby").publishedHC;
const robbyAfter = persistedPlayers.find((p) => p.key === "robby").publishedHC;
console.log(`robby publishedHC before: ${robbyBefore}, after: ${robbyAfter}`);
assert.ok(Number.isFinite(robbyAfter), "recomputed handicap should be a finite number");

// Regression: a player outside the active solver roster must be left
// exactly as-is, not corrupted to null/NaN. The solver's returned baseHC
// map retains every player's key even though it only actually updates
// roster players, so this is easy to get wrong by checking `key in baseHC`
// instead of roster membership.
const nonRosterAfter = persistedPlayers.find((p) => p.key === "zzznonroster");
assert.deepStrictEqual(nonRosterAfter, nonRosterPlayer, "a non-roster player's record should be untouched by a recompute");

const historyAfterSubmit = JSON.parse(mockFiles["public/data/hc-history.json"]);
assert.strictEqual(historyAfterSubmit.length, hcHistory.length + 1, "a submission should append exactly one history snapshot");
assert.strictEqual(historyAfterSubmit.at(-1).gameId, result.game.id, "the new snapshot should be tagged with the new game's id");
assert.strictEqual(historyAfterSubmit.at(-1).publishedHC.robby, robbyAfter, "the snapshot should record the freshly recomputed handicap");

console.log("\n--- uneven team sizes get an automatic LP filler ---");

// There's never a "true" 2v3 - whichever side has fewer real players always
// gets LP added, same as the Auto Teams/matchup preview already show
// before submission. This regressed once already: buildGameRecord graded
// straight off the submitted (uneven) totals with no LP adjustment at all,
// so a team could clear the number the preview promised them and still
// lose, because the preview's promised adjustment was never actually
// applied at grading time.
const unevenBody = { date: "2026-08-05", team1: ["robby", "kyle"], team1Score: 11, team2: ["doug", "sean", "mn"] };
// Snapshot handicaps as they stand *before* this submission - grading uses
// whatever's current at the moment of submission, before this game's own
// recompute can shift anyone (even slightly), so the cross-check below has
// to use the same pre-game snapshot buildGameRecord actually graded against.
const hcBeforeThisGame = Object.fromEntries(
  JSON.parse(mockFiles["public/data/players.json"]).map((p) => [p.key, p.publishedHC || 0])
);
const unevenResult = await submitGame(unevenBody, testRepoConfig);

assert.strictEqual(unevenResult.game.team1.length, unevenResult.game.team2.length, "LP should even out a 2v3 submission to 3v3");
assert.ok(unevenResult.game.team1.includes("lp"), "LP should be added to the smaller side (team1, 2 players vs 3)");

const { gradeMatch: gradeMatchCheck, teamHCTotal: teamHCTotalCheck } = await import("../public/lib/solver.js");
const expectedWinner = gradeMatchCheck(
  teamHCTotalCheck(unevenResult.game.team1, hcBeforeThisGame),
  teamHCTotalCheck(unevenResult.game.team2, hcBeforeThisGame),
  unevenResult.game.team1Score,
  config.raceScale
);
assert.strictEqual(unevenResult.game.winningTeam, expectedWinner, "the stored winner should match gradeMatch on the LP-inclusive totals");

console.log("Uneven team size / LP filler checks passed.");

console.log("\n--- rounds-played scaling ---");

// A game that ended 5-5 at round 10 of 20 should grade identically to 10-10.
const shortGameBody = { date: "2026-08-02", team1: ["robby", "kyle"], team1Score: 5, roundsPlayed: 10, team2: ["doug", "sean"] };
const shortGameResult = await submitGame(shortGameBody, testRepoConfig);

assert.strictEqual(shortGameResult.game.team1Score, 10, "5 wins at round 10 of 20 should scale to 10");
assert.strictEqual(shortGameResult.game.rawTeam1Score, 5, "raw reported score should be preserved");
assert.strictEqual(shortGameResult.game.roundsPlayed, 10, "roundsPlayed should be preserved");

assert.deepStrictEqual(
  validate({ date: "2026-08-01", team1: ["robby"], team1Score: 5, team2: ["doug"], roundsPlayed: 25 }, knownKeys, 20).length > 0,
  true,
  "roundsPlayed beyond the race total should be rejected"
);

console.log("Rounds-played scaling checks passed.");

console.log("\n--- editGame() ---");

assert.strictEqual(isEditable(shortGameResult.game.id), true, "a just-submitted game should be within the edit window");
assert.strictEqual(isEditable("legacy-19"), false, "a legacy migrated game (no embedded timestamp) should never be editable");
assert.strictEqual(isEditable(`game-${Date.now() - EDIT_WINDOW_MS - 1000}`), false, "a game older than the edit window should not be editable");
assert.strictEqual(getSubmittedAt("legacy-19"), null, "legacy ids don't carry a submission timestamp");

const { editGame } = await import("../public/lib/submit-game.js");

// Correct the short game's score entirely (different players, different score).
const correctedBody = { date: "2026-08-02", team1: ["robby", "sean"], team1Score: 9, team2: ["doug", "kyle"] };
const editResult = await editGame(shortGameResult.game.id, correctedBody, testRepoConfig);

assert.strictEqual(editResult.game.id, shortGameResult.game.id, "editing should keep the same game id, not create a new one");
assert.deepStrictEqual(editResult.game.team1, ["robby", "sean"], "edited team1 should be persisted");
assert.strictEqual(editResult.game.team1Score, 9, "edited score should be persisted");

const gamesAfterEdit = JSON.parse(mockFiles["public/data/games.json"]);
assert.strictEqual(gamesAfterEdit.length, games.length + 3, "editing should not change the total game count (replace, not append)");
assert.strictEqual(gamesAfterEdit.filter((g) => g.id === shortGameResult.game.id).length, 1, "there should be exactly one entry for the edited game");

await assert.rejects(
  () => editGame("game-1", correctedBody, testRepoConfig),
  /no longer editable/,
  "editing an old id (embedded timestamp = 1ms after epoch) should be rejected"
);

await assert.rejects(
  () => editGame(`game-${Date.now()}`, correctedBody, testRepoConfig),
  /not found/,
  "editing an id that doesn't exist in the log should be rejected"
);

console.log("editGame() checks passed.");

console.log("\n--- deleteGame() ---");

const { deleteGame } = await import("../public/lib/submit-game.js");

const gamesBeforeDelete = JSON.parse(mockFiles["public/data/games.json"]);
const deleteResult = await deleteGame(shortGameResult.game.id, testRepoConfig);

assert.strictEqual(deleteResult.deletedId, shortGameResult.game.id, "result should report which game was deleted");

const gamesAfterDelete = JSON.parse(mockFiles["public/data/games.json"]);
assert.strictEqual(gamesAfterDelete.length, gamesBeforeDelete.length - 1, "the game count should drop by exactly one");
assert.ok(!gamesAfterDelete.some((g) => g.id === shortGameResult.game.id), "the deleted game should no longer be in the log");

await assert.rejects(
  () => deleteGame("game-1", testRepoConfig),
  /no longer editable/,
  "deleting an old id should be rejected"
);

await assert.rejects(
  () => deleteGame(shortGameResult.game.id, testRepoConfig),
  /not found/,
  "deleting an already-deleted id should be rejected"
);

console.log("deleteGame() checks passed.");

console.log("\n--- GitHub API failures throw a real error ---");

// Simulate a broken GITHUB_TOKEN (or any GitHub API failure): getFile()
// should throw a descriptive error the caller can display, not fail silently
// or produce something unparseable.
global.fetch = async () => ({ ok: false, status: 401, text: async () => "Bad credentials" });

await assert.rejects(
  () => submitGame({ date: "2026-08-03", team1: ["robby"], team1Score: 5, team2: ["doug"] }, { ...testRepoConfig, GITHUB_TOKEN: "invalid" }),
  /GitHub getFile.*401/,
  "a bad token should surface as a clear thrown error"
);
console.log("GitHub-failure error handling check passed.");

global.fetch = originalFetch;
console.log("\nEnd-to-end pipeline test passed.");
