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

const state = { q: '', stems: [], contactId: null, contactName: null, year: null, day: null, review: null, reviewLabel: null, offset: 0, total: 0,
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

  // The pane on the right would otherwise say "pick a recording" for as long as
  // nobody has. Seven years of calls have something to say on their own.
  await showOverview();

  // Checked after the list is up, not before: a missing recognizer does not stop
  // anyone from reading transcripts that already exist, so it must not stand in
  // the way of opening the archive.
  await loadSetup({ openIfIncomplete: true });

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
    banner(`Model ${s.model} is not downloaded, so nothing can be transcribed. Audio still imports and plays.`,
      { label: 'Set up…', fn: guard(async () => { await loadSetup(); $('dlg-setup').showModal(); }) });
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
  const [ys, cs, rev] = await Promise.all([api.years(), api.people(), api.review().catch(() => null)]);

  // Recognition does not fail loudly: it returns one line for an hour of speech
  // as readily as a real transcript. Nobody finds those by scrolling 5,000
  // recordings, so the archive has to point at them.
  const rl = $('review');
  rl.replaceChildren();
  $('review-box').hidden = !rev?.reasons?.length;
  for (const r of rev?.reasons ?? []) {
    const li = el('li', state.review === r.key ? 'on' : '');
    li.title = `${r.hint} — ${fmtDur(r.ms)} of audio`;
    li.append(el('span', 'name', r.label), el('span', 'n', r.n));
    li.onclick = () => {
      state.review = state.review === r.key ? null : r.key;
      state.reviewLabel = state.review ? r.label : null;
      refilter();
    };
    rl.append(li);
  }

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
    const li = el('li', state.contactName === c.name ? 'on' : '');
    li.title = `${c.name} — ${c.calls} calls, ${fmtDur(c.total_ms)}`
      + (c.numbers > 1 ? `, across ${c.numbers} numbers` : '');
    li.append(el('span', 'name', c.name), el('span', 'n', c.calls));
    li.onclick = () => {
      state.contactName = state.contactName === c.name ? null : c.name;
      refilter();
    };
    cl.append(li);
  }
}

function refilter() {
  state.offset = 0;
  renderFilters();
  loadSidebar();
  loadList(true);
  syncDetail();
}

/**
 * The right-hand pane follows the filters, always.
 *
 * It used to be set only where a click happened, so removing a person's filter
 * left their panel standing and the only way back to the archive was clicking
 * the logo — which nothing advertised. One function decides it instead: whatever
 * is selected is what is shown.
 */
function syncDetail() {
  state.currentId = null;
  if (state.contactName) showPerson(state.contactName);
  else showOverview();
}

/** Back to the whole archive, from any combination of filters. */
function clearFilters() {
  state.year = null;
  state.day = null;
  state.contactId = null;
  state.contactName = null;
  state.review = null;
  state.reviewLabel = null;
  $('q').value = '';
  state.q = '';
  refilter();
}

/**
 * The next or previous recording in the list as it is currently filtered.
 * Loads another page when it runs off the end, so a long filter walks through
 * without the reader ever meeting the "load more" button.
 */
async function stepRecording(delta) {
  const items = [...$('calls').children];
  if (!items.length) return;
  const at = items.findIndex((li) => Number(li.dataset.id) === state.currentId);
  // Nothing open yet: the first item is the obvious place to start.
  if (at === -1) return openRecording(Number(items[0].dataset.id));

  const next = at + delta;
  if (next < 0) return;
  if (next >= items.length) {
    if (items.length >= state.total) return;      // that was the last one
    state.offset += PAGE;
    await loadList(false);
    const grown = [...$('calls').children];
    if (next < grown.length) return openRecording(Number(grown[next].dataset.id));
    return;
  }
  const li = items[next];
  li.scrollIntoView({ block: 'nearest' });
  return openRecording(Number(li.dataset.id));
}

/** A visible way back, at the top of whatever the pane is showing. */
function backTo(label, fn) {
  const b = el('button', 'backlink', `‹ ${label}`);
  b.onclick = guard(fn);
  return b;
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
  if (state.contactName) {
    active.push({
      label: state.contactName,
      clear: () => { state.contactName = null; },
    });
  }
  if (state.q) active.push({ label: `“${state.q}”`, clear: () => { $('q').value = ''; state.q = ''; } });
  if (state.day) {
    active.push({
      label: new Date(`${state.day}T12:00:00`).toLocaleDateString(undefined,
        { day: 'numeric', month: 'long', year: 'numeric' }),
      clear: () => { state.day = null; },
    });
  }
  if (state.review) {
    active.push({
      label: state.reviewLabel ?? 'needs review',
      clear: () => { state.review = null; state.reviewLabel = null; },
    });
  }

  box.hidden = active.length === 0;
  if (!active.length) return;

  if (state.review) {
    const again = el('button', 'small', `Transcribe these ${state.total} again`);
    again.title = 'Discards their transcripts and recognizes them from the audio again';
    again.onclick = guard(async () => {
      // Everything destructive here says what it costs before doing it. This
      // discards work: the transcripts go, and recognition runs for as long as
      // the audio takes.
      if (!confirm(`Discard the transcripts of these ${state.total} recordings and recognize them again?`)) return;
      again.disabled = true;
      const r = await api.transcribeAgain(null, state.review);
      if (r?.error) offerSetup(r.error, r.needsModel);
    });
    box.append(again);
  }

  box.append(el('span', 'muted tiny', 'Showing only'));
  for (const f of active) {
    const chip = el('button', 'filter-chip');
    chip.append(el('span', '', esc(String(f.label))), el('span', 'x', '×'));
    chip.title = 'Remove this filter';
    chip.onclick = () => { f.clear(); refilter(); };
    box.append(chip);
  }
  // Offered whenever anything is narrowing the list, not only when two things
  // are: with one filter active there was no single control that undid it and
  // returned to the archive.
  const all = el('button', 'small ghost', 'Show everything');
  all.title = 'Clear all filters and go back to the whole archive';
  all.onclick = guard(() => clearFilters());
  box.append(all);
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
    contactName: state.contactName,
    year: state.year,
    day: state.day,
    review: state.review,
    offset: keepPlace ? 0 : state.offset,
    limit: keepPlace ? Math.max(PAGE, loaded) : PAGE,
  });
  state.total = r.total;
  state.stems = r.stems ?? [];
  // Again, now that the count is known: the filter bar names how many recordings
  // an action would touch, and naming the previous filter's count is worse than
  // naming none.
  renderFilters();

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

/* ======================= the archive as a whole ======================= */

/**
 * A year of days as a 7×53 grid, the shape a decade of habit is legible in.
 *
 * A month calendar was the other candidate and loses at both ends: on a dense
 * archive nearly every cell is filled and carries no information, and crossing
 * seven years takes eighty pages. Here a year is one strip and the whole archive
 * fits on a screen — you can see a quiet year go pale.
 *
 * Intensity comes from the archive's own distribution, not fixed thresholds; see
 * stats.days() for why one 98-call day would otherwise flatten everything else.
 */
function heatmap(data, { onPick }) {
  const byDay = new Map(data.rows.map((r) => [r.day, r]));
  const years = [...new Set(data.rows.map((r) => r.day.slice(0, 4)))].sort();
  const box = el('div', 'chart');
  box.append(el('h3', 'sect-title', 'Every day'));

  for (const year of years) {
    const strip = el('div', 'heat-year');
    strip.append(el('span', 'heat-label', year));
    const grid = el('div', 'heat-grid');

    const start = new Date(`${year}-01-01T12:00:00`);
    const end = new Date(`${year}-12-31T12:00:00`);
    // Monday-first columns: leading blanks keep weekdays on the same row.
    const lead = (start.getDay() + 6) % 7;
    for (let i = 0; i < lead; i++) grid.append(el('span', 'heat-cell blank'));

    for (let t = new Date(start); t <= end; t.setDate(t.getDate() + 1)) {
      const iso = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
      const hit = byDay.get(iso);
      const cell = el('span', `heat-cell${hit ? '' : ' none'}${state.day === iso ? ' on' : ''}`);
      if (hit) {
        const level = Math.min(1, hit.ms / data.cap);
        cell.style.opacity = String(0.25 + level * 0.75);
        cell.title = `${iso} · ${hit.calls} call${hit.calls > 1 ? 's' : ''} · ${fmtDur(hit.ms)}`;
        cell.onclick = () => onPick(iso);
      }
      grid.append(cell);
    }
    strip.append(grid);
    box.append(strip);
  }
  return box;
}

/** Loads and appends the map, or nothing at all when there is too little to map. */
async function appendHeatmap(d, name = null) {
  const data = await api.days(name).catch(() => null);
  if (!data?.worthShowing) return;
  d.append(heatmap(data, { onPick: (day) => { state.day = day; refilter(); } }));
}


/**
 * Seven years read at once, in the pane that otherwise says "pick a recording".
 *
 * Charts are hand-drawn SVG. There is no build step in this project and adding
 * one for four bar charts would be a poor trade — and inline SVG inherits the
 * palette, so it follows the light/dark setting for free.
 */
function bars(rows, { value, label, title, format }) {
  const max = Math.max(...rows.map(value), 1);
  const box = el('div', 'chart');
  box.append(el('h3', 'sect-title', title));
  const grid = el('div', 'chart-bars');
  for (const row of rows) {
    const v = value(row);
    const bar = el('div', 'chart-bar');
    bar.title = `${label(row)} — ${format(v)}`;
    const fill = el('div', 'chart-fill');
    // A minimum height so an empty period still reads as a labelled column
    // rather than a gap in the axis.
    fill.style.height = `${Math.max(2, (v / max) * 100)}%`;
    bar.append(fill, el('span', 'chart-label', label(row)));
    grid.append(bar);
  }
  box.append(grid);
  return box;
}

/** One person: how long you have known them, and the shape of it year by year. */
async function showPerson(name) {
  const p = await api.person(name).catch(() => null);
  const d = $('detail');
  if (!p || p.error) return;
  state.currentId = null;
  for (const li of $('calls').children) li.classList.remove('on');

  d.replaceChildren();
  d.append(backTo('Your archive', () => clearFilters()));
  d.append(el('h2', '', esc(p.name)));

  const t = p.totals;
  const years = t.first && t.last
    ? Math.max(1, Math.round((Date.parse(t.last) - Date.parse(t.first)) / 31557600000))
    : 0;
  d.append(el('div', 'sub', [
    `${t.calls.toLocaleString()} calls`,
    fmtDur(t.ms),
    years ? `over ${years} year${years > 1 ? 's' : ''}` : '',
    t.numbers > 1 ? `${t.numbers} numbers` : '',
  ].filter(Boolean).join(' · ')));

  d.append(el('div', 'muted tiny', `First ${fmtMonthYear(t.first)} · last ${fmtMonthYear(t.last)}`
    + ` · usually ${fmtDur(Math.round(t.avgMs))}`));

  d.append(bars(p.byYear, {
    title: 'Hours a year together',
    value: (r) => r.ms,
    label: (r) => r.year,
    format: (v) => fmtDur(v),
  }));

  if (p.words?.length) {
    const box = el('div', 'chart');
    box.append(el('h3', 'sect-title', 'Words that stand out'));
    const line = el('div', 'words');
    line.textContent = p.words.map((w) => w.word).join(', ');
    line.title = p.words.map((w) => `${w.word} — in ${w.calls} calls`).join('\n');
    box.append(line);
    d.append(box);
  }

  await appendHeatmap(d, p.name);

  if (p.byHour.length > 1) {
    d.append(bars(p.byHour, {
      title: 'When you talk',
      value: (r) => r.ms,
      label: (r) => (r.hour % 6 === 0 ? String(r.hour) : ''),
      format: (v) => fmtDur(v),
    }));
  }

  const dir = Object.fromEntries(p.byDirection.map((x) => [x.direction, x.calls]));
  const foot = [];
  if (dir.Incoming) foot.push(`${dir.Incoming.toLocaleString()} incoming`);
  if (dir.Outgoing) foot.push(`${dir.Outgoing.toLocaleString()} outgoing`);
  if (foot.length) d.append(el('div', 'muted tiny', foot.join(' · ')));

  if (p.longest.length) {
    const box = el('div', 'chart');
    box.append(el('h3', 'sect-title', 'Longest conversations'));
    for (const r of p.longest) {
      const row = el('div', 'person-row');
      row.append(el('span', 'name', fmtWhenFull(r.started_at)));
      row.append(el('span', ''), el('span', 'person-n', fmtDur(r.ms)));
      row.onclick = () => openRecording(r.id);
      box.append(row);
    }
    d.append(box);
  }
}

async function showOverview() {
  const o = await api.overview().catch(() => null);
  const d = $('detail');
  if (!o) return;
  state.currentId = null;
  history.replaceState(null, '', '#');
  for (const li of $('calls').children) li.classList.remove('on');

  d.replaceChildren();
  d.append(el('h2', '', 'Your archive'));

  const t = o.totals;
  const span = t.first && t.last
    ? `${fmtMonthYear(t.first)} — ${fmtMonthYear(t.last)}`
    : '';
  d.append(el('div', 'sub', [
    `${t.recordings.toLocaleString()} recordings`,
    fmtDur(t.ms),
    `${t.people} people`,
    span,
  ].filter(Boolean).join(' · ')));

  // Before the charts: this is the part worth reading today, and the only view
  // that surfaces a conversation nobody would think to search for.
  const today = await api.onThisDay().catch(() => null);
  if (today?.rows?.length) {
    const box = el('div', 'chart');
    const when = new Date(`2000-${today.monthDay}T12:00:00`)
      .toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
    box.append(el('h3', 'sect-title', `On this day · ${when}`));
    for (const r of today.rows.slice(0, 8)) {
      // Its own grid: the people rows put a bar in the middle column, and a bare
      // year floating in that space reads as a mistake.
      const row = el('div', 'day-row');
      row.append(el('span', 'name', esc(r.name ?? 'Unknown number')));
      row.append(el('span', 'muted tiny', r.started_at.slice(0, 4)));
      row.append(el('span', 'person-n', fmtDur(r.ms)));
      row.onclick = () => openRecording(r.id);
      box.append(row);
    }
    if (today.rows.length > 8) {
      box.append(el('div', 'muted tiny', `and ${today.rows.length - 8} more`));
    }
    d.append(box);
  }

  if (o.words?.length) {
    // Not the commonest words — those are "да" and "ну" in every year alike —
    // but the ones that stand out against the rest of the archive.
    const box = el('div', 'chart');
    box.append(el('h3', 'sect-title', 'What each year was about'));
    for (const y of o.words) {
      const row = el('div', 'day-row words-row');
      row.append(el('span', 'name', y.year));
      row.append(el('span', 'words', y.words.map((w) => esc(w.word)).join(', ')));
      row.title = y.words.map((w) => `${w.word} — in ${w.calls} calls`).join('\n');
      box.append(row);
    }
    d.append(box);
  }

  d.append(bars(o.byYear, {
    title: 'Hours a year',
    value: (r) => r.ms,
    label: (r) => r.year,
    format: (v) => fmtDur(v),
  }));

  await appendHeatmap(d);

  // Ranked by time rather than by number of calls: 2,315 recordings under a
  // minute account for 17 hours, while 33 over an hour account for 49. Counting
  // calls would put a bank's notifications above a parent.
  const people = el('div', 'chart');
  people.append(el('h3', 'sect-title', 'Most time spent with'));
  const maxMs = Math.max(...o.topPeople.map((p) => p.ms), 1);
  for (const p of o.topPeople) {
    const row = el('div', 'person-row');
    row.append(el('span', 'name', esc(p.name)));
    const track = el('span', 'person-track');
    const fill = el('span', 'person-fill');
    fill.style.width = `${(p.ms / maxMs) * 100}%`;
    track.append(fill);
    row.append(track, el('span', 'person-n', fmtDur(p.ms)));
    row.title = `${p.calls} calls${p.numbers > 1 ? ` across ${p.numbers} numbers` : ''}`
      + ` · ${fmtMonthYear(p.first)} — ${fmtMonthYear(p.last)}`;
    row.onclick = () => {
      const c = document.querySelectorAll('#contacts li');
      for (const li of c) if (li.textContent.startsWith(p.name)) { li.click(); return; }
    };
    people.append(row);
  }
  d.append(people);

  d.append(bars(o.byHour, {
    title: 'When calls happen',
    value: (r) => r.ms,
    label: (r) => (r.hour % 6 === 0 ? String(r.hour) : ''),
    format: (v) => fmtDur(v),
  }));

  const dir = Object.fromEntries(o.byDirection.map((x) => [x.direction, x.calls]));
  const foot = [];
  if (dir.Incoming) foot.push(`${dir.Incoming.toLocaleString()} incoming`);
  if (dir.Outgoing) foot.push(`${dir.Outgoing.toLocaleString()} outgoing`);
  if (dir.unknown) foot.push(`${dir.unknown.toLocaleString()} without a direction recorded`);
  d.append(el('div', 'muted tiny', foot.join(' · ')));

  const longest = o.longest?.[0];
  if (longest) {
    const line = el('div', 'muted tiny longest');
    line.append(document.createTextNode('Longest conversation: '));
    const a = el('button', 'linkish', `${fmtDur(longest.ms)} with ${esc(longest.name ?? 'unknown')}`);
    a.onclick = () => openRecording(longest.id);
    line.append(a);
    d.append(line);
  }
}

function fmtMonthYear(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
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
  // Where this came from, and how to get back there. Opening a recording used to
  // be a one-way door: the pane was replaced and nothing said what replaced it.
  d.append(state.contactName
    ? backTo(state.contactName, () => showPerson(state.contactName))
    : backTo('Your archive', () => showOverview()));
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

  // Left and right walk the current filter without going back to the list —
  // the way a mail client walks a folder. With 1,897 calls to one person, this
  // removes more scrolling than any view does.
  document.addEventListener('keydown', (e) => {
    if (document.querySelector('dialog[open]')) return;
    if (/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName ?? '')) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      stepRecording(e.key === 'ArrowRight' ? 1 : -1);
    }
  });

  // Escape steps back one level, the way it does everywhere else.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
    if (document.activeElement === $('q')) return;
    if (state.currentId) syncDetail();
    else if (state.contactName || state.year || state.day || state.review || state.q) clearFilters();
  });

  // Clicking the name goes back to the archive as a whole — the only way back
  // out of a recording, and where people already reach for "home".
  const brand = document.querySelector('.brand');
  brand.title = 'Back to the whole archive';
  brand.onclick = guard(() => clearFilters());

  $('btn-setup').onclick = guard(async () => { await loadSetup(); $('dlg-setup').showModal(); });
  $('setup-close').onclick = () => $('dlg-setup').close();
  $('setup-recheck').onclick = guard(() => loadSetup());
  $('setup-copy').onclick = guard(async () => {
    await navigator.clipboard.writeText(setup?.installCommand ?? '');
    $('setup-copy').textContent = 'Copied';
    setTimeout(() => { $('setup-copy').textContent = 'Copy'; }, 1500);
  });
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
  const [{ usage, actions, config }, arch, about] = await Promise.all([
    api.maintenance(), api.archive(), api.about().catch(() => null),
  ]);
  renderAbout(about);

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
  try {
    // The IPC transport answers with an object, HTTP throws on 409 — a refusal
    // has to surface either way, or pressing Transcribe does nothing visible.
    const r = await api.transcribeStart({ order });
    if (r?.error) offerSetup(r.error, r.needsModel);
  } catch (e) {
    offerSetup(e.message, /not downloaded/i.test(e.message));
  }
}

/** States the problem and, when it is a missing model, opens the way to fix it. */
function offerSetup(message, needsModel) {
  banner(message, needsModel
    ? { label: 'Set up…', fn: guard(async () => { await loadSetup(); $('dlg-setup').showModal(); }) }
    : undefined);
}

/* ======================= progress ======================= */

const LABEL = {
  import: 'Importing', transcribe: 'Transcribing', reindex: 'Rebuilding index',
  model: 'Downloading the speech model',
  backfill: 'Attaching metadata',
  'maintenance:reindex': 'Rebuilding index',
  'maintenance:names': 'Clearing contact names',
  'maintenance:transcripts': 'Deleting transcripts',
  'maintenance:everything': 'Deleting everything',
};

function onProgress(p) {
  if (p.phase === 'log') return;
  showProgress({ kind: p.phase, done: p.done, total: p.total, file: p.file, fileMs: p.fileMs, filePercent: p.filePercent });
}

let refreshTimer = null;
let tickTimer = null;
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
  clearTimeout(tickTimer);
  jobStartedAt = null;
  currentFile = null;
  $('progress').hidden = true;
  const b = $('prog-cancel');
  b.disabled = false;
  b.textContent = 'Stop';
  // Three outcomes, not two. A job can also finish having failed on every single
  // recording, which the runner reports as ordinary completion — so this used to
  // clear the banner and say nothing, and pressing Transcribe looked like it
  // started and quietly stopped.
  const r = j.result ?? {};
  if (j.error) {
    banner(`Error: ${j.error}`);
  } else if (r.failed && !r.done) {
    offerSetup(`Nothing could be transcribed — ${r.failed} of ${r.total} failed.` +
      (r.lastError ? ` ${r.lastError}` : ''), /model/i.test(r.lastError ?? ''));
  } else if (r.failed) {
    banner(`${r.done} transcribed, ${r.failed} failed.` + (r.lastError ? ` Last error: ${r.lastError}` : ''));
  } else {
    banner(null);
  }
  // A finished download changes what the app can do, so re-probe rather than
  // leaving the dialog claiming the model is still missing.
  if (j.kind === 'model') loadSetup();
  refreshAll();
}

/** When the current file started, so a long one can show that it is progressing. */
let fileStartedAt = null;
let currentFile = null;

function showProgress({ kind, done = 0, total = 0, file, fileMs, filePercent, startedAt, stopping }) {
  $('progress').hidden = false;
  $('prog-label').textContent = stopping ? 'Stopping…' : (LABEL[kind] ?? kind);
  // Counting bytes as if they were files would read as "412000000 of 1500000000".
  $('prog-count').textContent = !total ? ''
    : kind === 'model' ? `${fmtBytes(done)} of ${fmtBytes(total)}`
    : `${done} of ${total}`;
  // The part of the current recording already recognized counts towards the bar.
  // Otherwise a single hour-long call leaves it frozen at the same width for an
  // hour, which is what made a working job look like a stuck one.
  const fraction = total ? (done + (filePercent ?? 0) / 100) / total : 0;
  $('prog-fill').style.width = `${Math.min(100, fraction * 100)}%`;
  if (file) {
    // A single recording can be six hours long, and recognition runs slower than
    // realtime. Saying only its name leaves the window looking frozen, so say how
    // big it is and how long it has been running.
    if (file !== currentFile) { currentFile = file; fileStartedAt = Date.now(); }
    const parts = [file];
    if (fileMs) parts.push(fmtSpan(fileMs) + ' long');
    if (filePercent != null) parts.push(`${filePercent}% recognized`);
    const elapsed = Date.now() - fileStartedAt;
    if (elapsed > 20000) parts.push(fmtSpan(elapsed) + ' on this one');
    $('prog-file').textContent = parts.join('  ·  ');
  }

  // A run measured in tens of hours needs to say when it will be done. Without
  // it the only honest answer to "how long" was to go and count in the terminal.
  if (startedAt) jobStartedAt = Date.parse(startedAt);
  $('prog-eta').textContent = etaText(done, total);
  if (stopping) {
    const b = $('prog-cancel');
    b.disabled = true;
    b.textContent = 'Stopping…';
  }

  // Redraw the elapsed figure even when no event arrives — a long recording
  // produces exactly one progress event and then silence for hours.
  clearTimeout(tickTimer);
  if (!stopping) tickTimer = setTimeout(() => showProgress({ kind, done, total, file, fileMs, filePercent, stopping }), 15000);

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

/**
 * Which build this is, and where its pieces live.
 *
 * The version is the first thing any bug report needs and an installed app
 * offers no other way to find it. The paths are here because the per-user model
 * directory and the settings file are exactly what someone needs when something
 * is missing, and neither is guessable.
 */
function renderAbout(about) {
  const box = $('set-about');
  box.replaceChildren();
  if (!about) return;

  const line = (label, v) => {
    const row = el('div', 'usage-row');
    row.append(el('span', 'muted', label), el('span', '', v));
    box.append(row);
  };
  const r = about.runtime ?? {};
  line('Version', `${about.name} ${about.version}`);
  line('Running as', about.shell === 'desktop' ? 'desktop app' : 'in a browser');
  // 'darwin' is what the runtime calls it, not what anyone else does.
  const OS = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
  line('Platform', [OS[r.platform] ?? r.platform, r.arch].filter(Boolean).join(' · '));
  line('Runtime', [r.electron && `Electron ${r.electron}`, r.node && `Node ${r.node}`]
    .filter(Boolean).join(' · '));
  line('Archive format', `version ${about.archiveFormat}`);
  line('Speech model', about.model);
  line('Models kept in', about.modelsWriteDir);
  line('App settings', about.settingsFile);
  line('License', about.license);

  const link = (id, url) => {
    $(id).onclick = guard(async () => {
      // A renderer window must never navigate to the web, so the desktop build
      // hands the URL to the real browser instead.
      const r2 = await api.openExternal(url);
      if (!r2?.ok) window.open(url, '_blank', 'noopener');
    });
  };
  link('about-repo', about.repo);
  link('about-releases', about.releases);

  $('about-copy').onclick = guard(async () => {
    // One click to paste into an issue, rather than retyping six lines.
    await navigator.clipboard.writeText([
      `${about.name} ${about.version}`,
      `${about.shell} · ${OS[r.platform] ?? r.platform} ${r.arch}`,
      r.electron ? `Electron ${r.electron} · Node ${r.node}` : `Node ${r.node}`,
      `archive format ${about.archiveFormat} · model ${about.model}`,
    ].join('\n'));
    $('about-copied').textContent = 'Copied';
    setTimeout(() => { $('about-copied').textContent = ''; }, 1500);
  });
}

/* ======================= requirements ======================= */

let setup = null;

/**
 * Which external tools are present, and where. The interface has to be able to
 * say this out loud: a packaged app launched from the Dock inherits none of the
 * PATH a terminal has, so "ffmpeg is missing" can be true here and false in a
 * shell, and a user with ffmpeg plainly installed deserves better than a flat
 * contradiction.
 */
async function loadSetup({ openIfIncomplete = false } = {}) {
  try {
    setup = await api.setup();
  } catch {
    return;                                   // an older backend; nothing to show
  }
  $('btn-setup').hidden = setup.ready;
  renderSetup();
  if (openIfIncomplete && !setup.ready && !$('dlg-setup').open) $('dlg-setup').showModal();
}

function renderSetup() {
  if (!setup) return;
  const box = $('setup-list');
  box.replaceChildren();

  const rows = [
    { ...setup.model, label: `Speech model — ${setup.model.name}`, isModel: true },
    { ...setup['whisper-cli'], label: 'whisper-cli' },
    { ...setup.ffmpeg, label: 'ffmpeg' },
    { ...setup.ffprobe, label: 'ffprobe' },
  ];

  for (const item of rows) {
    const row = el('div', `setup-row ${item.ok ? 'ok' : 'missing'}`);
    row.append(el('span', 'mark', item.ok ? '✔' : '✖'));

    const mid = el('div');
    mid.append(el('div', 'name', item.label));
    mid.append(el('div', 'muted tiny', item.why));
    // Where it was found — or, for the model, where it would go. This line is
    // the whole point of the dialog when PATH is what went wrong.
    if (item.path && (item.ok || item.isModel)) mid.append(el('div', 'where', item.path));
    row.append(mid);

    // Only the model is ours to fetch; see core/models.js for why the binaries
    // are left to the user.
    if (item.isModel && !item.ok) {
      const btn = el('button', 'primary small', item.size ? `Download · ${item.size}` : 'Download');
      btn.onclick = guard(async () => {
        btn.disabled = true;
        const r = await api.setupModel();
        if (r?.error) { banner(`Error: ${r.error}`); btn.disabled = false; }
      });
      row.append(btn);
    } else if (item.isModel) {
      row.append(el('span', 'muted tiny', fmtBytes(item.bytes)));
    }

    box.append(row);
  }

  const missing = rows.filter((r) => !r.ok && !r.isModel);
  $('setup-install').hidden = missing.length === 0;
  $('setup-cmd').textContent = setup.installCommand;
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
