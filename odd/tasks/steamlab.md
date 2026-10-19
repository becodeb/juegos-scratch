# STEAMLab course

## Objective

Add a third, hidden course called STEAMLab next to 3° and 4°, so workshop kids can
paste a Scratch link, type their name, and see every game made in that project.

## Problem / why

The board only knows school years with N/F/S divisions, and names come from the
school's `surname-given` Scratch usernames. STEAMLab kids use personal accounts, have
no division, and must not appear on the public `/` year picker.

## Scope

- Course `steamlab`: not on `/`, reachable at `/steamlab`, lists every STEAMLab
  project (the URL is the hiding place, so `listed` is not required there; noindex).
- `/steamlab` with exactly one project redirects to it (same as `/3` and `/4`).
- A STEAMLab project has a single board (grade `steamlab`): no grade picker, no chips.
- Usernames without `-` are shown exactly as typed (no capitalizing, no digit stripping).
- 3° and STEAMLab boards get an optional "your name" field. Pasting the link adds the
  game at once; the name can be typed before (sent with the add) or after (patches
  the game this page just added).
- Admin can create projects for 3°, 4° or STEAMLab and filter by it.

## Constraints

- Zero npm dependencies; single `app.js` (Dockerfile only versions `index.html`).
- `games.json` stays an array; `projects.json` `year` may now be `'steamlab'`.
- `steamlab` becomes a reserved slug.
- The grade never goes in the URL.
- No extra security (user's explicit choice for this app).

## Tasks

- [x] T1 Server: course model (`3`, `4`, `steamlab`), reserved slug, `/steamlab` page,
      `/api/projects?year=steamlab`, showcase excludes STEAMLab, prettify keeps
      dash-less usernames, `name` on add, public name patch for the just-added game.
- [x] T2 Public app: `/steamlab` route + lone redirect, single-board STEAMLab project,
      name field for 3° and STEAMLab, STEAMLab color.
- [x] T3 Admin: course picker/filter/chip with STEAMLab.
- [x] T4 Browser smoke test, then deploy.

## Route

All three code tasks: delegated direct, one writer (trigger: 3 non-trivial files —
server.js, app.js, admin.js — plus html/css).

## Checks

- TDD: off (no test runner in the repo; source: repo has no test script).
- `node --check` on server.js and every public JS file.
- Playwright smoke test against a local server with seed data in `/tmp`.
- RDD: off globally since 2026-09-23 (user choice).

## Progress

- 2026-10-19: document created; branch `feat/steamlab`.
- 2026-10-19: T1-T3 implemented (server.js, public/app.js, public/admin.js, public/index.html,
  public/admin.html, public/styles.css, public/admin.css). Decisions made where the brief
  left room:
  - STEAMLab color reuses the admin panel's own existing teal token set exactly
    (`--fill:#0fbd8c --edge:#0b8e69 --deep:#06533e --on:#083528 --on-deep:#fff
    --slot-edge:#075c44`, dark-mode `--mark:#3dd9a8`), since admin.css already defines
    this exact "extension teal" with proven contrast for its own chrome — same semantics
    (a tool/workshop course), so no new palette was invented.
  - "En el inicio" toggle: hidden entirely for STEAMLab project rows in admin (not shown
    disabled/explained), since it has no effect there.
  - `paintChrome()` in app.js was changed to read colors off `hat` (which always carries
    the current `data-g`) instead of looking up a matching `.chip` in the palette — the
    old lookup would throw for STEAMLab, which has no chips at all. This is a general
    robustness fix, not steamlab-only logic.
- Verification:
  - `node --check server.js && for f in public/*.js; do node --check "$f"; done` → all OK.
  - Local server (`DATA_DIR=/tmp/js-steam PORT=3998 node server.js`) with seed data (1
    listed 4° project, 2 listed 3° projects, 1 unlisted steamlab project) + curl:
    - `/api/projects` (no year) → excludes steamlab (only the 4° and two 3° projects).
    - `/api/projects?year=steamlab` → returns the steamlab project despite `listed:false`.
    - `GET /steamlab` → `200` with `X-Robots-Tag: noindex`.
    - `POST /api/games` to the steamlab project, grade `steamlab`, url
      `.../projects/1003185`, `name:"Juana"` → game created with `name:"Juana"`.
    - `POST /api/games/name` on that game → name updated.
    - `POST /api/games` to a 4° project, grade `4N`, no `name` → still works as before.
    - `POST /api/games/name` targeting the 4° project → refused
      ("Este proyecto no tiene campo de nombre.").
  - Playwright (chromium headless, `/tmp/pw`) against the same local server:
    - `/steamlab` redirects to the lone steamlab project; board shows directly (no
      picker), palette/chips hidden, hat label "STEAMLab", `--fill` is `#0fbd8c` (teal).
    - Pasted a link via clipboard on that board, typed a name; after the ~800ms debounce
      the card showed the typed name without a page reload.
    - 3° board: name field visible. 4° board: name field hidden.
    - `/` still lists only 3° and 4°.
    - No `pageerror`/console errors in any of the above.
    - Screenshots taken at 1200px and 375px of the steamlab board (sent to the user);
      both look correct — teal theme, "Tu nombre" field wraps to its own line and reads
      fine on the 375px board, `+` button correctly hidden on phone (existing rule).
  - Local test server and seed data were torn down after verification.
  - Not run here: the actual `/admin` UI was not exercised in the browser (only curl/code
    review), since it wasn't in the required Playwright checklist; course-aware admin
    logic (course picker, filters, hidden filter slots, hidden "En el inicio") was
    reasoned through against the existing code paths but not visually confirmed.
- 2026-10-19 (parent): dedupe games when a project collapses into STEAMLab's single
  board; slot `flex: 1 1 0` so link + Pegar stay on one row on a 375px phone. Re-checked in
  Chromium: name typed before pasting is kept (`Sofi`), admin shows 3°/4°/STEAMLab picker,
  filter and chip with no listed toggle on STEAMLab rows, `/steamlab` with two projects shows
  the shelf and the project's back link points to `/steamlab`, `/` shows only 3° and 4°,
  no page errors. Merged to main and deployed.
