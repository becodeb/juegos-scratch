const GRADES = ['4N', '4F', '4S'];
const STORAGE_KEY = 'grade';

const blocks = document.querySelectorAll('.grade');
const form = document.querySelector('.add');
const input = form.querySelector('.url');
const submit = form.querySelector('.submit');
const msg = document.querySelector('.msg');
const grid = document.querySelector('.grid');

let okTimer = null;

function setMessage(text, isError) {
  clearTimeout(okTimer);
  okTimer = null;
  msg.textContent = text;
  msg.classList.toggle('error', Boolean(isError));
}

function flashOk(text) {
  setMessage(text, false);
  okTimer = setTimeout(() => setMessage('', false), 2500);
}

function currentGrade() {
  const grade = document.body.dataset.grade;
  return GRADES.includes(grade) ? grade : null;
}

function renderEmpty() {
  grid.replaceChildren();
  const p = document.createElement('p');
  p.className = 'empty';
  p.textContent = 'Todavía no hay juegos. Pegá el primero.';
  grid.append(p);
}

function buildCard(game) {
  const card = document.createElement('a');
  card.className = 'card';
  card.href = `https://scratch.mit.edu/projects/${game.id}/fullscreen`;
  card.target = '_blank';
  card.rel = 'noopener';

  const img = document.createElement('img');
  img.src = `https://cdn2.scratch.mit.edu/get_image/project/${game.id}_282x218.png`;
  img.alt = game.title;
  img.loading = 'lazy';

  const meta = document.createElement('div');
  meta.className = 'meta';

  const title = document.createElement('p');
  title.className = 'title';
  title.textContent = game.title;

  const name = document.createElement('p');
  name.className = 'name';
  name.textContent = game.name;

  meta.append(title, name);
  card.append(img, meta);
  return card;
}

async function load(grade) {
  try {
    const response = await fetch(`/api/games?grade=${encodeURIComponent(grade)}`);
    if (!response.ok) throw new Error('request failed');
    const data = await response.json();
    const games = Array.isArray(data.games) ? data.games : [];
    if (games.length === 0) {
      renderEmpty();
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const game of games) fragment.append(buildCard(game));
    grid.replaceChildren(fragment);
  } catch {
    grid.replaceChildren();
    setMessage('No se pudieron cargar los juegos.', true);
  }
}

function selectGrade(grade) {
  document.body.dataset.grade = grade;
  for (const block of blocks) {
    block.setAttribute('aria-selected', String(block.dataset.grade === grade));
  }
  try {
    localStorage.setItem(STORAGE_KEY, grade);
  } catch {
    /* storage unavailable: the choice just will not persist */
  }
  setMessage('', false);
  load(grade);
}

for (const block of blocks) {
  block.addEventListener('click', () => selectGrade(block.dataset.grade));
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const grade = currentGrade();
  if (!grade) {
    setMessage('Elegí tu grado primero.', true);
    return;
  }

  const url = input.value.trim();
  if (!url) return;

  submit.disabled = true;
  try {
    const response = await fetch('/api/games', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, grade }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setMessage(data.error || 'No se pudo agregar el juego.', true);
      return;
    }
    input.value = '';
    await load(grade);
    flashOk('Listo.');
  } catch {
    setMessage('No se pudo agregar el juego.', true);
  } finally {
    submit.disabled = false;
  }
});

let stored = null;
try {
  stored = localStorage.getItem(STORAGE_KEY);
} catch {
  stored = null;
}
if (GRADES.includes(stored)) selectGrade(stored);
