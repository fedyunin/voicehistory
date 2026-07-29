// Schema and database access.
//
// IMPORTANT: the database is entirely derived. The source of truth is the files
// on disk (audio under recordings/, transcripts under transcripts/). Any
// version of the database can be deleted and rebuilt with `reindex`.
//
// That is a deliberate design choice: it makes schema changes trivial and means
// a bug in the indexing logic can never cost the user their data.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { paths } from './paths.js';
import {
  overrideFor, overrides, setOverride, setMany, reload as reloadOverrides,
} from './contactbook.js';
import { normalizeContact } from './contacts.js';

const SCHEMA_VERSION = 1;

let db = null;

export function open() {
  if (db) return db;
  fs.mkdirSync(path.dirname(paths.db), { recursive: true });
  db = new Database(paths.db);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  migrate(db);
  return db;
}

/**
 * Crash recovery. A recording is marked 'running' while whisper works on it;
 * if the process is killed at that moment the row would stay 'running' forever
 * and never be picked up again, so it goes back into the queue.
 *
 * MUST only be called by a process holding the writer lock. Running it on every
 * database open was a bug: merely starting `vh watch` alongside the server
 * declared the server's live job interrupted and re-queued the very recording
 * it was working on.
 */
export function recoverStale() {
  const d = open();
  // Working wavs from the dead run: large, regenerable, and this is the one
  // moment we know for certain nobody is using them.
  try {
    for (const f of fs.readdirSync(paths.tmp)) {
      if (f.endsWith('.wav')) fs.rmSync(path.join(paths.tmp, f), { force: true });
    }
  } catch { /* nothing to clean */ }
  const requeued = d.prepare(`UPDATE recordings SET transcript_status = 'pending'
                              WHERE transcript_status = 'running'`).run().changes;
  const jobs = d.prepare(`UPDATE jobs SET state = 'failed', message = 'interrupted',
                          finished_at = ? WHERE state = 'running'`)
    .run(new Date().toISOString()).changes;
  return { requeued, jobs };
}

export function close() {
  if (db) { db.close(); db = null; }
}

function migrate(d) {
  const current = d.pragma('user_version', { simple: true });
  if (current >= SCHEMA_VERSION) return;
  if (current === 0) {
    d.exec(`
      CREATE TABLE contacts (
        id           INTEGER PRIMARY KEY,
        key          TEXT NOT NULL UNIQUE,   -- E.164 | short code | name:… | unknown
        kind         TEXT NOT NULL,          -- phone | shortcode | name | unknown
        display_name TEXT NOT NULL
      );

      CREATE TABLE recordings (
        id                INTEGER PRIMARY KEY,
        sha256            TEXT NOT NULL UNIQUE,  -- file identity: not name, not path
        orig_name         TEXT NOT NULL,
        rel_path          TEXT NOT NULL,         -- recordings/2026/2026-07/phone_...amr
        source            TEXT NOT NULL,         -- phone | whatsapp | viber | gmeet
        started_at        TEXT NOT NULL,         -- naive local 'YYYY-MM-DDTHH:MM:SS'
        raw_contact       TEXT,
        contact_id        INTEGER REFERENCES contacts(id),
        direction         TEXT,                  -- Incoming | Outgoing | NULL
        duration_ms       INTEGER,
        bytes             INTEGER NOT NULL,
        audio_path        TEXT,                  -- audio/... playable copy
        transcript_path   TEXT,                  -- transcripts/....json
        -- pending | running | done | empty (no speech found) | silent (no signal
        -- at all, never sent to whisper) | failed
        transcript_status TEXT NOT NULL DEFAULT 'pending',
        transcript_error  TEXT,
        model             TEXT,
        language          TEXT,
        imported_at       TEXT NOT NULL,
        props_json        TEXT                   -- Cube's own sidecar, kept verbatim
      );

      CREATE INDEX idx_rec_started  ON recordings(started_at);
      CREATE INDEX idx_rec_contact  ON recordings(contact_id);
      CREATE INDEX idx_rec_status   ON recordings(transcript_status);

      CREATE TABLE segments (
        recording_id INTEGER NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
        idx          INTEGER NOT NULL,
        t0           INTEGER NOT NULL,   -- ms from start
        t1           INTEGER NOT NULL,
        text         TEXT NOT NULL,
        PRIMARY KEY (recording_id, idx)
      ) WITHOUT ROWID;

      -- rowid = recordings.id. unicode61 tokenizes Cyrillic correctly.
      CREATE VIRTUAL TABLE fts USING fts5(
        text,
        tokenize = 'unicode61 remove_diacritics 2'
      );

      CREATE TABLE jobs (
        id          INTEGER PRIMARY KEY,
        kind        TEXT NOT NULL,
        state       TEXT NOT NULL,   -- running | done | failed | cancelled
        total       INTEGER NOT NULL DEFAULT 0,
        done        INTEGER NOT NULL DEFAULT 0,
        failed      INTEGER NOT NULL DEFAULT 0,
        message     TEXT,
        started_at  TEXT NOT NULL,
        finished_at TEXT
      );
    `);
  }
  d.pragma(`user_version = ${SCHEMA_VERSION}`);
}

/* ---------- contacts ---------- */

export function upsertContact({ key, kind, display }) {
  const d = open();
  // A name the user typed or imported outranks anything inferred from filenames.
  const name = overrideFor(key) ?? display;
  const found = d.prepare('SELECT id, display_name FROM contacts WHERE key = ?').get(key);
  if (found) {
    // A name from the address book beats a bare number: if we previously only
    // knew the digits and a name has now arrived, upgrade the display name.
    if (found.display_name !== name && (kind === 'name' || overrideFor(key))) {
      d.prepare('UPDATE contacts SET display_name = ?, kind = ? WHERE id = ?').run(name, kind, found.id);
    }
    return found.id;
  }
  return d.prepare('INSERT INTO contacts (key, kind, display_name) VALUES (?, ?, ?)')
    .run(key, kind, name).lastInsertRowid;
}

/**
 * Empties the content tables in one transaction, ready for a rebuild.
 *
 * Deliberately NOT achieved by deleting the database file: reindex can be
 * triggered from the UI, which means it runs inside the same process that is
 * serving requests, and pulling the file out from under live readers is a race.
 * Job history is preserved so the rebuild's own progress row survives.
 */
export function truncateContent() {
  const d = open();
  d.transaction(() => {
    d.exec('DELETE FROM fts');
    d.exec('DELETE FROM segments');
    d.exec('DELETE FROM recordings');
    d.exec('DELETE FROM contacts');
  })();
}

/** Finds a recording by its original filename, for metadata back-fill. */
export function findByOrigName(origName) {
  return open().prepare(`SELECT id, rel_path, orig_name, direction, duration_ms, props_json
                         FROM recordings WHERE orig_name = ?`).get(origName);
}

export function allOrigNames() {
  return open().prepare('SELECT id, orig_name, rel_path, direction, props_json FROM recordings').all();
}

/**
 * Attaches Cube's .props metadata to a recording imported without it.
 * The sidecar's duration is authoritative — it is what the recorder measured,
 * whereas ours was probed from a re-encoded file.
 */
export function backfillProps(id, { direction, durationMs, raw }) {
  const sets = ['props_json = @raw'];
  if (direction) sets.push('direction = @direction');
  if (durationMs) sets.push('duration_ms = @durationMs');
  open().prepare(`UPDATE recordings SET ${sets.join(', ')} WHERE id = @id`)
    .run({ id, direction, durationMs, raw });
}

/** Records a recording as having no audio signal, without involving whisper. */
export function markSilent(id, transcriptPath, note) {
  open().prepare(`UPDATE recordings SET transcript_status = 'silent',
                  transcript_error = ?, transcript_path = ? WHERE id = ?`)
    .run(note, transcriptPath, id);
}

/** Rename one contact. Persists to contacts.json so it survives a reindex. */
export function renameContact(key, name) {
  const d = open();
  const row = d.prepare('SELECT id, kind FROM contacts WHERE key = ?').get(key);
  if (!row) throw new Error(`No contact with key ${key}`);
  const applied = setOverride(key, name);
  // Clearing a name must fall back to the same pretty formatting a fresh import
  // would produce, not to the raw E.164 key.
  const fallback = key === 'unknown' ? 'Unknown number' : normalizeContact(key).display;
  d.prepare('UPDATE contacts SET display_name = ? WHERE id = ?').run(applied ?? fallback, row.id);
  return { key, display_name: applied ?? fallback, custom: Boolean(applied) };
}

/**
 * Applies a batch of imported names to existing contacts.
 * Numbers present in the address book but never called are stored anyway — they
 * will be picked up automatically if such a call is ever imported.
 */
export function applyContactNames(pairs) {
  const d = open();
  setMany(pairs);
  const upd = d.prepare('UPDATE contacts SET display_name = ? WHERE key = ?');
  let matched = 0;
  const tx = d.transaction((pairs) => {
    for (const [key, name] of pairs) {
      if (upd.run(name, key).changes) matched++;
    }
  });
  tx(pairs);
  return { stored: pairs.length, matched };
}

/** Which of a contact's names came from contacts.json rather than a filename. */
export function customNames() {
  return new Set(overrides().keys());
}

/** Drops the cached name overrides after contacts.json is deleted or edited. */
export function reloadContactNames() {
  return reloadOverrides();
}

/* ---------- recordings ---------- */

export function findBySha(sha256) {
  return open().prepare('SELECT id, rel_path FROM recordings WHERE sha256 = ?').get(sha256);
}

export function insertRecording(r) {
  return open().prepare(`
    INSERT INTO recordings (sha256, orig_name, rel_path, source, started_at, raw_contact,
                            contact_id, direction, duration_ms, bytes, audio_path,
                            transcript_status, imported_at, props_json)
    VALUES (@sha256, @orig_name, @rel_path, @source, @started_at, @raw_contact,
            @contact_id, @direction, @duration_ms, @bytes, @audio_path,
            @transcript_status, @imported_at, @props_json)
  `).run(r).lastInsertRowid;
}

export function setAudioPath(id, audioPath) {
  open().prepare('UPDATE recordings SET audio_path = ? WHERE id = ?').run(audioPath, id);
}

/**
 * @param {'newest'|'named'} order  'named' puts recordings whose contact is in
 *   the address book (a real person, not a bare number) first. A full archive
 *   run takes days, so it is worth getting the voices of people you know done
 *   first rather than banks and delivery services.
 */
export function nextPending(limit = 1, order = 'newest') {
  const orderBy = order === 'named'
    ? `CASE WHEN c.kind = 'name' THEN 0 ELSE 1 END, r.started_at DESC`
    : 'r.started_at DESC';
  return open().prepare(`
    SELECT r.id, r.rel_path, r.orig_name, r.duration_ms
    FROM recordings r LEFT JOIN contacts c ON c.id = r.contact_id
    WHERE r.transcript_status = 'pending'
    ORDER BY ${orderBy}
    LIMIT ?
  `).all(limit);
}

export function markStatus(id, status, error = null) {
  open().prepare('UPDATE recordings SET transcript_status = ?, transcript_error = ? WHERE id = ?')
    .run(status, error, id);
}

/** Transcript, segments and FTS in one transaction, so no half state survives. */
export const saveTranscript = (() => {
  let tx = null;
  return (id, { transcriptPath, model, language, segments, fullText }) => {
    const d = open();
    tx ??= d.transaction((id, transcriptPath, model, language, segments, fullText) => {
      d.prepare(`UPDATE recordings SET transcript_path = ?, model = ?, language = ?,
                 transcript_status = ? WHERE id = ?`)
        .run(transcriptPath, model, language, fullText.trim() ? 'done' : 'empty', id);
      d.prepare('DELETE FROM segments WHERE recording_id = ?').run(id);
      const ins = d.prepare('INSERT INTO segments (recording_id, idx, t0, t1, text) VALUES (?, ?, ?, ?, ?)');
      segments.forEach((s, i) => ins.run(id, i, s.t0, s.t1, s.text));
      d.prepare('DELETE FROM fts WHERE rowid = ?').run(id);
      if (fullText.trim()) {
        d.prepare('INSERT INTO fts (rowid, text) VALUES (?, ?)').run(id, fullText);
      }
    });
    tx(id, transcriptPath, model, language, segments, fullText);
  };
})();

/* ---------- jobs ---------- */

export function startJob(kind, total, nowIso) {
  return open().prepare(`INSERT INTO jobs (kind, state, total, started_at) VALUES (?, 'running', ?, ?)`)
    .run(kind, total, nowIso).lastInsertRowid;
}

export function bumpJob(id, { done = 0, failed = 0 }) {
  open().prepare('UPDATE jobs SET done = done + ?, failed = failed + ? WHERE id = ?').run(done, failed, id);
}

export function finishJob(id, state, nowIso, message = null) {
  open().prepare('UPDATE jobs SET state = ?, finished_at = ?, message = ? WHERE id = ?')
    .run(state, nowIso, message, id);
}

/** Job history, newest first — how a long run is inspected after the fact. */
export function jobs(limit = 20) {
  return open().prepare(`SELECT id, kind, state, total, done, failed, message,
                                started_at, finished_at
                         FROM jobs ORDER BY id DESC LIMIT ?`).all(limit);
}

/* ---------- summary ---------- */

export function stats() {
  const d = open();
  const one = (sql) => d.prepare(sql).get();
  return {
    recordings: one('SELECT COUNT(*) n FROM recordings').n,
    contacts: one('SELECT COUNT(*) n FROM contacts').n,
    totalMs: one('SELECT COALESCE(SUM(duration_ms),0) n FROM recordings').n,
    byStatus: d.prepare('SELECT transcript_status s, COUNT(*) n FROM recordings GROUP BY 1').all(),
    years: d.prepare(`SELECT substr(started_at,1,4) y, COUNT(*) n FROM recordings GROUP BY 1 ORDER BY 1`).all(),
    range: one('SELECT MIN(started_at) a, MAX(started_at) b FROM recordings'),
  };
}
