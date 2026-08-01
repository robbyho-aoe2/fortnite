# Fortnite Stat Tracker

Consolidated win/loss history, handicaps, and match submission for the group —
replacing the old set of Google Sheets with a single site backed by this repo.

## What's here

This is a plain **static site on GitHub Pages** — no server, no Cloudflare, no separate backend. There's
no such thing as a secure server-side secret in that model, so the piece that writes new games back to
this repo (which needs a GitHub write credential) runs in the visitor's own browser instead. See
"Architecture & the public-token trade-off" below for why that's a deliberate choice, not an oversight.

- **`public/`** — the entire site, deployed as-is (no build step).
  - `index.html` — the landing page: Auto Teams generator + manual team builder/score submission (see below)
  - `statistics.html` — career-average and max box-score stats per player
  - `handicaps.html` — current handicaps + live 2026 win/loss record
  - `moose.html` — Moose Score leaderboard (see below)
  - `history.html` — season archives for 2023–2025, live-computed 2026
  - `data/` — the actual data: `players.json`, `games.json`, `config.json`, `stats.json`
  - `app.js` — shared rendering helpers loaded as a plain script on every page
  - `lib/` — ES modules imported directly by pages that need them (not bundled with anything):
    - `submit-game.js` — validates a submitted match, re-solves handicaps, commits the result back to this repo via the GitHub API. This is the client-side successor to what was briefly a Cloudflare Worker route — see git history if you're curious, but there's no Worker anymore.
    - `solver.js` — the handicap engine (see below)
    - `moose.js` — the Moose Score formula (also duplicated in `app.js` since that loads as a plain script, not a module — keep both in sync if it changes)
    - `github.js` — thin GitHub Contents API client used to read/write the JSON data files
    - `repo-config.js` — the repo-write token (see below) plus owner/repo/branch
- **`test/`** — solver + pipeline tests (`npm test`), including an end-to-end test of the submission flow with a mocked GitHub API.
- **`scripts/`** — manual one-off maintenance tools, run locally with `node scripts/<name>.js` (they use
  the same `repo-config.js` token as the site). Not part of the deployed site or any automated flow.
  - `recompute.js` — re-solves handicaps against the current log and commits the result without
    adding/changing a game. Useful after a solver bug fix: the fix is correct going forward, but
    whatever's already committed in `players.json` still reflects the old computation until something
    triggers a fresh solve.
  - `set-hc-anchor.js` — directly overwrites published handicaps with a given set of values (e.g. the
    group's own real numbers from their full-history system, when this site's ~546-game seed history
    has drifted from them). A reference for how to do this again, not something meant to run routinely.

## Architecture & the public-token trade-off

GitHub Pages only serves static files — there's no way to run server code that could keep a credential
hidden from visitors. So `lib/submit-game.js` runs entirely in the browser: it reads the current data
files, re-solves handicaps, and writes the result straight back to this repo via the GitHub API, using a
token that ships in the page's own JavaScript (`lib/repo-config.js`).

That token is:
- A **fine-grained GitHub PAT scoped to only this repo**, with **Contents: Read and write** and no other
  permission — it can't touch any other repo or account setting.
- **Lightly obfuscated** (reversed + base64) purely so GitHub's automated secret-scanning doesn't
  flag/revoke it on push. This is not real security — anyone who wants the actual value can trivially
  reconstruct it from that file or from a network request in dev tools. It only stops automated bots and
  casual code-search scraping.
- An **accepted risk, not a mistake**: this is a small trusted-group site, and the worst case is someone
  writing garbage into this one repo's data or defacing the site's own source. If that risk profile ever
  changes, the fix is to put a real backend back in front of the token (any host that can keep a secret
  server-side — Cloudflare Workers, Vercel, Netlify Functions, etc. — works, since `lib/github.js` and
  `lib/solver.js` are plain framework-agnostic JS with no browser-specific dependencies).

To rotate the token: generate a new fine-grained PAT (GitHub → Settings → Developer settings → Personal
access tokens → Fine-grained tokens), scoped to `robbyho-aoe2/fortnite`, Contents: Read and write. Then
run `btoa([...token].reverse().join(""))` in a browser console and paste the result into
`ENCODED_TOKEN` in `public/lib/repo-config.js`.

## How handicaps work

Ported faithfully from the group's original Google Apps Script (`singlepass()`). Two layers:

1. **Base handicap** — a coordinate hill-climb over the full game log. Every match already has
   a "games to tie" breakeven derived from the two teams' handicap totals (`(team1HC - team2HC) + 10`,
   on a fixed 20-game reference scale). The solver repeatedly nudges each player's handicap up or down so
   that their recency-weighted (exponential decay, `tau=50` games), handicap-adjusted win rate converges
   toward 50% — i.e. it finds the handicaps that would have made everyone's history look like a coin flip.
   One player is anchored near 10 as a scale reference; "lp" is hard-pinned to a fixed negative band, both
   matching the original script's behavior. The objective being minimized (the spread between the
   best and worst recency-weighted win rate) **excludes LP** — it's a filler, not a real player, so its
   win rate is noise; including it made the solver chase a spread that wasn't real, causing every new
   game to visibly move players who weren't even in it. This runs after *every* submitted game (not in
   batches), so getting that exclusion right matters — with it, one new game nudges published handicaps
   by a few hundredths to a few tenths, not whole points.
2. **Strength factor** — a current-record momentum nudge layered on top, from two recency windows
   (last 25 games and last 200 games) of simple win% deviation from 50%.

All the tunable constants (`tau`, iteration limits, step sizes, bounds, window sizes) live in
`public/data/config.json`, not hardcoded in the solver — recalibrating the system means editing that file.

**Published handicap = base + strength factor.** This is what's shown on the leaderboard.

## Building teams and submitting a game

`index.html` (the landing page) has two parts:

1. **Auto Teams** — check off who's playing tonight, hit "Generate Balanced Teams," and it ranks every
   way to split that pool into the most even two teams (sizes as equal as possible; if the pool is odd,
   one side is necessarily one player short). Ranked by how close the handicap gap is to a dead-even
   10-10 split. Click "Use this split" to load it into the builder below.
2. **Build Teams & Submit Result** — pick Team 1 and Team 2 by hand (or arrive here from Auto Teams
   already filled in). This shows a live "wins needed to tie" readout as you check players in and out,
   computed client-side with the exact same formula the backend uses, so what you see here is what
   actually gets graded. Once the games are played:
   - Leave **"Game completed"** checked if the session went the full 20-round reference length, and enter
     Team 1's win count directly.
   - If it ended early, uncheck it, enter how many rounds were actually played, and enter the raw win
     count for that shorter session (e.g. 5-5 at round 10 of 20). The backend scales it up proportionally
     to the 20-round scale before grading (5-5 at round 10 grades identically to 10-10) — see
     `src/api/submit-game.js`.

**LP is not a player.** It's a fixed-handicap filler (hard-pinned to a narrow negative band by the
solver) automatically added to whichever team has fewer real players, so an uneven pool — like a 3v4 —
still grades against a symmetric reference. It never appears as a selectable checkbox; both the Auto
Teams generator and the live "wins to tie" preview add it in automatically wherever team sizes don't
match, using the identical formula as the actual submission logic (`computeMatchup` /
`generateBalancedSplits` in `app.js` mirror `computeBreakeven` in `lib/solver.js`).

Hitting "Submit Game" calls `submitGame()` in `lib/submit-game.js`, which runs in your own browser:

1. Reads the current `games.json`/`players.json` straight from GitHub, appends the new game (after
   applying the rounds-played scaling above).
2. Re-runs the solver across the whole log and computes new published handicaps.
3. Commits both updated files straight back to this repo via the GitHub API.
4. That commit is a real push to `main`, which triggers the GitHub Actions deploy workflow (see
   Deployment below) the same as any other push — so the site redeploys with the fresh data within
   about a minute or two. GitHub stays the single source of truth for all data; there's no separate
   database, and no server sits between your submission and the commit.

**Correcting or removing a submission**: the "Your Recent Submissions" section lists anything you've
logged in the last 24 hours with **Edit** and **Delete** buttons (`editGame()` / `deleteGame()` in
`lib/submit-game.js`). Edit reuses the same team-builder form pre-filled with that game's data and
replaces it in place (same id, fully re-graded, full re-solve) rather than appending a duplicate.
Delete removes it and re-solves as if it never happened. Both are locked out once 24 hours have
passed — the id itself (`game-<timestamp>`) is what the window is measured against, so no separate
field tracks it. Legacy migrated games (`legacy-*` ids) were never eligible in the first place.

## Season history, live 2026, and why they use different data sources

2023–2025 are frozen season-end archives (`players[].seasonArchive`), migrated from the old
spreadsheets' whole-number year-end rollups.

**2026 works the same way, and that's deliberate.** `seasonArchive["2026"]` holds the same kind of
whole-number rollup (from the "FTN 2026 stats" sheet) as a **fixed baseline**, frozen as of migration.
`record2026()` in `app.js` takes that baseline and adds *only* genuinely new site submissions on top of
it (games whose id starts with `game-`, not the migrated `legacy-*` rows) — so 2026 updates live as
games are submitted, without ever re-deriving or re-litigating anything that came before.

This is **not** computed from the 545-game per-game log in `games.json` (which came from the "AI HCs"
spreadsheet's `log` tab, migrated 2025-07 through the migration date). That log exists for exactly one
purpose: seed data for the handicap solver, which tolerates imprecision fine since it's fitting a curve,
not keeping score. Early on, the win/loss/tie *record* was mistakenly derived from that same log
(via the solver's own grading, replaying old games against ever-changing current handicaps) — which
produced numbers that didn't match the group's actual season stats and drifted further every time
someone submitted a game. Keep these two uses of the log separate: the solver may keep using all of
`games.json` including legacy rows; the displayed *record* never should.

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
| lp | *(hidden — not a real player)* | LP |
| kman | K-Man2711 | K-Man *(new, no games yet — provisional handicap)* |

The UI shows each player's real name as primary, with their alias underneath where the two differ
(`displayName()` / `secondaryName()` in `app.js`). `lp` isn't a real player at all — see "Building
teams and submitting a game" above — so it's excluded from every player-picker and leaderboard, but
stays in the solver's roster since games it was auto-added to still affect everyone else's numbers.

## Deployment

Plain **GitHub Pages**, deployed via GitHub Actions (`.github/workflows/deploy.yml`) using the standard
`actions/deploy-pages` flow — no Cloudflare, no Worker, no external account of any kind involved.

**One-time setup:**

1. In this repo's **Settings → Pages**, set **Source** to **GitHub Actions** (not "Deploy from a
   branch" — that's the older, different Pages flow).
2. Make sure `public/lib/repo-config.js`'s `ENCODED_TOKEN` holds a currently-valid token (see
   "Architecture & the public-token trade-off" above for what it's scoped to and how to rotate it).
3. Push to `main` (or run the workflow manually via Actions → Deploy to GitHub Pages → Run workflow).

That's the entire stack: this repo's own `data/` files, GitHub Pages for hosting, and GitHub Actions
purely to publish on push — no database, no server, nothing else to configure or that can go down
independently.

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
