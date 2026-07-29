// Import orchestration. The two phases are deliberately separate:
//
//   Phase 1 (minutes) — hash, file away, read metadata, build a playable copy.
//                       Recordings become visible and audible immediately.
//   Phase 2 (hours)   — transcription, driven by a queue held in the database.
//                       Resumable: stop it halfway and it picks up where it left off.
//
// A file's identity is its SHA-256, not its name or path. Re-importing the same
// phone export therefore duplicates nothing.
import fs from 'node:fs';
import path from 'node:path';
import * as db from './db.js';
import { paths, rel, abs, archiveDirFor, mirrorPath, ensureDirs } from './paths.js';
import { parseFilename, parseProps, propsPathFor } from './parse.js';
import { normalizeContact } from './contacts.js';
import { collectAudioFiles, sha256File, transferFile, freePath } from './scan.js';
import {
  toPlayable, toWhisperWav, probeDurationMs, measureLevelDb, isSilent, PLAYBACK_FORMAT,
} from './audio.js';
import { transcribeWav, filterSegments, looksCollapsed } from './transcribe.js';
import { progress, logLine } from './events.js';
import * as lock from './lock.js';

const nowIso = () => new Date().toISOString();

/** Bounded concurrency: four ffmpeg processes, beyond that the disk is the limit. */
async function pool(items, concurrency, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

/* ============================ PHASE 1 ============================ */

export function scanInbox(sourceDir = paths.inbox) {
  return collectAudioFiles(sourceDir);
}

/**
 * @param {'move'|'copy'} mode  'copy' leaves the source alone. That is how the
 *   FIRST import should run: the original phone export stays as a backup until
 *   you have confirmed the archive came out right.
 */
export async function importFiles(sourceDir = paths.inbox, { concurrency = 4, mode = 'move' } = {}) {
  ensureDirs();
  db.open();
  lock.acquire('import');
  // Holding the writer lock is licence enough to reclaim: if it is ours, no other
  // writer exists, so anything left 'running' is debris. Waiting for a "stale
  // lock" signal instead missed the common case — a terminated process releases
  // its lock on the way out, leaving the database row behind and nothing to
  // notice it.
  db.recoverStale();
  try {
    return await runImport(sourceDir, concurrency, mode);
  } finally {
    lock.release();
  }
}

async function runImport(sourceDir, concurrency, mode) {
  const files = collectAudioFiles(sourceDir);
  const jobId = db.startJob('import', files.length, nowIso());
  const result = { total: files.length, imported: 0, duplicates: 0, failed: 0, unparsed: 0 };

  progress({ phase: 'import', done: 0, total: files.length });

  await pool(files, concurrency, async (file) => {
    try {
      const sha = await sha256File(file);
      const existing = db.findBySha(sha);
      if (existing) {
        result.duplicates++;
        // Nothing is ever deleted. Duplicates are parked for you to review.
        // In copy mode the source is not touched at all.
        if (mode === 'move' && isInside(file, paths.inbox)) {
          transferFile(file, freePath(paths.duplicates, path.basename(file)), 'move');
        }
        db.bumpJob(jobId, { done: 1 });
        progress({ phase: 'import', done: tally(result), total: files.length, file: path.basename(file) });
        return;
      }

      const stat = fs.statSync(file);
      let meta = parseFilename(path.basename(file));
      if (!meta) {
        // Not a Cube-style name. Don't lose the file — fall back to mtime.
        result.unparsed++;
        meta = { source: 'unknown', startedAt: localIso(stat.mtime), rawContact: '' };
      }

      const propsFile = propsPathFor(file, path);
      let props = null;
      if (fs.existsSync(propsFile)) props = parseProps(fs.readFileSync(propsFile, 'utf8'));

      const contact = normalizeContact(meta.rawContact, props?.callee ?? null);
      const contactId = db.upsertContact(contact);

      const destDir = archiveDirFor(meta.startedAt);
      const dest = freePath(destDir, path.basename(file));
      transferFile(file, dest, mode);

      // Move the .props sidecar next to the audio, into
      // recordings/YYYY/YYYY-MM/.props/. Without this, "the database is
      // rebuildable" would be a lie: call direction and duration exist
      // nowhere else.
      if (fs.existsSync(propsFile)) {
        const stem = path.basename(dest).replace(/\.[^.]+$/, '');
        transferFile(propsFile, path.join(destDir, '.props', `${stem}.json`), mode);
      }

      const durationMs = props?.durationMs ?? (await probeDurationMs(dest));

      const id = db.insertRecording({
        sha256: sha,
        orig_name: path.basename(file),
        rel_path: rel(dest),
        source: meta.source,
        started_at: meta.startedAt,
        raw_contact: meta.rawContact || null,
        contact_id: contactId,
        direction: props?.direction ?? null,
        duration_ms: durationMs,
        bytes: stat.size,
        audio_path: null,
        transcript_status: 'pending',
        imported_at: nowIso(),
        props_json: props?.raw ?? null,
      });

      // Playable copy: no browser and no webview can play AMR.
      try {
        const playable = mirrorPath(paths.audio, rel(dest), PLAYBACK_FORMAT);
        await toPlayable(dest, playable);
        db.setAudioPath(id, rel(playable));
      } catch (e) {
        logLine(`could not build a playable copy of ${path.basename(dest)}: ${e.message}`);
      }

      result.imported++;
      db.bumpJob(jobId, { done: 1 });
      progress({ phase: 'import', done: tally(result), total: files.length, file: path.basename(file) });
    } catch (e) {
      result.failed++;
      db.bumpJob(jobId, { failed: 1 });
      logLine(`import failed for ${path.basename(file)}: ${e.message}`);
    }
  });

  // Sidecars whose audio was already in the archive — including the case where
  // only a .props folder was dropped in.
  const back = backfillProps(sourceDir);
  if (back.updated) {
    result.propsBackfilled = back.updated;
    logLine(`attached .props metadata to ${back.updated} existing recording(s)`);
  }

  db.finishJob(jobId, 'done', nowIso(), JSON.stringify(result));
  return result;
}

/* ==================== .props BACK-FILL ==================== */

/**
 * Attaches Cube's `.props` sidecars to recordings that were imported without
 * them.
 *
 * Needed because sidecars are only read for audio sitting beside them, so
 * dropping a `.props` folder in on its own used to do nothing at all — and the
 * information it carries (incoming vs outgoing, the recorder's own duration)
 * exists nowhere else. Matching is by original filename.
 *
 * @returns {{found: number, matched: number, updated: number}}
 */
export function backfillProps(sourceDir = paths.inbox) {
  db.open();
  const result = { found: 0, matched: 0, updated: 0 };
  const propDirs = findPropsDirs(sourceDir);

  for (const dir of propDirs) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      result.found++;
      const stem = entry.name.replace(/\.json$/, '');
      const rec = findRecordingByStem(stem);
      if (!rec) continue;
      result.matched++;
      if (rec.props_json) continue;                    // already has metadata

      const props = parseProps(fs.readFileSync(path.join(dir, entry.name), 'utf8'));
      if (!props) continue;

      // Keep the sidecar beside the audio so a rebuild finds it too.
      const destDir = path.join(path.dirname(abs(rec.rel_path)), '.props');
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(path.join(dir, entry.name), path.join(destDir, `${stem}.json`));

      db.backfillProps(rec.id, {
        direction: props.direction,
        durationMs: props.durationMs,
        raw: props.raw,
      });
      result.updated++;
    }
  }
  progress({ phase: 'backfill', done: result.found, total: result.found });
  return result;
}

function findPropsDirs(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (e.name === '.props') { out.push(path.join(d, e.name)); continue; }
      if (e.name === '_duplicates') continue;
      walk(path.join(d, e.name));
    }
  };
  walk(root);
  return out;
}

/** A sidecar is named after the audio stem; the extension is not recorded. */
function findRecordingByStem(stem) {
  for (const ext of ['.amr', '.mp3', '.m4a', '.wav', '.ogg', '.opus', '.3gp']) {
    const rec = db.findByOrigName(stem + ext);
    if (rec) return rec;
  }
  return null;
}

/* ============================ PHASE 2 ============================ */

/**
 * Drains the transcription queue. Safe to interrupt at any moment: the state
 * lives in recordings.transcript_status, not in memory.
 */
export async function transcribePending(opts = {}) {
  ensureDirs();
  db.open();
  // The lock is what stops the server and a second terminal from pulling the
  // same recordings off the queue and transcribing them twice.
  lock.acquire('transcribe');
  // Holding the writer lock is licence enough to reclaim: if it is ours, no other
  // writer exists, so anything left 'running' is debris. Waiting for a "stale
  // lock" signal instead missed the common case — a terminated process releases
  // its lock on the way out, leaving the database row behind and nothing to
  // notice it.
  db.recoverStale();
  try {
    return await runTranscribe(opts);
  } finally {
    lock.release();
  }
}

async function runTranscribe({
  model = undefined, limit = Infinity, order = 'named', shouldStop = () => false,
} = {}) {
  const pendingTotal = db.stats().byStatus.find((s) => s.s === 'pending')?.n ?? 0;
  const total = Math.min(pendingTotal, limit);
  const jobId = db.startJob('transcribe', total, nowIso());
  let done = 0, failed = 0;

  progress({ phase: 'transcribe', done: 0, total });

  while (done + failed < total) {
    if (shouldStop()) {
      db.finishJob(jobId, 'cancelled', nowIso(), JSON.stringify({ done, failed }));
      return { done, failed, total, cancelled: true };
    }
    const [rec] = db.nextPending(1, order);
    if (!rec) break;
    db.markStatus(rec.id, 'running');
    const src = abs(rec.rel_path);
    const wav = path.join(paths.tmp, `${rec.id}.wav`);

    try {
      // Skip recordings that contain no signal at all. Measured on the source,
      // not the normalized copy, since normalization would amplify the noise
      // floor of a silent file into something whisper answers with hallucinated
      // subtitle credits. Costs one fast decode, saves a full whisper run.
      const level = await measureLevelDb(src);
      if (isSilent(level)) {
        // Persist the verdict beside the transcripts so a rebuild restores it
        // instead of putting a dead file back in the queue.
        const note = `no audio signal (peak ${level.maxDb} dBFS)`;
        const tPath = transcriptPathFor(rec);
        fs.mkdirSync(path.dirname(tPath), { recursive: true });
        fs.writeFileSync(tPath, JSON.stringify({
          origName: rec.orig_name,
          relPath: rec.rel_path,
          silent: true,
          note,
          level,
          segments: [],
        }, null, 1));
        db.markSilent(rec.id, rel(tPath), note);
        done++;
        db.bumpJob(jobId, { done: 1 });
        progress({ phase: 'transcribe', done: done + failed, total, file: rec.orig_name });
        continue;
      }

      // Recognize the audio as recorded. Normalization used to be applied to
      // everything, on the strength of one badly degraded file it rescued —
      // measured more widely it costs segmentation on healthy audio, turning 45
      // phrases into 27 and coarsening every seek.
      await toWhisperWav(src, wav, { normalize: false });
      let out = await transcribeWav(wav, { model });

      // …but when the decode collapses, normalization is what fixes it. Only the
      // affected minority pays for a second pass.
      if (looksCollapsed(out.segments)) {
        logLine(`${rec.orig_name}: decode looks collapsed, retrying normalized`);
        await toWhisperWav(src, wav, { normalize: true });
        const retry = await transcribeWav(wav, { model });
        if (!looksCollapsed(retry.segments)) out = retry;
      }

      const tPath = transcriptPathFor(rec);
      fs.mkdirSync(path.dirname(tPath), { recursive: true });
      // RAW whisper output goes to disk. It costs days of compute and must
      // survive any future change to the artifact-filtering logic.
      fs.writeFileSync(tPath, JSON.stringify({
        origName: rec.orig_name,
        relPath: rec.rel_path,
        model: out.model,
        language: out.language,
        durationMs: rec.duration_ms,
        segments: out.segments,
      }, null, 1));

      const { segments } = filterSegments(out.segments);
      db.saveTranscript(rec.id, {
        transcriptPath: rel(tPath),
        model: out.model,
        language: out.language,
        segments,
        fullText: segments.map((s) => s.text).join(' '),
      });
      done++;
      db.bumpJob(jobId, { done: 1 });
    } catch (e) {
      // Being interrupted is not a failure of the recording. Cancelling a job, or
      // quitting while one runs, used to leave recordings marked 'failed' with a
      // teardown message attached — indistinguishable from audio that genuinely
      // cannot be transcribed, and never retried.
      if (shouldStop() || isTeardown(e)) {
        db.markStatus(rec.id, 'pending');
        db.finishJob(jobId, 'cancelled', nowIso(), JSON.stringify({ done, failed }));
        return { done, failed, total, cancelled: true };
      }
      db.markStatus(rec.id, 'failed', e.message);
      failed++;
      db.bumpJob(jobId, { failed: 1 });
      logLine(`transcription failed for ${rec.orig_name}: ${e.message}`);
    } finally {
      fs.rmSync(wav, { force: true });
    }

    progress({ phase: 'transcribe', done: done + failed, total, file: rec.orig_name });
  }

  db.finishJob(jobId, 'done', nowIso(), JSON.stringify({ done, failed }));
  return { done, failed, total };
}

/* ============================ helpers ============================ */

const tally = (r) => r.imported + r.duplicates + r.failed;

/**
 * Errors that mean the process is going away, not that this recording is bad:
 * the database closing under an in-flight job, or the recognizer being killed
 * with its parent.
 */
function isTeardown(e) {
  const m = String(e?.message ?? '');
  return /database connection is not open|SQLITE_MISUSE|SIGTERM|SIGKILL|killed/i.test(m);
}

/** recordings/YYYY/YYYY-MM/x.amr → transcripts/YYYY/YYYY-MM/x.json */
function transcriptPathFor(rec) {
  return mirrorPath(paths.transcripts, rec.rel_path, 'json');
}

function isInside(file, dir) {
  const r = path.relative(dir, file);
  return r && !r.startsWith('..') && !path.isAbsolute(r);
}

/** Date → 'YYYY-MM-DDTHH:MM:SS' in local time, matching how the recorder wrote it. */
function localIso(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
         `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
