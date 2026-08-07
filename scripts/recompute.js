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
const HC_HISTORY_PATH = "public/data/hc-history.json";
const MAX_HISTORY_LENGTH = 250;
const ROSTER_ORDER = ["robby", "matt", "mn", "doug", "kyle", "jim", "bello", "chris", "collin", "sean", "vinny", "j2", "kman", "lp"];

const [configFile, playersFile, gamesFile, historyFile] = await Promise.all([
  getFile(repoConfig, CONFIG_PATH),
  getFile(repoConfig, PLAYERS_PATH),
  getFile(repoConfig, GAMES_PATH),
  getFile(repoConfig, HC_HISTORY_PATH),
]);
const history = JSON.parse(historyFile.content);

const config = JSON.parse(configFile.content);
const players = JSON.parse(playersFile.content);
const games = JSON.parse(gamesFile.content);
const knownKeys = players.map((p) => p.key);
const rosterOrder = ROSTER_ORDER.filter((k) => knownKeys.includes(k));

console.log(`Re-solving against ${games.length} games...`);
const { baseHC, strFacByPlayer, publishedHC } = recomputeAllHandicaps(
  players,
  games,
  rosterOrder,
  config.raceScale,
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

const COMMIT_ID = "recompute-after-strength-factor-fix";

await putFile(
  repoConfig,
  PLAYERS_PATH,
  JSON.stringify(updatedPlayers, null, 2),
  playersFile.sha,
  "Recompute handicaps after fixing strength factor grading (no game added)"
);

const snapshotHC = Object.fromEntries(updatedPlayers.filter((p) => p.publishedHC != null).map((p) => [p.key, p.publishedHC]));
const updatedHistory = [...history, { gameId: COMMIT_ID, publishedHC: snapshotHC }].slice(-MAX_HISTORY_LENGTH);
await putFile(
  repoConfig,
  HC_HISTORY_PATH,
  JSON.stringify(updatedHistory, null, 2),
  historyFile.sha,
  `Record handicap history after ${COMMIT_ID}`
);

console.log("Done.");
