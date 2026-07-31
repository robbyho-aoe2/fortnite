import fs from "fs";
import path from "path";
import assert from "assert";
import { fileURLToPath } from "url";
import { validate } from "../functions/api/submit-game.js";

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
// so we can exercise the full submit -> resolve -> respond flow without
// needing real GitHub credentials.
console.log("\n--- end-to-end submit pipeline (mocked GitHub) ---");

const config = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf-8"));
const games = JSON.parse(fs.readFileSync(path.join(dataDir, "games.json"), "utf-8"));

const mockFiles = {
  "public/data/config.json": JSON.stringify(config),
  "public/data/players.json": JSON.stringify(players),
  "public/data/games.json": JSON.stringify(games),
};

// Minimal fetch mock intercepting the GitHub Contents API calls made by functions/_lib/github.js
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

const { onRequestPost } = await import("../functions/api/submit-game.js");

const env = { GITHUB_TOKEN: "fake", GITHUB_OWNER: "robbyho-aoe2", GITHUB_REPO: "fortnite", GITHUB_BRANCH: "main" };
const requestBody = { date: "2026-08-01", team1: ["robby", "kyle"], team1Score: 13, team2: ["doug", "sean"] };
const request = new Request("http://localhost/api/submit-game", {
  method: "POST",
  body: JSON.stringify(requestBody),
});

const response = await onRequestPost({ request, env });
const responseBody = await response.json();

assert.strictEqual(response.status, 200, "submission should succeed");
assert.ok(responseBody.game, "response should include the new game");
assert.ok(responseBody.players.length === players.length, "response should include full updated roster");

const persistedGames = JSON.parse(mockFiles["public/data/games.json"]);
assert.strictEqual(persistedGames.length, games.length + 1, "new game should be persisted");
assert.ok(persistedGames.some((g) => g.id === responseBody.game.id), "persisted log should contain the new game");

const persistedPlayers = JSON.parse(mockFiles["public/data/players.json"]);
const robbyBefore = players.find((p) => p.key === "robby").publishedHC;
const robbyAfter = persistedPlayers.find((p) => p.key === "robby").publishedHC;
console.log(`robby publishedHC before: ${robbyBefore}, after: ${robbyAfter}`);
assert.ok(Number.isFinite(robbyAfter), "recomputed handicap should be a finite number");

global.fetch = originalFetch;
console.log("\nEnd-to-end pipeline test passed.");
