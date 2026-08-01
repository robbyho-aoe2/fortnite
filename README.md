# Fortnite Stat Tracker

Consolidated win/loss history, handicaps, and match submission for the group —
replacing the old set of Google Sheets with a single site backed by this repo.

## What's here

This is a single Cloudflare **Worker with static assets** (`fortnite` project) — not classic Cloudflare
Pages. Cloudflare's dashboard created a Worker rather than a Pages project when this was set up, so the
code matches that shape rather than fighting it (Workers-with-assets is also the model Cloudflare is
pushing going forward).

- **`public/`** — the static site, served via the `ASSETS` binding — no build step.
  - `index.html` — Statistics: career-average and max box-score stats per player
  - `handicaps.html` — current handicaps + live 2026 win/loss record
  - `moose.html` — Moose Score leaderboard (see below)
  - `history.html` — season archives for 2023–2025, live-computed 2026
  - `submit.html` — match submission form
  - `data/` — the actual data: `players.json`, `games.json`, `config.json`, `stats.json`
- **`src/`** — the Worker (the backend).
  - `worker.js` — the entrypoint. Routes `POST /api/submit-game` by hand (Workers have no file-based
    routing like Pages Functions did) and falls through to `env.ASSETS.fetch(request)` for everything else
  - `api/submit-game.js` — validates a submitted match, re-solves handicaps, commits the result back to this repo via the GitHub API
  - `lib/solver.js` — the handicap engine (see below)
  - `lib/moose.js` — the Moose Score formula (also duplicated in `public/app.js` for client-side rendering — static assets and the Worker script aren't bundled together, so this small pure formula can't be shared via import; keep both in sync if it changes)
  - `lib/github.js` — thin GitHub Contents API client used to read/write the JSON data files
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
2. That POSTs to `/api/submit-game`, handled by `src/worker.js` → `src/api/submit-game.js`.
3. That function re-reads the current `games.json`/`players.json` from GitHub, appends the new game,
   re-runs the solver across the whole log, and computes new published handicaps.
4. It commits both updated files straight back to this repo via the GitHub API.
5. That commit is a real push to `main`, which triggers the GitHub Actions workflow (see Deployment
   below) the same as any other push — so the Worker redeploys with the fresh data within about a
   minute, no separate database involved. GitHub stays the single source of truth for all data.

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

## Deployment

This is a Cloudflare **Worker** (project name `fortnite`), deployed via **GitHub Actions**
(`.github/workflows/deploy.yml`) rather than Cloudflare's own Git-connected build system.
Cloudflare's "Builds" feature hit an unresolvable account-level bug during setup (a stale build-token
attribution to a departed org member that persisted through recreating both the token and the whole
project) — GitHub Actions runs `wrangler deploy` instead, sidestepping it entirely. Same end result:
push to `main`, site redeploys.

**One-time setup:**

1. The Cloudflare Worker project (`fortnite`) already exists, connected to this repo. Its own
   Git-triggered build should stay **disabled** (Settings → Builds) so it doesn't also try to deploy
   and fail alongside the Actions workflow — only GitHub Actions should be doing deploys.
2. In **this GitHub repo's** Settings → Secrets and variables → **Actions**, add:
   - `CLOUDFLARE_API_TOKEN` — a token scoped to **Account → Cloudflare Pages → Edit** (this permission
     name is a holdover — it also covers Workers deploys)
   - `CLOUDFLARE_ACCOUNT_ID` — the Cloudflare account ID
3. In the **Worker's** Settings → **Variables and Secrets** (the top-level one — not the separate,
   differently-scoped "Variables and secrets" nested under the Builds section, which only applies to
   the build process and isn't visible to the deployed Worker at runtime), add — these are read by
   `/api/submit-game` at request time, separate from the two above which are only used at deploy time:
   - `GITHUB_TOKEN` — a fine-grained GitHub Personal Access Token scoped to **only this repo**, with
     **Contents: Read and write** permission. This is what lets the submit function commit new games.
   - `GITHUB_OWNER` — `robbyho-aoe2`
   - `GITHUB_REPO` — `fortnite`
   - `GITHUB_BRANCH` — `main`
4. Push to `main` (or run the workflow manually via Actions → Deploy to Cloudflare Workers → Run workflow).

No database, no separate server — the Worker + its `ASSETS` binding + this repo's own `data/` files are
the entire stack; GitHub Actions is just the delivery mechanism.

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
