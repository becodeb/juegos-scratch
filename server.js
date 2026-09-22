import { createServer } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || './data';
const DATA_FILE = path.join(DATA_DIR, 'games.json');
const TMP_FILE = path.join(DATA_DIR, 'games.json.tmp');

const GRADES = ['4N', '4F', '4S'];
const MAX_BODY_BYTES = 4 * 1024;
const MAX_LIST = 300;
const MAX_TITLE = 120;
const SCRATCH_TIMEOUT_MS = 10000;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const ERR_BAD_LINK = 'Ese link no es de un proyecto de Scratch.';
const ERR_NO_GRADE = 'Elegí tu grado primero.';
const ERR_NOT_SHARED =
  'Ese proyecto no está compartido. Tocá «Compartir» en Scratch y probá de nuevo.';
const ERR_UPSTREAM = 'No se pudo consultar Scratch. Probá de nuevo.';
const ERR_SAVE = 'No se pudo guardar. Probá de nuevo.';

/** In-memory source of truth. */
let games = [];

/** Serializes persistence so concurrent requests never interleave writes. */
let writeChain = Promise.resolve();

/**
 * Turns a school Scratch username (`surname-given`) into a readable name.
 * `Oliver-Felipe` becomes `Felipe Oliver`.
 */
function prettify(username) {
  const raw = String(username ?? '');
  const parts = raw
    .split(/[-_]+/)
    .filter(Boolean)
    .filter((part) => !/^\d+$/.test(part))
    .map((part) => part.replace(/\d+$/, ''))
    .filter(Boolean);

  if (parts.length === 0) return raw;
  if (parts.length === 1) return capitalize(parts[0]);

  const surname = parts[0];
  const given = parts.slice(1);
  return `${given.map(capitalize).join(' ')} ${capitalize(surname)}`;
}

function capitalize(part) {
  return part.charAt(0).toLocaleUpperCase('es') + part.slice(1).toLocaleLowerCase('es');
}

/**
 * Accepts full project URLs (with or without scheme, `www.`, trailing path
 * segment, query or hash) and bare numeric ids.
 */
function extractProjectId(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  const withoutQuery = trimmed.split(/[?#]/)[0];

  const bare = /^(\d{1,15})$/.exec(withoutQuery);
  if (bare) return bare[1];

  const url =
    /^(?:https?:\/\/)?(?:www\.)?scratch\.mit\.edu\/projects\/(\d{1,15})(?:\/[^/]*)*$/i.exec(
      withoutQuery,
    );
  return url ? url[1] : null;
}

async function loadGames() {
  await mkdir(DATA_DIR, { recursive: true });
  try {
    const text = await readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(text);
    games = Array.isArray(parsed) ? parsed : [];
  } catch {
    games = [];
    await writeFile(DATA_FILE, '[]', 'utf8');
  }
}

function persist() {
  const run = async () => {
    await writeFile(TMP_FILE, JSON.stringify(games), 'utf8');
    await rename(TMP_FILE, DATA_FILE);
  };
  const next = writeChain.then(run, run);
  writeChain = next.catch(() => {});
  return next;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendPlain(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function tooLargeError() {
  return Object.assign(new Error('payload too large'), { code: 'TOO_LARGE' });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      reject(tooLargeError());
      return;
    }

    const chunks = [];
    let size = 0;
    let done = false;

    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        done = true;
        reject(tooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => {
      if (done) return;
      done = true;
      reject(error);
    });
  });
}

function listGames(grade) {
  return games
    .filter((game) => game.grade === grade)
    .sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)))
    .slice(0, MAX_LIST);
}

async function fetchProject(id) {
  let response;
  try {
    response = await fetch(`https://api.scratch.mit.edu/projects/${id}`, {
      headers: { 'User-Agent': 'juegos-scratch/1.0' },
      signal: AbortSignal.timeout(SCRATCH_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, status: 502 };
  }

  if (!response.ok) return { ok: false, status: 404 };

  let payload;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, status: 404 };
  }

  const title = typeof payload?.title === 'string' ? payload.title.trim() : '';
  const author = payload?.author?.username;
  if (!payload?.title || typeof author !== 'string' || !author) {
    return { ok: false, status: 404 };
  }

  return { ok: true, title, author };
}

async function handleCreate(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (error) {
    if (error?.code === 'TOO_LARGE') {
      // The request body was not consumed, so the connection cannot be reused.
      res.setHeader('Connection', 'close');
      sendJson(res, 413, { error: ERR_BAD_LINK });
      req.resume();
      return;
    }
    return sendJson(res, 400, { error: ERR_BAD_LINK });
  }

  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    return sendJson(res, 400, { error: ERR_BAD_LINK });
  }

  const id = extractProjectId(body?.url);
  if (!id) return sendJson(res, 400, { error: ERR_BAD_LINK });

  const grade = typeof body?.grade === 'string' ? body.grade : '';
  if (!GRADES.includes(grade)) return sendJson(res, 400, { error: ERR_NO_GRADE });

  const project = await fetchProject(id);
  if (!project.ok) {
    return sendJson(res, project.status, {
      error: project.status === 502 ? ERR_UPSTREAM : ERR_NOT_SHARED,
    });
  }

  const title = (project.title || 'Sin título').slice(0, MAX_TITLE);
  const existing = games.find((game) => game.id === id && game.grade === grade);

  let game;
  let status;
  if (existing) {
    existing.title = title;
    existing.author = project.author;
    existing.name = prettify(project.author);
    game = existing;
    status = 200;
  } else {
    game = {
      id,
      title,
      author: project.author,
      name: prettify(project.author),
      grade,
      addedAt: new Date().toISOString(),
    };
    games.push(game);
    status = 201;
  }

  try {
    await persist();
  } catch {
    return sendJson(res, 500, { error: ERR_SAVE });
  }

  return sendJson(res, status, { game });
}

function resolveStaticPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const relative = decoded === '/' ? '/index.html' : decoded;
  const resolved = path.resolve(PUBLIC_DIR, `.${path.posix.normalize(relative)}`);
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) return null;
  return resolved;
}

async function handleStatic(res, pathname) {
  const filePath = resolveStaticPath(pathname);
  if (!filePath) return sendPlain(res, 404, 'Not found');

  const ext = path.extname(filePath).toLowerCase();
  const type = CONTENT_TYPES[ext];
  if (!type) return sendPlain(res, 404, 'Not found');

  let data;
  try {
    data = await readFile(filePath);
  } catch {
    return sendPlain(res, 404, 'Not found');
  }

  const headers = {
    'Content-Type': type,
    'Content-Length': data.length,
  };
  if (ext === '.html') headers['Cache-Control'] = 'no-cache';
  res.writeHead(200, headers);
  res.end(data);
}

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  if (req.method === 'POST' && pathname === '/api/games') {
    handleCreate(req, res).catch(() => sendJson(res, 500, { error: ERR_SAVE }));
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (pathname === '/api/games') {
      const grade = url.searchParams.get('grade') || '';
      if (!GRADES.includes(grade)) return sendJson(res, 400, { error: ERR_NO_GRADE });
      return sendJson(res, 200, { games: listGames(grade) });
    }
    if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });
    handleStatic(res, pathname).catch(() => sendPlain(res, 404, 'Not found'));
    return;
  }

  sendPlain(res, 405, 'Method not allowed');
});

await loadGames();
server.listen(PORT, HOST, () => {
  console.log(`juegos-scratch listening on http://${HOST}:${PORT}`);
});

export { prettify, extractProjectId };
