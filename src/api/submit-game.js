// POST /api/submit-game
// Body: { date: "YYYY-MM-DD", team1: ["robby","kyle"], team1Score: 12, team2: ["doug","sean"] }
//
// Validates the submission, appends it to the game log, re-solves handicaps
// across the full history, and commits both files back to GitHub. The
// resulting commit triggers a redeploy via the GitHub Actions workflow.

import { getFile, putFile } from "../lib/github.js";
import { recomputeAllHandicaps } from "../lib/solver.js";

const GAMES_PATH = "public/data/games.json";
const PLAYERS_PATH = "public/data/players.json";
const CONFIG_PATH = "public/data/config.json";

const ROSTER_ORDER = ["robby", "matt", "mn", "doug", "kyle", "jim", "bello", "chris", "collin", "sean", "vinny", "j2", "lp"];

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function validate(payload, knownKeys) {
  const errors = [];
  if (!payload || typeof payload !== "object") return ["Missing request body"];

  if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.date || "")) errors.push("date must be YYYY-MM-DD");

  for (const teamField of ["team1", "team2"]) {
    const team = payload[teamField];
    if (!Array.isArray(team) || team.length < 1 || team.length > 4) {
      errors.push(`${teamField} must be an array of 1-4 player keys`);
      continue;
    }
    for (const key of team) {
      if (!knownKeys.includes(key)) errors.push(`Unknown player key "${key}" in ${teamField}`);
    }
  }

  if (
    typeof payload.team1Score !== "number" ||
    !Number.isFinite(payload.team1Score) ||
    payload.team1Score < 0
  ) {
    errors.push("team1Score must be a non-negative number");
  }

  if (Array.isArray(payload.team1) && Array.isArray(payload.team2)) {
    const overlap = payload.team1.filter((k) => payload.team2.includes(k));
    if (overlap.length > 0) errors.push(`Player(s) ${overlap.join(", ")} can't be on both teams`);
  }

  return errors;
}

async function handleSubmitGame(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "Body must be valid JSON" }, 400);
  }

  const [configFile, playersFile, gamesFile] = await Promise.all([
    getFile(env, CONFIG_PATH),
    getFile(env, PLAYERS_PATH),
    getFile(env, GAMES_PATH),
  ]);

  const config = JSON.parse(configFile.content);
  const players = JSON.parse(playersFile.content);
  const games = JSON.parse(gamesFile.content);
  const knownKeys = players.map((p) => p.key);

  const errors = validate(payload, knownKeys);
  if (errors.length > 0) return jsonResponse({ error: errors.join("; ") }, 400);

  const t1 = teamHCTotalFrom(payload.team1, players);
  const t2 = teamHCTotalFrom(payload.team2, players);
  const breakeven = t1.total - t2.total + config.raceScale.half;
  const winningTeam = payload.team1Score > breakeven ? 1 : payload.team1Score < breakeven ? 2 : 0;

  const newGame = {
    id: `game-${Date.now()}`,
    date: payload.date,
    team1: payload.team1,
    team2: payload.team2,
    team1Score: payload.team1Score,
    winningTeam,
  };

  const updatedGames = [...games, newGame].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const rosterOrder = ROSTER_ORDER.filter((k) => knownKeys.includes(k));
  const currentBaseHC = {};
  for (const p of players) currentBaseHC[p.key] = p.baseHC || 0;

  const { baseHC, strFacByPlayer, publishedHC } = recomputeAllHandicaps(
    currentBaseHC,
    updatedGames,
    rosterOrder,
    config.raceScale,
    config.solver,
    config.strengthFactor
  );

  const updatedPlayers = players.map((p) => {
    if (!(p.key in baseHC)) return p;
    return {
      ...p,
      baseHC: baseHC[p.key],
      strFac: strFacByPlayer[p.key],
      publishedHC: Math.round(publishedHC[p.key] * 100) / 100,
    };
  });

  await putFile(
    env,
    GAMES_PATH,
    JSON.stringify(updatedGames, null, 2),
    gamesFile.sha,
    `Add game ${newGame.id} (${payload.date})`
  );
  await putFile(
    env,
    PLAYERS_PATH,
    JSON.stringify(updatedPlayers, null, 2),
    playersFile.sha,
    `Recompute handicaps after ${newGame.id}`
  );

  return jsonResponse({
    game: newGame,
    breakeven: { team1Threshold: breakeven, team2Threshold: config.raceScale.total - breakeven },
    players: updatedPlayers,
  });
}

function teamHCTotalFrom(teamKeys, players) {
  const byKey = Object.fromEntries(players.map((p) => [p.key, p.publishedHC || 0]));
  return { total: teamKeys.reduce((sum, k) => sum + (byKey[k] || 0), 0) };
}

export { handleSubmitGame, validate };
