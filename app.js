// The browser app's main thread: TMDb key, picking exports, progress, and handing
// each pass's ranked films to the viewer (shared with the Python app, generated
// into viewer.js by tools/build_web.py). The engine runs in worker.js.
import { startViewer } from './viewer.js';
import { kvGet, kvSet } from './engine/cache.js';

const $ = id => document.getElementById(id);
const KEY_STORE = 'blendboxd.tmdbKey';
const EXPORT_FILE = /\.(zip|csv)$/i;
const MAX_DEPTH = 4; // how deep to look inside a picked folder
const nf = new Intl.NumberFormat('en');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ------------------------------------------------------------------ TMDb key
// Kept in this browser only (localStorage), never in the page or the repo.
const store = {
  get() { try { return localStorage.getItem(KEY_STORE) || ''; } catch { return ''; } },
  set(v) { try { localStorage.setItem(KEY_STORE, v); } catch { /* private mode: session only */ } },
  clear() { try { localStorage.removeItem(KEY_STORE); } catch { /* ignore */ } },
};
let apiKey = store.get();

function setKeyStatus(html, cls = '') {
  const el = $('keystatus');
  el.className = `note ${cls}`;
  el.innerHTML = html;
}

function showKey() {
  $('keyform').hidden = Boolean(apiKey);
  if (apiKey) {
    setKeyStatus('&#10003; Key saved in this browser. <button type="button" class="lnk" id="changekey">Change</button>', 'ok');
    $('changekey').onclick = () => { apiKey = ''; store.clear(); $('key').value = ''; showKey(); $('key').focus(); updateBlendButton(); };
  }
  updateBlendButton();
}

async function checkKey(key) {
  try {
    const r = await fetch(`https://api.themoviedb.org/3/configuration?api_key=${encodeURIComponent(key)}`);
    if (r.ok) return 'ok';
    return r.status === 401 ? 'bad' : 'error';
  } catch {
    return 'offline';
  }
}

$('keyform').onsubmit = async e => {
  e.preventDefault();
  const key = $('key').value.trim();
  if (!key) return;
  if (key.startsWith('eyJ') && key.length > 60) {
    setKeyStatus('That is the long <b>API Read Access Token</b>. Paste the shorter <b>API Key</b> from the same page instead.', 'bad');
    return;
  }
  $('savekey').disabled = true;
  setKeyStatus('Checking the key with TMDb…');
  const verdict = await checkKey(key);
  $('savekey').disabled = false;
  if (verdict === 'ok') { apiKey = key; store.set(key); showKey(); return; }
  setKeyStatus({
    bad: 'TMDb rejected this key. Check that you copied the whole <b>API Key</b>.',
    error: 'TMDb gave an unexpected answer. Try again in a minute.',
    offline: "Couldn't reach TMDb. Check your internet connection and try again.",
  }[verdict], 'bad');
};

// ---------------------------------------------------------- picking exports
// Files arrive as [{path, file}] with '/'-separated paths relative to what was
// picked. Every .zip is one export; a folder holding watched.csv or ratings.csv is
// an unzipped export.
function groupSources(files, rootName = 'folder') {
  const sources = files.filter(f => /\.zip$/i.test(f.path))
    .map(f => ({ name: f.path, kind: 'zip', file: f.file }));
  const dirs = new Set();
  for (const f of files) {
    const m = f.path.match(/^(?:(.*)\/)?(watched|ratings)\.csv$/);
    if (m) dirs.add(m[1] || '');
  }
  for (const dir of dirs) {
    const prefix = dir ? `${dir}/` : '';
    const inside = files.filter(f => f.path.startsWith(prefix) && /\.csv$/i.test(f.path))
      .map(f => ({ path: f.path.slice(prefix.length), file: f.file }));
    sources.push({ name: dir || rootName, kind: 'folder', files: inside });
  }
  return sources.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.name.localeCompare(b.name));
}

async function readDirHandle(dir, prefix = '', depth = 0) {
  const out = [];
  for await (const [name, h] of dir.entries()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (h.kind === 'file') {
      if (EXPORT_FILE.test(name)) out.push({ path, file: await h.getFile() });
    } else if (depth < MAX_DEPTH) {
      out.push(...await readDirHandle(h, path, depth + 1));
    }
  }
  return out;
}

async function walkEntry(entry, prefix, out, depth) {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    if (EXPORT_FILE.test(entry.name)) out.push({ path, file: await new Promise((res, rej) => entry.file(res, rej)) });
  } else if (entry.isDirectory && depth < MAX_DEPTH) {
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const child of batch) await walkEntry(child, path, out, depth + 1);
    }
  }
}

let sources = [];
let members = [];
const excluded = new Set();

function useFiles(files, rootName) {
  sources = groupSources(files, rootName);
  excluded.clear();
  if (!sources.length) {
    members = [];
    renderMembers([], [{ name: rootName, reason: 'no .zip exports or export folders found there' }]);
    return;
  }
  $('memberlist').innerHTML = '<li class="counts">Reading exports…</li>';
  $('skiplist').innerHTML = '';
  worker.postMessage({ type: 'inspect', sources });
}

$('pickfolder').onclick = async () => {
  if (!window.showDirectoryPicker) { $('folderinput').click(); return; }
  let handle;
  try {
    handle = await window.showDirectoryPicker({ id: 'blendboxd', mode: 'read' });
  } catch {
    return; // cancelled
  }
  kvSet('lastFolder', handle).catch(() => {});
  useFiles(await readDirHandle(handle), handle.name);
};
$('folderinput').onchange = e => {
  const files = [...e.target.files].filter(f => EXPORT_FILE.test(f.name))
    .map(f => ({ path: f.webkitRelativePath || f.name, file: f }));
  e.target.value = '';
  useFiles(files, 'the folder');
};
$('pickzips').onclick = () => $('zipinput').click();
$('zipinput').onchange = e => {
  const files = [...e.target.files].map(f => ({ path: f.name, file: f }));
  e.target.value = '';
  useFiles(files, 'the selection');
};

const drop = $('drop');
drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = async e => {
  e.preventDefault();
  drop.classList.remove('over');
  // Grab the entries synchronously: DataTransfer items expire after this event.
  const entries = [...e.dataTransfer.items].filter(i => i.kind === 'file')
    .map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  const plain = [...e.dataTransfer.files];
  const files = [];
  if (entries.length) for (const entry of entries) await walkEntry(entry, '', files, 0);
  else for (const f of plain) files.push({ path: f.name, file: f });
  useFiles(files, 'the dropped files');
};

// Chromium can re-open the last picked folder (after a permission prompt).
kvGet('lastFolder').then(handle => {
  if (!handle || !window.showDirectoryPicker) return;
  const btn = $('reopen');
  btn.textContent = `Use “${handle.name}” again`;
  btn.hidden = false;
  btn.onclick = async () => {
    try {
      const ok = (await handle.queryPermission({ mode: 'read' })) === 'granted'
        || (await handle.requestPermission({ mode: 'read' })) === 'granted';
      if (ok) useFiles(await readDirHandle(handle), handle.name);
    } catch {
      btn.hidden = true; // the folder moved or was deleted
    }
  };
}).catch(() => {});

function renderMembers(list, skipped) {
  members = list;
  $('memberlist').innerHTML = list.map(m => `
    <li data-id="${m.id}" class="${excluded.has(m.id) ? 'off' : ''}">
      <span class="who">${esc(m.label)}</span>
      <span class="counts">${nf.format(m.rated)} rated · ${nf.format(m.liked)} liked</span>
      <span class="file" title="${esc(m.fileName)}">${esc(m.fileName.split('/').pop())}</span>
      <button type="button" class="drop-member" title="${excluded.has(m.id) ? 'Add back' : 'Leave out'}"
        aria-label="${excluded.has(m.id) ? 'Add' : 'Remove'} ${esc(m.label)}">${excluded.has(m.id) ? '+' : '&times;'}</button>
    </li>`).join('');
  $('memberlist').querySelectorAll('.drop-member').forEach(btn => {
    btn.onclick = () => {
      const id = Number(btn.closest('li').dataset.id);
      excluded.has(id) ? excluded.delete(id) : excluded.add(id);
      renderMembers(members, lastSkipped);
    };
  });
  lastSkipped = skipped;
  $('skiplist').innerHTML = skipped.map(s => `<li>Skipped ${esc(s.name.split('/').pop())}: ${esc(s.reason)}</li>`).join('');
  updateBlendButton();
}
let lastSkipped = [];

const included = () => members.filter(m => !excluded.has(m.id));

function updateBlendButton() {
  const n = included().length;
  const btn = $('blend');
  btn.disabled = !(apiKey && n);
  btn.textContent = n > 1 ? `Blend ${n} people` : n === 1 ? `Picks for ${included()[0].label}` : 'Blend';
  $('blendhint').textContent = !apiKey ? 'Save a TMDb key first (step 1).'
    : !members.length ? 'Pick the exports first (step 2).' : '';
}

// ---------------------------------------------------------------- the engine
let worker = null;
function startWorker() {
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = e => handlers[e.data.type]?.(e.data);
  worker.onerror = e => showFailure(`The engine crashed: ${e.message || 'unknown error'}`);
}

const PHASES = {
  resolve: ['Matching everyone’s films to TMDb', 0, 0.45],
  rated: ['Reading those films’ details', 0.45, 0.7],
  candidates: ['Finding films to recommend', 0.7, 0.97],
  score: ['Scoring', 0.97, 1],
};
let pending = null;
function paintProgress() {
  const { phase, done, total } = pending;
  pending = null;
  const [label, from, to] = PHASES[phase] || ['Working', 0, 1];
  const frac = total ? done / total : 0;
  $('pfill').style.width = `${Math.round((from + (to - from) * frac) * 100)}%`;
  $('pphase').textContent = total ? `${label} · ${nf.format(done)} / ${nf.format(total)}` : `${label}…`;
}

// What the viewer's poll reads (same shape as the Python server's /api/state).
const live = { generation: 0, pass: 0, done: false, films: [] };
window.blendboxdState = async (tab, since) => {
  const body = { tab: 'blend', generation: live.generation, pass: live.pass, done: live.done };
  if (since !== live.generation) body.films = live.films;
  return body;
};

function subtitle(names, combiner, minVotes) {
  const tail = `min TMDb votes ${minVotes}`;
  if (names.length === 1) return `solo picks for ${esc(names[0])} &middot; ranked by taste &middot; ${tail}`;
  return `blending ${names.map(esc).join(' &times; ')} &middot; combined via ${esc(combiner)} &middot; ${tail}`;
}

function showNotes(msg) {
  const u = msg.unresolved;
  $('unres').hidden = !u.length;
  $('unressum').textContent = `${nf.format(u.length)} film${u.length === 1 ? '' : 's'} couldn't be matched on TMDb`;
  $('unreslist').innerHTML = u.map(f => `<li>${esc(f.title)}${f.year ? ` (${f.year})` : ''}</li>`).join('');
  const failed = msg.stats.networkErrors;
  const notes = [];
  if (failed) notes.push(`${nf.format(failed)} TMDb lookup${failed === 1 ? '' : 's'} failed; blend again later to retry.`);
  if (!msg.stats.cached) notes.push('This browser isn’t keeping a cache, so the next blend starts from scratch.');
  $('appnote').textContent = notes.join(' ');
}

let viewing = false;
const handlers = {
  members: msg => renderMembers(msg.members, msg.skipped),
  progress: msg => {
    const first = pending == null;
    pending = msg;
    if (first) requestAnimationFrame(paintProgress);
  },
  pass: msg => {
    live.films = msg.records;
    live.pass = msg.pass;
    live.done = msg.done;
    live.generation += 1;
    window.blendboxdStats = msg.stats; // for debugging from the console
    showNotes(msg);
    if (viewing) return; // the viewer picks this up on its next poll
    viewing = true;
    $('progress').hidden = true;
    $('appbar').hidden = false;
    $('viewer').hidden = false;
    document.body.classList.add('viewing');
    startViewer({
      names: msg.names,
      memberActive: msg.names.map(() => true),
      maxShow: msg.topN,
      live: true,
      pollUrl: 'in-page',
      combiner: msg.combiner,
      hasCine: false,
      cinemas: [],
      cinemaIssues: [],
      data: msg.records,
      dataCine: [],
      subtitleBlend: subtitle(msg.names, msg.combiner, msg.minVoteCount),
      subtitleCine: '',
    });
  },
  error: msg => {
    if (msg.auth) {
      apiKey = '';
      store.clear();
      backToSetup();
      showKey();
      setKeyStatus('TMDb rejected the saved key. Paste a valid <b>API Key</b>.', 'bad');
      return;
    }
    showFailure(msg.message);
  },
};

function showFailure(message) {
  if (viewing) { $('appnote').textContent = `Deepening stopped: ${message}`; return; }
  $('ptitle').textContent = 'The blend stopped';
  $('pphase').textContent = message;
  $('cancel').textContent = 'Back';
}

function backToSetup() {
  // Restart the engine so nothing from the old blend keeps running, and re-read
  // the same exports into it.
  worker.terminate();
  startWorker();
  if (sources.length) worker.postMessage({ type: 'inspect', sources });
  $('progress').hidden = true;
  $('setup').hidden = false;
}

$('blend').onclick = () => {
  const chosen = included();
  if (!apiKey || !chosen.length) return;
  $('setup').hidden = true;
  $('progress').hidden = false;
  $('ptitle').textContent = chosen.length > 1 ? `Blending ${chosen.length} people…` : `Finding picks for ${chosen[0].label}…`;
  $('cancel').textContent = 'Cancel';
  $('pfill').style.width = '0%';
  $('pphase').textContent = 'Starting…';
  worker.postMessage({ type: 'blend', apiKey, include: chosen.map(m => m.id) });
};
$('cancel').onclick = backToSetup;
$('newblend').onclick = () => location.reload();

startWorker();
showKey();
