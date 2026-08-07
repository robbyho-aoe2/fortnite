import fs from "fs";
import path from "path";
import assert from "assert";
import { fileURLToPath } from "url";
import { recomputeAllHandicaps, computeBreakeven, gradeMatch } from "../public/lib/solver.js";
import { computeMooseScore } from "../public/lib/moose.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "public", "data");
const config = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf-8"));
const players = JSON.parse(fs.readFileSync(path.join(dataDir, "players.json"), "utf-8"));
const games = JSON.parse(fs.readFileSync(path.join(dataDir, "games.json"), "utf-8"));

const rosterOrder = ["robby", "matt", "mn", "doug", "kyle", "jim", "bello", "chris", "collin", "sean", "vinny", "j2", "kman", "lp"];

console.log("--- Sanity: breakeven / grading ---");
const bk = computeBreakeven(12.24, 14.6, config.raceScale);
assert.strictEqual(bk.team1Threshold, 8, "breakeven should round to the nearest whole win count");
assert.strictEqual(bk.team1Threshold + bk.team2Threshold, config.raceScale.total, "thresholds should sum to the race total");
console.log("breakeven ok:", bk);

console.log("\n--- Sanity: exact-half tie-break rounds toward the higher-handicap team ---");
// team1 total 15, team2 total 10 -> raw threshold (15-10)+10 = 15.0, not a half case; use a case that lands on .5:
// diff=-4.5 -> raw threshold 5.5. team2 has the higher total, so team2's number (14.5->15) should round up,
// meaning team1's threshold rounds DOWN to 5.
const higherTeam2 = computeBreakeven(10, 14.5, config.raceScale);
assert.strictEqual(higherTeam2.team1Threshold, 5, "team1 (lower HC) should round down on an exact half");
assert.strictEqual(higherTeam2.team2Threshold, 15, "team2 (higher HC) should round up on an exact half");

// Flip it: team1 has the higher total now, so team1's number should round up instead.
const higherTeam1 = computeBreakeven(14.5, 10, config.raceScale);
assert.strictEqual(higherTeam1.team1Threshold, 15, "team1 (higher HC) should round up on an exact half");
assert.strictEqual(higherTeam1.team2Threshold, 5, "team2 (lower HC) should round down on an exact half");
console.log("tie-break rounding ok");

console.log("\n--- Sanity: gradeMatch uses the raw fractional breakeven, exact comparison, no tie zone ---");
// Real historical example from the source sheet (2026-07-24, row 21):
// robby+doug (score 10) vs kyle+bello. Raw breakeven worked out to ~10.71 —
// team1 fell short of it, so the sheet's own Y column graded this "Team 2",
// not a tie. Checked all 545 real games: the sheet's exact-equality rule
// (F>W / F=W / F<W) never once produced a tie, including games decided by
// margins under 0.01 wins, so gradeMatch must match that exactly rather than
// rounding anything close to a tie.
assert.strictEqual(gradeMatch(8.607213078, 7.892270524, 10, config.raceScale), 2, "team1 falling short of the raw breakeven is a clean loss, not a tie");
assert.strictEqual(gradeMatch(5, 5, 11, config.raceScale), 1, "team1 clearing the raw breakeven is a clean win");
assert.strictEqual(gradeMatch(5, 5, 9, config.raceScale), 2, "team1 falling short of the raw breakeven is a clean loss");
assert.strictEqual(gradeMatch(5, 5, 10, config.raceScale), 0, "landing exactly on the raw breakeven is the only tie case");
console.log("gradeMatch exact-comparison ok");

console.log("\n--- Diagnostic: re-running solver from current snapshot (informational, not pass/fail) ---");
// This checks against live production data, which keeps changing as real
// games get submitted - it's useful to see logged in CI output, but must
// never fail the build over a number that's expected to drift over time
// (that's exactly what blocked a real deploy once: a hardcoded threshold
// here happened to be a hair under the actual, harmless drift on a given
// day). The deterministic regression test below is what actually guards
// against a real solver bug.
const start = Date.now();
const result = recomputeAllHandicaps(players, games, rosterOrder, config.raceScale, config.solver, config.strengthFactor);
console.log(`solved in ${Date.now() - start}ms`);

let maxDrift = 0;
for (const p of players) {
  if (!rosterOrder.includes(p.key)) continue;
  const newPublished = result.publishedHC[p.key];
  maxDrift = Math.max(maxDrift, Math.abs(newPublished - p.publishedHC));
  console.log(
    `${p.key.padEnd(8)} base ${result.baseHC[p.key].toFixed(2).padStart(6)}  strFac ${result.strFacByPlayer[p.key].toFixed(2).padStart(6)}  ` +
    `published ${newPublished.toFixed(2).padStart(6)}  (committed snapshot: ${p.publishedHC})`
  );
}
console.log(`max drift from committed snapshot: ${maxDrift.toFixed(2)} (informational only)`);

console.log("\n--- Regression: one new game shouldn't swing handicaps by more than a few tenths ---");
// Uses a small, fixed, synthetic roster/game-log instead of live production
// data, so this test's outcome is deterministic and can't drift as the real
// game log grows (see the diagnostic above for why that matters - a test
// tied to live data blocked a real deploy once already). 6 players, every
// 3v3 split played 5 times with a fixed score pattern so everyone clears the
// minimum-games gates; LP never plays here since team sizes are always even.
function combinations(arr, k) {
  const results = [];
  function helper(start, combo) {
    if (combo.length === k) { results.push([...combo]); return; }
    for (let i = start; i < arr.length; i++) { combo.push(arr[i]); helper(i + 1, combo); combo.pop(); }
  }
  helper(0, []);
  return results;
}
const syntheticRoster = ["p1", "p2", "p3", "p4", "p5", "p6", "lp"];
const syntheticPlayers = ["p1", "p2", "p3", "p4", "p5", "p6"];
const seenSplits = new Set();
const splits = [];
for (const teamA of combinations(syntheticPlayers, 3)) {
  const teamB = syntheticPlayers.filter((p) => !teamA.includes(p));
  const key = [[...teamA].sort().join(","), [...teamB].sort().join(",")].sort().join("|");
  if (seenSplits.has(key)) continue;
  seenSplits.add(key);
  splits.push({ teamA, teamB });
}
// Every synthetic player starts dead even (all real players at 5.0), so the
// very first pass grades each game against a 15-15 (threshold 10) breakeven
// - used here just to stamp a plausible, already-decided winningTeam onto
// each game, the same way a real submission freezes one at gradeMatch time.
// Ids are "game-*" so record2026FromEntries counts them as new-season
// submissions, giving the long (2026-season) strength-factor window
// something real to work with.
const syntheticGames = [];
let gi = 0;
for (let rep = 0; rep < 5; rep++) {
  for (const { teamA, teamB } of splits) {
    const team1Score = 8 + (gi % 9);
    syntheticGames.push({
      id: `game-synthetic-${gi}`,
      date: "2026-01-01",
      team1: teamA,
      team2: teamB,
      team1Score,
      winningTeam: gradeMatch(15, 15, team1Score, config.raceScale),
    });
    gi++;
  }
}
const syntheticPlayerObjs = syntheticRoster.map((k) => ({ key: k, baseHC: k === "lp" ? -2.5 : 5.0 }));
const settled = recomputeAllHandicaps(syntheticPlayerObjs, syntheticGames, syntheticRoster, config.raceScale, config.solver, config.strengthFactor);

// Sanity check baked into the same fixture: re-solving unchanged data from an
// already-settled point should move nothing. This is exactly the property
// the fabricated tie-zone broke (see gradeMatch above) - if that regresses,
// this catches it directly instead of only via a live-data snapshot.
const settledPlayerObjs = syntheticRoster.map((k) => ({ key: k, baseHC: settled.baseHC[k] }));
const reSettled = recomputeAllHandicaps(settledPlayerObjs, syntheticGames, syntheticRoster, config.raceScale, config.solver, config.strengthFactor);
let maxNoOpDrift = 0;
for (const key of syntheticRoster) maxNoOpDrift = Math.max(maxNoOpDrift, Math.abs(reSettled.baseHC[key] - settled.baseHC[key]));
console.log(`max no-op drift on unchanged synthetic data: ${maxNoOpDrift.toFixed(4)}`);
assert.ok(maxNoOpDrift < 0.001, "re-solving unchanged data should not move any handicap");

const newGameScore = 11;
const newGame = {
  id: "game-synthetic-new",
  date: "2026-02-01",
  team1: ["p1", "p2", "p3"],
  team2: ["p4", "p5", "p6"],
  team1Score: newGameScore,
  winningTeam: gradeMatch(15, 15, newGameScore, config.raceScale),
};
const after = recomputeAllHandicaps(settledPlayerObjs, [...syntheticGames, newGame], syntheticRoster, config.raceScale, config.solver, config.strengthFactor);
let maxSwing = 0;
for (const key of syntheticRoster) {
  const swing = Math.abs(after.publishedHC[key] - settled.publishedHC[key]);
  maxSwing = Math.max(maxSwing, swing);
}
console.log(`max single-game swing on synthetic fixture: ${maxSwing.toFixed(3)}`);
assert.ok(maxSwing < 1, "one additional game shouldn't swing any player's handicap by more than a few tenths");

console.log("\n--- Moose score sanity ---");
const collinCareer = { avgElims: 5.5, avgDamageDealt: 2400, avgEliminated: 6.2, avgDamageTaken: 1900, avgTimeAliveSeconds: 950 };
const moose = computeMooseScore(collinCareer, config.moose);
console.log("sample moose score:", moose.toFixed(2));
assert.ok(Number.isFinite(moose), "moose score should compute to a finite number");

console.log("\nAll checks passed.");
