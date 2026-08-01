// Shared data loading + rendering helpers used across all pages.

// GitHub Pages caches data files for several minutes (Cache-Control: max-age=600).
// A cache-busting query param forces every page load to fetch the latest
// commit's data instead of waiting out that window, since a game submission
// should show up right away, not "eventually."
function cacheBust(url) {
  return `${url}${url.includes("?") ? "&" : "?"}_=${Date.now()}`;
}

async function loadData() {
  const [players, games, config] = await Promise.all([
    fetch(cacheBust("data/players.json")).then((r) => r.json()),
    fetch(cacheBust("data/games.json")).then((r) => r.json()),
    fetch(cacheBust("data/config.json")).then((r) => r.json()),
  ]);
  return { players, games, config };
}

async function loadStats() {
  return fetch(cacheBust("data/stats.json")).then((r) => r.json());
}

// Kept in sync with lib/moose.js — duplicated here because app.js loads as a
// plain (non-module) script on every page, while lib/moose.js is an ES
// module imported directly by moose.html and lib/submit-game.js.
function computeMooseScore(stats, mooseCfg) {
  const { normalization: n, weights: w, regression: r } = mooseCfg;
  const raw =
    w.elims * (10 * stats.avgElims / n.maxAvgElims) +
    w.damageDealt * (10 * stats.avgDamageDealt / n.maxAvgDamageDealt) +
    w.eliminated * (10 * n.minAvgEliminated / stats.avgEliminated) +
    w.damageTaken * (10 * n.minAvgDamageTaken / stats.avgDamageTaken) +
    w.timeAlive * (10 * stats.avgTimeAliveSeconds / n.maxAvgTimeAliveSeconds);
  return r.slope * raw + r.intercept + r.shift;
}

function fmtTime(seconds) {
  if (seconds == null) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function playerByKey(players) {
  return Object.fromEntries(players.map((p) => [p.key, p]));
}

function displayName(player) {
  if (!player) return "Unknown";
  return player.realName || player.alias || player.key;
}

function secondaryName(player) {
  if (!player) return "";
  const primary = displayName(player);
  return player.alias && player.alias !== primary ? player.alias : "";
}

function gamesInYear(games, year) {
  return games.filter((g) => g.date.startsWith(String(year)));
}

// Kept in sync with gradeMatch in lib/solver.js — duplicated for the same
// reason as the Moose formula above. Grading uses the raw fractional
// breakeven (not the rounded display version) and calls anything within
// `tieZone` wins of it a tie, since you can't score a partial win and a game
// that close could have gone either way. A game's *stored* winningTeam field
// reflects whatever grading logic existed when it was submitted (older
// migrated games predate the tie-zone entirely), so display and record
// stats always re-derive the result fresh from current handicaps instead of
// trusting that field, for consistency with what the solver itself does.
function deriveWinningTeam(game, byKey, raceScale) {
  const hc1 = game.team1.reduce((sum, k) => sum + (byKey[k]?.publishedHC || 0), 0);
  const hc2 = game.team2.reduce((sum, k) => sum + (byKey[k]?.publishedHC || 0), 0);
  const rawTeam1Threshold = (hc1 - hc2) + raceScale.half;
  const margin = game.team1Score - rawTeam1Threshold;
  if (Math.abs(margin) < (raceScale.tieZone ?? 1)) return 0;
  return margin > 0 ? 1 : 2;
}

// Live win/loss/tie record computed directly from the game log for a given
// slice of games (e.g. all of 2026 so far). This is what makes the current
// season "update" automatically as new games are submitted.
function liveRecord(games, playerKey, byKey, raceScale) {
  let w = 0, l = 0, t = 0;
  for (const g of games) {
    const onTeam1 = g.team1.includes(playerKey);
    const onTeam2 = g.team2.includes(playerKey);
    if (!onTeam1 && !onTeam2) continue;
    const winningTeam = deriveWinningTeam(g, byKey, raceScale);
    if (winningTeam === 0) t++;
    else if ((winningTeam === 1 && onTeam1) || (winningTeam === 2 && onTeam2)) w++;
    else l++;
  }
  const total = w + l + t;
  const winPct = total > 0 ? (w + 0.5 * t) / total : null;
  return { games: total, w, l, t, winPct };
}

function fmtPct(p) {
  return p == null ? "—" : `${(p * 100).toFixed(1)}%`;
}

function fmtNum(n, digits = 2) {
  return n == null || Number.isNaN(n) ? "—" : Number(n).toFixed(digits);
}

function fmtRecord(r) {
  if (!r || r.games === 0) return "—";
  return `${r.w}-${r.l}-${r.t}`;
}

// Red -> yellow -> green heat-map color for a value t in [0, 1] (0 = red/worst,
// 0.5 = yellow/neutral, 1 = green/best). Two-segment lerp through yellow
// avoids the muddy brown a direct red->green interpolation produces.
function gradientColor(t) {
  const clamped = Math.max(0, Math.min(1, t));
  const red = [224, 101, 91];    // --loss
  const yellow = [201, 169, 74]; // --tie
  const green = [63, 191, 127];  // --win
  const [c1, c2, localT] = clamped < 0.5
    ? [red, yellow, clamped / 0.5]
    : [yellow, green, (clamped - 0.5) / 0.5];
  const mix = (i) => Math.round(c1[i] + (c2[i] - c1[i]) * localT);
  return `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`;
}

// Auto Teams fairness -> gradient position. fairness is |threshold - half|,
// 0 at a dead-even 10-10 split (green) up to `half` at the most lopsided
// possible split like 20-0 (red).
function fairnessColor(fairness, raceScale) {
  return gradientColor(1 - Math.min(fairness / raceScale.half, 1));
}

// LP isn't a real player — it's a fixed-handicap filler automatically added
// to whichever team has fewer real players, so uneven sessions (e.g. 3v4)
// still grade against a symmetric reference. Mirrors lib/solver.js's
// computeBreakeven exactly, so this live preview matches what actually gets
// submitted.
function computeMatchup(team1Keys, team2Keys, byKey, raceScale) {
  const team1 = [...team1Keys];
  const team2 = [...team2Keys];
  let lpTeam = null;
  if (team1.length !== team2.length) {
    if (team1.length < team2.length) { team1.push("lp"); lpTeam = 1; }
    else { team2.push("lp"); lpTeam = 2; }
  }
  const hc1 = team1.reduce((sum, k) => sum + (byKey[k]?.publishedHC || 0), 0);
  const hc2 = team2.reduce((sum, k) => sum + (byKey[k]?.publishedHC || 0), 0);
  const { team1Threshold, team2Threshold } = roundedBreakeven(hc1, hc2, raceScale);
  return { team1Effective: team1, team2Effective: team2, lpTeam, team1Threshold, team2Threshold };
}

// Kept in sync with computeBreakeven in lib/solver.js (see the comment there
// for why the tie-break exists) — duplicated for the same reason as the
// Moose formula above: app.js is a plain script, not a module.
function roundedBreakeven(team1HCTotal, team2HCTotal, raceScale) {
  const diff = team1HCTotal - team2HCTotal;
  const rawTeam1Threshold = diff + raceScale.half;
  const isExactHalf = Math.abs(rawTeam1Threshold - Math.floor(rawTeam1Threshold) - 0.5) < 1e-9;

  const team1Threshold = isExactHalf
    ? (team1HCTotal >= team2HCTotal ? Math.ceil(rawTeam1Threshold) : Math.floor(rawTeam1Threshold))
    : Math.round(rawTeam1Threshold);

  return { team1Threshold, team2Threshold: raceScale.total - team1Threshold };
}

function combinations(arr, k) {
  const results = [];
  function helper(start, combo) {
    if (combo.length === k) { results.push([...combo]); return; }
    for (let i = start; i < arr.length; i++) {
      combo.push(arr[i]);
      helper(i + 1, combo);
      combo.pop();
    }
  }
  helper(0, []);
  return results;
}

// Every way to split a pool of attending players into two teams of the most
// even sizes possible, ranked by how close the handicap gap is to dead even
// (LP fills the smaller side automatically when the pool size is odd).
function generateBalancedSplits(pool, byKey, raceScale) {
  if (pool.length < 2) return [];
  const sizeA = Math.floor(pool.length / 2);
  const seen = new Set();
  const splits = [];
  for (const teamA of combinations(pool, sizeA)) {
    const teamASet = new Set(teamA);
    const teamB = pool.filter((k) => !teamASet.has(k));
    const dedupeKey = [[...teamA].sort().join(","), [...teamB].sort().join(",")].sort().join("|");
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const matchup = computeMatchup(teamA, teamB, byKey, raceScale);
    splits.push({
      teamA, teamB,
      lpTeam: matchup.lpTeam,
      team1Threshold: matchup.team1Threshold,
      team2Threshold: matchup.team2Threshold,
      fairness: Math.abs(matchup.team1Threshold - raceScale.half),
    });
  }
  splits.sort((a, b) => a.fairness - b.fairness);
  return splits;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}
