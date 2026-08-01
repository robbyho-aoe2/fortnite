// One-off: overwrite published handicaps with the group's real (full
// multi-year history) values, as given after their own singlepass() run
// following the most recent game. This site's solver only has ~546 games of
// seed history, so it drifts from the real numbers; this resets the anchor
// point so future small per-game nudges (now fixed to be small - see the
// LP-objective-exclusion fix) build off an accurate baseline instead of
// compounding on top of a drifted one. Run with: node scripts/set-hc-anchor.js

import { getFile, putFile } from "../public/lib/github.js";
import { repoConfig } from "../public/lib/repo-config.js";

const PLAYERS_PATH = "public/data/players.json";

// Given values already include the strength factor (group ran the full
// pipeline including it), so they're treated as the new total anchor -
// baseHC and publishedHC both set to this value, strFac reset to 0. The next
// real submission will solve a fresh baseHC from here and layer a freshly
// computed strFac on top, same as any other recompute.
const REAL_HC = {
  robby: 6.18,
  matt: 3.07,
  mn: 4.07,
  doug: 1.54,
  kyle: 4.67,
  jim: 4.79,
  bello: 3.67,
  chris: 3.85,
  collin: 10.73,
  sean: 7.45,
  vinny: 5.01,
  j2: 5.33,
  lp: -1.70,
  // Also repairs a since-fixed bug: kman (not in the active solver roster)
  // got corrupted to publishedHC: null by an earlier recompute. The code fix
  // stops it happening again but doesn't repair data already corrupted
  // before the fix deployed, so reset to the standard new-player default.
  kman: 5.0,
};

const playersFile = await getFile(repoConfig, PLAYERS_PATH);
const players = JSON.parse(playersFile.content);

const updatedPlayers = players.map((p) => {
  if (!(p.key in REAL_HC)) return p;
  const value = REAL_HC[p.key];
  console.log(`${p.key.padEnd(8)} ${String(p.publishedHC).padStart(7)} -> ${value}`);
  return { ...p, baseHC: value, strFac: 0, publishedHC: value };
});

await putFile(
  repoConfig,
  PLAYERS_PATH,
  JSON.stringify(updatedPlayers, null, 2),
  playersFile.sha,
  "Reset handicap anchor to the group's real (full-history) post-game values"
);

console.log("Done.");
