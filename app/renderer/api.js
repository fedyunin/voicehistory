// THE single point of contact between the interface and the backend.
//
// This is the architectural seam. ui.js calls these methods and knows nothing
// about how they travel. There are two transports and the method names are
// identical in both:
//
//   • Electron — IPC through the preload bridge. No listening socket, so nothing
//     else on the machine can read the archive, and no port to clash.
//   • Browser  — HTTP against the local server. Kept for the read-only network
//     server: an archive on a home Linux box, browsable from the sofa.
//
// Nothing else in the interface changes between the two, which is the whole
// reason the boundary is this narrow.

const bridge = globalThis.vh ?? null;
export const isDesktop = Boolean(bridge);

/* ---------------- HTTP transport ---------------- */

const httpGet = async (method, params = {}) => {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== null && v !== undefined && v !== ''),
  );
  const r = await fetch(`/api/${method}?${qs}`);
  if (!r.ok) throw await httpError(r);
  return r.json();
};

const httpPost = async (method, body = {}) => {
  const r = await fetch(`/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw await httpError(r);
  return r.json();
};

async function httpError(r) {
  const body = await r.json().catch(() => ({}));
  const e = new Error(body.error ?? r.statusText);
  if (body.needsArchive) e.needsArchive = true;
  return e;
}

/* ---------------- dispatch ---------------- */

// Which HTTP verb each method uses. Irrelevant under IPC, which is why the
// table lives here rather than leaking into ui.js.
const WRITES = new Set([
  'archive/open', 'archive/forget', 'archive/choose', 'settings/update',
  'import/start', 'transcribe/start', 'transcribe/again', 'reindex', 'cancel',
  'contacts/rename', 'contacts/import', 'maintenance/run', 'backfill/props',
  'reveal/archive', 'setup/model', 'open/external',
]);

const call = (method, args = {}) => {
  if (bridge) return bridge.call(method, args);
  return WRITES.has(method) ? httpPost(method, args) : httpGet(method, args);
};

/* ---------------- the contract ---------------- */

export const api = {
  stats:      () => call('stats'),
  contacts:   () => call('contacts'),
  years:      () => call('years'),
  list:       (p) => call('list', p),
  recording:  (id) => call('recording', { id }),

  archive:         () => call('archive'),
  archiveInspect:  (dir) => call('archive/inspect', { dir }),
  archiveOpen:     (dir) => call('archive/open', { dir }),
  archiveForget:   (dir) => call('archive/forget', { dir }),
  updateSettings:  (patch) => call('settings/update', patch),

  importScan:      () => call('import/scan'),
  importCheck:     (dir) => call('import/check', { dir }),
  importStart:     (b) => call('import/start', b),
  transcribeStart: (b) => call('transcribe/start', b),
  reindex:         () => call('reindex'),
  transcribeAgain: (id, review) => call('transcribe/again', review ? { review } : id ? { id } : {}),
  cancel:          () => call('cancel'),
  renameContact:   (key, name) => call('contacts/rename', { key, name }),
  importVCard:     (vcard) => call('contacts/import', { vcard }),
  choices:         () => call('choices'),
  maintenance:     () => call('maintenance'),
  overview:        () => call('overview'),
  onThisDay:       (day) => call('onthisday', day ? { day } : {}),
  days:            (name) => call('days', name ? { name } : {}),
  people:          () => call('people'),
  person:          (name) => call('person', { name }),
  review:          () => call('review'),
  about:           () => call('about'),
  setup:           () => call('setup'),
  setupModel:      () => call('setup/model'),
  maintenanceRun:  (action, confirm) => call('maintenance/run', { action, confirm }),
  backfillProps:   (dir) => call('backfill/props', { dir }),

  /* --- desktop-only affordances; absent in the browser --- */

  /** A real folder picker. Returns {canceled} in the browser, where none exists. */
  chooseFolder: (mode) => (bridge ? call('archive/choose', { mode }) : Promise.resolve({ canceled: true, unsupported: true })),
  revealArchive: () => (bridge ? call('reveal/archive') : Promise.resolve({ ok: false })),

  /** In a browser an ordinary link already does the right thing. */
  openExternal: (url) => (bridge ? call('open/external', { url }) : Promise.resolve({ ok: false })),

  mediaUrl: (id) => (bridge ? bridge.mediaUrl(id) : `/media/${id}`),

  /** Live progress. IPC pushes it; the browser streams it over SSE. */
  subscribe(onProgress, onJob) {
    if (bridge) {
      const offP = bridge.onProgress(onProgress);
      const offJ = bridge.onJob(onJob);
      return () => { offP(); offJ(); };
    }
    const es = new EventSource('/api/events');
    es.addEventListener('progress', (e) => onProgress(JSON.parse(e.data)));
    es.addEventListener('job', (e) => onJob(JSON.parse(e.data)));
    return () => es.close();
  },
};
