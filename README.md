# juegos-scratch

A classroom board where 4th-grade students paste a link to their Scratch project
and see their classmates' games. Three grades: `4N`, `4F`, `4S`. No login — the
grade the visitor picks filters the list and is attached to whatever they submit.

Games belong to a **project** (a class assignment such as "Pong"). Each project has
its own page at `/<slug>` (for example `/pong`), where students pick their grade.
The home page `/` shows only the projects the teacher lists there; unlisted ones
still work by URL and are marked `noindex`.

When a link is submitted, the server extracts the Scratch project id, asks the
public Scratch API for the project's title and author, and stores the result.
Unshared or nonexistent projects are rejected.

## Requirements

Node 22 and zero npm dependencies. Nothing to install.

## Run locally

```sh
npm start
# or
node server.js
```

Then open <http://localhost:3000>.

Environment variables:

| Variable   | Default   | Meaning                       |
| ---------- | --------- | ----------------------------- |
| `PORT`     | `3000`    | Port to listen on             |
| `DATA_DIR` | `./data`  | Directory holding the JSON DB |

## Admin panel

`/admin` lets the teacher create projects, choose which ones the home page lists, copy
their links, and move, rename or delete games; a rename survives the student sending the
same link again. `/admin/<slug>` opens one project. Its password is the `ADMIN_PASSWORD`
constant in `server.js`, overridable by env. The slugs `admin`, `api` and `fonts` are reserved.

## Run with Docker

```sh
docker compose up -d --build
```

The container does not publish a port; the deploy target (Coolify) attaches it to
its own proxy network. Data lives in the named volume `juegos-data`.

## How data is stored

There is no database. Games live in `$DATA_DIR/games.json` (a plain array) and
projects in `$DATA_DIR/projects.json`, both loaded into memory at boot. The in-memory
arrays are the source of truth; every mutation is written back atomically (write a
`.tmp` file, then rename over the real one) and writes are serialized through a
promise chain so concurrent requests cannot interleave.

Each record looks like:

```json
{
  "id": "1375051955",
  "title": "spiderman",
  "author": "Oliver-Felipe",
  "name": "Felipe Oliver",
  "grade": "4N",
  "addedAt": "2026-01-01T00:00:00.000Z",
  "project": "3f2a9c1b7d4e"
}
```

A game is unique per `(project, grade, id)`, so the same Scratch project can appear in
two projects. A project looks like
`{ "id": "3f2a9c1b7d4e", "slug": "pong", "title": "Pong", "listed": true, "createdAt": "…" }`;
games point at its `id`, so changing a slug never touches them.

At boot, any game without a `project` (data from before projects existed) is moved into
an unlisted project "Primeros juegos" at `/primeros-juegos`; nothing else in the game
changes. A file that cannot be parsed is renamed to `*.broken-<time>` instead of being
overwritten.

`name` is derived from the Scratch username, which at this school follows the
`surname-given` convention.
