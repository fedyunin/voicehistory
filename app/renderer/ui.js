// The interface. Knows only about api.js — nothing about HTTP or SQLite.
// Porting to Electron does not require opening this file.
import { api } from '/api.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};

const state = { q: '', contactId: null, year: null, offset: 0, total: 0, currentId: null, segments: [] };

/* ======================= boot ======================= */

boot();

async function boot() {
  api.subscribe(onProgress, onJob);
  await Promise.all([refreshStats(), loadSidebar()]);
  await loadList(true);
  wire();

  // Deep link: #r=42 opens that recording directly, so a conversation can be
  // bookmarked and the selection survives a reload.
  const fromHash = Number(new URLSearchParams(location.hash.slice(1)).get('r'));
  if (fromHash) await openRecording(fromHash).catch(() => {});
  window.addEventListener('hashchange', () => {
    const id = Number(new URLSearchParams(location.hash.slice(1)).get('r'));
    if (id && id !== state.currentId) openRecording(id).catch(() => {});
  });
}

async function refreshStats() {
  const s = await api.stats();
  const n = (k) => s.byStatus.find((x) => x.s === k)?.n ?? 0;
  const done = n('done'), pending = n('pending'), empty = n('empty'), failed = n('failed');

  $('foot').textContent =
    `${s.recordings} recordings · ${fmtDur(s.totalMs)} · ${s.contacts} people · ` +
    `${done} transcribed, ${pending} queued` +
    (empty ? `, ${empty} with no speech` : '') + (failed ? `, ${failed} failed` : '') +
    ` · ${s.root}`;

  $('jobs-summary').textContent = pending
    ? `${pending} recordings queued. ${done} already transcribed.`
    : `Queue is empty — ${done} transcribed.`;

  if (!s.recordings) {
    banner('The archive is empty. Press “Import” to bring in a phone export.');
  } else if (!s.modelReady) {
    banner(`Model ${s.model} not found — transcription is unavailable. Audio still imports and plays. Run: npm run setup`);
  } else {
    banner(null);
  }

  if (s.job.running) showProgress(s.job);
  return s;
}

async function loadSidebar() {
  const [ys, cs] = await Promise.all([api.years(), api.contacts()]);

  const yl = $('years');
  yl.replaceChildren();
  for (const y of ys) {
    const li = el('li', state.year === y.year ? 'on' : '');
    li.append(el('span', 'name', y.year), el('span', 'n', y.calls));
    li.onclick = () => { state.year = state.year === y.year ? null : y.year; state.contactId = null; refilter(); };
    yl.append(li);
  }

  const cl = $('contacts');
  cl.replaceChildren();
  for (const c of cs.slice(0, 120)) {
    const li = el('li', state.contactId === c.id ? 'on' : '');
    li.title = `${c.display_name} — ${c.calls} calls, ${fmtDur(c.total_ms)}`;
    li.append(el('span', 'name', c.display_name), el('span', 'n', c.calls));
    li.onclick = () => { state.contactId = state.contactId === c.id ? null : c.id; state.year = null; refilter(); };
    cl.append(li);
  }
}

function refilter() {
  state.offset = 0;
  loadSidebar();
  loadList(true);
}

async function loadList(reset) {
  if (reset) state.offset = 0;
  const r = await api.list({
    q: state.q, contact: state.contactId, year: state.year, offset: state.offset, limit: 60,
  });
  state.total = r.total;

  const ul = $('calls');
  if (reset) ul.replaceChildren();
  for (const row of r.rows) ul.append(callRow(row));

  const shown = ul.children.length;
  $('list-head').textContent = state.q
    ? `${r.total} matches — showing ${shown}`
    : `${r.total} recordings${state.year ? ` in ${state.year}` : ''}`;
  $('more').hidden = shown >= r.total;
  $('clear').hidden = !state.q;
}

const STATUS_LABEL = {
  pending: 'queued', empty: 'no speech', silent: 'silent recording',
  failed: 'failed', running: 'transcribing…',
};

function callRow(row) {
  const li = el('li', row.id === state.currentId ? 'on' : '');
  li.dataset.id = row.id;

  li.append(el('span', 'who', esc(row.contact ?? '—')));
  li.append(el('span', 'when', fmtWhen(row.started_at)));

  const meta = el('div', 'meta');
  if (row.direction === 'Incoming') meta.append(el('span', 'arrow in', '↙ incoming'));
  else if (row.direction === 'Outgoing') meta.append(el('span', 'arrow out', '↗ outgoing'));
  meta.append(el('span', '', fmtDur(row.duration_ms)));
  if (row.source !== 'phone') meta.append(el('span', 'chip', esc(row.source)));
  if (row.transcript_status !== 'done') {
    meta.append(el('span', `chip ${row.transcript_status}`, STATUS_LABEL[row.transcript_status] ?? row.transcript_status));
  }
  li.append(meta);

  if (row.snippet) li.append(el('div', 'snip', row.snippet));

  li.onclick = () => openRecording(row.id);
  return li;
}

/* ======================= detail pane ======================= */

const NO_TRANSCRIPT = {
  pending: 'Not transcribed yet — this recording is in the queue.',
  running: 'Being transcribed right now.',
  empty: 'No speech recognized: most likely dial tones or line noise.',
  silent: 'This file contains no audio signal at all — the recorder produced an '
        + 'empty file. It was skipped rather than transcribed.',
};

async function openRecording(id) {
  state.currentId = id;
  history.replaceState(null, '', `#r=${id}`);
  for (const li of $('calls').children) li.classList.toggle('on', Number(li.dataset.id) === id);

  const rec = await api.recording(id);
  state.segments = rec.segments;

  const d = $('detail');
  d.replaceChildren();
  d.append(el('h2', '', esc(rec.contact ?? '—')));

  const bits = [fmtWhenFull(rec.started_at), fmtDur(rec.duration_ms)];
  if (rec.direction) bits.push(rec.direction.toLowerCase());
  if (rec.source !== 'phone') bits.push(rec.source);
  d.append(el('div', 'sub', bits.join(' · ')));

  const audio = el('audio');
  audio.controls = true;
  audio.preload = 'none';
  audio.src = api.mediaUrl(id);
  d.append(audio);

  if (rec.segments.length) {
    const ul = el('ul', 'segments');
    rec.segments.forEach((s, i) => {
      const li = el('li');
      li.dataset.i = i;
      li.append(el('span', 't', fmtTime(s.t0)), el('span', '', esc(s.text)));
      li.onclick = () => { audio.currentTime = s.t0 / 1000; audio.play(); };
      ul.append(li);
    });
    d.append(ul);

    // Highlight the line currently being spoken — the reason timestamps matter.
    audio.ontimeupdate = () => {
      const ms = audio.currentTime * 1000;
      const idx = state.segments.findIndex((s) => ms >= s.t0 && ms < s.t1);
      for (const li of ul.children) li.classList.toggle('now', Number(li.dataset.i) === idx);
    };
  } else {
    const why = rec.transcript_status === 'failed'
      ? `Transcription failed: ${rec.transcript_error ?? '—'}`
      : NO_TRANSCRIPT[rec.transcript_status];
    d.append(el('p', 'muted', why ?? 'No transcript.'));
  }

  d.append(el('div', 'filelink', esc(rec.rel_path)));
  d.scrollTop = 0;
}

/* ======================= events ======================= */

function wire() {
  let t;
  $('q').oninput = (e) => {
    clearTimeout(t);
    const v = e.target.value.trim();
    t = setTimeout(() => { state.q = v; loadList(true); }, 220);
  };
  $('clear').onclick = () => { $('q').value = ''; state.q = ''; loadList(true); };
  $('more').onclick = () => { state.offset += 60; loadList(false); };

  $('btn-import').onclick = openImport;
  $('imp-cancel').onclick = () => $('dlg-import').close();
  $('imp-go').onclick = startImport;
  $('imp-src').onchange = onSourceChange;
  let ct;
  $('imp-custom').oninput = () => { clearTimeout(ct); ct = setTimeout(checkCustom, 250); };

  $('btn-jobs').onclick = async () => { await refreshStats(); $('dlg-jobs').showModal(); };
  $('jobs-cancel').onclick = () => $('dlg-jobs').close();
  $('jobs-go').onclick = startTranscribe;
  $('jobs-reindex').onclick = async () => {
    $('dlg-jobs').close();
    try { await api.reindex(); } catch (e) { banner(e.message); }
  };

  $('prog-cancel').onclick = () => api.cancel();

  $('btn-settings').onclick = openSettings;
  $('set-close').onclick = () => { $('dlg-settings').close(); refreshAll(); };

  $('btn-people').onclick = openPeople;
  $('people-close').onclick = () => { $('dlg-people').close(); refreshAll(); };
  $('vcf').onchange = importVCard;
}

/* ======================= settings ======================= */

async function openSettings() {
  const { usage, actions } = await api.maintenance();

  const u = $('set-usage');
  u.replaceChildren();
  const line = (label, v) => {
    const row = el('div', 'usage-row');
    row.append(el('span', 'muted', label), el('span', '', v));
    u.append(row);
  };
  line('Archive root', usage.root);
  line('Audio (originals)', `${usage.archive.files} files · ${fmtBytes(usage.archive.bytes)}`);
  line('Playable copies', `${usage.audio.files} files · ${fmtBytes(usage.audio.bytes)}`);
  line('Transcripts', `${usage.transcripts.files} files · ${fmtBytes(usage.transcripts.bytes)}`);
  line('Search index', fmtBytes(usage.index.bytes));
  line('Contact names', usage.names ? 'contacts.json present' : 'none');

  const list = $('set-actions');
  list.replaceChildren();
  for (const [key, spec] of Object.entries(actions)) {
    const box = el('div', `action-box${spec.needsConfirm ? ' danger' : ''}`);
    box.append(el('div', 'action-title', esc(spec.title)));
    box.append(el('div', 'action-meta tiny',
      `<b>Destroys:</b> ${esc(spec.destroys)} &nbsp;·&nbsp; <b>Survives:</b> ${esc(spec.survives)}`));
    box.append(el('div', 'muted tiny', esc(spec.detail)));

    const row = el('div', 'action-run');
    let input = null;
    if (spec.needsConfirm) {
      input = el('input');
      input.type = 'text';
      input.placeholder = `type ${spec.confirm}`;
      input.spellcheck = false;
      row.append(input);
    }
    const btn = el('button', spec.needsConfirm ? 'danger-btn' : '', 'Run');
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await api.maintenanceRun(key, input ? input.value.trim() : undefined);
        $('dlg-settings').close();
      } catch (e) {
        banner(e.message);
      } finally {
        btn.disabled = false;
        if (input) input.value = '';
      }
    };
    row.append(btn);
    box.append(row);
    list.append(box);
  }

  $('dlg-settings').showModal();
}

function fmtBytes(n) {
  if (!n) return '0';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

/* ======================= people ======================= */

async function openPeople() {
  await renderPeople();
  $('vcf-result').textContent = '';
  $('dlg-people').showModal();
}

async function renderPeople() {
  const list = $('people-list');
  list.replaceChildren();
  const cs = await api.contacts();

  for (const c of cs) {
    const row = el('div', 'people-row');

    const input = el('input');
    input.type = 'text';
    input.value = c.display_name;
    input.placeholder = 'unnamed';
    // A name that is only a formatted number is not really a name — show it as
    // a placeholder so it is obvious which contacts still need identifying.
    if (!c.custom && c.kind !== 'name') { input.value = ''; input.placeholder = c.display_name; }
    input.onchange = async () => {
      try {
        const r = await api.renameContact(c.key, input.value);
        input.classList.toggle('named', r.custom);
      } catch (e) { banner(e.message); }
    };
    if (c.custom) input.classList.add('named');

    row.append(input);
    row.append(el('span', 'muted key', esc(c.key === 'unknown' ? '—' : c.key)));
    row.append(el('span', 'muted num', `${c.calls}`));
    list.append(row);
  }

  if (!cs.length) list.append(el('p', 'muted tiny', 'No contacts yet — import some recordings first.'));
}

async function importVCard(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const out = $('vcf-result');
  out.textContent = 'reading…';
  try {
    const text = await file.text();
    const r = await api.importVCard(text);
    out.textContent = r.matched
      ? `${r.cards} cards, ${r.numbers} numbers — ${r.matched} matched contacts in this archive.`
      : `${r.cards} cards read, but none of the numbers match a contact here.`;
    await renderPeople();
  } catch (err) {
    out.textContent = err.message;
  } finally {
    e.target.value = '';
  }
}

const CUSTOM = '__custom__';

async function openImport() {
  const sources = await api.importScan();
  const sel = $('imp-src');
  sel.replaceChildren();
  for (const s of sources) {
    const o = el('option', '', `${esc(s.label)} — ${s.files} files`);
    o.value = s.dir;
    sel.append(o);
  }
  sel.append(Object.assign(el('option', '', 'Another folder…'), { value: CUSTOM }));

  // If Import/ is empty, jump straight to the custom-path field: the archive
  // usually lives outside the project.
  const inbox = sources[0];
  sel.value = inbox && inbox.files > 0 ? inbox.dir : CUSTOM;
  onSourceChange();
  $('dlg-import').showModal();
}

function onSourceChange() {
  const custom = $('imp-src').value === CUSTOM;
  $('imp-custom-field').hidden = !custom;
  if (custom) { checkCustom(); $('imp-custom').focus(); } else { $('imp-go').disabled = false; }
}

let checkSeq = 0;

async function checkCustom() {
  const dir = $('imp-custom').value.trim();
  const hint = $('imp-custom-hint');
  const seq = ++checkSeq;
  if (!dir) {
    hint.textContent = 'Paste the full path to a folder of recordings.';
    $('imp-go').disabled = true;
    return;
  }
  try {
    const r = await api.importCheck(dir);
    if (seq !== checkSeq) return;               // a newer keystroke already won
    if (!r.exists) hint.textContent = r.notADirectory ? 'That is a file, not a folder.' : 'No such folder.';
    else if (!r.files) hint.textContent = 'Folder found, but it holds no audio files.';
    else hint.textContent = `${r.files} audio files found.`;
    $('imp-go').disabled = !r.files;
  } catch (e) {
    if (seq === checkSeq) { hint.textContent = e.message; $('imp-go').disabled = true; }
  }
}

async function startImport() {
  const sel = $('imp-src').value;
  const dir = sel === CUSTOM ? $('imp-custom').value.trim() : sel;
  const mode = document.querySelector('input[name=mode]:checked').value;
  $('dlg-import').close();
  try { await api.importStart({ dir, mode }); } catch (e) { banner(e.message); }
}

async function startTranscribe() {
  const order = document.querySelector('input[name=order]:checked').value;
  $('dlg-jobs').close();
  try { await api.transcribeStart({ order }); } catch (e) { banner(e.message); }
}

/* ======================= progress ======================= */

const LABEL = {
  import: 'Importing', transcribe: 'Transcribing', reindex: 'Rebuilding index',
  backfill: 'Attaching metadata',
  'maintenance:reindex': 'Rebuilding index',
  'maintenance:names': 'Clearing contact names',
  'maintenance:transcripts': 'Deleting transcripts',
  'maintenance:everything': 'Deleting everything',
};

function onProgress(p) {
  if (p.phase === 'log') return;
  showProgress({ kind: p.phase, done: p.done, total: p.total, file: p.file });
}

let refreshTimer = null;

function onJob(j) {
  if (j.running) { showProgress(j); return; }
  $('progress').hidden = true;
  banner(j.error ? `Error: ${j.error}` : null);
  refreshAll();
}

function showProgress({ kind, done = 0, total = 0, file }) {
  $('progress').hidden = false;
  $('prog-label').textContent = LABEL[kind] ?? kind;
  $('prog-count').textContent = total ? `${done} of ${total}` : '';
  $('prog-fill').style.width = total ? `${(done / total) * 100}%` : '0';
  if (file) $('prog-file').textContent = file;

  // Refresh the list during long jobs, but not on every single event.
  if (!refreshTimer) {
    refreshTimer = setTimeout(() => { refreshTimer = null; refreshAll(); }, 4000);
  }
}

async function refreshAll() {
  await Promise.all([refreshStats(), loadSidebar()]);
  await loadList(true);
}

/* ======================= formatting ======================= */

function banner(text) {
  const b = $('banner');
  b.hidden = !text;
  if (text) b.textContent = text;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtWhen(iso) {
  const [d, t] = iso.split('T');
  const [y, m, day] = d.split('-');
  return `${MONTHS[Number(m) - 1]} ${Number(day)}, ${y}, ${t.slice(0, 5)}`;
}

function fmtWhenFull(iso) {
  const [d, t] = iso.split('T');
  const [y, m, day] = d.split('-');
  return `${MONTHS[Number(m) - 1]} ${Number(day)}, ${y} at ${t.slice(0, 5)}`;
}

function fmtDur(ms) {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
