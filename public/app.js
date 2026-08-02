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

async function loadHcHistory() {
  return fetch(cacheBust("data/hc-history.json")).then((r) => r.json());
}

// One snapshot is recorded per recompute (every submit/edit/delete), so
// "stepsBack" counts recomputes, not calendar games — e.g. 1 = since the
// most recent recompute, 20 = over the last 20. Returns null if there's
// no earlier snapshot to compare against yet (e.g. brand new player, or
// fewer than `stepsBack` recomputes have happened at all).
function hcChangeOver(history, playerKey, stepsBack) {
  if (!history || history.length < 2) return null;
  const current = history.at(-1).publishedHC[playerKey];
  const pastIndex = Math.max(0, history.length - 1 - stepsBack);
  const past = history[pastIndex].publishedHC[playerKey];
  if (current == null || past == null) return null;
  return current - past;
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

// One fixed, maximally-distinct color per player (a categorical palette
// picked for visual distinction, not a hash), so the same player always
// reads as the same color everywhere their name shows up as a pill.
const PLAYER_COLORS = {
  robby: "#e6194b",
  matt: "#3cb44b",
  mn: "#4363d8",
  doug: "#f58231",
  kyle: "#911eb4",
  jim: "#46f0f0",
  bello: "#f032e6",
  chris: "#bcf60c",
  collin: "#008080",
  sean: "#9a6324",
  vinny: "#800000",
  j2: "#808000",
  lp: "#808080",
  kman: "#000075",
};

function playerColor(key) {
  return PLAYER_COLORS[key] || "#495057";
}

// Black or white text, whichever contrasts better against the pill's
// background - computed from perceived brightness (YIQ) rather than
// hardcoded per color, so it stays correct if a color above ever changes.
function pillTextColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 128 ? "#000000" : "#ffffff";
}

// A colored pill badge for a single player.
function playerPill(player) {
  if (!player) return el("span", { class: "player-pill" }, "Unknown");
  const bg = playerColor(player.key);
  const pill = el("span", { class: "player-pill" }, displayName(player));
  pill.style.background = bg;
  pill.style.color = pillTextColor(bg);
  return pill;
}

// A wrapped row of pills for a team/group, replacing plain ", "-joined text.
function playerPillGroup(keys, byKey) {
  return el("span", { class: "pill-group" }, keys.map((k) => playerPill(byKey[k])));
}

function gamesInYear(games, year) {
  return games.filter((g) => g.date.startsWith(String(year)));
}

// The 2026 record is NOT derived from the migrated per-game log at all — that
// log ("AI HCs" -> log tab, 545 rows) is only ever used as training data for
// the handicap solver, which tolerates imprecision fine. The group's actual
// 2026 win/loss/tie record of truth is the whole-number rollup migrated into
// `seasonArchive["2026"]` (the "FTN 2026 stats" sheet). That baseline is
// frozen as of the migration; going forward, only genuinely new site
// submissions (id starts with "game-", not the legacy "legacy-*" rows) get
// tallied on top of it. This is what makes 2026 "update" as new games are
// submitted, without re-litigating or recomputing anything that came before.
function record2026(player, games) {
  const baseline = player.seasonArchive?.["2026"] || { games: 0, w: 0, l: 0, t: 0 };
  let w = baseline.w || 0, l = baseline.l || 0, t = baseline.t || 0;
  for (const g of games) {
    if (!g.id.startsWith("game-")) continue;
    const onTeam1 = g.team1.includes(player.key);
    const onTeam2 = g.team2.includes(player.key);
    if (!onTeam1 && !onTeam2) continue;
    if (g.winningTeam === 0) t++;
    else if ((g.winningTeam === 1 && onTeam1) || (g.winningTeam === 2 && onTeam2)) w++;
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

// Scores are whole numbers most of the time (a clean win count) but can be
// fractional after rounds-played scaling (e.g. 3 wins at round 15 of 20 ->
// 4.0, but 3 wins at round 14 of 20 -> 4.29). Show up to 2 decimals, but
// drop them when the value is actually a whole number instead of always
// padding to "4.00".
function fmtScore(n) {
  if (n == null || Number.isNaN(n)) return "—";
  return String(Math.round(n * 100) / 100);
}

function fmtRecord(r) {
  if (!r || r.games === 0) return "—";
  return `${r.w}-${r.l}-${r.t}`;
}

// Signed display for handicap changes: "+0.42" / "-0.18" / "±0.00".
function fmtDelta(n, digits = 2) {
  if (n == null || Number.isNaN(n)) return "—";
  const sign = n > 0 ? "+" : n < 0 ? "" : "±";
  return `${sign}${Number(n).toFixed(digits)}`;
}

// Delta -> gradient position, symmetric around 0 within +/-scale (positive
// change green, negative red, 0 yellow).
function deltaColor(n, scale) {
  if (n == null) return null;
  return gradientColor(0.5 + Math.max(-0.5, Math.min(0.5, n / (2 * scale))));
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

// Stepped (not smooth) fairness banding for a split's rounded wins-needed-
// to-tie target - dead even (10-10) is green, one or two off (9-11/8-12) is
// yellow, three or four off (7-13/6-14) is orange, five or more (5-15+) is
// red. Returns a background color; pair with pillTextColor() for the label.
function fairnessColor(team1Threshold, raceScale) {
  const gap = Math.abs(team1Threshold - raceScale.half);
  if (gap === 0) return "#16a34a";
  if (gap <= 2) return "#eab308";
  if (gap <= 4) return "#f97316";
  return "#dc2626";
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
  // Raw, unrounded handicap gap - used for ranking splits so ties in the
  // *rounded* display target (many splits can all round to "10-10") don't
  // mask which one is actually closest to even.
  const rawGap = Math.abs(hc1 - hc2);
  return { team1Effective: team1, team2Effective: team2, lpTeam, team1Threshold, team2Threshold, rawGap };
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
      // Raw gap for ranking (see computeMatchup) - many splits round to the
      // same displayed target, but aren't equally close to even underneath.
      fairness: matchup.rawGap,
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
