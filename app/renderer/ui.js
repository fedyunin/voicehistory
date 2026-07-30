// The interface. Knows only about api.js — nothing about HTTP or SQLite.
// Porting to Electron does not require opening this file.
import { api, isDesktop } from './api.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};

const state = { q: '', stems: [], contactId: null, contactName: null, year: null, offset: 0, total: 0,
                currentId: null, segments: [], hits: [], hitAt: 0 };

/* ======================= boot ======================= */

boot();

async function boot() {
  // The traffic-light inset is macOS-only; other platforms keep a normal bar.
  if (globalThis.vh?.platform === 'darwin') document.body.classList.add('mac');
  api.subscribe(onProgress, onJob);

  // Nothing can be listed until a folder is chosen, so that comes first.
  const arch = await api.archive();
  if (!arch.open) return firstRun(arch);

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
    banner('The archive is empty — bring in a phone export to get started.',
      { label: 'Import…', fn: openImport });
  } else if (!s.modelReady) {
    banner(`Model ${s.model} is not downloaded, so nothing can be transcribed. Audio still imports and plays. Run: npm run setup`);
  } else if (pending && !s.job.running) {
    // Import deliberately stops before transcription, which can run for days.
    // Saying nothing left imported recordings sitting in the queue with no hint
    // that a second, separate step exists.
    banner(`${pending} recording${pending > 1 ? 's' : ''} waiting to be transcribed.`,
      { label: 'Start transcribing', fn: () => api.transcribeStart({ order: 'named' }) });
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
    li.onclick = () => { state.year = state.year === y.year ? null : y.year; refilter(); };
    yl.append(li);
  }

  const cl = $('contacts');
  cl.replaceChildren();
  for (const c of cs.slice(0, 120)) {
    const li = el('li', state.contactId === c.id ? 'on' : '');
    li.title = `${c.display_name} — ${c.calls} calls, ${fmtDur(c.total_ms)}`;
    li.append(el('span', 'name', c.display_name), el('span', 'n', c.calls));
    li.onclick = () => { state.contactId = state.contactId === c.id ? null : c.id; state.contactName = state.contactId ? c.display_name : null; refilter(); };
    cl.append(li);
  }
}

function refilter() {
  state.offset = 0;
  renderFilters();
  loadSidebar();
  loadList(true);
}

/**
 * What is currently narrowing the list, and how to undo it.
 *
 * Filters could always be cleared by clicking the same row again, but nothing
 * said so — an invisible toggle is not an affordance. Showing the active filter
 * with a way out covers both of the heuristics at stake: the system says what
 * state it is in, and offers an exit that does not require guessing.
 *
 * A single "All" row per list would have been the other option, and is weaker: it
 * duplicates state in two places and says nothing once a year and a person are
 * applied together.
 */
function renderFilters() {
  const box = $('filters');
  box.replaceChildren();

  const active = [];
  if (state.year) active.push({ label: state.year, clear: () => { state.year = null; } });
  if (state.contactId) {
    active.push({
      label: state.contactName ?? 'selected person',
      clear: () => { state.contactId = null; state.contactName = null; },
    });
  }
  if (state.q) active.push({ label: `“${state.q}”`, clear: () => { $('q').value = ''; state.q = ''; } });

  box.hidden = active.length === 0;
  if (!active.length) return;

  box.append(el('span', 'muted tiny', 'Showing only'));
  for (const f of active) {
    const chip = el('button', 'filter-chip');
    chip.append(el('span', '', esc(String(f.label))), el('span', 'x', '×'));
    chip.title = 'Remove this filter';
    chip.onclick = () => { f.clear(); refilter(); };
    box.append(chip);
  }
  if (active.length > 1) {
    const all = el('button', 'small ghost', 'Show all');
    all.onclick = () => {
      state.year = null; state.contactId = null; state.contactName = null;
      $('q').value = ''; state.q = '';
      refilter();
    };
    box.append(all);
  }
}

const PAGE = 60;

/**
 * @param {boolean} reset  start again from the first page
 * @param {boolean} keepPlace  refetch everything already loaded and restore the
 *   scroll position. Used by the periodic refresh during a long job: reloading
 *   from page one there threw away every "Load more" and snapped the list back to
 *   the top every few seconds, which is unusable while a 42-hour run is going.
 */
async function loadList(reset, keepPlace = false) {
  if (reset) state.offset = 0;
  const pane = document.querySelector('.middle');
  const loaded = $('calls').children.length;
  const scrollTop = pane?.scrollTop ?? 0;

  const r = await api.list({
    q: state.q,
    contact: state.contactId,
    year: state.year,
    offset: keepPlace ? 0 : state.offset,
    limit: keepPlace ? Math.max(PAGE, loaded) : PAGE,
  });
  state.total = r.total;
  state.stems = r.stems ?? [];

  const ul = $('calls');
  if (reset || keepPlace) ul.replaceChildren();
  for (const row of r.rows) ul.append(callRow(row));
  if (keepPlace && pane) pane.scrollTop = scrollTop;

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

  // The player is wrapped so it can stick to the top of the pane: on a long
  // transcript it would otherwise scroll out of reach, leaving no way to pause or
  // scrub while reading.
  const player = el('div', 'player');
  const audio = el('audio');
  audio.controls = true;
  audio.preload = 'none';
  audio.src = api.mediaUrl(id);
  player.append(audio);

  // Redo just this one. Useful after changing the language or model, and for the
  // occasional recording the recognizer simply made a mess of.
  const again = el('button', 'small redo', rec.transcript_status === 'done'
    ? 'Transcribe again' : 'Transcribe this one');
  again.onclick = guard(async () => {
    again.disabled = true;
    await api.transcribeAgain(id);
  });
  player.append(again);
  d.append(player);

  if (rec.segments.length) {
    // Which phrases the current search matched. Computed from the stems the
    // search itself returned, so "matching" means the same thing in both places.
    state.hits = state.stems.length
      ? rec.segments.map((s, i) => (matchesStems(s.text) ? i : -1)).filter((i) => i >= 0)
      : [];
    state.hitAt = 0;

    const ul = el('ul', 'segments');
    rec.segments.forEach((s, i) => {
      const li = el('li', state.hits.includes(i) ? 'hit' : '');
      li.dataset.i = i;
      li.append(el('span', 't', fmtTime(s.t0)), el('span', '', markStems(s.text)));
      li.onclick = () => { audio.currentTime = s.t0 / 1000; audio.play(); };
      ul.append(li);
    });
    d.append(ul);

    // Landing at the top of a 27-minute call after searching for one phrase
    // means finding it twice. Go to it, in the text and in the audio.
    if (state.hits.length) {
      const jump = (n) => {
        state.hitAt = (n + state.hits.length) % state.hits.length;
        const i = state.hits[state.hitAt];
        const li = ul.children[i];
        li.scrollIntoView({ block: 'center' });
        audio.currentTime = rec.segments[i].t0 / 1000;
        for (const x of ul.children) x.classList.toggle('hit-now', x === li);
        counter.textContent = state.hits.length > 1
          ? `match ${state.hitAt + 1} of ${state.hits.length}`
          : '1 match';
      };
      const nav = el('div', 'hit-nav');
      const counter = el('span', 'muted tiny');
      const prev = el('button', 'small', '↑');
      const next = el('button', 'small', '↓');
      prev.title = 'Previous match';
      next.title = 'Next match';
      prev.onclick = () => jump(state.hitAt - 1);
      next.onclick = () => jump(state.hitAt + 1);
      nav.append(counter);
      if (state.hits.length > 1) nav.append(prev, next);
      player.append(nav);

      // Wait for layout before scrolling. Called synchronously after the list is
      // appended, scrollIntoView does nothing at all — the element has no
      // computed position yet — which left the pane at the top while the audio
      // had already seeked, so a working jump looked like a broken one.
      requestAnimationFrame(() => requestAnimationFrame(() => jump(0)));
    }

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

/* ======================= search matching ======================= */

/**
 * A phrase matches when it contains every stem of the query — the same AND
 * semantics the database search uses, so a highlighted line is one the search
 * would have found on its own.
 */
function matchesStems(text) {
  const lower = text.toLowerCase();
  return state.stems.every((s) => lower.includes(s));
}

/** Escapes first, then marks the stems, so no input can inject markup. */
function markStems(text) {
  let html = esc(text);
  for (const s of state.stems) {
    if (!s) continue;
    // Extend the mark to the end of the word, so a stem does not visually cut
    // a word in half.
    const re = new RegExp(`(${escapeRe(esc(s))}[\\p{L}\\p{N}]*)`, 'giu');
    html = html.replace(re, '<mark>$1</mark>');
  }
  return html;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\/* ======================= events ======================= */');

/* ======================= events ======================= */

/**
 * Wraps a click handler so a thrown error becomes a visible message.
 *
 * Without this, any exception inside an opener vanished into an unhandled
 * rejection and the button simply appeared dead — which is exactly how a stale
 * field name in one dialog presented itself.
 */
function guard(fn) {
  return async (...args) => {
    try { await fn(...args); } catch (e) { banner(e.message || String(e)); }
  };
}

function wire() {
  let t;
  $('q').oninput = (e) => {
    clearTimeout(t);
    const v = e.target.value.trim();
    t = setTimeout(() => { state.q = v; renderFilters(); loadList(true); }, 220);
  };
  $('clear').onclick = () => { $('q').value = ''; state.q = ''; renderFilters(); loadList(true); };
  $('more').onclick = () => { state.offset += PAGE; loadList(false); };

  $('btn-import').onclick = guard(openImport);
  $('imp-cancel').onclick = () => $('dlg-import').close();
  $('imp-go').onclick = guard(startImport);
  $('imp-src').onchange = onSourceChange;
  let ct;
  $('imp-custom').oninput = () => { clearTimeout(ct); ct = setTimeout(checkCustom, 250); };
  if (isDesktop) {
    $('imp-browse').hidden = false;
    $('imp-browse').onclick = guard(async () => {
      const r = await api.chooseFolder('open');
      if (!r.canceled) { $('imp-custom').value = r.dir; checkCustom(); }
    });
  }

  $('btn-jobs').onclick = guard(async () => { await refreshStats(); $('dlg-jobs').showModal(); });
  $('jobs-cancel').onclick = () => $('dlg-jobs').close();
  $('jobs-go').onclick = guard(startTranscribe);
  $('jobs-all-again').onclick = guard(async () => {
    if (!confirm('Discard every transcript and recognize the whole archive again?')) return;
    $('dlg-jobs').close();
    await api.transcribeAgain();
  });
  $('jobs-reindex').onclick = async () => {
    $('dlg-jobs').close();
    try { await api.reindex(); } catch (e) { banner(e.message); }
  };

  $('prog-cancel').onclick = guard(async () => {
    // Say so immediately. Stopping ends the recognizer mid-file, but the loop
    // still has to unwind, and a button that looks inert invites a second click.
    const b = $('prog-cancel');
    b.disabled = true;
    b.textContent = 'Stopping…';
    await api.cancel();
  });

  $('btn-settings').onclick = guard(openSettings);
  $('set-close').onclick = () => { $('dlg-settings').close(); refreshAll(); };

  $('btn-people').onclick = guard(openPeople);
  $('people-close').onclick = () => { $('dlg-people').close(); refreshAll(); };
  $('vcf').onchange = guard(importVCard);
}

/* ======================= first run ======================= */

function firstRun(arch) {
  document.querySelector('.layout').hidden = true;
  document.querySelector('.top').hidden = true;
  $('foot').hidden = true;
  $('firstrun').hidden = false;

  const input = $('fr-path');
  const hint = $('fr-hint');
  const go = $('fr-go');
  input.value = arch.suggestion ?? '';

  let seq = 0;
  const check = async () => {
    const dir = input.value.trim();
    const mine = ++seq;
    if (!dir) { hint.textContent = 'Paste or type a folder path.'; go.disabled = true; return; }
    try {
      const r = await api.archiveInspect(dir);
      if (mine !== seq) return;
      hint.textContent = describeFolder(r);
      go.disabled = Boolean(r.error);
      go.textContent = r.isArchive ? 'Open this archive' : 'Create archive here';
    } catch (e) {
      if (mine === seq) { hint.textContent = e.message; go.disabled = true; }
    }
  };

  let t;
  input.oninput = () => { clearTimeout(t); t = setTimeout(check, 250); };
  input.onkeydown = (e) => { if (e.key === 'Enter' && !go.disabled) go.click(); };

  // A native picker exists only in the desktop shell; the browser has no way to
  // turn a chosen folder into a path, so there the field is the only option.
  if (isDesktop) {
    $('fr-browse').hidden = false;
    $('fr-browse').onclick = async () => {
      const r = await api.chooseFolder('create');
      if (!r.canceled) { input.value = r.dir; check(); }
    };
  }
  go.onclick = async () => {
    go.disabled = true;
    try {
      await api.archiveOpen(input.value.trim());
      location.reload();
    } catch (e) { hint.textContent = e.message; go.disabled = false; }
  };

  if (arch.recents.length) {
    $('fr-recents').hidden = false;
    const ul = $('fr-recents-list');
    ul.replaceChildren();
    for (const p of arch.recents) {
      const li = el('li');
      li.append(el('span', 'name', esc(p)));
      li.onclick = () => { input.value = p; check(); };
      ul.append(li);
    }
  }
  check();
  input.focus();
}

/** One sentence saying exactly what pressing the button will do. */
function describeFolder(r) {
  if (r.error) return r.error;
  if (r.isArchive) {
    return r.recordings
      ? `Existing archive — ${r.recordings} recordings, format ${r.formatVersion}.`
      : `Existing archive, currently empty (format ${r.formatVersion}).`;
  }
  if (!r.exists) return 'Folder does not exist yet — it will be created.';
  if (r.empty) return 'Empty folder — a new archive will be set up here.';
  return 'Folder has other files in it; archive folders will be added alongside them.';
}

/* ======================= settings ======================= */

async function openSettings() {
  const [{ usage, actions, config }, arch] = await Promise.all([api.maintenance(), api.archive()]);

  const u = $('set-usage');
  u.replaceChildren();
  const line = (label, v) => {
    const row = el('div', 'usage-row');
    row.append(el('span', 'muted', label), el('span', '', v));
    u.append(row);
  };
  line('Archive root', usage.root);
  line('Recordings', `${usage.recordings.files} files · ${fmtBytes(usage.recordings.bytes)}`);
  line('Playable copies', `${usage.audio.files} files · ${fmtBytes(usage.audio.bytes)}`);
  line('Transcripts', `${usage.transcripts.files} files · ${fmtBytes(usage.transcripts.bytes)}`);
  line('Search index', fmtBytes(usage.index.bytes));
  line('Contact names', usage.names ? 'contacts.json present' : 'none');

  // Where each value came from matters as much as the value: it answers
  // "why is it doing that" without hunting through the code.
  const c = $('set-config');
  c.replaceChildren();
  for (const [key, { value, from }] of Object.entries(config.values)) {
    const row = el('div', 'usage-row');
    row.append(el('span', 'muted', key));
    const right = el('span', '');
    right.append(el('span', '', esc(String(value))), el('span', 'from', esc(from)));
    row.append(right);
    c.append(row);
  }
  if (!config.configFileExists) {
    c.append(el('div', 'usage-row muted tiny', '<span>no config.json — all values are defaults</span><span></span>'));
  }

  // archive folder
  const ap = $('set-archive-path');
  const ahint = $('set-archive-hint');
  ap.value = usage.root ?? '';
  ahint.textContent = '';
  let aseq = 0;
  const acheck = async () => {
    const mine = ++aseq;
    const r = await api.archiveInspect(ap.value.trim()).catch((e) => ({ error: e.message }));
    if (mine === aseq) ahint.textContent = describeFolder(r);
  };
  let at;
  ap.oninput = () => { clearTimeout(at); at = setTimeout(acheck, 250); };
  if (isDesktop) {
    $('set-archive-browse').hidden = false;
    $('set-archive-browse').onclick = async () => {
      const r = await api.chooseFolder('open');
      if (!r.canceled) { ap.value = r.dir; acheck(); }
    };
  }
  $('set-archive-open').onclick = async () => {
    try { await api.archiveOpen(ap.value.trim()); location.reload(); }
    catch (e) { ahint.textContent = e.message; }
  };

  const rec = $('set-recents');
  rec.replaceChildren();
  for (const p of arch.recents) {
    const li = el('li');
    li.append(el('span', 'name', esc(p)));
    li.title = 'Open this archive';
    li.onclick = async () => {
      try { await api.archiveOpen(p); location.reload(); } catch (e) { banner(e.message); }
    };
    rec.append(li);
  }

  // language and region — every value picked from a list, since none of these
  // are guessable: a language code, a model name, or three interlocking numbers
  // that describe a numbering plan.
  const v = (k) => config.values[k].value;
  const ch = await api.choices();

  fill('s-language', ch.languages.map((l) => [l.code, `${l.name} (${l.code})`]), v('language'));
  fill('s-model', ch.models.map((m) => [m.id, `${m.name} · ${m.size}`]), v('model'));
  fill('s-silence', ch.silenceLevels.map((s) => [String(s.value), s.name]), String(v('silencePeakDb')));
  fill('s-plan',
    [...ch.numberingPlans.map((p) => [p.id, p.name]), ['custom', 'Custom…']],
    ch.currentPlan ?? 'custom');

  const plans = new Map(ch.numberingPlans.map((p) => [p.id, p]));
  const syncPlan = () => {
    const id = $('s-plan').value;
    const custom = id === 'custom';
    $('s-custom-plan').hidden = !custom;
    const p = custom
      ? { countryCode: $('s-cc').value.trim(), trunkPrefix: $('s-trunk').value.trim(), nsnLength: $('s-nsn').value }
      : plans.get(id);
    // Spell out what the choice means, so the effect is visible before saving.
    $('s-plan-summary').textContent = p
      ? `+${p.countryCode} · trunk ${p.trunkPrefix || 'none'} · ${p.nsnLength} digits`
      : '';
    if (!custom && p) {
      $('s-cc').value = p.countryCode;
      $('s-trunk').value = p.trunkPrefix;
      $('s-nsn').value = p.nsnLength;
    }
  };
  $('s-plan').onchange = syncPlan;
  for (const id of ['s-cc', 's-trunk', 's-nsn']) $(id).oninput = syncPlan;
  $('s-cc').value = v('countryCode');
  $('s-trunk').value = String(v('trunkPrefix')).replace('(none)', '');
  $('s-nsn').value = v('nsnLength');
  syncPlan();

  // Raw value, not the truncated display copy — saving the ellipsis back would
  // silently replace a custom prompt with a broken fragment.
  $('s-prompt').value = config.stored?.prompt ?? '';

  const locked = new Set(config.lockedByEnv ?? []);
  for (const [key, id] of Object.entries({
    language: 's-language', model: 's-model', countryCode: 's-cc',
    trunkPrefix: 's-trunk', nsnLength: 's-nsn', silencePeakDb: 's-silence', prompt: 's-prompt',
  })) {
    if (locked.has(key) && ['countryCode', 'trunkPrefix', 'nsnLength'].includes(key)) $('s-plan').disabled = true;
    if (locked.has(key)) {
      // An environment variable is winning, so a saved value would appear to do
      // nothing. Say so instead of letting the field lie.
      $(id).disabled = true;
      $(id).title = 'Set by an environment variable for this run';
    }
  }

  $('s-save').onclick = async () => {
    const patch = {
      language: $('s-language').value,
      model: $('s-model').value,
      prompt: $('s-prompt').value.trim() || null,
      silencePeakDb: Number($('s-silence').value),
      numbering: {
        countryCode: $('s-cc').value.trim() || '7',
        trunkPrefix: $('s-trunk').value.trim(),
        nsnLength: Number($('s-nsn').value) || 10,
      },
    };
    try {
      await api.updateSettings(patch);
      $('s-saved').textContent = 'Saved. Contact names refresh on the next rebuild.';
      await openSettings();
    } catch (e) { $('s-saved').textContent = e.message; }
  };

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

/** Fills a select from [value, label] pairs and selects one. */
function fill(id, pairs, selected) {
  const s = $(id);
  s.replaceChildren();
  for (const [value, label] of pairs) {
    const o = el('option', '', esc(label));
    o.value = value;
    s.append(o);
  }
  // An unknown stored value must stay visible rather than silently becoming
  // whatever happens to be first in the list.
  if (selected !== undefined && selected !== null && !pairs.some(([v]) => v === selected)) {
    const o = el('option', '', `${esc(String(selected))} (not in list)`);
    o.value = selected;
    s.append(o);
  }
  s.value = selected;
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
    const o = el('option', '', `${esc(s.label)} — ${s.files ? s.files + ' files waiting' : 'empty'}`);
    o.value = s.dir;
    sel.append(o);
  }
  sel.append(Object.assign(el('option', '', 'Choose another folder…'), { value: CUSTOM }));

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
let jobStartedAt = null;

/** Linear projection from elapsed time — crude, and honest about being a guess. */
function etaText(done, total) {
  if (!jobStartedAt || !done || !total || done >= total) return '';
  const elapsed = Date.now() - jobStartedAt;
  const perItem = elapsed / done;
  const left = perItem * (total - done);
  const rate = 3600000 / perItem;
  return `${fmtSpan(left)} left · ${rate < 100 ? rate.toFixed(0) : Math.round(rate)}/hour`;
}

function fmtSpan(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

function onJob(j) {
  if (j.running) { showProgress(j); return; }
  jobStartedAt = null;
  $('progress').hidden = true;
  const b = $('prog-cancel');
  b.disabled = false;
  b.textContent = 'Stop';
  banner(j.error ? `Error: ${j.error}` : null);
  refreshAll();
}

function showProgress({ kind, done = 0, total = 0, file, startedAt, stopping }) {
  $('progress').hidden = false;
  $('prog-label').textContent = stopping ? 'Stopping…' : (LABEL[kind] ?? kind);
  $('prog-count').textContent = total ? `${done} of ${total}` : '';
  $('prog-fill').style.width = total ? `${(done / total) * 100}%` : '0';
  if (file) $('prog-file').textContent = file;

  // A run measured in tens of hours needs to say when it will be done. Without
  // it the only honest answer to "how long" was to go and count in the terminal.
  if (startedAt) jobStartedAt = Date.parse(startedAt);
  $('prog-eta').textContent = etaText(done, total);
  if (stopping) {
    const b = $('prog-cancel');
    b.disabled = true;
    b.textContent = 'Stopping…';
  }

  // Refresh the list during long jobs, but not on every single event.
  if (!refreshTimer) {
    // Longer than it was, and non-destructive: a job that runs for days should not
    // redraw the list under the reader's hands.
    refreshTimer = setTimeout(() => { refreshTimer = null; refreshAll({ keepPlace: true }); }, 8000);
  }
}

async function refreshAll({ keepPlace = false } = {}) {
  await Promise.all([refreshStats(), loadSidebar()]);
  await loadList(!keepPlace, keepPlace);
}

/* ======================= formatting ======================= */

/**
 * @param {string|null} text
 * @param {{label: string, fn: Function}} [action]  a banner that states a problem
 *   without offering the fix makes the user hunt for it.
 */
function banner(text, action) {
  const b = $('banner');
  b.hidden = !text;
  $('banner-text').textContent = text ?? '';
  const btn = $('banner-action');
  btn.hidden = !action;
  if (action) {
    btn.textContent = action.label;
    btn.onclick = guard(action.fn);
  }
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
