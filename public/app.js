const GRADES = ['4N', '4F', '4S'];
const STORAGE_KEY = 'grade';
const NS = 'http://www.w3.org/2000/svg';

const SPRING = 'cubic-bezier(.34, 1.56, .64, 1)';
const FALL = 'cubic-bezier(.55, 0, .9, .45)';
const SETTLE = 'cubic-bezier(.2, .7, .4, 1)';
const SKELETON_DELAY = 150;
const STAGGER = 35;
const STAGGER_CAP = 12;
const GRAVITY = 1700;
// Scratch 3 category colors, one per confetti piece in turn.
const CONFETTI = ['#4c97ff', '#9966ff', '#cf63cf', '#ffab19', '#ffbf00', '#5cb1d6', '#59c059', '#ff8c1a', '#ff6680'];

const root = document.documentElement;
const home = document.querySelector('.home');
const shelf = home.querySelector('.projects');
const homeEmpty = home.querySelector('.home-empty');
const missing = document.querySelector('.missing');
const lostHat = missing.querySelector('.lost');
const note = missing.querySelector('.note');
const crumbs = [...document.querySelectorAll('.crumb')];
const landing = document.querySelector('.landing');
const picks = [...landing.querySelectorAll('.pick')];
const board = document.querySelector('.board');
const palette = board.querySelector('.palette');
const chips = [...palette.querySelectorAll('.chip')];
const stack = board.querySelector('.stack');
const hat = stack.querySelector('.head');
const hatLabel = hat.querySelector('.hat-label');
const form = stack.querySelector('.add');
const lead = form.querySelector('.lead');
const peek = form.querySelector('.peek');
const input = form.querySelector('.slot');
const submit = form.querySelector('.go');
const bubble = board.querySelector('.say');
const bubbleText = bubble.querySelector('.say-text');
const games = board.querySelector('.games');
const grid = games.querySelector('.grid');
const live = document.getElementById('live');
const favicon = document.querySelector('link[rel="icon"]');
const themeColors = document.querySelectorAll('meta[name="theme-color"]');

const motionOk = matchMedia('(prefers-reduced-motion: no-preference)');
const moving = () => motionOk.matches;

/* ---------- Scratch block geometry ---------- */

// Outline pieces from scratch-blocks (vertical renderer) in 1x units.
const CAP = 'c 25,-22 71,-22 96,0';
const NOTCH = 'c 2,0 3,1 4,2 l 4,4 c 1,1 2,2 4,2 h 12 c 2,0 3,-1 4,-2 l 4,-4 c 1,-1 2,-2 4,-2';
const BUMP = 'c -2,0 -3,1 -4,2 l -4,4 c -1,1 -2,2 -4,2 h -12 c -2,0 -3,-1 -4,-2 l -4,-4 c -1,-1 -2,-2 -4,-2';

const r2 = (n) => Math.round(n * 100) / 100;
const scaled = (d, s) => d.replace(/-?\d+(?:\.\d+)?/g, (n) => String(r2(n * s)));

/** Outline of a hat or command block whose body is `w` x `h` px, at scale `s`. */
function blockPath(w, h, s, { hat = false, notch = false, bump = true } = {}) {
  const r = r2(4 * s);
  let d = hat ? `M0,0 ${scaled(CAP, s)}` : `M0,${r} a${r},${r} 0 0 1 ${r},${-r}`;
  if (!hat && notch) d += ` H${r2(12 * s)} ${scaled(NOTCH, s)}`;
  d += ` H${r2(w - r)} a${r},${r} 0 0 1 ${r},${r} V${r2(h - r)} a${r},${r} 0 0 1 ${-r},${r}`;
  if (bump) d += ` H${r2(48 * s)} ${scaled(BUMP, s)}`;
  return `${d} H${r} a${r},${r} 0 0 1 ${-r},${-r} Z`;
}

const TAIL_TIP = 6; // how far left of `tx` the tail's tip lands, in px

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

const outlines = new Map();

function draw(el, w, h) {
  if (!w || !h) return;
  let d;
  if (el === bubble) {
    // Aim the tip 16px inside the input. Offsets ignore transforms, so a pop or shake cannot skew it.
    const inputLeft = stack.offsetLeft + form.offsetLeft + input.offsetLeft;
    const tip = Math.min(Math.max(inputLeft + 16 - bubble.offsetLeft, 24), w - 48);
    d = bubblePath(w, h, tip + TAIL_TIP);
    bubble.style.transformOrigin = `${tip}px -18px`;
  } else if (el === note) {
    d = bubblePath(w, h, 44 + TAIL_TIP);
  } else {
    const s = parseFloat(getComputedStyle(el).getPropertyValue('--s')) || 1;
    d = blockPath(w, h, s, { hat: el.classList.contains('hat'), notch: el.classList.contains('cmd') });
  }
  for (const path of el.querySelector(':scope > .shape').children) path.setAttribute('d', d);
  outlines.set(el, d);
}

// One glow outline behind the whole stack, so the seam between blocks stays clean.
const glow = document.createElementNS(NS, 'svg');
glow.setAttribute('class', 'glow');
glow.setAttribute('aria-hidden', 'true');
glow.append(document.createElementNS(NS, 'path'), document.createElementNS(NS, 'path'));
stack.prepend(glow);

function drawGlow() {
  [hat, form].forEach((el, i) => {
    const d = outlines.get(el);
    if (!d) return;
    glow.children[i].setAttribute('d', d);
    glow.children[i].setAttribute('transform', `translate(${el.offsetLeft} ${el.offsetTop})`);
  });
}

// Shapes are redrawn whenever a block resizes, so fluid blocks stay exact.
const shapes = new ResizeObserver((entries) => {
  let stackChanged = false;
  for (const entry of entries) {
    const box = entry.borderBoxSize?.[0];
    const el = entry.target;
    draw(el, box ? box.inlineSize : el.offsetWidth, box ? box.blockSize : el.offsetHeight);
    if (el === hat || el === form) stackChanged = true;
  }
  if (stackChanged) {
    drawGlow();
    // The input may have moved under a bubble that kept its size.
    if (!bubble.hidden) draw(bubble, bubble.offsetWidth, bubble.offsetHeight);
  }
});

function addShape(el, layers) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'shape');
  svg.setAttribute('aria-hidden', 'true');
  for (const layer of layers) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('class', layer);
    svg.append(path);
  }
  el.prepend(svg);
  shapes.observe(el);
}

/* ---------- Motion ---------- */

const LAND = [
  { transform: 'translateY(-170px)', opacity: 0, easing: FALL },
  { offset: 0.18, opacity: 1 },
  { offset: 0.5, transform: 'translateY(0) scale(1.07, .9)', easing: SETTLE },
  { offset: 0.72, transform: 'translateY(-12px) scale(.98, 1.03)', easing: 'ease-in' },
  { offset: 0.87, transform: 'translateY(0) scale(1.02, .98)', easing: 'ease-out' },
  { transform: 'none', opacity: 1 },
];

const HAT_DROP = [
  { transform: 'translateY(-80px) rotate(-5deg)', opacity: 0, easing: FALL },
  { offset: 0.15, opacity: 1 },
  { offset: 0.55, transform: 'translateY(0) rotate(0) scale(1.05, .93)', easing: SETTLE },
  { offset: 0.8, transform: 'translateY(-5px) scale(.99, 1.02)', easing: 'ease-in-out' },
  { transform: 'none', opacity: 1 },
];

const POP_OFF = [
  { transform: 'none', opacity: 1 },
  { offset: 0.25, transform: 'translate(8px, -18px) rotate(4deg)', opacity: 1 },
  { transform: 'translate(84px, -76px) rotate(16deg)', opacity: 0 },
];

const SNAP = [
  { transform: 'translate(22px, 34px) rotate(2deg)', opacity: 0, easing: 'cubic-bezier(.2, .9, .3, 1)' },
  { offset: 0.6, transform: 'translate(0, 3px) rotate(0)', opacity: 1, easing: 'ease-out' },
  { transform: 'none', opacity: 1 },
];

const RISE = [
  { transform: 'translateY(18px) scale(.96)', opacity: 0 },
  { transform: 'none', opacity: 1 },
];

const DROP_CARD = [
  { transform: 'translateY(-60px) rotate(-4deg) scale(.9)', opacity: 0 },
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

const POP = [
  { transform: 'scale(.3)', opacity: 0 },
  { transform: 'none', opacity: 1 },
];

const COLOR_TOKENS = ['--fill', '--edge', '--deep', '--on', '--on-deep', '--slot-edge'];

function colorsOf(el) {
  const style = getComputedStyle(el);
  return Object.fromEntries(COLOR_TOKENS.map((token) => [token, style.getPropertyValue(token).trim()]));
}

/** Keyframes that walk the block colors around the hue wheel instead of through gray. */
function colorShift(from, to) {
  const middle = {};
  for (const token of COLOR_TOKENS) middle[token] = `color-mix(in oklch, ${from[token]}, ${to[token]})`;
  return [from, middle, to];
}

function burst(card) {
  const rect = card.getBoundingClientRect();
  const layer = document.createElement('span');
  layer.className = 'confetti';
  layer.setAttribute('aria-hidden', 'true');
  layer.style.left = `${rect.left + rect.width / 2}px`;
  layer.style.top = `${rect.top + (rect.width * 3) / 8}px`;
  document.body.append(layer);

  const runs = [];
  for (let i = 0; i < 30; i++) {
    const bit = document.createElement('i');
    bit.style.background = CONFETTI[i % CONFETTI.length];
    layer.append(bit);
    const angle = ((-90 + (Math.random() * 2 - 1) * 58) * Math.PI) / 180;
    const speed = 380 + Math.random() * 340;
    const vx = Math.cos(angle) * speed;
    const vy = Math.sin(angle) * speed;
    const spin = (Math.random() * 2 - 1) * 900;
    const life = 0.8 + Math.random() * 0.3;
    const frames = [];
    for (let k = 0; k <= 8; k++) {
      const t = (life * k) / 8;
      frames.push({
        transform: `translate(${r2(vx * t)}px, ${r2(vy * t + (GRAVITY * t * t) / 2)}px) rotate(${r2(spin * t)}deg) scale(${k ? 1 : 0.4})`,
        opacity: k < 6 ? 1 : (8 - k) / 2.5,
      });
    }
    runs.push(bit.animate(frames, { duration: life * 1000, easing: 'linear', fill: 'forwards' }).finished);
  }
  Promise.allSettled(runs).then(() => layer.remove());
}

/* ---------- Grade ---------- */

/** The project this page belongs to: `{ slug, title, listed }`, or null on the home. */
let project = null;
let grade = null;
let introUntil = 0;
let hatDrop = null;

function paintChrome(next) {
  const colors = colorsOf(chips.find((chip) => chip.dataset.g === next));
  const svg =
    `<svg xmlns="${NS}" viewBox="-4 -34.25 108 108"><path d="${blockPath(100, 48, 1, { hat: true })}" ` +
    `fill="${colors['--fill']}" stroke="${colors['--edge']}" stroke-width="4"/></svg>`;
  favicon.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  for (const meta of themeColors) meta.content = colors['--fill'];
}

function setGrade(next) {
  grade = next;
  root.dataset.grade = next;
  board.dataset.g = next;
  hat.dataset.g = next;
  form.dataset.g = next;
  hatLabel.textContent = next;
  for (const chip of chips) chip.setAttribute('aria-pressed', String(chip.dataset.g === next));
  document.title = `${project.title} · ${next}`;
  paintChrome(next);
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* storage unavailable: the choice just will not persist */
  }
}

function showLanding() {
  landing.hidden = false;
  document.title = project.title;
  if (!moving()) return;
  picks.forEach((pick, i) => {
    pick.animate(LAND, { duration: 780, delay: 120 + i * 120, fill: 'backwards' });
  });
}

function showBoard(next) {
  board.hidden = false;
  setGrade(next);
  if (moving()) {
    introUntil = performance.now() + 680;
    hat.animate(HAT_DROP, { duration: 600, delay: 60, fill: 'backwards' });
    form.animate(SNAP, { duration: 420, delay: 400, fill: 'backwards' });
    palette.animate(RISE, { duration: 360, delay: 220, easing: SETTLE, fill: 'backwards' });
  }
  load(next, { stagger: true });
}

let picked = false;

function pick(event) {
  // The landing is one-shot; ignore a second tap while it morphs away.
  if (picked) return;
  picked = true;
  const next = event.currentTarget.dataset.g;
  const enter = () => {
    landing.hidden = true;
    board.hidden = false;
    setGrade(next);
    hat.focus({ preventScroll: true });
    load(next, { stagger: true });
  };
  if (!document.startViewTransition || !moving()) {
    enter();
    return;
  }
  // The chosen hat morphs into the board's hat.
  const chosen = event.currentTarget;
  chosen.style.viewTransitionName = 'hat';
  introUntil = performance.now() + 560;
  document.startViewTransition(enter).finished.finally(() => {
    chosen.style.viewTransitionName = '';
  });
}

function popHat(prev) {
  const ghost = hat.cloneNode(true);
  ghost.classList.replace('head', 'ghost-hat');
  ghost.removeAttribute('tabindex');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.dataset.g = prev;
  ghost.style.left = `${hat.offsetLeft}px`;
  ghost.style.top = `${hat.offsetTop}px`;
  ghost.style.width = `${hat.offsetWidth}px`;
  stack.append(ghost);
  ghost
    .animate(POP_OFF, { duration: 300, easing: 'cubic-bezier(.3, 0, .8, .45)', fill: 'forwards' })
    .finished.finally(() => ghost.remove());
}

function switchGrade(next) {
  if (next === grade) {
    // Tapping the current grade retries a list that failed to load.
    if (bubble.dataset.kind === 'load') load(grade);
    return;
  }
  const prev = grade;
  const before = colorsOf(form);
  if (moving()) popHat(prev);
  setGrade(next);
  unsay();
  if (moving()) {
    hatDrop?.cancel();
    hatDrop = hat.animate(HAT_DROP, { duration: 560, delay: 170, fill: 'backwards' });
    form.animate(colorShift(before, colorsOf(form)), {
      duration: 420,
      delay: 120,
      easing: 'ease-in-out',
      fill: 'backwards',
    });
  }
  load(next, { stagger: true });
}

/* ---------- Games list ---------- */

let loading = null;
let skeletonTimer = 0;

const thumb = (id, w, h) => `https://cdn2.scratch.mit.edu/get_image/project/${id}_${w}x${h}.png`;

function buildCard(game) {
  const card = document.createElement('li');
  card.className = 'card';
  card.dataset.id = game.id;

  const stage = document.createElement('a');
  stage.className = 'stage';
  stage.href = `https://scratch.mit.edu/projects/${game.id}/fullscreen`;
  stage.target = '_blank';
  stage.rel = 'noopener';
  stage.setAttribute('aria-label', game.name ? `${game.title} de ${game.name}` : game.title);

  const frame = document.createElement('span');
  frame.className = 'frame';
  const img = document.createElement('img');
  img.src = thumb(game.id, 480, 360);
  img.alt = '';
  img.width = 480;
  img.height = 360;
  img.loading = 'lazy';
  img.decoding = 'async';
  const flag = document.createElement('span');
  flag.className = 'flag';
  flag.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-flag"/></svg>';
  frame.append(img, flag);

  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = game.title;
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = game.name;

  stage.append(frame, title, name);
  card.append(stage);
  return card;
}

function emptySlot() {
  const slot = document.createElement('li');
  slot.className = 'card empty';
  slot.innerHTML =
    '<span class="frame"><svg class="icon" aria-hidden="true"><use href="#i-up"/></svg></span>' +
    '<span class="sr-only">Todavía no hay juegos. Pegá el primero.</span>';
  return slot;
}

function renderSkeleton() {
  grid.classList.remove('stale');
  const slots = Array.from({ length: 8 }, () => {
    const slot = document.createElement('li');
    slot.className = 'card ghost';
    slot.setAttribute('aria-hidden', 'true');
    slot.innerHTML = '<span class="frame"><span class="sheen"></span></span>';
    return slot;
  });
  grid.replaceChildren(...slots);
}

function render(list, stagger) {
  grid.classList.remove('stale');
  if (list.length === 0) {
    grid.replaceChildren(emptySlot());
    return;
  }
  const cards = list.map(buildCard);
  grid.replaceChildren(...cards);
  if (!stagger || !moving()) return;
  const start = Math.max(0, introUntil - performance.now());
  cards.forEach((card, i) => {
    card.animate(RISE, {
      duration: 380,
      delay: start + Math.min(i, STAGGER_CAP) * STAGGER,
      easing: SPRING,
      fill: 'backwards',
    });
  });
}

/** Fetches and renders a grade. `quiet` keeps the current cards on screen while it reloads. */
async function load(g, { stagger = false, quiet = false } = {}) {
  loading?.abort();
  const request = new AbortController();
  loading = request;
  clearTimeout(skeletonTimer);
  games.setAttribute('aria-busy', 'true');
  if (!quiet) {
    grid.classList.add('stale');
    skeletonTimer = setTimeout(renderSkeleton, Math.max(SKELETON_DELAY, introUntil - performance.now()));
  }
  try {
    const query = `project=${encodeURIComponent(project.slug)}&grade=${encodeURIComponent(g)}`;
    const response = await fetch(`/api/games?${query}`, { signal: request.signal });
    if (!response.ok) throw new Error('request failed');
    const data = await response.json();
    if (request.signal.aborted) return;
    clearTimeout(skeletonTimer);
    render(Array.isArray(data.games) ? data.games : [], stagger);
    if (bubble.dataset.kind === 'load') unsay();
  } catch {
    if (request.signal.aborted) return;
    clearTimeout(skeletonTimer);
    grid.replaceChildren();
    say('No se pudieron cargar los juegos.', 'load');
  } finally {
    if (loading === request) {
      loading = null;
      grid.classList.remove('stale');
      games.setAttribute('aria-busy', 'false');
    }
  }
}

/* ---------- Feedback ---------- */

let announceTimer = 0;

function announce(text) {
  clearTimeout(announceTimer);
  live.textContent = '';
  announceTimer = setTimeout(() => {
    live.textContent = text;
  }, 60);
}

let shift = null;

/** Applies a layout change above the grid, then glides the grid from where it was (FLIP). */
function reflow(change) {
  const before = games.getBoundingClientRect().top;
  shift?.cancel();
  change();
  if (!moving()) return;
  const delta = before - games.getBoundingClientRect().top;
  if (Math.abs(delta) < 1) return;
  shift = games.animate([{ transform: `translateY(${delta}px)` }, { transform: 'none' }], {
    duration: 320,
    easing: SETTLE,
  });
}

function say(message, kind) {
  reflow(() => {
    bubbleText.textContent = message;
    bubble.dataset.kind = kind;
    bubble.classList.remove('stale');
    bubble.hidden = false;
    board.classList.add('saying');
  });
  if (kind === 'add') {
    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('aria-describedby', bubbleText.id);
  } else {
    input.removeAttribute('aria-invalid');
    input.removeAttribute('aria-describedby');
  }
  announce(message);
  if (moving()) bubble.animate(POP, { duration: 300, easing: SPRING });
}

function unsay() {
  if (bubble.hidden) return;
  reflow(() => {
    bubble.hidden = true;
    bubble.classList.remove('stale');
    board.classList.remove('saying');
  });
  delete bubble.dataset.kind;
  input.removeAttribute('aria-invalid');
  input.removeAttribute('aria-describedby');
}

function shake() {
  if (moving()) stack.animate(SHAKE, { duration: 420, easing: 'ease-out' });
}

function celebrate(game) {
  announce(`Listo. Agregaste ${game.title}${/[.!?]$/.test(game.title) ? '' : '.'}`);
  const card = grid.querySelector(`.card[data-id="${CSS.escape(game.id)}"]`);
  if (!card) return;
  const frame = card.querySelector('.frame');
  const halo = document.createElement('span');
  halo.className = 'halo';
  frame.append(halo);

  if (!moving()) {
    card.scrollIntoView({ block: 'nearest' });
    setTimeout(() => halo.remove(), 1500);
    return;
  }

  const rect = card.getBoundingClientRect();
  const offscreen = rect.top < 0 || rect.bottom > innerHeight;
  const wait = offscreen ? 450 : 0;
  if (offscreen) card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  card.querySelector('.stage').animate(DROP_CARD, { duration: 560, delay: wait, easing: SPRING, fill: 'backwards' });
  halo
    .animate([{ opacity: 1 }, { offset: 0.3, opacity: 1 }, { opacity: 0 }], {
      duration: 1500,
      delay: wait,
      easing: 'ease-in',
      fill: 'backwards',
    })
    .finished.finally(() => halo.remove());
  setTimeout(() => burst(card), wait + 240);
}

/* ---------- Live preview ---------- */

// Mirrors the server's extractProjectId; the server stays authoritative.
function extractProjectId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const withoutQuery = trimmed.split(/[?#]/)[0];

  const bare = /^(\d{1,15})$/.exec(withoutQuery);
  if (bare) return bare[1];

  const url =
    /^(?:https?:\/\/)?(?:www\.)?scratch\.mit\.edu\/projects\/(\d{1,15})(?:\/[^/]*)*$/i.exec(withoutQuery);
  return url ? url[1] : null;
}

let peekId = null;
let peekTimer = 0;

function hidePeek() {
  lead.classList.remove('peeking');
  peek.hidden = true;
}

function showPeek(id) {
  if (id === peekId) return;
  peekId = id;
  if (!id) {
    hidePeek();
    peek.removeAttribute('src');
    return;
  }
  peek.src = thumb(id, 144, 108);
}

peek.addEventListener('load', () => {
  // Unknown projects come back as a tiny placeholder; treat that as no preview.
  if (!peekId || peek.naturalWidth < 100) {
    hidePeek();
    return;
  }
  if (!peek.hidden) return;
  peek.hidden = false;
  lead.classList.add('peeking');
  if (moving()) {
    peek.animate([{ transform: 'scale(.2) rotate(-12deg)', opacity: 0 }, { transform: 'none', opacity: 1 }], {
      duration: 320,
      easing: SPRING,
    });
  }
});

peek.addEventListener('error', hidePeek);

/* ---------- Add flow ---------- */

let busy = false;

input.addEventListener('input', () => {
  unsay();
  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => showPeek(extractProjectId(input.value)), 200);
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || !grade) return;

  const url = input.value.trim();
  if (!url) {
    shake();
    input.focus();
    return;
  }

  const g = grade;
  // Keep an old message in place while retrying, so the grid does not bounce up and back down.
  bubble.classList.add('stale');
  busy = true;
  stack.classList.add('running');
  form.setAttribute('aria-busy', 'true');
  submit.setAttribute('aria-disabled', 'true');
  input.readOnly = true;

  let game = null;
  let problem = null;
  try {
    const response = await fetch('/api/games', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, grade: g, project: project.slug }),
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok && data.game) game = data.game;
    else problem = data.error || 'No se pudo agregar el juego.';
  } catch {
    problem = 'No se pudo agregar el juego.';
  } finally {
    busy = false;
    stack.classList.remove('running');
    form.setAttribute('aria-busy', 'false');
    submit.removeAttribute('aria-disabled');
    input.readOnly = false;
  }

  if (problem) {
    shake();
    say(problem, 'add');
    return;
  }

  input.value = '';
  clearTimeout(peekTimer);
  showPeek(null);
  unsay();
  // A grade switch mid-request already reloaded the other list.
  if (grade !== g) return;
  await load(g, { quiet: true });
  celebrate(game);
});

/* ---------- Home: the projects shelf ---------- */

const LIFT = [
  { transform: 'translateY(-48px) rotate(-2deg)', opacity: 0 },
  { transform: 'none', opacity: 1 },
];

function mosaic(ids) {
  const frame = document.createElement('span');
  frame.className = 'frame mosaic';
  if (ids.length === 0) {
    frame.classList.add('none');
    frame.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-puzzle"/></svg>';
    return frame;
  }
  const tiles = document.createElement('span');
  tiles.className = 'tiles';
  tiles.dataset.n = String(ids.length);
  frame.append(tiles);
  for (const id of ids) {
    const img = document.createElement('img');
    img.src = thumb(id, 480, 360);
    img.alt = '';
    img.width = 480;
    img.height = 360;
    img.decoding = 'async';
    tiles.append(img);
  }
  return frame;
}

function buildProject(entry) {
  const card = document.createElement('li');
  card.className = 'card project';
  const link = document.createElement('a');
  link.className = 'stage';
  link.href = `/${entry.slug}`;
  const count = entry.count === 1 ? '1 juego' : `${entry.count} juegos`;
  link.setAttribute('aria-label', `${entry.title}, ${count}`);
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = entry.title;
  link.append(mosaic(entry.recent ?? []), title);
  card.append(link);
  return card;
}

async function showHome() {
  home.hidden = false;
  const skeleton = setTimeout(() => {
    shelf.replaceChildren(
      ...Array.from({ length: 3 }, () => {
        const slot = document.createElement('li');
        slot.className = 'card ghost';
        slot.setAttribute('aria-hidden', 'true');
        slot.innerHTML = '<span class="frame"><span class="sheen"></span></span>';
        return slot;
      }),
    );
  }, SKELETON_DELAY);
  let list = null;
  try {
    const response = await fetch('/api/projects');
    if (response.ok) list = (await response.json()).projects;
  } catch {
    list = null;
  }
  clearTimeout(skeleton);
  if (!Array.isArray(list) || list.length === 0) {
    shelf.replaceChildren();
    homeEmpty.hidden = false;
    if (!list) homeEmpty.querySelector('.home-empty-text').textContent = 'No se pudieron cargar los proyectos.';
    return;
  }
  const cards = list.map(buildProject);
  shelf.replaceChildren(...cards);
  if (!moving()) return;
  cards.forEach((card, i) => {
    card.animate(LIFT, { duration: 520, delay: 80 + Math.min(i, STAGGER_CAP) * 70, easing: SPRING, fill: 'backwards' });
  });
}

/* ---------- A project that does not exist ---------- */

function showMissing(message) {
  missing.hidden = false;
  if (message) note.querySelector('.say-text').textContent = message;
  if (!moving()) return;
  lostHat.animate(HAT_DROP, { duration: 620, delay: 80, fill: 'backwards' });
  note.animate(POP, { duration: 320, delay: 520, easing: SPRING, fill: 'backwards' });
}

/* ---------- Start ---------- */

/** `/` is the home; `/pong` is the project with slug `pong` (the server already lowercases it). */
function routeSlug() {
  const path = location.pathname.replace(/\/+$/, '');
  if (!path || path === '/index.html') return null;
  try {
    return decodeURIComponent(path.slice(1)).toLowerCase();
  } catch {
    return '';
  }
}

async function openProject(slug) {
  let response = null;
  try {
    response = await fetch(`/api/projects/${encodeURIComponent(slug)}`);
  } catch {
    response = null;
  }
  if (!response?.ok) {
    showMissing(response?.status === 404 ? null : 'No se pudo cargar. Recargá la página.');
    return;
  }
  project = (await response.json()).project;
  for (const crumb of crumbs) {
    crumb.querySelector('.crumb-title').textContent = project.title;
    // Only a listed project leads back home, so kids in a class project stay in it.
    crumb.querySelector('.back').hidden = !project.listed;
  }
  let stored = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    stored = null;
  }
  if (GRADES.includes(stored)) showBoard(stored);
  else showLanding();
}

for (const el of picks) {
  addShape(el, ['ring', 'gap', 'body']);
  el.addEventListener('click', pick);
}
addShape(hat, ['body']);
addShape(form, ['body']);
addShape(bubble, ['body']);
addShape(lostHat, ['body']);
addShape(note, ['body']);

for (const chip of chips) chip.addEventListener('click', () => switchGrade(chip.dataset.g));

const slug = routeSlug();
if (slug === null) showHome();
else openProject(slug);
