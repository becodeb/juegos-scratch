# juegos-scratch

A classroom board where 4th-grade students paste a link to their Scratch project
and see their classmates' games. Three grades: `4N`, `4F`, `4S`. No login — the
grade the visitor picks filters the list and is attached to whatever they submit.

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

`/admin` lets the teacher move, rename and delete entries; a rename survives the student sending the
same link again. Its password is the `ADMIN_PASSWORD` constant in `server.js`, overridable by env.

## Run with Docker

```sh
docker compose up -d --build
```

The container does not publish a port; the deploy target (Coolify) attaches it to
its own proxy network. Data lives in the named volume `juegos-data`.

## How data is stored

There is no database. Entries live in a single JSON file, `$DATA_DIR/games.json`,
loaded into memory at boot. The in-memory array is the source of truth; every
mutation is written back atomically (write `games.json.tmp`, then rename over
`games.json`) and writes are serialized through a promise chain so concurrent
requests cannot interleave.

Each record looks like:

```json
{
  "id": "1375051955",
  "title": "spiderman",
  "author": "Oliver-Felipe",
  "name": "Felipe Oliver",
  "grade": "4N",
  "addedAt": "2026-01-01T00:00:00.000Z"
}
```

`name` is derived from the Scratch username, which at this school follows the
`surname-given` convention.
