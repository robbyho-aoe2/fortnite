# Fortnite Stat Tracker

Consolidated win/loss history, handicaps, and match submission for the group —
replacing the old set of Google Sheets with a single site backed by this repo.

## What's here

- **`public/`** — the static site (Cloudflare Pages serves this directly, no build step).
  - `index.html` — Statistics: career-average and max box-score stats per player
  - `handicaps.html` — current handicaps + live 2026 win/loss record
  - `moose.html` — Moose Score leaderboard (see below)
  - `history.html` — season archives for 2023–2025, live-computed 2026
  - `submit.html` — match submission form
  - `data/` — the actual data: `players.json`, `games.json`, `config.json`, `stats.json`
- **`functions/`** — Cloudflare Pages Functions (the backend).
  - `api/submit-game.js` — validates a submitted match, re-solves handicaps, commits the result back to this repo via the GitHub API
  - `_lib/solver.js` — the handicap engine (see below)
  - `_lib/moose.js` — the Moose Score formula (also duplicated in `public/app.js` for client-side rendering — `public/` and `functions/` are separate deploy roots, so this small pure formula can't be shared via import; keep both in sync if it changes)
  - `_lib/github.js` — thin GitHub Contents API client used to read/write the JSON data files
- **`test/`** — solver + pipeline tests (`npm test`), including an end-to-end test of the submission flow with a mocked GitHub API.

## How handicaps work

Ported faithfully from the group's original Google Apps Script (`singlepass()`). Two layers:

1. **Base handicap** — a coordinate hill-climb over the full game log. Every match already has
   a "games to tie" breakeven derived from the two teams' handicap totals (`(team1HC - team2HC) + 10`,
   on a fixed 20-game reference scale). The solver repeatedly nudges each player's handicap up or down so
   that their recency-weighted (exponential decay, `tau=50` games), handicap-adjusted win rate converges
   toward 50% — i.e. it finds the handicaps that would have made everyone's history look like a coin flip.
   One player is anchored near 10 as a scale reference; "lp" is hard-pinned to a fixed negative band, both
   matching the original script's behavior.
2. **Strength factor** — a current-record momentum nudge layered on top, from two recency windows
   (last 25 games and last 200 games) of simple win% deviation from 50%.

All the tunable constants (`tau`, iteration limits, step sizes, bounds, window sizes) live in
`public/data/config.json`, not hardcoded in the solver — recalibrating the system means editing that file.

**Published handicap = base + strength factor.** This is what's shown on the leaderboard.

## How a submitted game flows through the system

1. Someone fills out `submit.html`: picks Team 1, Team 2, and how many games Team 1 won in the session.
2. That POSTs to `/api/submit-game` (a Pages Function).
3. The function re-reads the current `games.json`/`players.json` from GitHub, appends the new game,
   re-runs the solver across the whole log, and computes new published handicaps.
4. It commits both updated files straight back to this repo via the GitHub API.
5. That commit triggers a normal Cloudflare Pages redeploy — the site reflects the new numbers within
   about a minute, no separate database involved. GitHub stays the single source of truth for all data.

## Season history vs. live 2026

2023–2025 are frozen season-end archives (`players[].seasonArchive`), migrated from the old spreadsheets
where only year-end win/loss totals survive (per-game detail for those years lives in ~90 old monthly
tabs that weren't migrated — not worth the complexity since the season-end numbers are what matters).

2026 is **not** a static snapshot — `history.html` and `handicaps.html` compute it live by filtering
`games.json` to the current year, so it updates automatically as games are submitted. The full
per-game log (545 games, 2025-07 through the migration date) came from the "AI HCs" spreadsheet's
`log` tab, which is what the live solver runs against.

## Statistics & Moose Score

`public/data/stats.json` holds 2026 career-average and max box-score stats per player (elims, damage
dealt, eliminated, damage taken, time alive) — currently season-level figures the group supplied
directly, not derived from `games.json`, since per-game box scores aren't captured yet (see Roadmap).

**Moose Score** (`moose.html`) is a PER-style individual rating computed from those stats, anchored so
Collin's career average = 10:

```
raw = 0.958×(10×avgElims/16.91) + 0.958×(10×avgDamageDealt/7505)
    + 0.425×(10×9.00/avgEliminated) + 0.145×(10×4109/avgDamageTaken)
    + 0.444×(10×avgTimeAliveSeconds/2898)
moose = 0.6238×raw − 7.6609 + 0.5931
```

The weights are each stat's correlation to raw (pre-strength-factor) handicap; the normalization
denominators are fixed group career maximums/minimums. All of this lives in `config.json`'s `moose`
block, not hardcoded — recalibrating means editing that file, and per the group's spec, recalibration
is always a deliberate scheduled event, never automatic (handicap updates do **not** trigger a Moose
recalc). Current values are an early cut — the group is still tuning the exact calibration constants,
so treat them as provisional. The "Delta" column (Moose − Handicap) is a quick eyeball for whether
someone's raw stats are outperforming or underperforming what their handicap currently credits them for.

## Player roster & aliases

Sheet names never matched players' actual Epic/online display names, so `players.json` carries both:

| key | alias (online) | real name |
|-----|-----------------|-----------|
| robby | not A theist | Robby |
| matt | MightyMosaic389 | Matt |
| mn | garfunkelmoose | Mike Nolen |
| doug | TrdFrgsn20 | Doug |
| kyle | StrtldMoose | Kyle |
| jim | MootCapybara942 | Jim |
| bello | LetMeCook2055 | Bello |
| chris | WildingSumo4 | Chris |
| collin | WeekndCRB | Collin |
| sean | Seaningo | Sean |
| vinny | Vinyyy_13 | Vinny |
| j2 | JimmyBwell | Jimmy |
| lp | *(hidden — legacy/inactive)* | LP |
| kman | K-Man2711 | K-Man *(new, no games yet — provisional handicap)* |

The UI shows the alias as the primary name. `lp` is excluded from the leaderboard, season history, and
the submission form, but stays in the solver's roster since historical games involving them still affect
everyone else's numbers.

## Deployment (Cloudflare Pages)

1. In the Cloudflare dashboard: **Workers & Pages → Create → Pages → Connect to Git**, pick this repo.
2. Build settings: **no build command**, build output directory = `public`.
3. Add these as **Pages secrets/environment variables** (Settings → Environment variables):
   - `GITHUB_TOKEN` — a fine-grained GitHub Personal Access Token scoped to **only this repo**, with
     **Contents: Read and write** permission. This is what lets the submit function commit new games.
   - `GITHUB_OWNER` — `robbyho-aoe2`
   - `GITHUB_REPO` — `fortnite`
   - `GITHUB_BRANCH` — `main`
4. Deploy. Every push to `main` (including the automated commits from `/api/submit-game`) redeploys
   the site automatically.

No database, no separate server — Cloudflare Pages + Functions + this repo's own `data/` files are the
entire stack.

## Roadmap (not built yet)

- **Per-game box-score capture.** `stats.json` is currently season-level averages typed in by the group,
  not derived from individual games. Once box scores get logged per game (manually or via screenshot
  upload), `stats.json` should become computed from `games.json` the same way win/loss records already
  are, and this also unlocks real per-stat highs/lows history instead of a single season snapshot.
- **Screenshot upload with full box-score parsing** (kills, damage, eliminated, damage taken, time
  alive — not just win/loss). Deferred because OCR across varying screen layouts/resolutions is
  unreliable; manual per-game entry is the reliable path to build toward first.
- **Moose Score calibration.** The formula is implemented and matches the group's spec, but the
  regression constants need another tuning pass (see Statistics & Moose Score above).
