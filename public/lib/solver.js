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
// raw fractional breakeven directly and compares it to the score exactly —
// no tie zone. Verified against all 545 real games in the source sheet: the
// real formula (F>W / F=W / F<W) never once produced a tie, including games
// decided by a margin under 0.01 wins, so an exact score match is genuinely
// the only case that counts as a tie.
// 1 = team1 win, 2 = team2 win, 0 = tie
function gradeMatch(team1HCTotal, team2HCTotal, team1Score, raceScale) {
  const rawTeam1Threshold = (team1HCTotal - team2HCTotal) + raceScale.half;
  if (team1Score === rawTeam1Threshold) return 0;
  return team1Score > rawTeam1Threshold ? 1 : 2;
}

function gradeGame(game, hcByPlayer, raceScale) {
  const t1 = teamHCTotal(game.team1, hcByPlayer);
  const t2 = teamHCTotal(game.team2, hcByPlayer);
  return gradeMatch(t1, t2, game.team1Score, raceScale);
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

function resultForPlayer(entry, hcByPlayer, raceScale) {
  const winner = gradeGame(entry.game, hcByPlayer, raceScale);
  if (winner === 0) return 0.5;
  return winner === entry.team ? 1 : 0;
}

function weightedWinRate(playerEntries, hcByPlayer, raceScale, tau) {
  if (playerEntries.length === 0) return 0.5;
  let weightSum = 0;
  let resultSum = 0;
  for (let rank = 1; rank <= playerEntries.length; rank++) {
    const weight = Math.exp(-(rank - 1) / tau);
    resultSum += weight * resultForPlayer(playerEntries[rank - 1], hcByPlayer, raceScale);
    weightSum += weight;
  }
  return weightSum > 0 ? resultSum / weightSum : 0.5;
}

// Strength factor represents actual current-record momentum, not a
// hypothetical re-grade against whatever base HC the coordinate descent is
// testing mid-solve — verified against the source sheet: its short/long
// window win/loss/tie counts (AM:AP, AV:AY) are cached numbers, not live
// formulas depending on the handicap column, unlike the base-HC objective's
// own win-rate columns (which genuinely are live VLOOKUP-driven formulas).
// Using a live re-grade here made a player's "current record" swing just
// because *other* players' base HC moved slightly, even when that player
// wasn't in the game that changed - confirmed directly: two players with no
// shared game in the triggering change still showed exactly mirrored
// swings (+1.37 / -1.37) from a single unrelated recompute.
function storedResultForPlayer(entry) {
  const winner = entry.game.winningTeam;
  if (winner === 0) return 0.5;
  return winner === entry.team ? 1 : 0;
}

// The "last 300 games in 2026" long window is, in practice, just the whole
// 2026 season (no one has played anywhere near 300 games this year) - so
// rather than a rolling game count, it's exactly the same running 2026
// record used elsewhere (record2026() in app.js): a frozen season-end
// baseline plus every genuinely new site submission on top. Duplicated here
// for the same reason computeBreakeven/computeMatchup are duplicated
// between this module and app.js - app.js loads as a plain script, not an
// ES module, so it can't import from here.
function record2026FromEntries(baseline, playerEntries) {
  let w = baseline?.w || 0, l = baseline?.l || 0, t = baseline?.t || 0;
  for (const entry of playerEntries) {
    if (!entry.game.id.startsWith("game-")) continue;
    if (entry.game.winningTeam === 0) t++;
    else if (entry.game.winningTeam === entry.team) w++;
    else l++;
  }
  return { games: w + l + t, w, l, t };
}

function hiLoSpread(rosterOrder, playerIndex, hcByPlayer, raceScale, tau, minGames) {
  let hi = -Infinity;
  let lo = Infinity;
  let any = false;
  for (const key of rosterOrder) {
    const entries = playerIndex[key];
    if (entries.length < minGames) continue;
    const rate = weightedWinRate(entries, hcByPlayer, raceScale, tau);
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
function singlePassSolve(initialHC, games, rosterOrder, raceScale, cfg) {
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
    const objective = hiLoSpread(objectiveRoster, playerIndex, hc, raceScale, cfg.tau, cfg.minGamesForObjective);

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

    const rate = weightedWinRate(entries, hc, raceScale, cfg.tau);
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

function multiPassSolve(initialHC, games, rosterOrder, raceScale, cfg) {
  let hc = { ...initialHC };
  for (let p = 0; p < cfg.passes; p++) {
    hc = singlePassSolve(hc, games, rosterOrder, raceScale, cfg);
  }
  return hc;
}

// Strength factor: current-record momentum on top of the solved base HC.
// Short window = last 25 real games (any year), recency-ordered. Long
// window = the running 2026 season record (see record2026FromEntries) -
// each window ramps in independently based on its *own* game count, not a
// shared career total, matching MIN(games*0.05,1) being computed separately
// per window in the source sheet (AM4 for short, AV4 for long).
function computeStrengthFactor(playerEntries, seasonBaseline2026, cfg) {
  function windowFactor(winSum, count, windowCfg) {
    if (count === 0) return 0;
    const winPct = winSum / count;
    const rampFactor = Math.min(count * cfg.rampGamesDivisor, 1);
    const sign = winPct > 0.5 ? 1 : -1;
    const magnitude = Math.pow(Math.abs(winPct - 0.5), windowCfg.exponent) * windowCfg.scalar * rampFactor;
    return sign * Math.min(magnitude, cfg.cap);
  }

  const shortWindowed = playerEntries.slice(0, cfg.shortWindow.games);
  let shortWinSum = 0;
  for (const entry of shortWindowed) shortWinSum += storedResultForPlayer(entry);
  const shortFactor = windowFactor(shortWinSum, shortWindowed.length, cfg.shortWindow);

  const season2026 = record2026FromEntries(seasonBaseline2026, playerEntries);
  const longWinSum = season2026.w + 0.5 * season2026.t;
  const longFactor = windowFactor(longWinSum, season2026.games, cfg.longWindow);

  return shortFactor + longFactor;
}

// Full pipeline: solve base HCs across the whole log, then layer strength factor on top.
function recomputeAllHandicaps(players, games, rosterOrder, raceScale, solverCfg, strengthCfg) {
  const currentBaseHC = Object.fromEntries(players.map((p) => [p.key, p.baseHC || 0]));
  const byKey = Object.fromEntries(players.map((p) => [p.key, p]));
  const baseHC = multiPassSolve(currentBaseHC, games, rosterOrder, raceScale, solverCfg);
  const playerIndex = buildPlayerGameIndex(games, rosterOrder);

  const strFacByPlayer = {};
  const publishedHC = {};
  for (const key of rosterOrder) {
    const seasonBaseline2026 = byKey[key]?.seasonArchive?.["2026"];
    const strFac = computeStrengthFactor(playerIndex[key], seasonBaseline2026, strengthCfg);
    strFacByPlayer[key] = strFac;
    publishedHC[key] = (baseHC[key] || 0) + strFac;
  }

  return { baseHC, strFacByPlayer, publishedHC };
}

export {
  computeBreakeven,
  teamHCTotal,
  gradeMatch,
  gradeGame,
  buildPlayerGameIndex,
  weightedWinRate,
  hiLoSpread,
  singlePassSolve,
  multiPassSolve,
  record2026FromEntries,
  computeStrengthFactor,
  recomputeAllHandicaps,
};
