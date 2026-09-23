import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || './data';
const GAMES_FILE = path.join(DATA_DIR, 'games.json');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');

// School years and the divisions inside each. A grade is year + letter: 3N, 4F...
const YEARS = [3, 4];
const DIVISIONS = ['N', 'F', 'S'];
const gradesOf = (year) => DIVISIONS.map((letter) => `${year}${letter}`);
// Projects saved before years existed were all 4th grade.
const LEGACY_YEAR = 4;
const MAX_BODY_BYTES = 4 * 1024;
const MAX_LIST = 300;
const MAX_TITLE = 120;
const MAX_PROJECT_TITLE = 60;
const MAX_SLUG = 40;
const SCRATCH_TIMEOUT_MS = 10000;

const SLUG_SHAPE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// Top-level paths the app uses itself, so no project can take them.
// (Purely numeric slugs are reserved too: /3 and /4 are the year pages.)
const RESERVED_SLUGS = new Set(['admin', 'api', 'fonts']);
const isReservedSlug = (slug) => RESERVED_SLUGS.has(slug) || /^\d+$/.test(slug);
// Games saved before projects existed land here, unlisted.
const LEGACY_PROJECT = { slug: 'primeros-juegos', title: 'Primeros juegos' };

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
const ERR_WRONG_YEAR = 'Ese grado no es de este proyecto.';
const ERR_NO_PROJECT = 'Ese proyecto no existe.';
const ERR_NOT_SHARED =
  'Ese proyecto no está compartido. Tocá «Compartir» en Scratch y probá de nuevo.';
const ERR_UPSTREAM = 'No se pudo consultar Scratch. Probá de nuevo.';
const ERR_SAVE = 'No se pudo guardar. Probá de nuevo.';

// The teacher opens /admin on the classroom projector, so the URL alone must not be enough.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'gatoverde';
const ADMIN_COOKIE = '__Host-admin';
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const ADMIN_PAGE_PATH = /^\/admin(?:\.html|\/(?:[^/.]+\/?)?)?$/;
const ADMIN_PROJECT_PATH = /^\/api\/admin\/projects\/([\w-]{1,64})(?:\/games(?:\/(\d[A-Z])\/(\d{1,15}))?)?$/;
// Both derive from the password, so changing it signs every session out.
const PASSWORD_DIGEST = createHash('sha256').update(ADMIN_PASSWORD).digest();
const SESSION_KEY = createHash('sha256').update(`juegos-scratch admin session:${ADMIN_PASSWORD}`).digest();

const ERR_ADMIN_PASSWORD = 'Contraseña incorrecta.';
const ERR_ADMIN_SESSION = 'Entrá de nuevo.';
const ERR_ADMIN_GONE = 'Ese juego ya no está.';
const ERR_ADMIN_PROJECT_GONE = 'Ese proyecto ya no está.';
const ERR_ADMIN_NOTHING = 'No hay cambios.';
const ERR_ADMIN_BAD = 'No se entendió el pedido.';
const ERR_SLUG_SHAPE = 'La dirección solo puede tener letras sin tildes, números y guiones.';
const ERR_SLUG_EMPTY = 'Elegí una dirección con letras o números.';
const ERR_SLUG_RESERVED = 'Esa dirección está reservada. Elegí otra.';
const ERR_SLUG_TAKEN = 'Ya hay un proyecto con esa dirección.';

// Scratch's default thumbnail (the cat alone on a white stage) as a 12x9 grid of mean RGB,
// measured from two real default thumbnails. One line per grid row.
const DEFAULT_THUMB = Buffer.from(
  [
  'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  'ffffffffffffffffffffffffffffffeddcbeebdbbeffffffffffffffffffffffffffffff',
  'fffffffffffffffffffffffffcfcfce0c99ed5cfc2fcfcfdffffffffffffffffffffffff',
  'fffffffffffffffffffffffffdfdfce3c795ecdfc7ffffffffffffffffffffffffffffff',
  'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  ].join(''),
  'hex',
);
// A thumbnail is the default when no grid cell differs from it by more than this (0-255).
// Known defaults reach 2.1; the closest real thumbnail seen (a robot on white) is 28.
const DEFAULT_THUMB_LIMIT = 10;
const THUMB_TIMEOUT_MS = 10_000;
const THUMB_RETRY_MS = 15 * 60 * 1000;
const THUMB_RECHECK_MS = 12 * 60 * 60 * 1000;
const MAX_THUMB_BYTES = 3 * 1024 * 1024;

/** In-memory source of truth. */
let games = [];
let projects = [];

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

/** "Juegos de Ñandú" becomes `juegos-de-nandu`; a long title is cut at a word, within 40 characters. */
function slugify(text) {
  const full = String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (full.length <= MAX_SLUG) return full;
  const cut = full.slice(0, MAX_SLUG + 1);
  const end = cut.lastIndexOf('-');
  return (end > 0 ? cut.slice(0, end) : full.slice(0, MAX_SLUG)).replace(/-+$/, '');
}

function newProjectId() {
  let id;
  do id = randomBytes(6).toString('hex');
  while (projects.some((project) => project.id === id));
  return id;
}

function createProject(title, slug, listed, year = LEGACY_YEAR) {
  const project = { id: newProjectId(), slug, title, year, listed, createdAt: new Date().toISOString() };
  projects.push(project);
  return project;
}

/** The first free `base`, `base-2`, `base-3`… Only migration uses it; people get a 409 instead. */
function freeSlug(base) {
  let slug = base;
  for (let n = 2; projects.some((project) => project.slug === slug); n++) slug = `${base}-${n}`;
  return slug;
}

/**
 * Gives every game a project without touching anything else in it. Games from before
 * projects existed join one unlisted project; a game whose project vanished gets a
 * placeholder project with the same id, so nothing becomes invisible.
 */
function migrate() {
  let changed = false;
  for (const project of projects) {
    if (YEARS.includes(project.year)) continue;
    project.year = LEGACY_YEAR;
    changed = true;
  }
  const loose = games.filter((game) => typeof game.project !== 'string' || !game.project);
  if (loose.length) {
    const legacy =
      projects.find((project) => project.slug === LEGACY_PROJECT.slug) ??
      createProject(LEGACY_PROJECT.title, LEGACY_PROJECT.slug, false);
    for (const game of loose) game.project = legacy.id;
    changed = true;
  }
  const known = new Set(projects.map((project) => project.id));
  for (const game of games) {
    if (known.has(game.project)) continue;
    projects.push({
      id: game.project,
      slug: freeSlug('recuperado'),
      title: 'Proyecto recuperado',
      year: Number(game.grade?.[0]) === 3 ? 3 : LEGACY_YEAR,
      listed: false,
      createdAt: new Date().toISOString(),
    });
    known.add(game.project);
    changed = true;
  }
  return changed;
}

/** Reads a JSON array. A file that exists but cannot be read is kept aside, never overwritten. */
async function readList(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    /* set aside below */
  }
  await rename(file, `${file}.broken-${Date.now()}`);
  return null;
}

async function loadData() {
  await mkdir(DATA_DIR, { recursive: true });
  const savedGames = await readList(GAMES_FILE);
  const savedProjects = await readList(PROJECTS_FILE);
  games = savedGames ?? [];
  projects = savedProjects ?? [];
  if (migrate() || !savedGames || !savedProjects) await persist();
}

async function writeAtomic(file, list) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(list), 'utf8');
  await rename(tmp, file);
}

/**
 * Writes both files. Projects go first, so a crash in between never leaves a game
 * pointing at a project that was not saved; a deletion passes `gamesFirst` so the
 * games of a deleted project cannot outlive it on disk.
 */
function persist({ gamesFirst = false } = {}) {
  const run = async () => {
    if (gamesFirst) await writeAtomic(GAMES_FILE, games);
    await writeAtomic(PROJECTS_FILE, projects);
    if (!gamesFirst) await writeAtomic(GAMES_FILE, games);
  };
  const next = writeChain.then(run, run);
  writeChain = next.catch(() => {});
  return next;
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
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

/** The fields every public answer exposes; bookkeeping stays on the server. */
function publicGame({ id, title, author, name, grade, addedAt }) {
  return { id, title, author, name, grade, addedAt };
}

/** Admin answers also say how the thumbnail was classified. */
function adminGame(game) {
  return { ...publicGame(game), thumb: game.thumb ?? null };
}

const newestFirst = (a, b) => String(b.addedAt).localeCompare(String(a.addedAt));
const newestProjectFirst = (a, b) => String(b.createdAt).localeCompare(String(a.createdAt));

const projectBySlug = (slug) => projects.find((project) => project.slug === slug);
const projectById = (id) => projects.find((project) => project.id === id);
const gamesOf = (project) => games.filter((game) => game.project === project.id).sort(newestFirst);

/**
 * Ids for a cover mosaic, one per Scratch project: the newest games with a real
 * thumbnail first, then Scratch's default cat only to fill what is left. Games not
 * checked yet, or whose picture could not be read, count as real.
 */
function coverIds(newest) {
  const ids = [];
  const take = (game) => {
    if (ids.length < 4 && !ids.includes(game.id)) ids.push(game.id);
  };
  for (const game of newest) if (game.thumb !== 'default') take(game);
  for (const game of newest) if (game.thumb === 'default') take(game);
  return ids;
}

function listGames(project, grade) {
  return gamesOf(project)
    .filter((game) => game.grade === grade)
    .slice(0, MAX_LIST)
    .map(publicGame);
}

/** Listed projects, newest first; only one school year when `year` is given. */
function listProjects(year) {
  return projects
    .filter((project) => project.listed && (!year || project.year === year))
    .sort(newestProjectFirst)
    .map((project) => {
      const own = gamesOf(project);
      return { slug: project.slug, title: project.title, year: project.year, count: own.length, recent: coverIds(own) };
    });
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
  if (!grade) return sendJson(res, 400, { error: ERR_NO_GRADE });

  const owner = typeof body?.project === 'string' ? projectBySlug(body.project) : undefined;
  if (!owner) return sendJson(res, 404, { error: ERR_NO_PROJECT });
  if (!gradesOf(owner.year).includes(grade)) return sendJson(res, 400, { error: ERR_WRONG_YEAR });

  const project = await fetchProject(id);
  if (!project.ok) {
    return sendJson(res, project.status, {
      error: project.status === 502 ? ERR_UPSTREAM : ERR_NOT_SHARED,
    });
  }
  // The project may have been deleted while Scratch answered.
  if (!projectById(owner.id)) return sendJson(res, 404, { error: ERR_NO_PROJECT });

  const title = (project.title || 'Sin título').slice(0, MAX_TITLE);
  const existing = games.find((game) => game.project === owner.id && game.grade === grade && game.id === id);

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
      project: owner.id,
    };
    // The same Scratch project may already be classified in another project or grade.
    const twin = games.find((entry) => entry.id === id && entry.thumb);
    if (twin) Object.assign(game, { thumb: twin.thumb, thumbCheckedAt: twin.thumbCheckedAt });
    games.push(game);
    status = 201;
  }

  try {
    await persist();
  } catch {
    return sendJson(res, 500, { error: ERR_SAVE });
  }

  // Sending a link again may mean a new thumbnail, so look at it either way.
  queueThumb(id);
  return sendJson(res, status, { game: publicGame(game) });
}

function handlePublicApi(req, res, url) {
  const { pathname, searchParams } = url;
  if (pathname === '/api/games') {
    const grade = searchParams.get('grade') || '';
    const project = projectBySlug(searchParams.get('project') || '');
    if (!project) return sendJson(res, 404, { error: ERR_NO_PROJECT });
    if (!gradesOf(project.year).includes(grade)) return sendJson(res, 400, { error: ERR_NO_GRADE });
    return sendJson(res, 200, { games: listGames(project, grade) });
  }
  if (pathname === '/api/projects') {
    // ?year=3 or ?year=4 narrows the list; without it, every listed project.
    const year = Number(searchParams.get('year'));
    if (searchParams.has('year') && !YEARS.includes(year)) return sendJson(res, 400, { error: ERR_ADMIN_BAD });
    return sendJson(res, 200, { projects: listProjects(YEARS.includes(year) ? year : null) });
  }
  const match = /^\/api\/projects\/([^/]+)$/.exec(pathname);
  const project = match && projectBySlug(match[1]);
  if (project) {
    const { slug, title, year, listed } = project;
    return sendJson(res, 200, { project: { slug, title, year, listed } }, listed ? {} : { 'X-Robots-Tag': 'noindex' });
  }
  if (match) return sendJson(res, 404, { error: ERR_NO_PROJECT });
  return sendJson(res, 404, { error: 'Not found' });
}

/* ---------- Thumbnails: Scratch's default cat or a real picture ---------- */

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Minimal PNG decoder: non-interlaced 8/16-bit gray, RGB, gray+alpha and RGBA, and
 * 1/2/4/8-bit palette. Returns RGB composited over white (a Scratch stage is white),
 * or null for anything else (Scratch also serves some old thumbnails as GIF or JPEG).
 */
function decodePng(buf) {
  const magic = '89504e470d0a1a0a';
  if (buf.length < 8 || buf.toString('hex', 0, 8) !== magic) return null;
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = -1;
  let interlace = 0;
  let palette = null;
  let alphas = null;
  const idat = [];
  for (let pos = 8; pos + 8 <= buf.length; ) {
    const length = buf.readUInt32BE(pos);
    const kind = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + length);
    pos += 12 + length;
    if (kind === 'IHDR' && data.length >= 13) {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      type = data[9];
      interlace = data[12];
    } else if (kind === 'PLTE') palette = data;
    else if (kind === 'tRNS') alphas = data;
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!channels || !width || !height || width * height > 4_000_000 || interlace !== 0) return null;
  if (type === 3 ? !palette || ![1, 2, 4, 8].includes(depth) : ![8, 16].includes(depth)) return null;

  let raw;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const bits = channels * depth;
  const bpp = Math.max(1, bits >> 3);
  const stride = Math.ceil((width * bits) / 8);
  if (raw.length < (stride + 1) * height) return null;

  const pixels = new Uint8Array(width * height * 3);
  const step = depth === 16 ? 2 : 1;
  let prev = new Uint8Array(stride);
  let line = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    const filter = raw[start];
    if (filter > 4) return null;
    line.set(raw.subarray(start + 1, start + 1 + stride));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      if (filter === 1) line[i] = (line[i] + a) & 255;
      else if (filter === 2) line[i] = (line[i] + b) & 255;
      else if (filter === 3) line[i] = (line[i] + ((a + b) >> 1)) & 255;
      else if (filter === 4) line[i] = (line[i] + paeth(a, b, c)) & 255;
    }
    for (let x = 0; x < width; x++) {
      let r;
      let g;
      let b;
      let a = 255;
      if (type === 3) {
        const bit = x * depth;
        const index = (line[bit >> 3] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
        r = palette[index * 3] ?? 0;
        g = palette[index * 3 + 1] ?? 0;
        b = palette[index * 3 + 2] ?? 0;
        if (alphas && index < alphas.length) a = alphas[index];
      } else {
        const at = x * channels * step;
        r = line[at];
        g = type === 0 || type === 4 ? r : line[at + step];
        b = type === 0 || type === 4 ? r : line[at + 2 * step];
        if (type === 4) a = line[at + step];
        if (type === 6) a = line[at + 3 * step];
      }
      const o = (y * width + x) * 3;
      pixels[o] = (r * a + 255 * (255 - a)) / 255;
      pixels[o + 1] = (g * a + 255 * (255 - a)) / 255;
      pixels[o + 2] = (b * a + 255 * (255 - a)) / 255;
    }
    [prev, line] = [line, prev];
  }
  return { width, height, pixels };
}

/** The mean RGB of each cell of a 12x9 grid: a coarse fingerprint of the picture. */
function thumbSignature({ width, height, pixels }) {
  const out = new Float64Array(12 * 9 * 3);
  for (let cy = 0; cy < 9; cy++) {
    const y0 = Math.floor((cy * height) / 9);
    const y1 = Math.floor(((cy + 1) * height) / 9);
    for (let cx = 0; cx < 12; cx++) {
      const x0 = Math.floor((cx * width) / 12);
      const x1 = Math.floor(((cx + 1) * width) / 12);
      const sum = [0, 0, 0];
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const o = (y * width + x) * 3;
          sum[0] += pixels[o];
          sum[1] += pixels[o + 1];
          sum[2] += pixels[o + 2];
        }
      }
      const n = Math.max(1, (y1 - y0) * (x1 - x0));
      const cell = (cy * 12 + cx) * 3;
      for (let k = 0; k < 3; k++) out[cell + k] = sum[k] / n;
    }
  }
  return out;
}

/**
 * 'default' or 'custom'; 'unknown' when the picture cannot be read or is too small to be
 * a real thumbnail (Scratch answers missing ones with a 60x60 placeholder).
 */
function classifyThumb(buf) {
  const image = decodePng(buf);
  if (!image || image.width < 160 || image.height < 120) return 'unknown';
  const signature = thumbSignature(image);
  let worst = 0;
  for (let cell = 0; cell < signature.length; cell += 3) {
    let diff = 0;
    for (let k = 0; k < 3; k++) diff += Math.abs(signature[cell + k] - DEFAULT_THUMB[cell + k]);
    worst = Math.max(worst, diff / 3);
  }
  return worst <= DEFAULT_THUMB_LIMIT ? 'default' : 'custom';
}

/** Downloads and classifies one thumbnail. Returns null when it should be tried again later. */
async function checkThumb(id) {
  try {
    const response = await fetch(`https://cdn2.scratch.mit.edu/get_image/project/${id}_480x360.png`, {
      headers: { 'User-Agent': 'juegos-scratch/1.0' },
      signal: AbortSignal.timeout(THUMB_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    if (Number(response.headers.get('content-length')) > MAX_THUMB_BYTES) return 'unknown';
    const buf = Buffer.from(await response.arrayBuffer());
    return buf.length > MAX_THUMB_BYTES ? 'unknown' : classifyThumb(buf);
  } catch {
    return null;
  }
}

/** Scratch ids waiting for a look, one at a time in the background; requests never wait on it. */
const thumbQueue = new Set();
let thumbWorking = false;

function queueThumb(id) {
  thumbQueue.add(id);
  if (!thumbWorking) void drainThumbs();
}

async function drainThumbs() {
  thumbWorking = true;
  while (thumbQueue.size) {
    const [id] = thumbQueue;
    thumbQueue.delete(id);
    const verdict = await checkThumb(id);
    if (!verdict) {
      setTimeout(() => queueThumb(id), THUMB_RETRY_MS).unref();
      continue;
    }
    const checkedAt = new Date().toISOString();
    let touched = false;
    for (const game of games) {
      if (game.id !== id) continue;
      game.thumb = verdict;
      game.thumbCheckedAt = checkedAt;
      touched = true;
    }
    if (touched) await persist().catch(() => {});
  }
  thumbWorking = false;
}

function startThumbChecks() {
  for (const game of games) if (!game.thumb) queueThumb(game.id);
  // A kid can save a real thumbnail later, so defaults get another look twice a day.
  setInterval(() => {
    for (const game of games) if (game.thumb === 'default') queueThumb(game.id);
  }, THUMB_RECHECK_MS).unref();
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

function countByGrade(list, year) {
  const counts = Object.fromEntries(gradesOf(year).map((grade) => [grade, 0]));
  for (const game of list) if (game.grade in counts) counts[game.grade] += 1;
  return counts;
}

function adminProject(project) {
  const own = gamesOf(project);
  const { id, slug, title, year, listed, createdAt } = project;
  return {
    id,
    slug,
    title,
    year,
    listed,
    createdAt,
    counts: countByGrade(own, year),
    total: own.length,
    recent: coverIds(own),
  };
}

/** Checks a slug a person typed. Returns an error message, or null when it can be used. */
function slugProblem(slug) {
  if (!slug) return ERR_SLUG_EMPTY;
  if (slug.length > MAX_SLUG) return `La dirección puede tener hasta ${MAX_SLUG} caracteres.`;
  if (!SLUG_SHAPE.test(slug)) return ERR_SLUG_SHAPE;
  if (isReservedSlug(slug)) return ERR_SLUG_RESERVED;
  return null;
}

const slugTaken = (slug, self) => projects.some((project) => project.slug === slug && project !== self);

/** Validates project fields. Returns `{ changes }`, or `{ status, error }`. */
function readProjectChanges(body, self) {
  const changes = {};
  if (body.title !== undefined) {
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) return { status: 400, error: 'El nombre no puede quedar vacío.' };
    if (title.length > MAX_PROJECT_TITLE) {
      return { status: 400, error: `El nombre puede tener hasta ${MAX_PROJECT_TITLE} caracteres.` };
    }
    changes.title = title;
  }
  if (body.slug !== undefined) {
    const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
    const problem = slugProblem(slug);
    if (problem) return { status: 400, error: problem };
    if (slugTaken(slug, self)) return { status: 409, error: ERR_SLUG_TAKEN };
    changes.slug = slug;
  }
  if (body.listed !== undefined) {
    if (typeof body.listed !== 'boolean') return { status: 400, error: ERR_ADMIN_BAD };
    changes.listed = body.listed;
  }
  if (body.year !== undefined) {
    if (!YEARS.includes(body.year)) return { status: 400, error: 'Elegí 3° o 4°.' };
    changes.year = body.year;
  }
  return { changes };
}

async function handleProjectCreate(req, res) {
  const body = await readJsonBody(req, res);
  if (!body) return;
  if (body.title === undefined) return sendJson(res, 400, { error: 'El nombre no puede quedar vacío.' });
  // Without a slug, the title suggests one; a taken or odd one is still a clear error.
  const fields = { ...body, slug: body.slug === undefined ? slugify(body.title) : body.slug };
  const { changes, status, error } = readProjectChanges(fields, null);
  if (error) return sendJson(res, status, { error });

  // New projects start off the home page until the teacher lists them.
  if (changes.year === undefined) return sendJson(res, 400, { error: 'Elegí 3° o 4°.' });
  const project = createProject(changes.title, changes.slug, changes.listed ?? false, changes.year);
  try {
    await persist();
  } catch {
    return sendJson(res, 500, { error: ERR_SAVE });
  }
  return sendJson(res, 201, { project: adminProject(project) });
}

async function handleProjectUpdate(req, res, project) {
  const body = await readJsonBody(req, res);
  if (!body) return;
  const { changes, status, error } = readProjectChanges(body, project);
  if (error) return sendJson(res, status, { error });
  if (Object.keys(changes).length === 0) return sendJson(res, 400, { error: ERR_ADMIN_NOTHING });

  // Games point at the project id, so a new slug leaves them untouched. A new year
  // carries the games along: 4N becomes 3N, keeping each division.
  if (changes.year !== undefined && changes.year !== project.year) {
    for (const game of games) if (game.project === project.id) game.grade = `${changes.year}${game.grade.slice(1)}`;
  }
  Object.assign(project, changes);
  try {
    await persist();
  } catch {
    return sendJson(res, 500, { error: ERR_SAVE });
  }
  return sendJson(res, 200, { project: adminProject(project) });
}

async function handleProjectDelete(req, res, project) {
  req.resume();
  const before = games.length;
  games = games.filter((game) => game.project !== project.id);
  projects = projects.filter((entry) => entry !== project);
  try {
    await persist({ gamesFirst: true });
  } catch {
    return sendJson(res, 500, { error: ERR_SAVE });
  }
  return sendJson(res, 200, { ok: true, games: before - games.length });
}

/** Validates `{ grade?, title?, name? }`. Returns `{ changes }` or `{ error }`. */
function readGameChanges(body, project) {
  const changes = {};
  if (body.grade !== undefined) {
    if (!gradesOf(project.year).includes(body.grade)) return { error: ERR_WRONG_YEAR };
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

const findGame = (project, grade, id) =>
  games.find((entry) => entry.project === project.id && entry.grade === grade && entry.id === id);

async function handleGameUpdate(req, res, project, grade, id) {
  const body = await readJsonBody(req, res);
  if (!body) return;
  const { changes, error } = readGameChanges(body, project);
  if (error) return sendJson(res, 400, { error });

  const game = findGame(project, grade, id);
  if (!game) return sendJson(res, 404, { error: ERR_ADMIN_GONE });

  const target = changes.grade ?? grade;
  if (target !== grade && findGame(project, target, id)) {
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
  return sendJson(res, 200, { game: adminGame(game) });
}

async function handleGameDelete(req, res, project, grade, id) {
  req.resume();
  const game = findGame(project, grade, id);
  if (!game) return sendJson(res, 404, { error: ERR_ADMIN_GONE });
  games = games.filter((entry) => entry !== game);

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

  if (pathname === '/api/admin/projects') {
    if (req.method === 'POST') return handleProjectCreate(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: ERR_ADMIN_BAD });
    return sendJson(res, 200, { projects: [...projects].sort(newestProjectFirst).map(adminProject) });
  }

  const match = ADMIN_PROJECT_PATH.exec(pathname);
  if (!match) return sendJson(res, 404, { error: 'Not found' });
  const [, projectId, grade, id] = match;
  const project = projectById(projectId);
  if (!project) {
    req.resume();
    return sendJson(res, 404, { error: ERR_ADMIN_PROJECT_GONE });
  }
  const scope = pathname.endsWith('/games') ? 'games' : grade ? 'game' : 'project';

  if (scope === 'project') {
    if (req.method === 'PATCH') return handleProjectUpdate(req, res, project);
    if (req.method === 'DELETE') return handleProjectDelete(req, res, project);
  } else if (scope === 'games') {
    if (req.method === 'GET' || req.method === 'HEAD') {
      const own = gamesOf(project);
      return sendJson(res, 200, {
        project: adminProject(project),
        games: own.map(adminGame),
        counts: countByGrade(own, project.year),
      });
    }
  } else {
    if (req.method === 'PATCH') return handleGameUpdate(req, res, project, grade, id);
    if (req.method === 'DELETE') return handleGameDelete(req, res, project, grade, id);
  }
  req.resume();
  return sendJson(res, 405, { error: ERR_ADMIN_BAD });
}

/* ---------- Pages ---------- */

async function sendPage(res, file, status, headers = {}) {
  const data = await readFile(path.join(PUBLIC_DIR, file));
  res.writeHead(status, {
    'Content-Type': CONTENT_TYPES['.html'],
    'Content-Length': data.length,
    'Cache-Control': 'no-cache',
    ...headers,
  });
  res.end(data);
}

/**
 * `/` picks the school year, `/3` and `/4` list that year's projects, and `/<slug>` is a
 * project; index.html reads the path.
 * `/Pong` and `/pong/` redirect to `/pong`; unknown paths get the app's own 404.
 */
function handleAppPage(res, url) {
  const { pathname, search } = url;
  if (pathname === '/' || pathname === '/index.html') return sendPage(res, 'index.html', 200);

  const segment = /^\/([^/]+)\/?$/.exec(pathname)?.[1];
  let slug = '';
  try {
    slug = segment ? decodeURIComponent(segment).toLowerCase() : '';
  } catch {
    slug = '';
  }
  if (SLUG_SHAPE.test(slug) && pathname !== `/${slug}`) {
    res.writeHead(301, { Location: `/${slug}${search}`, 'Content-Length': 0 });
    res.end();
    return undefined;
  }

  if (YEARS.map(String).includes(slug)) return sendPage(res, 'index.html', 200);
  const project = SLUG_SHAPE.test(slug) && !isReservedSlug(slug) ? projectBySlug(slug) : undefined;
  if (!project) return sendPage(res, 'index.html', 404, { 'X-Robots-Tag': 'noindex' });
  return sendPage(res, 'index.html', 200, project.listed ? {} : { 'X-Robots-Tag': 'noindex' });
}

function resolveStaticPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const resolved = path.resolve(PUBLIC_DIR, `.${path.posix.normalize(decoded)}`);
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
  const reading = req.method === 'GET' || req.method === 'HEAD';

  if (pathname.startsWith('/api/admin/')) {
    handleAdmin(req, res, pathname).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: ERR_SAVE });
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/games') {
    handleCreate(req, res).catch(() => sendJson(res, 500, { error: ERR_SAVE }));
    return;
  }

  if (!reading) {
    sendPlain(res, 405, 'Method not allowed');
    return;
  }

  if (pathname.startsWith('/api/')) {
    handlePublicApi(req, res, url);
    return;
  }

  if (ADMIN_PAGE_PATH.test(pathname)) {
    sendPage(res, 'admin.html', 200, { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }).catch(() =>
      sendPlain(res, 404, 'Not found'),
    );
    return;
  }

  // Files have an extension in their last segment; everything else is the app.
  if (/\.[^/]+$/.test(pathname) && pathname !== '/index.html') {
    handleStatic(res, pathname).catch(() => sendPlain(res, 404, 'Not found'));
    return;
  }
  Promise.resolve(handleAppPage(res, url)).catch(() => sendPlain(res, 404, 'Not found'));
});

await loadData();
server.listen(PORT, HOST, () => {
  console.log(`juegos-scratch listening on http://${HOST}:${PORT}`);
  startThumbChecks();
});

export { prettify, extractProjectId, slugify };
