import fs from "fs";
import path from "path";
import assert from "assert";
import { fileURLToPath } from "url";
import { recomputeAllHandicaps, computeBreakeven } from "../src/lib/solver.js";
import { computeMooseScore } from "../src/lib/moose.js";

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
assert.ok(Math.abs(bk.team1Threshold - 7.64) < 0.01, "breakeven should match manual formula");
console.log("breakeven ok:", bk);

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

console.log("\n--- Moose score sanity ---");
const collinCareer = { avgElims: 5.5, avgDamageDealt: 2400, avgEliminated: 6.2, avgDamageTaken: 1900, avgTimeAliveSeconds: 950 };
const moose = computeMooseScore(collinCareer, config.moose);
console.log("sample moose score:", moose.toFixed(2));
assert.ok(Number.isFinite(moose), "moose score should compute to a finite number");

console.log("\nAll checks passed.");
