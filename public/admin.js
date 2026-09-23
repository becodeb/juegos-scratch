const GRADES = ['4N', '4F', '4S'];
const NS = 'http://www.w3.org/2000/svg';
const SPRING = 'cubic-bezier(.34, 1.56, .64, 1)';
const SETTLE = 'cubic-bezier(.2, .7, .4, 1)';
const CONFIRM_MS = 3000;
const SKELETON_DELAY = 150;
const MAX_TEXT = 120;
const MAX_PROJECT_TITLE = 60;
const MAX_SLUG = 40;
// Mirrors the server, which stays authoritative.
const SLUG_SHAPE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const RESERVED_SLUGS = new Set(['admin', 'api', 'fonts']);

const ERR_OFFLINE = 'No hay conexión. Probá de nuevo.';
const ERR_SAVE = 'No se pudo guardar. Probá de nuevo.';
const ERR_LOAD = 'No se pudo cargar. Recargá la página.';
const ERR_EXPIRED = 'Tu sesión se cerró. Entrá de nuevo.';

const gate = document.querySelector('.gate');
const loginForm = gate.querySelector('.login');
const password = loginForm.querySelector('.slot');
const enterButton = loginForm.querySelector('.enter');
const panel = document.querySelector('.panel');
const upLink = panel.querySelector('.up');
const head = panel.querySelector('.head');
const headLabel = head.querySelector('.head-label');
const outButton = panel.querySelector('.out');

const projectsView = panel.querySelector('.projects-view');
const maker = projectsView.querySelector('.maker');
const makerTitle = maker.querySelector('.maker-title');
const makerSlug = maker.querySelector('.maker-slug');
const plist = projectsView.querySelector('.plist');
const pnothing = projectsView.querySelector('.nothing');

const gamesView = panel.querySelector('.games-view');
const filtersBox = gamesView.querySelector('.filters');
const filterButtons = [...filtersBox.querySelectorAll('.filter')];
const rows = gamesView.querySelector('.glist');
const nothing = gamesView.querySelector('.nothing');
const nothingText = nothing.querySelector('.nothing-text');

const bubble = document.querySelector('.say');
const bubbleText = bubble.querySelector('.say-text');
const live = document.getElementById('live');

const motionOk = matchMedia('(prefers-reduced-motion: no-preference)');
const moving = () => motionOk.matches;
const shortDate = new Intl.DateTimeFormat('es-AR', { dateStyle: 'short' });

/** Every project, newest first, as the server last confirmed it. */
let projects = [];
/** The project whose games are open, and those games, newest first. */
let current = null;
let games = [];
let filter = 'all';

/* ---------- Scratch shapes (same geometry as app.js) ---------- */

const CAP = 'c 25,-22 71,-22 96,0';
const NOTCH = 'c 2,0 3,1 4,2 l 4,4 c 1,1 2,2 4,2 h 12 c 2,0 3,-1 4,-2 l 4,-4 c 1,-1 2,-2 4,-2';
const BUMP = 'c -2,0 -3,1 -4,2 l -4,4 c -1,1 -2,2 -4,2 h -12 c -2,0 -3,-1 -4,-2 l -4,-4 c -1,-1 -2,-2 -4,-2';

const r2 = (n) => Math.round(n * 100) / 100;
const scaled = (d, s) => d.replace(/-?\d+(?:\.\d+)?/g, (n) => String(r2(n * s)));

function blockPath(w, h, s, { hat = false, notch = false } = {}) {
  const r = r2(4 * s);
  let d = hat ? `M0,0 ${scaled(CAP, s)}` : `M0,${r} a${r},${r} 0 0 1 ${r},${-r}`;
  if (!hat && notch) d += ` H${r2(12 * s)} ${scaled(NOTCH, s)}`;
  d += ` H${r2(w - r)} a${r},${r} 0 0 1 ${r},${r} V${r2(h - r)} a${r},${r} 0 0 1 ${-r},${r}`;
  d += ` H${r2(48 * s)} ${scaled(BUMP, s)}`;
  return `${d} H${r} a${r},${r} 0 0 1 ${-r},${-r} Z`;
}

/** Scratch "say" bubble with its tail flipped to point up-left from `tx`. */
function bubblePath(w, h, tx, k = 1.5) {
  const R = 16;
  const p = (x, y) => `${r2(tx + x * k)},${r2(y * k)}`;
  return (
    `M${R},0 H${tx} C${p(0, -4)} ${p(-4, -8)} ${p(-4, -10)} Q${p(-4, -12)} ${p(-2, -12)} ` +
    `C${p(1, -12)} ${p(11, -8)} ${p(16, 0)} H${r2(w - R)} A${R},${R} 0 0 1 ${r2(w)},${R} ` +
    `V${r2(h - R)} A${R},${R} 0 0 1 ${r2(w - R)},${r2(h)} H${R} A${R},${R} 0 0 1 0,${r2(h - R)} ` +
    `V${R} A${R},${R} 0 0 1 ${R},0 Z`
  );
}

/** Left edge in layout pixels; offsets ignore transforms, so a pop or a glide cannot skew it. */
function layoutLeft(node) {
  let x = 0;
  for (let at = node; at; at = at.offsetParent) x += at.offsetLeft;
  return x;
}

let tailTarget = null;

function draw(node, w, h) {
  if (!w || !h) return;
  let d;
  if (node === bubble) {
    const aim = tailTarget ? layoutLeft(tailTarget) + Math.min(tailTarget.offsetWidth / 2, 20) : 0;
    const tip = Math.min(Math.max(aim - layoutLeft(bubble), 24), w - 48);
    d = bubblePath(w, h, tip + 6);
    bubble.style.transformOrigin = `${tip}px -18px`;
  } else {
    const s = parseFloat(getComputedStyle(node).getPropertyValue('--s')) || 1;
    d = blockPath(w, h, s, { hat: node.classList.contains('hat'), notch: node.classList.contains('cmd') });
  }
  node.querySelector(':scope > .shape .body').setAttribute('d', d);
}

const shapes = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const box = entry.borderBoxSize?.[0];
    draw(entry.target, box ? box.inlineSize : entry.target.offsetWidth, box ? box.blockSize : entry.target.offsetHeight);
  }
});

function addShape(node) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'shape');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('class', 'body');
  svg.append(path);
  node.prepend(svg);
  shapes.observe(node);
}

/* ---------- Small helpers ---------- */

function icon(id, className = 'icon') {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

let announceTimer = 0;

function announce(text) {
  clearTimeout(announceTimer);
  live.textContent = '';
  announceTimer = setTimeout(() => {
    live.textContent = text;
  }, 60);
}

async function api(method, url, body) {
  let response;
  try {
    response = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { status: 0, data: { error: ERR_OFFLINE } };
  }
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

const projectPath = (project) => `/api/admin/projects/${project.id}`;
const gamePath = (game) => `${projectPath(current)}/games/${game.grade}/${game.id}`;
const thumbUrl = (id) => `https://cdn2.scratch.mit.edu/get_image/project/${id}_144x108.png`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Same rule as the server: accents stripped, anything else a hyphen, cut at a word within 40. */
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

/** What is wrong with a slug for `self` (null when creating), or null when it can be used. */
function slugProblem(slug, self) {
  if (!slug) return 'Elegí una dirección con letras o números.';
  if (slug.length > MAX_SLUG) return `La dirección puede tener hasta ${MAX_SLUG} caracteres.`;
  if (!SLUG_SHAPE.test(slug)) return 'La dirección solo puede tener letras sin tildes, números y guiones.';
  if (RESERVED_SLUGS.has(slug)) return 'Esa dirección está reservada. Elegí otra.';
  if (projects.some((project) => project.slug === slug && project !== self)) {
    return 'Ya hay un proyecto con esa dirección.';
  }
  return null;
}

/** Keeps a slug field typeable: lowercase, no accents, anything else becomes a hyphen. */
function tidySlugField(input) {
  const before = input.value;
  const tidy = before
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-');
  if (tidy === before) return;
  const caret = input.selectionStart ?? tidy.length;
  input.value = tidy;
  const at = Math.min(caret - (before.length - tidy.length), tidy.length);
  input.setSelectionRange(Math.max(at, 0), Math.max(at, 0));
}

const finalSlug = (value) => value.trim().replace(/^-+|-+$/g, '');

/* ---------- Motion ---------- */

const POP = [
  { transform: 'scale(.3)', opacity: 0 },
  { transform: 'none', opacity: 1 },
];

const SHAKE = [
  { transform: 'none' },
  { transform: 'translateX(-10px) rotate(-1deg)' },
  { transform: 'translateX(8px) rotate(.8deg)' },
  { transform: 'translateX(-6px)' },
  { transform: 'translateX(3px)' },
  { transform: 'none' },
];

const onScreen = (node) => {
  const rect = node.getBoundingClientRect();
  return rect.bottom > -80 && rect.top < innerHeight + 80;
};

const listOf = (node) => node.closest('.rows');

/** Applies a change that moves rows, then glides each visible row from where it was (FLIP). */
function flip(list, change) {
  if (!moving() || !list) return change();
  const tracked = [...list.children].filter(onScreen);
  const before = tracked.map((row) => row.getBoundingClientRect().top);
  for (const row of tracked) row.glide?.cancel();
  const result = change();
  tracked.forEach((row, i) => {
    if (!row.isConnected) return;
    const dy = before[i] - row.getBoundingClientRect().top;
    if (Math.abs(dy) < 1) return;
    row.glide = row.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], {
      duration: 260,
      easing: SETTLE,
    });
  });
  return result;
}

function flash(row) {
  if (!moving()) return;
  row.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 1200, easing: 'ease-in', pseudoElement: '::after' });
}

function rise(items) {
  if (!moving()) return;
  items.slice(0, 12).forEach((row, i) => {
    row.animate(
      [
        { opacity: 0, transform: 'translateY(8px)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration: 240, delay: i * 18, easing: SETTLE, fill: 'backwards' },
    );
  });
}

/* ---------- Say bubble ---------- */

/**
 * Shows `message` under `place` (inside it when it is a row) with the tail aimed at `target`.
 * `info` swaps the stop sign for a calm note, for news that is not an error.
 */
function say(message, place, target, { info = false } = {}) {
  const inRow = place.classList.contains('row');
  const list = listOf(place);
  const change = () => {
    if (inRow) place.append(bubble);
    else place.after(bubble);
    bubbleText.textContent = message;
    tailTarget = target;
    bubble.hidden = false;
    bubble.classList.toggle('calm', info);
    bubble.classList.remove('end');
    if (inRow) {
      const rowBox = place.getBoundingClientRect();
      const aim = target.getBoundingClientRect();
      if (aim.left + aim.width / 2 - rowBox.left > rowBox.width * 0.55) bubble.classList.add('end');
    }
  };
  flip(list, change);
  draw(bubble, bubble.offsetWidth, bubble.offsetHeight);
  announce(message);
  if (moving()) bubble.animate(POP, { duration: 300, easing: SPRING });
}

function unsay() {
  if (bubble.hidden) return;
  flip(listOf(bubble), () => {
    bubble.hidden = true;
    tailTarget = null;
  });
}

function shake(node) {
  if (moving()) node.animate(SHAKE, { duration: 420, easing: 'ease-out' });
}

/* ---------- Rows shared by both lists ---------- */

function setBusy(row, busy) {
  row.busy = busy;
  row.classList.toggle('busy', busy);
  row.setAttribute('aria-busy', String(busy));
}

function actButton(className, iconId, label) {
  const button = el('button', `act ${className}`);
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.append(icon(iconId));
  return button;
}

function field(label, value, max, className = 'field') {
  const input = el('input', className);
  input.type = 'text';
  input.value = value;
  input.maxLength = max;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-label', label);
  return input;
}

function skeleton(list, count) {
  const ghosts = Array.from({ length: count }, () => {
    const row = el('li', 'row ghost');
    row.setAttribute('aria-hidden', 'true');
    row.innerHTML =
      '<span class="thumb"><span class="sheen"></span></span>' +
      '<span class="info"><span class="line long"><span class="sheen"></span></span>' +
      '<span class="line short"><span class="sheen"></span></span></span>';
    return row;
  });
  list.replaceChildren(...ghosts);
}

/** Removes a row with a slide, closes the gap smoothly and keeps keyboard focus nearby. */
function removeRow(row, focusSelector, fallback, done) {
  const list = listOf(row);
  const neighbor = row.nextElementSibling || row.previousElementSibling;
  const hadFocus = row.contains(document.activeElement);
  const finish = () => {
    flip(list, () => row.remove());
    done?.();
    if (!hadFocus) return;
    const target = neighbor?.isConnected && neighbor.querySelector(focusSelector);
    (target || fallback()).focus();
  };
  if (row.contains(bubble)) unsay();
  if (!moving()) {
    finish();
    return;
  }
  row.style.pointerEvents = 'none';
  row
    .animate(
      [
        { opacity: 1, transform: 'none' },
        { opacity: 0, transform: 'translateX(-32px)' },
      ],
      { duration: 200, easing: 'ease-in', fill: 'forwards' },
    )
    .finished.then(finish, finish);
}

function disarm(button) {
  clearTimeout(button.disarmTimer);
  if (!button.classList.contains('confirming')) return;
  button.classList.remove('confirming');
  button.setAttribute('aria-label', button.dataset.label);
}

/** First tap of a two-tap delete: the button turns into a red question for a few seconds. */
function arm(button, question) {
  for (const other of document.querySelectorAll('.del.confirming')) disarm(other);
  button.dataset.label = button.getAttribute('aria-label');
  button.classList.add('confirming');
  button.setAttribute('aria-label', `${question} Tocá de nuevo para borrar.`);
  announce('Tocá de nuevo para borrar.');
  button.disarmTimer = setTimeout(() => disarm(button), CONFIRM_MS);
}

/* ---------- Views and navigation ---------- */

function showGate(message) {
  unsay();
  panel.hidden = true;
  plist.replaceChildren();
  rows.replaceChildren();
  projects = [];
  games = [];
  current = null;
  gate.hidden = false;
  password.value = '';
  if (message) say(message, loginForm, password);
  password.focus();
}

function showPanel() {
  gate.hidden = true;
  panel.hidden = false;
}

function expired() {
  showGate(ERR_EXPIRED);
}

/** `/admin` lists the projects; `/admin/pong` opens the games of the project `pong`. */
function pathSlug() {
  const match = /^\/admin\/([^/]+)\/?$/.exec(location.pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]).toLowerCase();
  } catch {
    return null;
  }
}

function navigate(path) {
  if (location.pathname !== path) history.pushState(null, '', path);
  return route();
}

let routing = 0;

async function route({ focusRow = null } = {}) {
  const ticket = ++routing;
  unsay();
  const slug = pathSlug();
  const loaded = await loadProjects();
  if (ticket !== routing || !loaded) return;
  if (!slug) {
    showProjects({ focusRow });
    return;
  }
  const project = projects.find((entry) => entry.slug === slug);
  if (!project) {
    history.replaceState(null, '', '/admin');
    showProjects();
    say('No encontramos ese proyecto.', maker, makerTitle);
    return;
  }
  await openGames(project, ticket);
}

async function loadProjects() {
  const wait = setTimeout(() => {
    showPanel();
    showView(projectsView);
    skeleton(plist, 4);
  }, SKELETON_DELAY);
  const { status, data } = await api('GET', '/api/admin/projects');
  clearTimeout(wait);
  if (status === 401) {
    showGate();
    return false;
  }
  showPanel();
  if (status !== 200) {
    showView(projectsView);
    plist.replaceChildren();
    say(data.error || ERR_LOAD, maker, makerTitle);
    return false;
  }
  projects = Array.isArray(data.projects) ? data.projects : [];
  return true;
}

function showView(view) {
  projectsView.hidden = view !== projectsView;
  gamesView.hidden = view !== gamesView;
}

/* ---------- Projects screen ---------- */

const projectOf = (row) => projects.find((project) => project.id === row.dataset.id);

function coverOf(project) {
  const cover = el('span', 'thumb cover');
  if (project.recent?.length) {
    const img = document.createElement('img');
    img.src = thumbUrl(project.recent[0]);
    img.alt = '';
    img.width = 144;
    img.height = 108;
    img.loading = 'lazy';
    img.decoding = 'async';
    cover.append(img);
  } else {
    cover.classList.add('none');
    cover.append(icon('i-puzzle'));
  }
  return cover;
}

function buildProjectRow(project) {
  const row = el('li', 'row prow');
  row.dataset.id = project.id;

  const open = el('a', 'plink');
  open.href = `/admin/${project.slug}`;
  open.setAttribute('aria-label', `Abrir «${project.title}», ${plural(project.total, 'juego', 'juegos')}`);
  const info = el('span', 'info');
  const title = el('span', 'row-title');
  title.append(el('span', 'ptitle', project.title), icon('i-caret', 'icon caret'));
  const meta = el('span', 'row-meta pmeta');
  meta.append(el('span', 'slug', `/${project.slug}`));
  for (const grade of GRADES) {
    const tally = el('span', 'tally');
    tally.dataset.g = grade;
    tally.append(el('b', '', grade), ` ${project.counts[grade]}`);
    meta.append(' ', tally);
  }
  info.append(title, meta);
  open.append(coverOf(project), info);

  const toggle = el('button', 'switch');
  toggle.type = 'button';
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-checked', String(project.listed));
  toggle.setAttribute('aria-label', `Mostrar «${project.title}» en el inicio`);
  toggle.innerHTML = '<span class="track" aria-hidden="true"><span class="knob"></span></span>';
  toggle.append(el('span', 'switch-label', 'En el inicio'));

  const acts = el('div', 'acts');
  const copy = actButton('copy', 'i-copy', `Copiar el link de «${project.title}»`);
  const label = el('span', 'act-label', 'Copiar link');
  label.setAttribute('aria-hidden', 'true');
  copy.append(label);
  const copied = el('span', 'pill copied', 'Copiado');
  copied.setAttribute('aria-hidden', 'true');
  copy.append(copied);
  const del = actButton('del', 'i-trash', `Borrar «${project.title}»`);
  const question = project.total ? `¿Borrar con ${plural(project.total, 'juego', 'juegos')}?` : '¿Borrar?';
  const sure = el('span', 'pill sure', question);
  sure.setAttribute('aria-hidden', 'true');
  del.append(sure);
  acts.append(copy, actButton('edit', 'i-edit', `Editar «${project.title}»`), del);

  row.append(open, toggle, acts);
  return row;
}

function showProjects({ focusRow = null } = {}) {
  current = null;
  document.title = 'Panel de juegos';
  headLabel.textContent = 'Panel';
  upLink.hidden = true;
  showView(projectsView);
  const items = projects.map(buildProjectRow);
  plist.replaceChildren(...items);
  pnothing.hidden = items.length > 0;
  rise(items);
  if (focusRow) plist.querySelector(`.row[data-id="${CSS.escape(focusRow)}"] .plink`)?.focus();
}

let slugTouched = false;

makerTitle.addEventListener('input', () => {
  if (bubble.previousElementSibling === maker) unsay();
  if (!slugTouched) makerSlug.value = slugify(makerTitle.value);
});

makerSlug.addEventListener('input', () => {
  if (bubble.previousElementSibling === maker) unsay();
  tidySlugField(makerSlug);
  // An emptied slug goes back to following the title.
  slugTouched = makerSlug.value !== '';
  if (!slugTouched) makerSlug.value = slugify(makerTitle.value);
});

maker.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (maker.busy) return;
  const title = makerTitle.value.trim();
  const slug = finalSlug(makerSlug.value) || slugify(title);
  if (!title) {
    shake(maker);
    say('Escribí el nombre del proyecto.', maker, makerTitle);
    makerTitle.focus();
    return;
  }
  if (title.length > MAX_PROJECT_TITLE) {
    say(`El nombre puede tener hasta ${MAX_PROJECT_TITLE} caracteres.`, maker, makerTitle);
    return;
  }
  const problem = slugProblem(slug, null);
  if (problem) {
    shake(maker);
    say(problem, maker, makerSlug);
    makerSlug.focus();
    return;
  }

  maker.busy = true;
  const { status, data } = await api('POST', '/api/admin/projects', { title, slug });
  maker.busy = false;
  if (status === 401) return expired();
  if (status !== 201) {
    shake(maker);
    say(data.error || ERR_SAVE, maker, status === 409 || status === 400 ? makerSlug : makerTitle);
    return;
  }
  unsay();
  makerTitle.value = '';
  makerSlug.value = '';
  slugTouched = false;
  projects.unshift(data.project);
  const row = buildProjectRow(data.project);
  flip(plist, () => plist.prepend(row));
  pnothing.hidden = true;
  if (moving()) row.animate(POP, { duration: 320, easing: SPRING });
  flash(row);
  announce(`Creaste «${data.project.title}». Su link es ${location.origin}/${data.project.slug}.`);
  // The next thing a teacher does is copy the link for the bookmarks bar.
  row.querySelector('.copy').focus();
});

async function toggleListed(row, button) {
  const project = projectOf(row);
  if (!project || row.busy) return;
  const next = !project.listed;
  button.setAttribute('aria-checked', String(next));
  setBusy(row, true);
  const { status, data } = await api('PATCH', projectPath(project), { listed: next });
  setBusy(row, false);
  if (status === 401) return expired();
  if (status !== 200) {
    button.setAttribute('aria-checked', String(project.listed));
    say(data.error || ERR_SAVE, row, button);
    return;
  }
  Object.assign(project, data.project);
  announce(next ? `«${project.title}» aparece en el inicio.` : `«${project.title}» ya no aparece en el inicio.`);
}

function copyFallback(text) {
  const area = el('textarea', 'sr-only');
  area.value = text;
  area.setAttribute('readonly', '');
  document.body.append(area);
  area.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  area.remove();
  return copied;
}

async function copyLink(row, button) {
  const project = projectOf(row);
  if (!project) return;
  const url = `${location.origin}/${project.slug}`;
  let copied = false;
  try {
    await navigator.clipboard.writeText(url);
    copied = true;
  } catch {
    copied = copyFallback(url);
  }
  if (!copied) {
    say(`No se pudo copiar. El link es ${url}`, row, button, { info: true });
    return;
  }
  clearTimeout(button.doneTimer);
  button.classList.add('done');
  button.querySelector('use').setAttribute('href', '#i-check');
  announce(`Copiaste el link: ${url}`);
  button.doneTimer = setTimeout(() => {
    button.classList.remove('done');
    button.querySelector('use').setAttribute('href', '#i-copy');
  }, 1600);
}

function slugField(value) {
  const wrap = el('label', 'slug-slot field-slug');
  wrap.append(el('span', 'slug-slash', '/'), field('Dirección', value, MAX_SLUG, 'slug-input'));
  wrap.firstChild.setAttribute('aria-hidden', 'true');
  return wrap;
}

function cancelOtherEdits(except) {
  for (const row of document.querySelectorAll('.row.editing')) {
    if (row === except) continue;
    if (row.contains(bubble)) unsay();
    if (row.classList.contains('prow')) {
      const project = projectOf(row);
      if (project) row.replaceWith(buildProjectRow(project));
    } else {
      const game = gameOf(row);
      if (game) row.replaceWith(buildGameRow(game));
    }
  }
}

function startProjectEdit(row) {
  const project = projectOf(row);
  if (!project || row.busy || row.classList.contains('editing')) return;
  cancelOtherEdits(row);
  if (row.contains(bubble)) unsay();
  const title = field('Nombre del proyecto', project.title, MAX_PROJECT_TITLE);
  const slug = slugField(project.slug);
  const box = el('div', 'pedit');
  const fields = el('div', 'info');
  fields.append(title, slug);
  box.append(coverOf(project), fields);
  flip(plist, () => {
    row.classList.add('editing');
    row.querySelector('.plink').replaceWith(box);
    row.querySelector('.acts').replaceChildren(actButton('save', 'i-check', 'Guardar'), actButton('cancel', 'i-x', 'Cancelar'));
  });
  title.focus();
  title.select();
}

function endProjectEdit(row, project, { saved = false } = {}) {
  if (row.contains(bubble)) unsay();
  const fresh = buildProjectRow(project);
  flip(plist, () => row.replaceWith(fresh));
  fresh.querySelector('.edit').focus();
  if (saved) flash(fresh);
  return fresh;
}

async function saveProjectEdit(row) {
  const project = projectOf(row);
  if (!project || row.busy) return;
  const titleInput = row.querySelector('.field');
  const slugInput = row.querySelector('.slug-input');
  const title = titleInput.value.trim();
  const slug = finalSlug(slugInput.value);
  titleInput.removeAttribute('aria-invalid');
  slugInput.removeAttribute('aria-invalid');

  const slugIssue = slug === project.slug ? null : slugProblem(slug, project);
  const problem =
    (!title && ['El nombre no puede quedar vacío.', titleInput]) ||
    (title.length > MAX_PROJECT_TITLE && [`El nombre puede tener hasta ${MAX_PROJECT_TITLE} caracteres.`, titleInput]) ||
    (slugIssue && [slugIssue, slugInput]);
  if (problem) {
    const [message, input] = problem;
    input.setAttribute('aria-invalid', 'true');
    say(message, input.closest('.slug-slot') ?? input, input);
    input.focus();
    return;
  }

  const changes = {};
  if (title !== project.title) changes.title = title;
  if (slug !== project.slug) changes.slug = slug;
  if (Object.keys(changes).length === 0) {
    endProjectEdit(row, project);
    return;
  }

  setBusy(row, true);
  const { status, data } = await api('PATCH', projectPath(project), changes);
  setBusy(row, false);
  if (status === 401) return expired();
  if (status !== 200) {
    const input = status === 409 || /direcci/.test(data.error ?? '') ? slugInput : titleInput;
    say(data.error || ERR_SAVE, input.closest('.slug-slot') ?? input, input);
    return;
  }
  Object.assign(project, data.project);
  const fresh = endProjectEdit(row, project, { saved: true });
  if (changes.slug) {
    // Old bookmarks now land on the not-found page, so say it plainly.
    say(`El link ahora es /${project.slug}. Copialo de nuevo para los marcadores.`, fresh, fresh.querySelector('.copy'), {
      info: true,
    });
  } else {
    announce(`Guardaste «${project.title}».`);
  }
}

async function removeProject(row, button) {
  const project = projectOf(row);
  if (!project || row.busy) return;
  if (!button.classList.contains('confirming')) {
    arm(button, button.querySelector('.sure').textContent);
    return;
  }
  clearTimeout(button.disarmTimer);
  setBusy(row, true);
  const { status, data } = await api('DELETE', projectPath(project));
  if (status === 401) return expired();
  if (status !== 200 && status !== 404) {
    setBusy(row, false);
    disarm(button);
    say(data.error || ERR_SAVE, row, button);
    return;
  }
  projects = projects.filter((entry) => entry !== project);
  const gone = data.games ?? project.total;
  announce(gone ? `Borraste «${project.title}» y ${plural(gone, 'juego', 'juegos')}.` : `Borraste «${project.title}».`);
  removeRow(row, '.del', () => makerTitle, () => {
    pnothing.hidden = plist.children.length > 0;
  });
}

plist.addEventListener('click', (event) => {
  const row = event.target.closest('.row');
  if (!row || row.classList.contains('ghost')) return;
  const link = event.target.closest('.plink');
  if (link) {
    // Keep new-tab clicks working; a plain click stays in this page.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigate(new URL(link.href).pathname);
    return;
  }
  const button = event.target.closest('button');
  if (!button) return;
  if (button.classList.contains('switch')) toggleListed(row, button);
  else if (button.classList.contains('copy')) copyLink(row, button);
  else if (button.classList.contains('edit')) startProjectEdit(row);
  else if (button.classList.contains('save')) saveProjectEdit(row);
  else if (button.classList.contains('cancel')) endProjectEdit(row, projectOf(row));
  else if (button.classList.contains('del')) removeProject(row, button);
});

/* ---------- Games screen ---------- */

const visibleGames = () => (filter === 'all' ? games : games.filter((game) => game.grade === filter));

function gameOf(row) {
  return games.find((game) => game.id === row.dataset.id && game.grade === row.dataset.grade);
}

function moveButton(grade, game) {
  const button = el('button', 'pip');
  button.type = 'button';
  button.dataset.g = grade;
  button.dataset.move = grade;
  button.setAttribute('aria-label', `Mover «${game.title}» a ${grade}`);
  button.append(el('span', '', grade));
  return button;
}

function currentPip(grade) {
  const pip = el('span', 'pip now');
  pip.dataset.g = grade;
  const dot = el('span', '', grade);
  dot.prepend(el('span', 'sr-only', 'Está en '));
  pip.append(dot);
  return pip;
}

function buildGameRow(game) {
  const row = el('li', 'row');
  row.dataset.id = game.id;
  row.dataset.grade = game.grade;

  const link = el('a', 'thumb');
  link.href = `https://scratch.mit.edu/projects/${game.id}/`;
  link.target = '_blank';
  link.rel = 'noopener';
  link.setAttribute('aria-label', `Abrir «${game.title}» en Scratch`);
  const img = document.createElement('img');
  img.src = thumbUrl(game.id);
  img.alt = '';
  img.width = 144;
  img.height = 108;
  img.loading = 'lazy';
  img.decoding = 'async';
  link.append(img, icon('i-open', 'icon open'));

  const info = el('div', 'info');
  const title = el('span', 'row-title', game.title);
  title.title = game.title;
  const meta = el('span', 'row-meta');
  const date = el('time', 'row-date', shortDate.format(new Date(game.addedAt)));
  date.dateTime = game.addedAt;
  meta.append(el('span', 'row-name', game.name), ' · ', date);
  info.append(title, meta);

  const mover = el('div', 'mover');
  mover.setAttribute('role', 'group');
  mover.setAttribute('aria-label', 'Grado');
  for (const grade of GRADES) mover.append(grade === game.grade ? currentPip(grade) : moveButton(grade, game));

  const acts = el('div', 'acts');
  const del = actButton('del', 'i-trash', `Borrar «${game.title}»`);
  const sure = el('span', 'pill sure', '¿Seguro?');
  sure.setAttribute('aria-hidden', 'true');
  del.append(sure);
  acts.append(actButton('edit', 'i-edit', `Editar «${game.title}»`), del);

  row.append(link, info, mover, acts);
  return row;
}

function updateCounts({ pop = false } = {}) {
  const counts = { all: games.length };
  for (const grade of GRADES) counts[grade] = games.filter((game) => game.grade === grade).length;
  for (const button of filterButtons) {
    const count = button.querySelector('.count');
    const next = String(counts[button.dataset.f]);
    if (count.textContent === next) continue;
    count.textContent = next;
    if (pop && moving()) {
      count.animate([{ transform: 'scale(1.35)' }, { transform: 'none' }], { duration: 320, easing: SPRING });
    }
  }
}

function showNothing() {
  const empty = rows.children.length === 0;
  nothing.hidden = !empty;
  if (empty) nothingText.textContent = filter === 'all' ? 'Todavía no hay juegos.' : `No hay juegos en ${filter}.`;
}

function renderGames({ stagger = false } = {}) {
  unsay();
  const items = visibleGames().map(buildGameRow);
  rows.replaceChildren(...items);
  showNothing();
  updateCounts();
  if (stagger) rise(items);
}

function setFilter(next) {
  filter = next;
  for (const button of filterButtons) button.setAttribute('aria-pressed', String(button.dataset.f === next));
}

async function openGames(project, ticket) {
  current = project;
  games = [];
  setFilter('all');
  document.title = `${project.title} · Panel`;
  headLabel.textContent = project.title;
  upLink.hidden = false;
  showView(gamesView);
  rows.replaceChildren();
  nothing.hidden = true;
  updateCounts();
  const wait = setTimeout(() => skeleton(rows, 6), SKELETON_DELAY);
  const { status, data } = await api('GET', `${projectPath(project)}/games`);
  clearTimeout(wait);
  if (ticket !== routing) return;
  if (status === 401) return expired();
  if (status !== 200) {
    rows.replaceChildren();
    say(data.error || ERR_LOAD, filtersBox, filterButtons[0]);
    return;
  }
  games = Array.isArray(data.games) ? data.games : [];
  renderGames({ stagger: true });
  head.focus({ preventScroll: true });
}

async function move(row, target) {
  const game = gameOf(row);
  if (!game || row.busy) return;
  if (row.contains(bubble)) unsay();
  setBusy(row, true);
  const { status, data } = await api('PATCH', gamePath(game), { grade: target });
  setBusy(row, false);
  if (status === 401) return expired();
  if (status !== 200) {
    say(data.error || ERR_SAVE, row, row.querySelector(`[data-move="${target}"]`) || row);
    return;
  }

  const from = game.grade;
  Object.assign(game, data.game);
  updateCounts({ pop: true });
  announce(`«${game.title}» ahora está en ${target}.`);

  if (filter !== 'all') {
    removeRow(row, '.pip[data-move]', () => filterButtons.find((b) => b.dataset.f === filter), showNothing);
    return;
  }
  const fresh = buildGameRow(game);
  row.replaceWith(fresh);
  // Focus the way back, so an accidental move is one keypress away from undone.
  fresh.querySelector(`[data-move="${from}"]`).focus();
  if (moving()) {
    fresh.querySelector('.pip.now span').animate([{ transform: 'scale(.4)' }, { transform: 'none' }], {
      duration: 320,
      easing: SPRING,
    });
  }
  flash(fresh);
}

function startGameEdit(row) {
  const game = gameOf(row);
  if (!game || row.busy || row.classList.contains('editing')) return;
  cancelOtherEdits(row);
  if (row.contains(bubble)) unsay();
  const title = field('Título', game.title, MAX_TEXT);
  const name = field('Nombre', game.name, MAX_TEXT);
  flip(rows, () => {
    row.classList.add('editing');
    row.querySelector('.info').replaceChildren(title, name);
    row.querySelector('.acts').replaceChildren(actButton('save', 'i-check', 'Guardar'), actButton('cancel', 'i-x', 'Cancelar'));
  });
  title.focus();
  title.select();
}

function endGameEdit(row, game, { saved = false } = {}) {
  if (row.contains(bubble)) unsay();
  const fresh = buildGameRow(game);
  flip(rows, () => row.replaceWith(fresh));
  fresh.querySelector('.edit').focus();
  if (saved) flash(fresh);
}

async function saveGameEdit(row) {
  const game = gameOf(row);
  if (!game || row.busy) return;
  const [titleInput, nameInput] = row.querySelectorAll('.field');
  const title = titleInput.value.trim();
  const name = nameInput.value.trim();

  const problem =
    (!title && ['El título no puede quedar vacío.', titleInput]) ||
    (!name && ['El nombre no puede quedar vacío.', nameInput]) ||
    (title.length > MAX_TEXT && [`El título puede tener hasta ${MAX_TEXT} caracteres.`, titleInput]) ||
    (name.length > MAX_TEXT && [`El nombre puede tener hasta ${MAX_TEXT} caracteres.`, nameInput]);
  titleInput.removeAttribute('aria-invalid');
  nameInput.removeAttribute('aria-invalid');
  if (problem) {
    const [message, input] = problem;
    input.setAttribute('aria-invalid', 'true');
    say(message, input, input);
    input.focus();
    return;
  }

  const changes = {};
  if (title !== game.title) changes.title = title;
  if (name !== game.name) changes.name = name;
  if (Object.keys(changes).length === 0) {
    endGameEdit(row, game);
    return;
  }

  setBusy(row, true);
  const { status, data } = await api('PATCH', gamePath(game), changes);
  setBusy(row, false);
  if (status === 401) return expired();
  if (status !== 200) {
    say(data.error || ERR_SAVE, row, titleInput);
    return;
  }
  Object.assign(game, data.game);
  endGameEdit(row, game, { saved: true });
  announce(`Guardaste «${game.title}».`);
}

async function removeGame(row, button) {
  const game = gameOf(row);
  if (!game || row.busy) return;
  if (!button.classList.contains('confirming')) {
    arm(button, '¿Seguro?');
    return;
  }
  clearTimeout(button.disarmTimer);
  setBusy(row, true);
  const { status, data } = await api('DELETE', gamePath(game));
  if (status === 401) return expired();
  // 404 means it was already gone, which is what the teacher wanted.
  if (status !== 200 && status !== 404) {
    setBusy(row, false);
    disarm(button);
    say(data.error || ERR_SAVE, row, button);
    return;
  }
  games = games.filter((entry) => entry !== game);
  updateCounts({ pop: true });
  announce(`Borraste «${game.title}».`);
  removeRow(row, '.del', () => filterButtons.find((b) => b.dataset.f === filter), showNothing);
}

rows.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  const row = button?.closest('.row');
  if (!row || row.classList.contains('ghost')) return;
  if (button.dataset.move) move(row, button.dataset.move);
  else if (button.classList.contains('edit')) startGameEdit(row);
  else if (button.classList.contains('save')) saveGameEdit(row);
  else if (button.classList.contains('cancel')) endGameEdit(row, gameOf(row));
  else if (button.classList.contains('del')) removeGame(row, button);
});

for (const button of filterButtons) {
  button.addEventListener('click', () => {
    if (button.dataset.f === filter) return;
    setFilter(button.dataset.f);
    renderGames({ stagger: true });
  });
}

/* ---------- Keyboard and typing in both lists ---------- */

for (const list of [plist, rows]) {
  list.addEventListener('keydown', (event) => {
    const row = event.target.closest('.row');
    if (!row) return;
    const project = row.classList.contains('prow');
    if (event.target.matches('.field, .slug-input')) {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (project) saveProjectEdit(row);
        else saveGameEdit(row);
      } else if (event.key === 'Escape' && !row.busy) {
        event.preventDefault();
        if (project) endProjectEdit(row, projectOf(row));
        else endGameEdit(row, gameOf(row));
      }
    } else if (event.key === 'Escape' && event.target.classList.contains('confirming')) {
      disarm(event.target);
    }
  });

  list.addEventListener('input', (event) => {
    if (event.target.classList.contains('slug-input')) tidySlugField(event.target);
    if (!event.target.matches('.field, .slug-input')) return;
    event.target.removeAttribute('aria-invalid');
    if (event.target.closest('.row').contains(bubble)) unsay();
  });
}

/* ---------- Session ---------- */

let entering = false;

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (entering) return;
  if (!password.value) {
    shake(loginForm);
    password.focus();
    return;
  }
  entering = true;
  enterButton.setAttribute('aria-disabled', 'true');
  const { status, data } = await api('POST', '/api/admin/login', { password: password.value });
  entering = false;
  enterButton.removeAttribute('aria-disabled');
  if (status !== 200) {
    shake(loginForm);
    say(data.error || ERR_OFFLINE, loginForm, password);
    password.select();
    return;
  }
  password.value = '';
  await route();
  if (!panel.hidden) {
    head.focus({ preventScroll: true });
    announce('Entraste al panel.');
  }
});

password.addEventListener('input', unsay);

outButton.addEventListener('click', async () => {
  await api('POST', '/api/admin/logout');
  showGate();
  announce('Saliste del panel.');
});

upLink.addEventListener('click', (event) => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  const from = current?.id ?? null;
  if (location.pathname !== '/admin') history.pushState(null, '', '/admin');
  route({ focusRow: from });
});

window.addEventListener('popstate', () => route());

/* ---------- Start ---------- */

addShape(loginForm);
addShape(head);
addShape(maker);
addShape(bubble);
if (location.pathname.endsWith('/')) {
  history.replaceState(null, '', location.pathname.replace(/\/+$/, '') || '/admin');
}
route();
