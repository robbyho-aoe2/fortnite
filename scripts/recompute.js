// One-off/manual maintenance script: re-solves handicaps against the current
// game log and commits the result, without adding or changing any game.
// Useful after a solver bug fix (like the LP-objective-exclusion fix) where
// the code is correct going forward but the already-committed players.json
// still reflects the old, buggy computation until something triggers a
// fresh solve. Run with: node scripts/recompute.js
//
// Needs the same repo-write token as the site itself - reads it straight
// from public/lib/repo-config.js so there's exactly one place it's defined.

import { getFile, putFile } from "../public/lib/github.js";
import { recomputeAllHandicaps } from "../public/lib/solver.js";
import { repoConfig } from "../public/lib/repo-config.js";

const PLAYERS_PATH = "public/data/players.json";
const GAMES_PATH = "public/data/games.json";
const CONFIG_PATH = "public/data/config.json";
const ROSTER_ORDER = ["robby", "matt", "mn", "doug", "kyle", "jim", "bello", "chris", "collin", "sean", "vinny", "j2", "lp"];

const [configFile, playersFile, gamesFile] = await Promise.all([
  getFile(repoConfig, CONFIG_PATH),
  getFile(repoConfig, PLAYERS_PATH),
  getFile(repoConfig, GAMES_PATH),
]);

const config = JSON.parse(configFile.content);
const players = JSON.parse(playersFile.content);
const games = JSON.parse(gamesFile.content);
const knownKeys = players.map((p) => p.key);
const rosterOrder = ROSTER_ORDER.filter((k) => knownKeys.includes(k));

const currentBaseHC = {};
for (const p of players) currentBaseHC[p.key] = p.baseHC || 0;

console.log(`Re-solving against ${games.length} games...`);
const { baseHC, strFacByPlayer, publishedHC } = recomputeAllHandicaps(
  currentBaseHC,
  games,
  rosterOrder,
  config.solver,
  config.strengthFactor
);

const updatedPlayers = players.map((p) => {
  if (!rosterOrder.includes(p.key)) return p;
  const before = p.publishedHC;
  const after = Math.round(publishedHC[p.key] * 100) / 100;
  console.log(`${p.key.padEnd(8)} ${String(before).padStart(7)} -> ${String(after).padStart(7)}`);
  return { ...p, baseHC: baseHC[p.key], strFac: strFacByPlayer[p.key], publishedHC: after };
});

await putFile(
  repoConfig,
  PLAYERS_PATH,
  JSON.stringify(updatedPlayers, null, 2),
  playersFile.sha,
  "Recompute handicaps with LP-objective-exclusion fix (no game added)"
);

console.log("Done.");
