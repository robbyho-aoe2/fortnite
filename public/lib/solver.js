// Handicap solver — ported from the group's Google Apps Script `singlepass()`.
// Two layers, computed in order:
//   1. Base HC: a coordinate hill-climb over the full game log that finds handicaps
//      making every player's recency-weighted, handicap-adjusted win rate ~50%.
//   2. Strength factor: a current-record momentum nudge added on top of the base.
//
// LP (a fixed-handicap filler for uneven team counts, not a real player) still
// gets its own coordinate-descent step and bounds like everyone else, but is
// excluded from the Hi-Lo spread objective the solver is minimizing — its win
// rate is noise, not skill signal, so including it made the solver chase a
// spread that wasn't real, causing far more per-game churn than intended.

// "Wins needed to tie" is a real target line announced before playing, so it
// has to be a whole number. Round to the nearest integer; on an exact half
// (e.g. 7.5/12.5), round the higher-handicap team's number up — they're the
// stronger side, so the tie-break tightens the target against them, not for them.
function computeBreakeven(team1HCTotal, team2HCTotal, raceScale) {
  const diff = team1HCTotal - team2HCTotal;
  const rawTeam1Threshold = diff + raceScale.half;
  const isExactHalf = Math.abs(rawTeam1Threshold - Math.floor(rawTeam1Threshold) - 0.5) < 1e-9;

  const team1Threshold = isExactHalf
    ? (team1HCTotal >= team2HCTotal ? Math.ceil(rawTeam1Threshold) : Math.floor(rawTeam1Threshold))
    : Math.round(rawTeam1Threshold);

  const team2Threshold = raceScale.total - team1Threshold;
  return { team1Threshold, team2Threshold };
}

function teamHCTotal(team, hcByPlayer) {
  return team.reduce((sum, key) => sum + (hcByPlayer[key] || 0), 0);
}

// Actual grading (as opposed to the rounded pre-game display above) uses the
// raw fractional breakeven directly, and calls it a tie whenever the actual
// score lands within `tieZone` wins of that line — you can't score a partial
// win, so a game that close could just as easily have gone the other way.
// 1 = team1 win, 2 = team2 win, 0 = tie
function gradeMatch(team1HCTotal, team2HCTotal, team1Score, raceScale) {
  const rawTeam1Threshold = (team1HCTotal - team2HCTotal) + raceScale.half;
  const margin = team1Score - rawTeam1Threshold;
  if (Math.abs(margin) < (raceScale.tieZone ?? 1)) return 0;
  return margin > 0 ? 1 : 2;
}

// Games are assumed sorted oldest -> newest. Returns, per player key, their games
// in most-recent-first order (rank 1 = most recent).
function buildPlayerGameIndex(games, rosterOrder) {
  const index = {};
  for (const key of rosterOrder) index[key] = [];
  for (let i = games.length - 1; i >= 0; i--) {
    const g = games[i];
    for (const key of g.team1) {
      if (index[key]) index[key].push({ game: g, team: 1 });
    }
    for (const key of g.team2) {
      if (index[key]) index[key].push({ game: g, team: 2 });
    }
  }
  return index; // index[key][0] is that player's most recent game
}

// A game's win/loss/tie is decided once, at submission time (gradeMatch, using
// whatever handicaps were current then), and stored on the game as
// `winningTeam` — it is history, not a live computation. The spreadsheet this
// was ported from works the same way: its per-game winner columns read a
// fixed per-row result, not a live formula against the current handicap
// column. Re-deriving it here from the handicaps being solved *right now*
// would mean every nudge to a player's HC retroactively rewrites the outcome
// of every game they've ever played — cascading into their past teammates'
// and opponents' win rates too, and far beyond, which is exactly the kind of
// runaway per-game swing this solver is supposed to avoid.
function resultForPlayer(entry) {
  const winner = entry.game.winningTeam;
  if (winner === 0) return 0.5;
  return winner === entry.team ? 1 : 0;
}

function weightedWinRate(playerEntries, tau) {
  if (playerEntries.length === 0) return 0.5;
  let weightSum = 0;
  let resultSum = 0;
  for (let rank = 1; rank <= playerEntries.length; rank++) {
    const weight = Math.exp(-(rank - 1) / tau);
    resultSum += weight * resultForPlayer(playerEntries[rank - 1]);
    weightSum += weight;
  }
  return weightSum > 0 ? resultSum / weightSum : 0.5;
}

function simpleWinRate(playerEntries, windowSize) {
  const windowed = playerEntries.slice(0, windowSize);
  if (windowed.length === 0) return { games: 0, winPct: 0.5 };
  let sum = 0;
  for (const entry of windowed) sum += resultForPlayer(entry);
  return { games: windowed.length, winPct: sum / windowed.length };
}

function hiLoSpread(rosterOrder, playerIndex, tau, minGames) {
  let hi = -Infinity;
  let lo = Infinity;
  let any = false;
  for (const key of rosterOrder) {
    const entries = playerIndex[key];
    if (entries.length < minGames) continue;
    const rate = weightedWinRate(entries, tau);
    hi = Math.max(hi, rate);
    lo = Math.min(lo, rate);
    any = true;
  }
  return any ? hi - lo : 0;
}

function boundsFor(key, pinnedKey, cfg) {
  if (cfg.specialBounds[key]) return cfg.specialBounds[key];
  if (key === pinnedKey) return cfg.pinnedHighBounds;
  return cfg.bounds;
}

function clamp(value, bounds) {
  return Math.max(bounds.min, Math.min(bounds.max, value));
}

// One full hill-climb pass. `initialHC` is a { key: number } map, mutated copy returned.
function singlePassSolve(initialHC, games, rosterOrder, cfg) {
  const hc = { ...initialHC };
  const playerIndex = buildPlayerGameIndex(games, rosterOrder);

  const pinnableKeys = rosterOrder.filter((k) => !cfg.specialBounds[k]);
  let pinnedKey = null;
  let maxVal = -Infinity;
  for (const key of pinnableKeys) {
    if ((hc[key] || 0) > maxVal) {
      maxVal = hc[key] || 0;
      pinnedKey = key;
    }
  }

  // The Hi-Lo spread judges whether the *real* population looks fair. LP is
  // a fixed-handicap filler, not a real player, so its win rate is noise —
  // including it would make the objective chase a spread that isn't
  // actually about anyone's skill, causing more churn than the data justifies.
  // (LP still gets its own coordinate-descent step below via `rosterOrder`,
  // this only excludes it from the objective being minimized.)
  const objectiveRoster = pinnableKeys;

  let step = cfg.startStep;
  let bestObjective = Infinity;
  let bestHC = { ...hc };
  let noImprovementCount = 0;
  let firstCycle = true;
  let cellIndex = 0;

  for (let iter = 0; iter < cfg.maxIterations; iter++) {
    const objective = hiLoSpread(objectiveRoster, playerIndex, cfg.tau, cfg.minGamesForObjective);

    if (objective < bestObjective - cfg.improvementEpsilon) {
      bestObjective = objective;
      bestHC = { ...hc };
      noImprovementCount = 0;
    } else {
      noImprovementCount++;
    }

    if (!firstCycle && noImprovementCount >= cfg.noImprovementLimit) break;

    const key = rosterOrder[cellIndex];
    const entries = playerIndex[key];

    if (entries.length < cfg.minGamesForAdjustment) {
      cellIndex = (cellIndex + 1) % rosterOrder.length;
      if (cellIndex === 0) firstCycle = false;
      continue;
    }

    const rate = weightedWinRate(entries, cfg.tau);
    const deviation = rate - cfg.targetWinRate;

    if (Math.abs(deviation) < cfg.deviationSkipThreshold) {
      cellIndex = (cellIndex + 1) % rosterOrder.length;
      if (cellIndex === 0) firstCycle = false;
      continue;
    }

    const dynamicStep = Math.max(cfg.minStep, step * (1 + Math.abs(deviation) * 5));
    const adjustment = deviation > 0 ? dynamicStep : -dynamicStep;
    hc[key] = clamp((hc[key] || 0) + adjustment, boundsFor(key, pinnedKey, cfg));

    step = Math.max(cfg.minStep, step * cfg.decayRate);

    cellIndex = (cellIndex + 1) % rosterOrder.length;
    if (cellIndex === 0) firstCycle = false;
  }

  return bestHC;
}

function multiPassSolve(initialHC, games, rosterOrder, cfg) {
  let hc = { ...initialHC };
  for (let p = 0; p < cfg.passes; p++) {
    hc = singlePassSolve(hc, games, rosterOrder, cfg);
  }
  return hc;
}

// Strength factor: current-record momentum on top of the solved base HC.
function computeStrengthFactor(playerEntries, cfg) {
  const totalGames = playerEntries.length;
  const rampFactor = Math.min(totalGames * cfg.rampGamesDivisor, 1);

  function windowFactor(windowCfg) {
    const { winPct } = simpleWinRate(playerEntries, windowCfg.games);
    const sign = winPct > 0.5 ? 1 : -1;
    const magnitude = Math.pow(Math.abs(winPct - 0.5), windowCfg.exponent) * windowCfg.scalar * rampFactor;
    return sign * Math.min(magnitude, cfg.cap);
  }

  return windowFactor(cfg.shortWindow) + windowFactor(cfg.longWindow);
}

// Full pipeline: solve base HCs across the whole log, then layer strength factor on top.
function recomputeAllHandicaps(currentBaseHC, games, rosterOrder, solverCfg, strengthCfg) {
  const baseHC = multiPassSolve(currentBaseHC, games, rosterOrder, solverCfg);
  const playerIndex = buildPlayerGameIndex(games, rosterOrder);

  const strFacByPlayer = {};
  const publishedHC = {};
  for (const key of rosterOrder) {
    const strFac = computeStrengthFactor(playerIndex[key], strengthCfg);
    strFacByPlayer[key] = strFac;
    publishedHC[key] = (baseHC[key] || 0) + strFac;
  }

  return { baseHC, strFacByPlayer, publishedHC };
}

export {
  computeBreakeven,
  teamHCTotal,
  gradeMatch,
  buildPlayerGameIndex,
  weightedWinRate,
  hiLoSpread,
  singlePassSolve,
  multiPassSolve,
  computeStrengthFactor,
  recomputeAllHandicaps,
};
