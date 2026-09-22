import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
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

// The teacher opens /admin on the classroom projector, so the URL alone must not be enough.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'gatoverde';
const ADMIN_COOKIE = '__Host-admin';
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const ADMIN_PAGES = new Set(['/admin', '/admin/', '/admin.html']);
const ADMIN_GAME_PATH = /^\/api\/admin\/games\/(4[NFS])\/(\d{1,15})$/;
// Both derive from the password, so changing it signs every session out.
const PASSWORD_DIGEST = createHash('sha256').update(ADMIN_PASSWORD).digest();
const SESSION_KEY = createHash('sha256').update(`juegos-scratch admin session:${ADMIN_PASSWORD}`).digest();

const ERR_ADMIN_PASSWORD = 'Contraseña incorrecta.';
const ERR_ADMIN_SESSION = 'Entrá de nuevo.';
const ERR_ADMIN_GONE = 'Ese juego ya no está.';
const ERR_ADMIN_GRADE = 'Ese grado no existe.';
const ERR_ADMIN_NOTHING = 'No hay cambios.';
const ERR_ADMIN_BAD = 'No se entendió el pedido.';

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

/** The fields every API answer exposes; bookkeeping flags stay on the server. */
function publicGame({ id, title, author, name, grade, addedAt }) {
  return { id, title, author, name, grade, addedAt };
}

const newestFirst = (a, b) => String(b.addedAt).localeCompare(String(a.addedAt));

function listGames(grade) {
  return games
    .filter((game) => game.grade === grade)
    .sort(newestFirst)
    .slice(0, MAX_LIST)
    .map(publicGame);
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
    // Sending the same link again must not undo a fix made in /admin.
    if (!existing.titleLocked) existing.title = title;
    existing.author = project.author;
    if (!existing.nameLocked) existing.name = prettify(project.author);
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

  return sendJson(res, status, { game: publicGame(game) });
}

/* ---------- Admin ---------- */

function sign(expires) {
  return createHmac('sha256', SESSION_KEY).update(`admin:${expires}`).digest('base64url');
}

function sessionCookie(value, maxAge) {
  return `${ADMIN_COOKIE}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

/** The session cookie is `<expiry seconds>.<HMAC of the expiry>`, so the server keeps no state. */
function hasSession(req) {
  const match = /(?:^|;\s*)__Host-admin=(\d{1,12})\.([\w-]{43})(?:;|$)/.exec(req.headers.cookie || '');
  if (!match || Number(match[1]) * 1000 <= Date.now()) return false;
  return timingSafeEqual(Buffer.from(sign(match[1])), Buffer.from(match[2]));
}

/** Reads a JSON object body. When it cannot, it answers the request itself and returns null. */
async function readJsonBody(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (error) {
    if (error?.code === 'TOO_LARGE') {
      res.setHeader('Connection', 'close');
      sendJson(res, 413, { error: ERR_ADMIN_BAD });
      req.resume();
      return null;
    }
    sendJson(res, 400, { error: ERR_ADMIN_BAD });
    return null;
  }
  try {
    const body = JSON.parse(raw || '{}');
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch {
    /* answered below */
  }
  sendJson(res, 400, { error: ERR_ADMIN_BAD });
  return null;
}

async function handleLogin(req, res) {
  const body = await readJsonBody(req, res);
  if (!body) return;
  const password = typeof body.password === 'string' ? body.password : '';
  // Equal-length digests keep the comparison constant-time.
  if (!timingSafeEqual(createHash('sha256').update(password).digest(), PASSWORD_DIGEST)) {
    return sendJson(res, 401, { error: ERR_ADMIN_PASSWORD });
  }
  const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  res.setHeader('Set-Cookie', sessionCookie(`${expires}.${sign(expires)}`, SESSION_SECONDS));
  return sendJson(res, 200, { ok: true });
}

function countByGrade() {
  const counts = Object.fromEntries(GRADES.map((grade) => [grade, 0]));
  for (const game of games) if (game.grade in counts) counts[game.grade] += 1;
  return counts;
}

/** Validates `{ grade?, title?, name? }`. Returns `{ changes }` or `{ error }`. */
function readChanges(body) {
  const changes = {};
  if (body.grade !== undefined) {
    if (!GRADES.includes(body.grade)) return { error: ERR_ADMIN_GRADE };
    changes.grade = body.grade;
  }
  for (const [field, label] of [
    ['title', 'El título'],
    ['name', 'El nombre'],
  ]) {
    if (body[field] === undefined) continue;
    const text = typeof body[field] === 'string' ? body[field].trim() : '';
    if (!text) return { error: `${label} no puede quedar vacío.` };
    if (text.length > MAX_TITLE) return { error: `${label} puede tener hasta ${MAX_TITLE} caracteres.` };
    changes[field] = text;
  }
  if (Object.keys(changes).length === 0) return { error: ERR_ADMIN_NOTHING };
  return { changes };
}

async function handleUpdate(req, res, grade, id) {
  const body = await readJsonBody(req, res);
  if (!body) return;
  const { changes, error } = readChanges(body);
  if (error) return sendJson(res, 400, { error });

  const game = games.find((entry) => entry.id === id && entry.grade === grade);
  if (!game) return sendJson(res, 404, { error: ERR_ADMIN_GONE });

  const target = changes.grade ?? grade;
  if (target !== grade && games.some((entry) => entry.id === id && entry.grade === target)) {
    return sendJson(res, 409, { error: `Ese juego ya está en ${target}.` });
  }

  game.grade = target;
  if (changes.title !== undefined && changes.title !== game.title) {
    game.title = changes.title;
    game.titleLocked = true;
  }
  if (changes.name !== undefined && changes.name !== game.name) {
    game.name = changes.name;
    game.nameLocked = true;
  }

  try {
    await persist();
  } catch {
    return sendJson(res, 500, { error: ERR_SAVE });
  }
  return sendJson(res, 200, { game: publicGame(game) });
}

async function handleDelete(req, res, grade, id) {
  req.resume();
  const index = games.findIndex((entry) => entry.id === id && entry.grade === grade);
  if (index === -1) return sendJson(res, 404, { error: ERR_ADMIN_GONE });
  games.splice(index, 1);

  try {
    await persist();
  } catch {
    return sendJson(res, 500, { error: ERR_SAVE });
  }
  return sendJson(res, 200, { ok: true });
}

async function handleAdmin(req, res, pathname) {
  if (pathname === '/api/admin/login' || pathname === '/api/admin/logout') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: ERR_ADMIN_BAD });
    if (pathname === '/api/admin/login') return handleLogin(req, res);
    req.resume();
    res.setHeader('Set-Cookie', sessionCookie('', 0));
    return sendJson(res, 200, { ok: true });
  }

  if (!hasSession(req)) {
    req.resume();
    return sendJson(res, 401, { error: ERR_ADMIN_SESSION });
  }

  if (pathname === '/api/admin/games') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: ERR_ADMIN_BAD });
    return sendJson(res, 200, {
      games: [...games].sort(newestFirst).map(publicGame),
      counts: countByGrade(),
    });
  }

  const match = ADMIN_GAME_PATH.exec(pathname);
  if (!match) return sendJson(res, 404, { error: 'Not found' });
  const [, grade, id] = match;
  if (req.method === 'PATCH') return handleUpdate(req, res, grade, id);
  if (req.method === 'DELETE') return handleDelete(req, res, grade, id);
  return sendJson(res, 405, { error: ERR_ADMIN_BAD });
}

async function handleAdminPage(res) {
  const data = await readFile(path.join(PUBLIC_DIR, 'admin.html'));
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES['.html'],
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex',
  });
  res.end(data);
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

  if (pathname.startsWith('/api/admin/')) {
    handleAdmin(req, res, pathname).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: ERR_SAVE });
    });
    return;
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && ADMIN_PAGES.has(pathname)) {
    handleAdminPage(res).catch(() => sendPlain(res, 404, 'Not found'));
    return;
  }

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
