// Full rebuild of the database from the files on disk.
//
// This is not a break-glass recovery tool — it is the check that keeps the
// project's central invariant honest: SQLite holds nothing that archive/ and
// derived/ do not. As long as reindex reproduces the database exactly, the
// schema can change freely and no user data is ever at risk.
import fs from 'node:fs';
import path from 'node:path';
import * as db from './db.js';
import { paths, rel, ensureDirs } from './paths.js';
import { parseFilename, parseProps, propsPathFor } from './parse.js';
import { normalizeContact } from './contacts.js';
import { collectAudioFiles, sha256File } from './scan.js';
import { PLAYBACK_FORMAT, probeDurationMs } from './audio.js';
import { filterSegments } from './transcribe.js';
import { progress, logLine } from './events.js';
import * as lock from './lock.js';

const nowIso = () => new Date().toISOString();

export async function reindex() {
  ensureDirs();
  db.open();
  const { stale } = lock.acquire('reindex');
  if (stale) db.recoverStale();
  try {
    return await runReindex();
  } finally {
    lock.release();
  }
}

async function runReindex() {
  db.truncateContent();

  const files = collectAudioFiles(paths.archive);
  progress({ phase: 'reindex', done: 0, total: files.length });
  const result = { total: files.length, rows: 0, transcripts: 0, silent: 0, failed: 0 };
  // Recorded like any other long job so `vh jobs` and `vh watch` can see it.
  // truncateContent() deliberately spares the jobs table, so this row survives.
  const jobId = db.startJob('reindex', files.length, nowIso());

  for (const [i, file] of files.entries()) {
    try {
      const stat = fs.statSync(file);
      const sha = await sha256File(file);
      const meta = parseFilename(path.basename(file)) ?? {
        source: 'unknown', startedAt: localIso(stat.mtime), rawContact: '',
      };

      const propsFile = propsPathFor(file, path);
      const props = fs.existsSync(propsFile) ? parseProps(fs.readFileSync(propsFile, 'utf8')) : null;

      const contactId = db.upsertContact(normalizeContact(meta.rawContact, props?.callee ?? null));
      const stem = path.basename(file).replace(/\.[^.]+$/, '');
      const relDir = path.dirname(rel(file)).split('/').slice(1).join('/');

      const playable = path.join(paths.audio, relDir, `${stem}.${PLAYBACK_FORMAT}`);
      const tPath = path.join(paths.transcripts, relDir, `${stem}.json`);

      // Same fallback as import: recordings exported without a .props sidecar
      // have no stored duration, so probe the file. Skipping this silently
      // zeroed every duration in the archive and broke the promise that a
      // reindex reproduces the database exactly.
      const durationMs = props?.durationMs ?? (await probeDurationMs(file));

      const id = db.insertRecording({
        sha256: sha,
        orig_name: path.basename(file),
        rel_path: rel(file),
        source: meta.source,
        started_at: meta.startedAt,
        raw_contact: meta.rawContact || null,
        contact_id: contactId,
        direction: props?.direction ?? null,
        duration_ms: durationMs,
        bytes: stat.size,
        audio_path: fs.existsSync(playable) ? rel(playable) : null,
        transcript_status: 'pending',
        imported_at: nowIso(),
        props_json: props?.raw ?? null,
      });
      result.rows++;

      if (fs.existsSync(tPath)) {
        const t = JSON.parse(fs.readFileSync(tPath, 'utf8'));
        if (t.silent) {
          // The silence verdict is a derived fact worth persisting, exactly like
          // a transcript. Without it every rebuild would put dead files back in
          // the queue.
          db.markSilent(id, rel(tPath), t.note ?? 'no audio signal');
          result.silent++;
        } else {
          // Artifact filtering happens here: improve the hallucination list and a
          // reindex is enough — no re-transcription needed.
          const { segments } = filterSegments(t.segments ?? []);
          db.saveTranscript(id, {
            transcriptPath: rel(tPath),
            model: t.model ?? null,
            language: t.language ?? null,
            segments,
            fullText: segments.map((s) => s.text).join(' '),
          });
          result.transcripts++;
        }
      }
    } catch (e) {
      result.failed++;
      db.bumpJob(jobId, { failed: 1 });
      logLine(`reindex: ${path.basename(file)} — ${e.message}`);
    }
    db.bumpJob(jobId, { done: 1 });
    // Report often enough that the bar visibly moves: each file costs a SHA-256
    // plus possibly an ffprobe, so 50-file batches left it frozen for 15 s.
    if (i % 5 === 0) {
      progress({ phase: 'reindex', done: i + 1, total: files.length, file: path.basename(file) });
    }
  }

  progress({ phase: 'reindex', done: files.length, total: files.length });
  db.finishJob(jobId, 'done', nowIso(), JSON.stringify(result));
  return result;
}

function localIso(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
         `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
