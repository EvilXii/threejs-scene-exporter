const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const short = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));

let tab = null;
let scenes = [];          // {key, frameId, id, name, kind, via, meshes, tris, verts, objects}
let activeKey = null;
const selections = new Map(); // key -> Set(uuid)
let format = 'glb';

/* ---------- talking to the page ---------- */
async function inAll(func, args = []) {
  return chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, world: 'MAIN', func, args });
}
async function inFrame(frameId, func, args = []) {
  const r = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [frameId] }, world: 'MAIN', func, args });
  return r[0] && r[0].result;
}

/* ---------- scanning ---------- */
async function scan() {
  $('#sub').textContent = 'Scanning page…';
  $('#controls').hidden = true;
  const content = $('#content');
  content.textContent = '';
  if (!tab || !/^(https?|file):/.test(tab.url || '')) {
    return showEmpty('This page can’t be scanned', 'Chrome doesn’t allow extensions on this kind of page. Open a regular website that shows a 3D scene.');
  }
  let res;
  try {
    res = await inAll(() => (window.__T3X__ ? window.__T3X__.detect() : null));
    if (res.some((r) => !r.result)) { // frames loaded before the extension: inject on demand (global scan only)
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, world: 'MAIN', files: ['inject.js'] });
      res = await inAll(() => (window.__T3X__ ? window.__T3X__.detect() : null));
    }
  } catch (e) {
    return showEmpty('Couldn’t scan this page', String(e.message || e));
  }
  scenes = [];
  let revision = null, canvases = 0;
  for (const r of res) {
    const d = r.result;
    if (!d) continue;
    revision = revision || d.revision;
    canvases += d.canvases;
    for (const s of d.sources) scenes.push({ ...s, frameId: r.frameId, key: r.frameId + ':' + s.id, frameUrl: d.url });
  }
  if (!scenes.length) {
    $('#sub').textContent = revision ? 'three.js r' + revision + ' detected, no scene reachable' : canvases ? 'WebGL canvas found, no three.js scene' : 'No 3D scene found';
    const b = revision || canvases ? 'No exportable scene yet' : 'No three.js scene on this page';
    const msg = revision || canvases
      ? 'The scene may not be created yet, or it was created before this extension started. Reload the page, let the 3D view finish loading, then scan again.'
      : 'If you expect one, reload the page (the extension only sees scenes created after it is active), wait for the 3D view to load, and scan again.';
    return showEmpty(b, msg, true);
  }
  if (!scenes.some((s) => s.key === activeKey)) activeKey = scenes[0].key;
  $('#sub').textContent = scenes.length + (scenes.length === 1 ? ' scene' : ' scenes') + ' found' + (revision ? ' · three.js r' + revision : '');
  renderScenes();
  $('#controls').hidden = false;
  updateExportLabel();
}

function showEmpty(title, text, withReload) {
  $('#sub').textContent = $('#sub').textContent === 'Scanning page…' ? title : $('#sub').textContent;
  const box = el('div', 'empty');
  box.append(el('b', null, title), document.createTextNode(text));
  if (withReload) {
    const btn = el('button', 'ghost', 'Reload page');
    btn.onclick = async () => { await chrome.tabs.reload(tab.id); window.close(); };
    box.append(document.createElement('br'), btn);
  }
  $('#content').append(box);
}

/* ---------- rendering ---------- */
function renderScenes() {
  const content = $('#content');
  content.textContent = '';
  for (const s of scenes) {
    const card = el('div', 'scene' + (s.key === activeKey ? ' active' : ''));
    const head = el('div', 'scene-head');
    const radio = el('input'); radio.type = 'radio'; radio.name = 'scene'; radio.checked = s.key === activeKey;
    const body = el('div');
    body.append(el('div', 'scene-title', s.name + (s.kind !== 'Scene' ? ' (' + s.kind + ')' : '')));
    const meta = el('div', 'scene-meta', short(s.meshes) + ' meshes · ' + short(s.tris) + ' triangles · ' + short(s.verts) + ' vertices ');
    const via = el('span', 'via', '· ' + s.via + (s.frameId ? ' · iframe' : ''));
    meta.append(via);
    body.append(meta);
    const toggle = el('button', 'toggle', 'Objects');
    head.append(radio, body, toggle);
    const tree = el('div', 'tree'); tree.hidden = true;
    let loaded = false;
    const activate = () => { activeKey = s.key; renderScenes(); updateExportLabel(); };
    head.onclick = (e) => { if (e.target === toggle) return; if (activeKey !== s.key) activate(); };
    toggle.onclick = async (e) => {
      e.stopPropagation();
      tree.hidden = !tree.hidden;
      toggle.textContent = tree.hidden ? 'Objects' : 'Hide objects';
      if (!tree.hidden && !loaded) { loaded = true; await loadChildren(s, null, tree); }
    };
    card.append(head, tree);
    content.append(card);
  }
}

async function loadChildren(scene, uuid, box) {
  box.textContent = '';
  box.append(el('div', 'loading', 'Loading…'));
  let r;
  try { r = await inFrame(scene.frameId, (id, u) => window.__T3X__.tree(id, u), [scene.id, uuid]); }
  catch (e) { box.textContent = 'Could not read objects.'; return; }
  box.textContent = '';
  if (!r || !r.items.length) { box.append(el('div', 'more', 'No child objects')); return; }
  for (const item of r.items) box.append(nodeRow(scene, item));
  if (r.total > r.items.length) box.append(el('div', 'more', '+' + (r.total - r.items.length) + ' more objects not shown'));
}

function nodeRow(scene, item) {
  const wrap = el('div');
  const row = el('div', 'node');
  const arrow = el('button', 'arrow', '▶'); arrow.disabled = !item.children; arrow.setAttribute('aria-label', 'Expand');
  const cb = el('input'); cb.type = 'checkbox';
  const sel = selections.get(scene.key);
  cb.checked = !!(sel && sel.has(item.uuid));
  const nm = el('span', 'nm' + (item.name ? '' : ' dim'), item.name || '(unnamed)');
  nm.title = item.name || item.type;
  const ty = el('span', 'ty', item.type);
  const ct = el('span', 'ct', item.meshes ? short(item.tris) + ' △' : '–');
  const fl = el('button', 'fl', 'Flash'); fl.title = 'Briefly show this object as wireframe on the page';
  row.append(arrow, cb, nm, ty, ct, fl);
  if (!item.visible) nm.style.opacity = '0.5';
  const kids = el('div', 'kids'); kids.hidden = true;
  let loaded = false;
  arrow.onclick = async () => {
    kids.hidden = !kids.hidden;
    arrow.textContent = kids.hidden ? '▶' : '▼';
    if (!kids.hidden && !loaded) { loaded = true; await loadChildren(scene, item.uuid, kids); }
  };
  cb.onchange = () => {
    if (!selections.has(scene.key)) selections.set(scene.key, new Set());
    const set = selections.get(scene.key);
    cb.checked ? set.add(item.uuid) : set.delete(item.uuid);
    if (activeKey !== scene.key) { activeKey = scene.key; document.querySelectorAll('.scene').forEach(() => {}); }
    updateExportLabel();
  };
  fl.onclick = () => inFrame(scene.frameId, (id, u) => window.__T3X__.flash(id, u), [scene.id, [item.uuid]]);
  wrap.append(row, kids);
  return wrap;
}

/* ---------- export ---------- */
const getOpts = () => ({
  includeHidden: $('#o-hidden').checked, textures: $('#o-tex').checked,
  bakePose: $('#o-pose').checked, zUp: $('#o-zup').checked
});

function updateExportLabel() {
  const s = scenes.find((x) => x.key === activeKey);
  const n = s && selections.get(s.key) ? selections.get(s.key).size : 0;
  $('#export').textContent = 'Export ' + format.toUpperCase() + (n ? ' (' + n + ' selected)' : ' · whole scene');
  $('#export-all').hidden = scenes.length < 2;
}

function setStatus(kind, text, extra) {
  const st = $('#status');
  st.className = kind || '';
  st.textContent = text;
  if (extra) st.append(el('small', null, extra));
}

async function runExport(list) {
  const btns = [$('#export'), $('#export-all')];
  btns.forEach((b) => (b.disabled = true));
  const opts = getOpts();
  try {
    for (const s of list) {
      setStatus('', 'Exporting ' + s.name + '…');
      const uuids = selections.has(s.key) ? Array.from(selections.get(s.key)) : [];
      const r = await inFrame(s.frameId, (id, u, f, o) => window.__T3X__.exportScene(id, u, f, o), [s.id, uuids, format, opts]);
      if (!r || !r.ok) { setStatus('err', (r && r.error) || 'Export failed.'); return; }
      const mb = (r.bytes / 1048576).toFixed(r.bytes > 1048576 ? 1 : 2);
      setStatus('ok', 'Saved ' + r.filename + ' (' + mb + ' MB)',
        (r.meshes ? r.meshes + ' meshes · ' + short(r.triangles) + ' triangles' : 'three.js JSON') + (r.warnings && r.warnings.length ? ' · Note: ' + r.warnings.join(' ') : ''));
    }
  } catch (e) {
    setStatus('err', String(e.message || e));
  } finally {
    btns.forEach((b) => (b.disabled = false));
  }
}

/* ---------- wiring ---------- */
$('#formats').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-f]');
  if (!b) return;
  format = b.dataset.f;
  document.querySelectorAll('#formats button').forEach((x) => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-checked', on); });
  $('#o-zup').checked = format === 'stl';
  $('#o-tex').disabled = format === 'stl' || format === 'json';
  updateExportLabel();
});
$('#export').onclick = () => { const s = scenes.find((x) => x.key === activeKey); if (s) runExport([s]); };
$('#export-all').onclick = () => runExport(scenes);
$('#rescan').onclick = () => { setStatus('', ''); scan(); };

(async () => {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  scan();
})();
