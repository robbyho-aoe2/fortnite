// Client-side port of the submission pipeline (formerly a Cloudflare Worker
// route). Runs entirely in the browser: validates, scales the reported score
// up to the 20-round reference if the session ended early, re-solves
// handicaps across the full history, and commits both updated files straight
// back to GitHub. That commit triggers a normal GitHub Pages redeploy.

import { getFile, putFile } from "./github.js";
import { recomputeAllHandicaps, computeBreakeven, gradeMatch, teamHCTotal } from "./solver.js";
import { repoConfig } from "./repo-config.js";

const GAMES_PATH = "public/data/games.json";
const PLAYERS_PATH = "public/data/players.json";
const CONFIG_PATH = "public/data/config.json";
const HC_HISTORY_PATH = "public/data/hc-history.json";

const ROSTER_ORDER = ["robby", "matt", "mn", "doug", "kyle", "jim", "bello", "chris", "collin", "sean", "vinny", "j2", "lp"];

// How many recompute snapshots to keep for the Handicaps page's "change
// since last game" / "change over last 20 games" columns. Comfortably more
// than the 20-snapshot lookback needs, without growing the file unbounded.
const MAX_HISTORY_LENGTH = 250;

// A submitted game can be corrected for a limited window afterward (typos,
// wrong score, forgot a player) without leaving a stray duplicate in the
// log. After that it's locked, matching the group's expectation that the
// history stabilizes. The submission timestamp is the id itself
// (`game-<ms>`) rather than a separate field, since that's already exactly
// "when this was recorded."
const EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

function getSubmittedAt(gameId) {
  const match = /^game-(\d+)$/.exec(gameId || "");
  return match ? Number(match[1]) : null;
}

function isEditable(gameId) {
  const submittedAt = getSubmittedAt(gameId);
  return submittedAt != null && Date.now() - submittedAt < EDIT_WINDOW_MS;
}

function validate(payload, knownKeys, raceTotal = 20) {
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

  if (payload.roundsPlayed != null) {
    if (
      typeof payload.roundsPlayed !== "number" ||
      !Number.isFinite(payload.roundsPlayed) ||
      payload.roundsPlayed <= 0 ||
      payload.roundsPlayed > raceTotal
    ) {
      errors.push(`roundsPlayed must be a number between 1 and ${raceTotal}`);
    }
  }

  if (Array.isArray(payload.team1) && Array.isArray(payload.team2)) {
    const overlap = payload.team1.filter((k) => payload.team2.includes(k));
    if (overlap.length > 0) errors.push(`Player(s) ${overlap.join(", ")} can't be on both teams`);
  }

  return errors;
}

// Validates a payload and turns it into a game record (scaled score, graded
// winner) — the part that's identical whether this is a brand new game or an
// edit of an existing one.
function buildGameRecord(payload, players, raceConfig, id) {
  const knownKeys = players.map((p) => p.key);
  const errors = validate(payload, knownKeys, raceConfig.raceScale.total);
  if (errors.length > 0) throw new Error(errors.join("; "));

  // If the session ended before the full 20-round reference, scale the
  // reported score up proportionally (e.g. 5-5 at round 10 of 20 grades the
  // same as 10-10) so every game compares against the same fixed scale. Both
  // the reported score and rounds played can be fractional (partial-round
  // credit), so this is plain proportional math, not integer division -
  // rounded only for storage, not truncated.
  const roundsPlayed = payload.roundsPlayed || raceConfig.raceScale.total;
  const scaledTeam1Score = Math.round(payload.team1Score * (raceConfig.raceScale.total / roundsPlayed) * 100) / 100;

  const hcByKey = Object.fromEntries(players.map((p) => [p.key, p.publishedHC || 0]));
  const t1Total = teamHCTotal(payload.team1, hcByKey);
  const t2Total = teamHCTotal(payload.team2, hcByKey);
  // The stored record uses the same raw-fractional-breakeven grading as the
  // solver (gradeMatch), not the rounded display breakeven - an exact match
  // is the only tie case, same as the original spreadsheet.
  const winningTeam = gradeMatch(t1Total, t2Total, scaledTeam1Score, raceConfig.raceScale);
  const { team1Threshold, team2Threshold } = computeBreakeven(t1Total, t2Total, raceConfig.raceScale);

  return {
    game: {
      id,
      date: payload.date,
      team1: payload.team1,
      team2: payload.team2,
      team1Score: scaledTeam1Score,
      rawTeam1Score: payload.team1Score,
      roundsPlayed,
      winningTeam,
      // The pre-game "wins needed to tie" target, frozen at submission time
      // (same handicaps used to grade winningTeam) - lets the Recent Games
      // display show "beat team 2 by 1" (actual score vs this target)
      // instead of a bare round-count margin, without having to re-derive
      // it from possibly-since-changed current handicaps.
      team1Threshold,
    },
    breakeven: { team1Threshold, team2Threshold },
  };
}

// Re-solves handicaps across the given game log and commits both files back
// to GitHub. Shared by submitGame and editGame — the only difference between
// them is how `updatedGames` got built.
async function resolveAndCommit(updatedGames, players, raceConfig, config, gamesFile, playersFile, historyFile, history, commitId) {
  const knownKeys = players.map((p) => p.key);
  const rosterOrder = ROSTER_ORDER.filter((k) => knownKeys.includes(k));

  const { baseHC, strFacByPlayer, publishedHC } = recomputeAllHandicaps(
    players,
    updatedGames,
    rosterOrder,
    raceConfig.raceScale,
    raceConfig.solver,
    raceConfig.strengthFactor
  );

  const updatedPlayers = players.map((p) => {
    // `baseHC` retains every player's key (the solver only mutates rosterOrder
    // entries, it doesn't drop the rest) — check rosterOrder itself, not
    // `in baseHC`, or players outside the active roster (e.g. brand new,
    // not yet eligible) get strFac/publishedHC looked up as undefined.
    if (!rosterOrder.includes(p.key)) return p;
    return {
      ...p,
      baseHC: baseHC[p.key],
      strFac: strFacByPlayer[p.key],
      publishedHC: Math.round(publishedHC[p.key] * 100) / 100,
    };
  });

  // One snapshot per recompute (submit/edit/delete all count), so the
  // Handicaps page can show "change since last game" / "change over the
  // last 20" without re-solving the whole log just to render a page.
  const snapshotHC = Object.fromEntries(updatedPlayers.filter((p) => p.publishedHC != null).map((p) => [p.key, p.publishedHC]));
  const updatedHistory = [...history, { gameId: commitId, publishedHC: snapshotHC }].slice(-MAX_HISTORY_LENGTH);

  await putFile(config, GAMES_PATH, JSON.stringify(updatedGames, null, 2), gamesFile.sha, `Update game ${commitId}`);
  await putFile(config, PLAYERS_PATH, JSON.stringify(updatedPlayers, null, 2), playersFile.sha, `Recompute handicaps after ${commitId}`);
  await putFile(config, HC_HISTORY_PATH, JSON.stringify(updatedHistory, null, 2), historyFile.sha, `Record handicap history after ${commitId}`);

  return updatedPlayers;
}

async function loadCurrentState(config) {
  const [configFile, playersFile, gamesFile, historyFile] = await Promise.all([
    getFile(config, CONFIG_PATH),
    getFile(config, PLAYERS_PATH),
    getFile(config, GAMES_PATH),
    getFile(config, HC_HISTORY_PATH),
  ]);
  return {
    raceConfig: JSON.parse(configFile.content),
    players: JSON.parse(playersFile.content),
    games: JSON.parse(gamesFile.content),
    history: JSON.parse(historyFile.content),
    playersFile,
    gamesFile,
    historyFile,
  };
}

// Throws on validation or GitHub API failure; returns { game, breakeven, players } on success.
async function submitGame(payload, config = repoConfig) {
  const { raceConfig, players, games, playersFile, gamesFile, historyFile, history } = await loadCurrentState(config);

  const { game, breakeven } = buildGameRecord(payload, players, raceConfig, `game-${Date.now()}`);
  const updatedGames = [...games, game].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const updatedPlayers = await resolveAndCommit(updatedGames, players, raceConfig, config, gamesFile, playersFile, historyFile, history, game.id);

  return { game, breakeven, players: updatedPlayers };
}

// Same pipeline, but replaces an existing game in place instead of
// appending. Only allowed within EDIT_WINDOW_MS of the original submission.
async function editGame(gameId, payload, config = repoConfig) {
  if (!isEditable(gameId)) {
    throw new Error("This game is no longer editable (the 24-hour edit window has passed).");
  }

  const { raceConfig, players, games, playersFile, gamesFile, historyFile, history } = await loadCurrentState(config);
  const index = games.findIndex((g) => g.id === gameId);
  if (index === -1) throw new Error(`Game ${gameId} not found — it may have already been edited by someone else.`);

  const { game, breakeven } = buildGameRecord(payload, players, raceConfig, gameId);
  const updatedGames = [...games];
  updatedGames[index] = game;
  updatedGames.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const updatedPlayers = await resolveAndCommit(updatedGames, players, raceConfig, config, gamesFile, playersFile, historyFile, history, game.id);

  return { game, breakeven, players: updatedPlayers };
}

// Removes a game entirely (rather than replacing it) and re-solves. Same
// 24-hour window as editGame — deleting an old game would retroactively
// rewrite handicap history further than the group wants to reopen.
async function deleteGame(gameId, config = repoConfig) {
  if (!isEditable(gameId)) {
    throw new Error("This game is no longer editable (the 24-hour edit window has passed).");
  }

  const { raceConfig, players, games, playersFile, gamesFile, historyFile, history } = await loadCurrentState(config);
  if (!games.some((g) => g.id === gameId)) {
    throw new Error(`Game ${gameId} not found — it may have already been edited by someone else.`);
  }

  const updatedGames = games.filter((g) => g.id !== gameId);
  const updatedPlayers = await resolveAndCommit(updatedGames, players, raceConfig, config, gamesFile, playersFile, historyFile, history, `${gameId} (deleted)`);

  return { deletedId: gameId, players: updatedPlayers };
}

export { submitGame, editGame, deleteGame, validate, isEditable, getSubmittedAt, EDIT_WINDOW_MS };
