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

const rosterOrder = ["robby", "matt", "mn", "doug", "kyle", "jim", "bello", "chris", "collin", "sean", "vinny", "j2", "lp"];
const currentBaseHC = {};
for (const p of players) currentBaseHC[p.key] = p.baseHC || 0;

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

console.log("\n--- Sanity: gradeMatch uses the raw fractional breakeven + tie zone, not the rounded display one ---");
// Real historical example: robby+doug (score 10) vs kyle+bello. Raw breakeven
// worked out to ~10.71, a margin of ~0.71 — within the tie zone, so this
// should grade as a tie even though the rounded *display* breakeven (11)
// would suggest a clean loss.
assert.strictEqual(gradeMatch(8.607213078, 7.892270524, 10, config.raceScale), 0, "a game within one win of the raw breakeven should grade as a tie");
// A clear win/loss (margin >= 1) should still resolve normally.
assert.strictEqual(gradeMatch(5, 5, 12, config.raceScale), 1, "a margin past the tie zone should be a clear win");
assert.strictEqual(gradeMatch(5, 5, 8, config.raceScale), 2, "a margin past the tie zone should be a clear loss");
console.log("gradeMatch tie-zone ok");

console.log("\n--- Re-running solver from current snapshot (should stay close) ---");
const start = Date.now();
const result = recomputeAllHandicaps(currentBaseHC, games, rosterOrder, config.raceScale, config.solver, config.strengthFactor);
console.log(`solved in ${Date.now() - start}ms`);

let maxDrift = 0;
for (const p of players) {
  if (!rosterOrder.includes(p.key)) continue;
  const newPublished = result.publishedHC[p.key];
  const drift = Math.abs(newPublished - p.publishedHC);
  maxDrift = Math.max(maxDrift, drift);
  console.log(
    `${p.key.padEnd(8)} base ${result.baseHC[p.key].toFixed(2).padStart(6)}  strFac ${result.strFacByPlayer[p.key].toFixed(2).padStart(6)}  ` +
    `published ${newPublished.toFixed(2).padStart(6)}  (sheet snapshot: ${p.publishedHC})`
  );
}
console.log(`max drift from sheet snapshot: ${maxDrift.toFixed(2)} (expected: nonzero, we only have 545 games of history vs the full multi-year log the sheet solved against)`);
assert.ok(maxDrift < 4, "recomputed handicaps should be in the same ballpark as the sheet snapshot");

console.log("\n--- Regression: one new game should nudge handicaps by a few decimals, not swing them ---");
// LP must be excluded from the Hi-Lo objective (it's a filler, not a real
// player — its win rate is noise). Including it made the solver chase a
// spread that wasn't really about anyone's skill, causing far bigger
// per-game swings than intended, including for players not even in the new
// game. This reproduces that exact scenario against the local seed data.
const oneMoreGame = {
  id: "game-test-regression",
  date: "2026-08-02",
  team1: ["robby", "doug", "jim"],
  team2: ["mn", "kyle", "j2"],
  team1Score: 4,
  winningTeam: 2,
};
const before = recomputeAllHandicaps(currentBaseHC, games, rosterOrder, config.raceScale, config.solver, config.strengthFactor);
const after = recomputeAllHandicaps(before.baseHC, [...games, oneMoreGame], rosterOrder, config.raceScale, config.solver, config.strengthFactor);

let maxSwing = 0;
for (const key of rosterOrder) {
  const swing = Math.abs(after.publishedHC[key] - before.publishedHC[key]);
  maxSwing = Math.max(maxSwing, swing);
}
console.log(`max single-game swing: ${maxSwing.toFixed(3)}`);
assert.ok(maxSwing < 0.5, "one additional game shouldn't swing any player's handicap by more than a few tenths");

console.log("\n--- Moose score sanity ---");
const collinCareer = { avgElims: 5.5, avgDamageDealt: 2400, avgEliminated: 6.2, avgDamageTaken: 1900, avgTimeAliveSeconds: 950 };
const moose = computeMooseScore(collinCareer, config.moose);
console.log("sample moose score:", moose.toFixed(2));
assert.ok(Number.isFinite(moose), "moose score should compute to a finite number");

console.log("\nAll checks passed.");
