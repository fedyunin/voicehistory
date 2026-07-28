// THE single point of contact between the interface and the backend.
//
// This is the architectural seam: porting to Electron changes only this file —
// fetch becomes window.electron.invoke with the same method names. ui.js is
// never touched.

const get = async (method, params = {}) => {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== null && v !== undefined && v !== ''),
  );
  const r = await fetch(`/api/${method}?${qs}`);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
  return r.json();
};

const post = async (method, body = {}) => {
  const r = await fetch(`/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
  return r.json();
};

export const api = {
  stats:      () => get('stats'),
  contacts:   () => get('contacts'),
  years:      () => get('years'),
  list:       (p) => get('list', p),
  recording:  (id) => get('recording', { id }),

  importScan:      () => get('import/scan'),
  importCheck:     (dir) => get('import/check', { dir }),
  renameContact:   (key, name) => post('contacts/rename', { key, name }),
  importVCard:     (vcard) => post('contacts/import', { vcard }),
  importStart:     (b) => post('import/start', b),
  transcribeStart: (b) => post('transcribe/start', b),
  reindex:         () => post('reindex'),
  cancel:          () => post('cancel'),

  maintenance:     () => get('maintenance'),
  maintenanceRun:  (action, confirm) => post('maintenance/run', { action, confirm }),
  backfillProps:   (dir) => post('backfill/props', { dir }),

  mediaUrl: (id) => `/media/${id}`,

  /** Live progress for long-running jobs. */
  subscribe(onProgress, onJob) {
    const es = new EventSource('/api/events');
    es.addEventListener('progress', (e) => onProgress(JSON.parse(e.data)));
    es.addEventListener('job', (e) => onJob(JSON.parse(e.data)));
    return () => es.close();
  },
};
