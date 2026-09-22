const GRADES = ['4N', '4F', '4S'];
const NS = 'http://www.w3.org/2000/svg';
const SPRING = 'cubic-bezier(.34, 1.56, .64, 1)';
const SETTLE = 'cubic-bezier(.2, .7, .4, 1)';
const CONFIRM_MS = 3000;
const SKELETON_DELAY = 150;
const MAX_TEXT = 120;

const ERR_OFFLINE = 'No hay conexión. Probá de nuevo.';
const ERR_SAVE = 'No se pudo guardar. Probá de nuevo.';
const ERR_LOAD = 'No se pudieron cargar los juegos. Recargá la página.';
const ERR_EXPIRED = 'Tu sesión se cerró. Entrá de nuevo.';

const gate = document.querySelector('.gate');
const loginForm = gate.querySelector('.login');
const password = loginForm.querySelector('.slot');
const enterButton = loginForm.querySelector('.enter');
const panel = document.querySelector('.panel');
const head = panel.querySelector('.head');
const outButton = panel.querySelector('.out');
const filtersBox = panel.querySelector('.filters');
const filterButtons = [...filtersBox.querySelectorAll('.filter')];
const sheet = panel.querySelector('.sheet');
const rows = sheet.querySelector('.rows');
const nothing = sheet.querySelector('.nothing');
const nothingText = nothing.querySelector('.nothing-text');
const bubble = document.querySelector('.say');
const bubbleText = bubble.querySelector('.say-text');
const live = document.getElementById('live');

const motionOk = matchMedia('(prefers-reduced-motion: no-preference)');
const moving = () => motionOk.matches;
const shortDate = new Intl.DateTimeFormat('es-AR', { dateStyle: 'short' });

/** Every game, newest first, exactly as the server last confirmed it. */
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
function layoutLeft(el) {
  let x = 0;
  for (let node = el; node; node = node.offsetParent) x += node.offsetLeft;
  return x;
}

let tailTarget = null;

function draw(el, w, h) {
  if (!w || !h) return;
  let d;
  if (el === bubble) {
    const aim = tailTarget ? layoutLeft(tailTarget) + Math.min(tailTarget.offsetWidth / 2, 20) : 0;
    const tip = Math.min(Math.max(aim - layoutLeft(bubble), 24), w - 48);
    d = bubblePath(w, h, tip + 6);
    bubble.style.transformOrigin = `${tip}px -18px`;
  } else {
    const s = parseFloat(getComputedStyle(el).getPropertyValue('--s')) || 1;
    d = blockPath(w, h, s, { hat: el.classList.contains('hat'), notch: el.classList.contains('cmd') });
  }
  el.querySelector(':scope > .shape .body').setAttribute('d', d);
}

const shapes = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const box = entry.borderBoxSize?.[0];
    draw(entry.target, box ? box.inlineSize : entry.target.offsetWidth, box ? box.blockSize : entry.target.offsetHeight);
  }
});

function addShape(el) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'shape');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('class', 'body');
  svg.append(path);
  el.prepend(svg);
  shapes.observe(el);
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

const gamePath = (game) => `/api/admin/games/${game.grade}/${game.id}`;
const thumbUrl = (id) => `https://cdn2.scratch.mit.edu/get_image/project/${id}_144x108.png`;

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

/** Applies a change that moves rows, then glides each visible row from where it was (FLIP). */
function flip(change) {
  if (!moving()) return change();
  const tracked = [...rows.children].filter(onScreen);
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

/* ---------- Say bubble ---------- */

/** Shows `message` under `place` (inside it when it is a row) with the tail aimed at `target`. */
function say(message, place, target) {
  const inRow = place.classList.contains('row');
  const change = () => {
    if (inRow) place.append(bubble);
    else place.after(bubble);
    bubbleText.textContent = message;
    tailTarget = target;
    bubble.hidden = false;
    bubble.classList.remove('end');
    if (inRow) {
      const rowBox = place.getBoundingClientRect();
      const aim = target.getBoundingClientRect();
      if (aim.left + aim.width / 2 - rowBox.left > rowBox.width * 0.55) bubble.classList.add('end');
    }
  };
  flip(change);
  draw(bubble, bubble.offsetWidth, bubble.offsetHeight);
  announce(message);
  if (moving()) bubble.animate(POP, { duration: 300, easing: SPRING });
}

function unsay() {
  if (bubble.hidden) return;
  flip(() => {
    bubble.hidden = true;
    tailTarget = null;
  });
}

/* ---------- Views ---------- */

function showGate(message) {
  unsay();
  panel.hidden = true;
  rows.replaceChildren();
  games = [];
  gate.hidden = false;
  password.value = '';
  if (message) say(message, loginForm, password);
  password.focus();
}

function showPanel() {
  unsay();
  gate.hidden = true;
  panel.hidden = false;
}

function expired() {
  showGate(ERR_EXPIRED);
}

/* ---------- List ---------- */

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

function actButton(className, iconId, label) {
  const button = el('button', `act ${className}`);
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.append(icon(iconId));
  return button;
}

function buildRow(game) {
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
  const sure = el('span', 'sure', '¿Seguro?');
  sure.setAttribute('aria-hidden', 'true');
  del.append(sure);
  acts.append(actButton('edit', 'i-edit', `Editar «${game.title}»`), del);

  row.append(link, info, mover, acts);
  return row;
}

function renderSkeleton() {
  const ghosts = Array.from({ length: 6 }, () => {
    const row = el('li', 'row ghost');
    row.setAttribute('aria-hidden', 'true');
    row.innerHTML =
      '<span class="thumb"><span class="sheen"></span></span>' +
      '<span class="info"><span class="line long"><span class="sheen"></span></span>' +
      '<span class="line short"><span class="sheen"></span></span></span>';
    return row;
  });
  nothing.hidden = true;
  rows.replaceChildren(...ghosts);
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

function render({ stagger = false } = {}) {
  unsay();
  const items = visibleGames().map(buildRow);
  rows.replaceChildren(...items);
  showNothing();
  updateCounts();
  if (!stagger || !moving()) return;
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

async function load() {
  sheet.setAttribute('aria-busy', 'true');
  const skeleton = setTimeout(() => {
    showPanel();
    renderSkeleton();
  }, SKELETON_DELAY);
  const { status, data } = await api('GET', '/api/admin/games');
  clearTimeout(skeleton);
  sheet.setAttribute('aria-busy', 'false');
  if (status === 401) {
    showGate();
    return false;
  }
  showPanel();
  if (status !== 200) {
    games = [];
    rows.replaceChildren();
    updateCounts();
    say(data.error || ERR_LOAD, filtersBox, filterButtons[0]);
    return false;
  }
  games = Array.isArray(data.games) ? data.games : [];
  render({ stagger: true });
  return true;
}

/** Removes a row with a slide, closes the gap smoothly and keeps keyboard focus nearby. */
function removeRow(row, focusSelector) {
  const neighbor = row.nextElementSibling || row.previousElementSibling;
  const hadFocus = row.contains(document.activeElement);
  const finish = () => {
    flip(() => row.remove());
    showNothing();
    if (!hadFocus) return;
    const target = neighbor?.isConnected && neighbor.querySelector(focusSelector);
    (target || filterButtons.find((button) => button.dataset.f === filter)).focus();
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

/* ---------- Row actions ---------- */

function setBusy(row, busy) {
  row.busy = busy;
  row.classList.toggle('busy', busy);
  row.setAttribute('aria-busy', String(busy));
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
    removeRow(row, '.pip[data-move]');
    return;
  }
  const fresh = buildRow(game);
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

function field(label, value) {
  const input = el('input', 'field');
  input.type = 'text';
  input.value = value;
  input.maxLength = MAX_TEXT;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-label', label);
  return input;
}

function cancelOtherEdits(except) {
  for (const row of rows.querySelectorAll('.row.editing')) {
    if (row === except) continue;
    if (row.contains(bubble)) unsay();
    const game = gameOf(row);
    if (game) row.replaceWith(buildRow(game));
  }
}

function startEdit(row) {
  const game = gameOf(row);
  if (!game || row.busy || row.classList.contains('editing')) return;
  cancelOtherEdits(row);
  if (row.contains(bubble)) unsay();
  const title = field('Título', game.title);
  const name = field('Nombre', game.name);
  const acts = row.querySelector('.acts');
  flip(() => {
    row.classList.add('editing');
    row.querySelector('.info').replaceChildren(title, name);
    acts.replaceChildren(actButton('save', 'i-check', 'Guardar'), actButton('cancel', 'i-x', 'Cancelar'));
  });
  title.focus();
  title.select();
}

function endEdit(row, game, { saved = false } = {}) {
  if (row.contains(bubble)) unsay();
  const fresh = buildRow(game);
  flip(() => row.replaceWith(fresh));
  fresh.querySelector('.edit').focus();
  if (saved) flash(fresh);
}

async function saveEdit(row) {
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
    endEdit(row, game);
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
  endEdit(row, game, { saved: true });
  announce(`Guardaste «${game.title}».`);
}

function disarm(button) {
  clearTimeout(button.disarmTimer);
  if (!button.classList.contains('confirming')) return;
  button.classList.remove('confirming');
  button.setAttribute('aria-label', button.dataset.label);
}

function arm(button, game) {
  button.dataset.label = button.getAttribute('aria-label');
  button.classList.add('confirming');
  button.setAttribute('aria-label', `¿Seguro? Tocá de nuevo para borrar «${game.title}»`);
  announce('Tocá de nuevo para borrar.');
  button.disarmTimer = setTimeout(() => disarm(button), CONFIRM_MS);
}

async function remove(row, button) {
  const game = gameOf(row);
  if (!game || row.busy) return;
  if (!button.classList.contains('confirming')) {
    for (const other of rows.querySelectorAll('.del.confirming')) disarm(other);
    arm(button, game);
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
  removeRow(row, '.del');
}

rows.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  const row = button?.closest('.row');
  if (!row || row.classList.contains('ghost')) return;
  if (button.dataset.move) move(row, button.dataset.move);
  else if (button.classList.contains('edit')) startEdit(row);
  else if (button.classList.contains('save')) saveEdit(row);
  else if (button.classList.contains('cancel')) endEdit(row, gameOf(row));
  else if (button.classList.contains('del')) remove(row, button);
});

rows.addEventListener('keydown', (event) => {
  const row = event.target.closest('.row');
  if (!row) return;
  if (event.target.classList.contains('field')) {
    if (event.key === 'Enter') {
      event.preventDefault();
      saveEdit(row);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (!row.busy) endEdit(row, gameOf(row));
    }
  } else if (event.key === 'Escape' && event.target.classList.contains('confirming')) {
    disarm(event.target);
  }
});

rows.addEventListener('input', (event) => {
  if (!event.target.classList.contains('field')) return;
  event.target.removeAttribute('aria-invalid');
  if (event.target.closest('.row').contains(bubble)) unsay();
});

/* ---------- Filters and session ---------- */

for (const button of filterButtons) {
  button.addEventListener('click', () => {
    if (button.dataset.f === filter) return;
    filter = button.dataset.f;
    for (const other of filterButtons) other.setAttribute('aria-pressed', String(other === button));
    render({ stagger: true });
  });
}

let entering = false;

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (entering) return;
  if (!password.value) {
    if (moving()) loginForm.animate(SHAKE, { duration: 420, easing: 'ease-out' });
    password.focus();
    return;
  }
  entering = true;
  enterButton.setAttribute('aria-disabled', 'true');
  const { status, data } = await api('POST', '/api/admin/login', { password: password.value });
  entering = false;
  enterButton.removeAttribute('aria-disabled');
  if (status !== 200) {
    if (moving()) loginForm.animate(SHAKE, { duration: 420, easing: 'ease-out' });
    say(data.error || ERR_OFFLINE, loginForm, password);
    password.select();
    return;
  }
  password.value = '';
  if (await load()) {
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

/* ---------- Start ---------- */

addShape(loginForm);
addShape(head);
addShape(bubble);
load();
