// The HTTP shell. The second adapter onto core/, alongside the CLI — it holds
// no logic of its own.
//
// Under Electron this file is replaced by main.js: the same method names move
// into ipcMain.handle, and api.js in the renderer swaps fetch for invoke.
// Nothing else changes — that was the point of keeping the contract narrow.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths, abs, ensureDirs, hasRoot } from '../core/paths.js';
import { bus, progress } from '../core/events.js';
import * as db from '../core/db.js';
import * as runner from '../core/runner.js';
import * as lock from '../core/lock.js';
import * as appsettings from '../core/appsettings.js';
import { list, recording, contacts, years } from '../core/search.js';
import { importFiles, transcribePending, retranscribe, scanInbox, backfillProps } from '../core/ingest.js';
import { reindex } from '../core/reindex.js';
import { modelAvailable } from '../core/transcribe.js';
import * as tools from '../core/tools.js';
import * as models from '../core/models.js';
import * as abort from '../core/abort.js';
import { vcardsToOverrides } from '../core/contactbook.js';
import * as maintenance from '../core/maintenance.js';
import * as config from '../core/config.js';
import * as session from '../core/session.js';
import * as archiveMod from '../core/archive.js';
import { all as choicesList, matchPlan } from '../core/choices.js';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'renderer');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.m4a': 'audio/mp4', '.opus': 'audio/ogg', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.amr': 'audio/amr', '.svg': 'image/svg+xml',
};

export function serve(port = 4321) {
  // The server starts with or without an archive: on first run the interface
  // asks for a folder, so there is nothing to configure before launching.
  const restored = session.restoreArchive();
  if (restored?.missing) {
    console.log(`  last archive is unavailable (${restored.root}) — choose another in the interface`);
  } else if (restored) {
    console.log(`  archive: ${restored.root}`);
    if (!lock.holder()) {
      const { requeued } = db.recoverStale();
      if (requeued) console.log(`  recovered ${requeued} interrupted recording(s) back into the queue`);
    }
  } else {
    console.log('  no archive yet — the interface will ask where to keep it');
  }

  const server = http.createServer(handle);
  server.listen(port, '127.0.0.1', () => {
    console.log(`\n  Open:  http://127.0.0.1:${port}\n  Ctrl+C to stop\n`);
  });
  return server;
}

/** Endpoints that make no sense until a folder is chosen. */
const NEEDS_ARCHIVE = new Set([
  'stats', 'contacts', 'years', 'list', 'recording', 'import/scan', 'import/start',
  'transcribe/start', 'reindex', 'contacts/rename', 'contacts/import', 'maintenance',
  'maintenance/run', 'backfill/props', 'settings/update', 'transcribe/again',
]);

async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  try {
    if (p.startsWith('/api/')) return await api(req, res, url);
    if (p.startsWith('/media/')) return media(req, res, Number(p.slice(7)));
    return statics(res, p);
  } catch (e) {
    json(res, 500, { error: e.message });
  }
}

/* ------------------------- API ------------------------- */

/**
 * Setup state: what the app needs before it can do anything, and where each
 * piece was found. Shared by the CLI's doctor and the interface.
 */
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
      size: (choicesList().models.find((m) => m.id === config.MODEL) ?? {}).size ?? null,
      why: 'the speech model the recognizer reads',
    },
    ready: probe.ffmpeg.ok && probe.ffprobe.ok && probe['whisper-cli'].ok && models.available(),
  };
}

/** Downloads the model as a normal job, so it gets progress and Stop for free. */
function startModelDownload() {
  return runner.start('model', async () => {
    abort.begin();
    try {
      const r = await models.fetch(config.MODEL, {
        signal: abort.signal(),
        onProgress: ({ received, total }) =>
          progress({ phase: 'model', done: received, total, file: `ggml-${config.MODEL}.bin` }),
      });
      return r;
    } finally {
      abort.end();
    }
  });
}


async function api(req, res, url) {
  const p = url.pathname.slice(5);
  const q = url.searchParams;

  if (NEEDS_ARCHIVE.has(p) && !hasRoot()) {
    return json(res, 409, { error: 'No archive is open', needsArchive: true });
  }

  switch (p) {
    case 'archive':
      return json(res, 200, session.archiveState());

    case 'setup':
      return json(res, 200, await setupState());

    case 'setup/model': {
      if (models.available()) return json(res, 200, { ok: true, already: true });
      if (runner.isBusy()) return json(res, 409, { error: `Already running: ${runner.state().kind}` });
      return json(res, 200, startModelDownload());
    }

    case 'archive/inspect':
      return json(res, 200, archiveMod.inspect(q.get('dir') ?? ''));

    case 'archive/open': {
      const { dir } = await readJson(req);
      if (runner.isBusy()) {
        return json(res, 409, { error: 'A job is running — stop it before switching archives' });
      }
      try {
        const opened = session.openArchive(dir);
        return json(res, 200, { ...session.archiveState(), created: opened.created });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    case 'archive/forget': {
      const { dir } = await readJson(req);
      appsettings.forget(dir);
      return json(res, 200, session.archiveState());
    }

    case 'settings/update': {
      const patch = await readJson(req);
      try {
        archiveMod.updateSettings(patch);
        config.reload();
        return json(res, 200, config.effective());
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    case 'stats':
      return json(res, 200, {
        ...db.stats(),
        job: runner.state(),
        modelReady: modelAvailable(),
        model: config.MODEL,
        root: paths.root,
      });

    case 'contacts': return json(res, 200, contacts());
    case 'years':    return json(res, 200, years());

    case 'list':
      return json(res, 200, list({
        q: q.get('q') ?? '',
        contactId: q.get('contact') ? Number(q.get('contact')) : null,
        year: q.get('year') || null,
        source: q.get('source') || null,
        offset: Number(q.get('offset') ?? 0),
        limit: Number(q.get('limit') ?? 60),
      }));

    case 'recording': {
      const rec = recording(Number(q.get('id')));
      return rec ? json(res, 200, rec) : json(res, 404, { error: 'no such recording' });
    }

    // the default drop folder, and how many files are waiting in it
    case 'import/scan':
      return json(res, 200, [
        { dir: paths.inbox, label: "The archive's own inbox folder", files: scanInbox(paths.inbox).length },
      ]);

    // count audio files in an arbitrary folder, so the UI can validate a
    // pasted path before starting a job
    case 'import/check': {
      const dir = q.get('dir') ?? '';
      if (!dir) return json(res, 400, { error: 'no folder given' });
      const resolved = path.resolve(dir.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
      if (!fs.existsSync(resolved)) return json(res, 200, { dir: resolved, exists: false, files: 0 });
      if (!fs.statSync(resolved).isDirectory()) {
        return json(res, 200, { dir: resolved, exists: false, files: 0, notADirectory: true });
      }
      return json(res, 200, { dir: resolved, exists: true, files: scanInbox(resolved).length });
    }

    case 'import/start': {
      const body = await readJson(req);
      const dir = body.dir || paths.inbox;
      const mode = body.mode === 'copy' ? 'copy' : 'move';
      return json(res, 200, runner.start('import', () => importFiles(dir, { mode })));
    }

    case 'transcribe/start': {
    // Refuse rather than start a job that can only fail on every file. Without
    // this the queue drained into per-recording failures and the interface said
    // nothing, because a job whose every file failed still finished "successfully".
    if (!models.available()) {
      return json(res, 409, { error: `Model ${config.MODEL} is not downloaded — open Setup to fetch it`, needsModel: true });
    }
      const body = await readJson(req);
      return json(res, 200, runner.start('transcribe', () => transcribePending({
        order: body.order === 'newest' ? 'newest' : 'named',
        limit: body.limit ? Number(body.limit) : Infinity,
        shouldStop: runner.isCancelled,
      })));
    }

    case 'transcribe/again': {
      if (!models.available()) {
        return json(res, 409, { error: `Model ${config.MODEL} is not downloaded — open Setup to fetch it`, needsModel: true });
      }
      const { id } = await readJson(req);
      return json(res, 200, runner.start('transcribe', () => retranscribe({
        ids: id ? [Number(id)] : null, shouldStop: runner.isCancelled,
      })));
    }

    case 'reindex':
      return json(res, 200, runner.start('reindex', () => reindex()));

    case 'cancel':
      runner.cancel();
      return json(res, 200, { ok: true });

    // rename one contact; an empty name clears the override
    case 'contacts/rename': {
      const { key, name } = await readJson(req);
      if (!key) return json(res, 400, { error: 'no contact key given' });
      return json(res, 200, db.renameContact(key, name ?? ''));
    }

    // import an address book exported from a phone (.vcf)
    case 'contacts/import': {
      const { vcard } = await readJson(req);
      if (!vcard || !/BEGIN:VCARD/i.test(vcard)) {
        return json(res, 400, { error: 'that does not look like a vCard file' });
      }
      const { pairs, cards, numbers } = vcardsToOverrides(vcard);
      if (!pairs.length) return json(res, 200, { cards, numbers, stored: 0, matched: 0 });
      const applied = db.applyContactNames(pairs);
      return json(res, 200, { cards, numbers, ...applied });
    }

    // what each destructive action would cost, plus current disk usage
    case 'choices':
      return json(res, 200, { ...choicesList(), currentPlan: matchPlan(config.NUMBERING) });

    case 'maintenance': {
      const specs = Object.fromEntries(
        Object.entries(maintenance.ACTIONS).map(([k, v]) => [k, { ...v, needsConfirm: Boolean(v.confirm) }]),
      );
      return json(res, 200, { usage: maintenance.usage(), actions: specs, config: config.effective() });
    }

    case 'maintenance/run': {
      const { action, confirm } = await readJson(req);
      if (runner.isBusy()) {
        return json(res, 409, { error: 'A job is running — stop it before changing the archive' });
      }
      // Validate before scheduling, so a wrong confirmation phrase is a 400
      // rather than a job that reports success and then fails in the background.
      try {
        maintenance.assertConfirmed(action, confirm);
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
      return json(res, 200, runner.start(`maintenance:${action}`,
        () => maintenance.run(action, confirm)));
    }

    case 'backfill/props': {
      const { dir } = await readJson(req);
      return json(res, 200, runner.start('backfill', () => backfillProps(dir || paths.inbox)));
    }

    case 'events': return sse(req, res);
  }
  return json(res, 404, { error: 'no such method' });
}

/* ---------------- progress stream (SSE) ---------------- */

function sse(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': ok\n\n');

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const onProgress = (p) => send('progress', p);
  const onJob = (j) => send('job', j);
  bus.on('progress', onProgress);
  bus.on('job', onJob);

  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(ping);
    bus.off('progress', onProgress);
    bus.off('job', onJob);
  });
}

/* ---------------- audio, with Range support ---------------- */

// Range is mandatory: without it the browser cannot seek, and jumping to a
// phrase by clicking it is half the point of the interface.
function media(req, res, id) {
  const rec = db.open().prepare('SELECT audio_path, rel_path FROM recordings WHERE id = ?').get(id);
  if (!rec) return json(res, 404, { error: 'no such recording' });
  const file = abs(rec.audio_path ?? rec.rel_path);
  if (!fs.existsSync(file)) return json(res, 404, { error: 'file is missing' });

  const size = fs.statSync(file).size;
  const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  const range = req.headers.range;

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m[1] ? Number(m[1]) : 0;
    const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
    });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }

  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
  fs.createReadStream(file).pipe(res);
}

/* ---------------- static files ---------------- */

function statics(res, p) {
  const file = path.join(WEB, p === '/' ? 'index.html' : p.replace(/^\/+/, ''));
  if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

/* ---------------- helpers ---------------- */

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}
