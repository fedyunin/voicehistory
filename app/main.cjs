// Electron main process — the third adapter onto core/, alongside the CLI and
// the read-only network server.
//
// It replaces HTTP entirely rather than wrapping it: no listening socket, so
// nothing else on the machine can read your transcripts, and no port to clash.
// The method names below are the same ones the HTTP server exposes, because the
// renderer talks through one narrow contract either way.
// CommonJS on purpose. Electron's ESM entry path does not hand the main process
// the real electron bindings — the module resolves to an empty object — whereas
// require() in a .cjs entry is the long-standing, reliable route. core/ stays ESM
// and is pulled in with dynamic import inside the bootstrap below.
const { app, BrowserWindow, ipcMain, dialog, protocol, shell, net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const HERE = __dirname;
const RENDERER = path.join(HERE, 'renderer');

// Filled by loadCore() before any window exists.
let paths, abs, hasRoot, bus, db, runner, lock, appsettings, session, archive, config,
    maintenance, list, recording, contacts, years,
    importFiles, transcribePending, scanInbox, backfillProps, reindex, modelAvailable,
    vcardsToOverrides;

async function loadCore() {
  const m = async (p) => import(pathToFileURL(path.join(HERE, '..', 'core', p)).href);
  ({ paths, abs, hasRoot } = await m('paths.js'));
  ({ bus } = await m('events.js'));
  db = await m('db.js');
  runner = await m('runner.js');
  lock = await m('lock.js');
  appsettings = await m('appsettings.js');
  session = await m('session.js');
  archive = await m('archive.js');
  config = await m('config.js');
  maintenance = await m('maintenance.js');
  ({ list, recording, contacts, years } = await m('search.js'));
  ({ importFiles, transcribePending, scanInbox, backfillProps } = await m('ingest.js'));
  ({ reindex } = await m('reindex.js'));
  ({ modelAvailable } = await m('transcribe.js'));
  ({ vcardsToOverrides } = await m('contactbook.js'));
}

let win = null;

/* ============================ API ============================ */

/**
 * The contract. Deliberately identical in name and shape to the HTTP routes, so
 * the renderer's api.js can speak either without knowing which it is talking to.
 */
const API = {
  /* --- archive --- */
  archive: () => session.archiveState(),
  'archive/inspect': ({ dir }) => archive.inspect(dir ?? ''),
  'archive/open': ({ dir }) => {
    if (runner.isBusy()) throw new Error('A job is running — stop it before switching archives');
    const opened = session.openArchive(dir);
    return { ...session.archiveState(), created: opened.created };
  },
  'archive/forget': ({ dir }) => { appsettings.forget(dir); return session.archiveState(); },

  /** The reason a desktop shell earns its keep: a real folder picker. */
  'archive/choose': async ({ mode = 'open' } = {}) => {
    const r = await dialog.showOpenDialog(win, {
      title: mode === 'create' ? 'Choose a folder for your archive' : 'Open an archive',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: mode === 'create' ? 'Use this folder' : 'Open',
      defaultPath: paths.root ?? archive.suggestDefaultLocation(),
    });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    return { canceled: false, dir: r.filePaths[0], info: archive.inspect(r.filePaths[0]) };
  },

  'settings/update': (patch) => {
    archive.updateSettings(patch);
    return config.reload();
  },

  /* --- reading --- */
  stats: () => ({
    ...db.stats(),
    job: runner.state(),
    modelReady: modelAvailable(),
    model: config.MODEL,
    root: paths.root,
  }),
  contacts: () => contacts(),
  years: () => years(),
  list: (p) => list({
    q: p.q ?? '',
    contactId: p.contact ? Number(p.contact) : null,
    year: p.year || null,
    source: p.source || null,
    offset: Number(p.offset ?? 0),
    limit: Number(p.limit ?? 60),
  }),
  recording: ({ id }) => recording(Number(id)) ?? { error: 'no such recording' },

  /* --- import --- */
  'import/scan': () => [{ dir: paths.inbox, label: 'inbox/', files: scanInbox(paths.inbox).length }],
  'import/check': ({ dir }) => {
    if (!dir) throw new Error('no folder given');
    const resolved = path.resolve(archive.expandHome(dir));
    if (!fs.existsSync(resolved)) return { dir: resolved, exists: false, files: 0 };
    if (!fs.statSync(resolved).isDirectory()) {
      return { dir: resolved, exists: false, files: 0, notADirectory: true };
    }
    return { dir: resolved, exists: true, files: scanInbox(resolved).length };
  },
  'import/start': ({ dir, mode }) => runner.start('import',
    () => importFiles(dir || paths.inbox, { mode: mode === 'copy' ? 'copy' : 'move' })),
  'backfill/props': ({ dir }) => runner.start('backfill', () => backfillProps(dir || paths.inbox)),

  /* --- jobs --- */
  'transcribe/start': ({ order, limit }) => runner.start('transcribe', () => transcribePending({
    order: order === 'newest' ? 'newest' : 'named',
    limit: limit ? Number(limit) : Infinity,
    shouldStop: runner.isCancelled,
  })),
  reindex: () => runner.start('reindex', () => reindex()),
  cancel: () => { runner.cancel(); return { ok: true }; },

  /* --- contacts --- */
  'contacts/rename': ({ key, name }) => {
    if (!key) throw new Error('no contact key given');
    return db.renameContact(key, name ?? '');
  },
  'contacts/import': ({ vcard }) => {
    if (!vcard || !/BEGIN:VCARD/i.test(vcard)) throw new Error('that does not look like a vCard file');
    const { pairs, cards, numbers } = vcardsToOverrides(vcard);
    if (!pairs.length) return { cards, numbers, stored: 0, matched: 0 };
    return { cards, numbers, ...db.applyContactNames(pairs) };
  },

  /* --- maintenance --- */
  maintenance: () => ({
    usage: maintenance.usage(),
    actions: Object.fromEntries(Object.entries(maintenance.ACTIONS)
      .map(([k, v]) => [k, { ...v, needsConfirm: Boolean(v.confirm) }])),
    config: config.effective(),
  }),
  'maintenance/run': ({ action, confirm }) => {
    if (runner.isBusy()) throw new Error('A job is running — stop it before changing the archive');
    maintenance.assertConfirmed(action, confirm);   // synchronous, so a bad phrase is an error not a job
    return runner.start(`maintenance:${action}`, () => maintenance.run(action, confirm));
  },

  /* --- shell integration, only a desktop app can do these --- */
  'reveal/archive': () => {
    if (hasRoot()) shell.showItemInFolder(paths.root);
    return { ok: hasRoot() };
  },
};

/** Endpoints that make no sense until a folder is chosen. */
const NEEDS_ARCHIVE = new Set([
  'stats', 'contacts', 'years', 'list', 'recording', 'import/scan', 'import/start',
  'transcribe/start', 'reindex', 'contacts/rename', 'contacts/import', 'maintenance',
  'maintenance/run', 'backfill/props', 'settings/update',
]);

/* ============================ media ============================ */

/**
 * Audio over a custom scheme rather than an HTTP endpoint. Range support is
 * mandatory: without it the player cannot seek, and clicking a line of transcript
 * to jump to that moment is half the point of the interface.
 */
function registerMediaProtocol() {
  protocol.handle('vh', async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== 'media') return new Response('not found', { status: 404 });
    if (!hasRoot()) return new Response('no archive', { status: 409 });

    const id = Number(url.pathname.replace(/^\//, ''));
    const row = db.open()
      .prepare('SELECT audio_path, rel_path FROM recordings WHERE id = ?').get(id);
    if (!row) return new Response('not found', { status: 404 });

    const file = abs(row.audio_path ?? row.rel_path);
    if (!fs.existsSync(file)) return new Response('file missing', { status: 404 });

    // net.fetch on a file:// URL gives Chromium's own file handler, which already
    // implements Range and content types correctly — less to get wrong than
    // streaming it by hand.
    return net.fetch(pathToFileURL(file).toString(), {
      headers: request.headers,
      bypassCustomProtocolHandlers: true,
    });
  });
}

/* ============================ window ============================ */

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Voice History',
    backgroundColor: '#fbfaf8',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(RENDERER, 'index.html'));

  // Progress and job events, pushed rather than polled.
  const onProgress = (p) => win?.webContents.send('vh:progress', p);
  const onJob = (j) => win?.webContents.send('vh:job', j);
  bus.on('progress', onProgress);
  bus.on('job', onJob);
  win.on('closed', () => {
    bus.off('progress', onProgress);
    bus.off('job', onJob);
    win = null;
  });
}

/* ============================ lifecycle ============================ */

app.whenReady().then(async () => {
  await loadCore();
  const restored = session.restoreArchive();
  if (restored && !restored.missing && !lock.holder()) db.recoverStale();

  registerMediaProtocol();

  ipcMain.handle('vh:api', async (_event, method, args) => {
    if (!Object.hasOwn(API, method)) throw new Error(`no such method: ${method}`);
    if (NEEDS_ARCHIVE.has(method) && !hasRoot()) {
      const e = new Error('No archive is open');
      e.needsArchive = true;
      throw e;
    }
    return API[method](args ?? {});
  });

  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  lock.release();
  db.close();
});
