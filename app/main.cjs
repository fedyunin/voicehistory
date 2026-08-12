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
const { app, BrowserWindow, ipcMain, dialog, protocol, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Readable } = require('node:stream');

const MEDIA_TYPES = {
  '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.amr': 'audio/amr',
};

const HERE = __dirname;
const RENDERER = path.join(HERE, 'renderer');

/**
 * Declare the media scheme before the app is ready — after that it is too late,
 * and a custom scheme without these privileges cannot feed a <audio> element:
 * playback fails with "no supported source was found" and media error code 4.
 *
 * `stream` is the one that matters here. Without it Chromium will not treat the
 * response as seekable media, so the transcript-to-audio sync the whole interface
 * is built around silently does nothing.
 */
protocol.registerSchemesAsPrivileged([{
  scheme: 'vh',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true },
}]);

// Filled by loadCore() before any window exists.
let paths, abs, hasRoot, bus, progress, db, runner, lock, appsettings, session, archive, config,
    maintenance, list, recording, contacts, years,
    importFiles, transcribePending, retranscribe, scanInbox, backfillProps, reindex, modelAvailable,
    vcardsToOverrides, choices, matchPlan, tools, models, abort, about, review;

async function loadCore() {
  const m = async (p) => import(pathToFileURL(path.join(HERE, '..', 'core', p)).href);
  ({ paths, abs, hasRoot } = await m('paths.js'));
  ({ bus, progress } = await m('events.js'));
  db = await m('db.js');
  runner = await m('runner.js');
  lock = await m('lock.js');
  appsettings = await m('appsettings.js');
  session = await m('session.js');
  archive = await m('archive.js');
  config = await m('config.js');
  maintenance = await m('maintenance.js');
  ({ list, recording, contacts, years } = await m('search.js'));
  ({ importFiles, transcribePending, retranscribe, scanInbox, backfillProps } = await m('ingest.js'));
  ({ reindex } = await m('reindex.js'));
  ({ modelAvailable } = await m('transcribe.js'));
  ({ vcardsToOverrides } = await m('contactbook.js'));
  ({ all: choices, matchPlan } = await m('choices.js'));
  tools = await m('tools.js');
  models = await m('models.js');
  about = await m('about.js');
  review = await m('review.js');
  abort = await m('abort.js');
}

let win = null;

/* ============================ API ============================ */

/** Mirrors cli/server.js setupState(): what is installed, and where. */
async function setupState() {
  const probe = await tools.probe();
  return {
    ...probe,
    model: {
      name: config.MODEL,
      ok: models.available(),
      path: models.pathFor(),
      bytes: models.sizeOf(),
      url: models.urlFor(),
      // Size comes from the model catalogue rather than a constant: the sizes
      // differ by an order of magnitude, and a button promising 1.5 GB before a
      // 3 GB download is a small lie the interface does not need to tell.
      size: (choices().models.find((m) => m.id === config.MODEL) ?? {}).size ?? null,
      why: 'the speech model the recognizer reads',
    },
    ready: probe.ffmpeg.ok && probe.ffprobe.ok && probe['whisper-cli'].ok && models.available(),
  };
}

/** A normal job, so the model download gets the progress bar and Stop for free. */
function startModelDownload() {
  return runner.start('model', async () => {
    abort.begin();
    try {
      return await models.fetch(config.MODEL, {
        signal: abort.signal(),
        onProgress: ({ received, total }) =>
          progress({ phase: 'model', done: received, total, file: `ggml-${config.MODEL}.bin` }),
      });
    } finally {
      abort.end();
    }
  });
}

/**
 * The contract. Deliberately identical in name and shape to the HTTP routes, so
 * the renderer's api.js can speak either without knowing which it is talking to.
 */
const API = {
  /* --- archive --- */
  archive: () => session.archiveState(),

  review: () => ({ reasons: review.counts() }),

  about: () => ({
    ...about.info(),
    shell: 'desktop',
    // Only the desktop build has these, and they are the versions a bug report
    // actually needs.
    runtime: { ...about.info().runtime, electron: process.versions.electron, chrome: process.versions.chrome },
  }),
  /** Opens a link in the real browser; a renderer window must never become one. */
  'open/external': ({ url }) => {
    if (!/^https:\/\//.test(url ?? '')) return { ok: false };
    shell.openExternal(url);
    return { ok: true };
  },

  setup: () => setupState(),
  'setup/model': () => {
    if (models.available()) return { ok: true, already: true };
    if (runner.isBusy()) return { error: `Already running: ${runner.state().kind}` };
    return startModelDownload();
  },
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
    review: p.review || null,
    offset: Number(p.offset ?? 0),
    limit: Number(p.limit ?? 60),
  }),
  recording: ({ id }) => recording(Number(id)) ?? { error: 'no such recording' },

  /* --- import --- */
  'import/scan': () => [{ dir: paths.inbox, label: "The archive's own inbox folder", files: scanInbox(paths.inbox).length }],
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
  'transcribe/start': ({ order, limit }) => {
    // Refuse rather than start a job that can only fail on every file: a job whose
    // every recording failed used to finish looking like success, so the interface
    // said nothing at all.
    if (!models.available()) {
      return { error: `Model ${config.MODEL} is not downloaded — open Setup to fetch it`, needsModel: true };
    }
    return runner.start('transcribe', () => transcribePending({
      order: order === 'newest' ? 'newest' : 'named',
      limit: limit ? Number(limit) : Infinity,
      shouldStop: runner.isCancelled,
    }));
  },
  /** Redo one recording, or the whole archive when no id is given. */
  'transcribe/again': ({ id, review: reason }) => {
    if (!models.available()) {
      return { error: `Model ${config.MODEL} is not downloaded — open Setup to fetch it`, needsModel: true };
    }
    // A whole review category at once: finding 188 doubtful recordings is only
    // half the point, and re-running them one at a time is not the other half.
    const ids = reason ? review.ids(reason) : id ? [Number(id)] : null;
    return runner.start('transcribe', () => retranscribe({
      ids,
      shouldStop: runner.isCancelled,
    }));
  },
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
  choices: () => ({ ...choices(), currentPlan: matchPlan(config.NUMBERING) }),

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
  'maintenance/run', 'backfill/props', 'settings/update', 'transcribe/again',
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

    // Range is implemented here rather than delegated to net.fetch on a file://
    // URL. That delegation plays audio but reports seekable.end === 0, because
    // the response carries no Accept-Ranges or Content-Length, so Chromium treats
    // it as an unseekable stream — and clicking a transcript line to jump to that
    // moment silently does nothing.
    const size = fs.statSync(file).size;
    const type = MEDIA_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    const range = request.headers.get('range');
    const m = range && /bytes=(\d*)-(\d*)/.exec(range);

    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start >= size || start > end) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      }
      return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
        status: 206,
        headers: {
          'Content-Type': type,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
        },
      });
    }

    return new Response(Readable.toWeb(fs.createReadStream(file)), {
      status: 200,
      headers: {
        'Content-Type': type,
        'Content-Length': String(size),
        'Accept-Ranges': 'bytes',
      },
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
  // Closing the database under an in-flight job is what produced "the database
  // connection is not open" against individual recordings. Ask the job to stop
  // and leave teardown to process exit instead.
  if (runner?.isBusy()) {
    runner.cancel();
    lock?.release();
    return;
  }
  lock?.release();
  db?.close();
});
