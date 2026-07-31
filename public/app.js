// Shared data loading + rendering helpers used by index.html, history.html, submit.html.

async function loadData() {
  const [players, games, config] = await Promise.all([
    fetch("data/players.json").then((r) => r.json()),
    fetch("data/games.json").then((r) => r.json()),
    fetch("data/config.json").then((r) => r.json()),
  ]);
  return { players, games, config };
}

async function loadStats() {
  return fetch("data/stats.json").then((r) => r.json());
}

// Kept in sync with functions/_lib/moose.js — duplicated here because the
// static site (public/) and the Pages Functions (functions/) are separate
// deploy roots, so this small pure formula can't be shared via import.
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
  return player.alias || player.realName || player.key;
}

function gamesInYear(games, year) {
  return games.filter((g) => g.date.startsWith(String(year)));
}

// Live win/loss/tie record computed directly from the game log for a given
// slice of games (e.g. all of 2026 so far). This is what makes the current
// season "update" automatically as new games are submitted.
function liveRecord(games, playerKey) {
  let w = 0, l = 0, t = 0;
  for (const g of games) {
    const onTeam1 = g.team1.includes(playerKey);
    const onTeam2 = g.team2.includes(playerKey);
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

function fmtRecord(r) {
  if (!r || r.games === 0) return "—";
  return `${r.w}-${r.l}-${r.t}`;
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
