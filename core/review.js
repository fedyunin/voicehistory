// Recordings whose transcription looks wrong, and why.
//
// Recognition does not fail loudly. It returns a plausible-looking result for a
// recording it made nothing of: one line for an hour of speech, a stage
// direction instead of a conversation, a wall of text with no punctuation. None
// of that is an error anywhere in the pipeline, so nothing surfaces it — and in
// a 5,398-recording archive nobody is going to find them by scrolling.
//
// The rules are SQL rather than a stored flag on purpose. They will be wrong at
// first and want tuning, and a rule that lives in a query can be changed without
// re-transcribing or even reindexing anything.
import { open } from './db.js';

/**
 * Each reason is a WHERE fragment over `recordings r`, ordered by how likely it
 * is that something is actually wrong.
 */
/**
 * Durations are quantiles of THIS archive, not fixed minutes.
 *
 * "Longer than three minutes" was measured against 5,398 recordings and 505
 * hours. On an archive of a few dozen short calls the same number matches
 * nothing and the whole section silently disappears; on one of very long calls
 * it matches everything. Quantiles say the same thing — "long for you" — at any
 * size. Cached until the recording count moves.
 */
let marks = null;

function thresholds() {
  const d = open();
  const n = d.prepare('SELECT COUNT(*) n FROM recordings').get().n;
  if (marks?.n === n) return marks;
  if (!n) return { n, mid: 0, long: 0, words: 0 };

  const at = (q) => d.prepare(
    'SELECT duration_ms v FROM recordings ORDER BY duration_ms LIMIT 1 OFFSET ?',
  ).get(Math.min(n - 1, Math.floor(n * q)))?.v ?? 0;

  marks = {
    n,
    mid: at(0.6),          // longer than most calls
    long: at(0.85),        // among the longest
    // "Almost no words" scaled to what a call of that length usually yields:
    // roughly a tenth of the archive's own characters-per-minute.
    words: Math.max(60, Math.round(charsPerMinute(d) * 0.1)),
  };
  return marks;
}

function charsPerMinute(d) {
  const r = d.prepare(`
    SELECT COALESCE(SUM(LENGTH(s.text)), 0) chars, COALESCE(SUM(r.duration_ms), 0) ms
    FROM segments s JOIN recordings r ON r.id = s.recording_id
  `).get();
  return r.ms ? (r.chars / (r.ms / 60000)) : 600;
}

export const REASONS = {
  failed: {
    label: 'Failed',
    hint: 'recognition returned an error',
    where: "r.transcript_status = 'failed'",
  },
  collapsed: {
    label: 'No punctuation',
    hint: 'a long unbroken run of lowercase — the decode collapsed',
    where: `r.transcript_status = 'done' AND r.id IN (
      SELECT recording_id FROM (
        SELECT recording_id, GROUP_CONCAT(text, ' ') t FROM segments GROUP BY recording_id
      ) WHERE LENGTH(t) > 400
        AND (LENGTH(t) - LENGTH(REPLACE(REPLACE(t, '.', ''), ',', ''))) * 1.0 / LENGTH(t) < 0.005
    )`,
  },
  thin: {
    label: 'Barely anything',
    hint: 'minutes of audio, a couple of phrases out of it',
    where: (t) => `r.transcript_status = 'done' AND r.duration_ms > ${t.mid}
      AND (SELECT COUNT(*) FROM segments s WHERE s.recording_id = r.id) <= 3`,
  },
  sparse: {
    label: 'Very little text',
    hint: 'a long call with almost no words recognized',
    where: (t) => `r.transcript_status = 'done' AND r.duration_ms > ${t.long}
      AND (SELECT COALESCE(SUM(LENGTH(text)), 0) FROM segments s WHERE s.recording_id = r.id)
          < ${t.words} * (r.duration_ms / 60000.0)`,
  },
  quiet: {
    label: 'Reported as no speech',
    hint: 'long enough that silence is worth double-checking',
    where: (t) => `r.transcript_status IN ('silent', 'empty') AND r.duration_ms > ${t.mid}`,
  },
};

export function whereFor(reason) {
  const spec = REASONS[reason];
  if (!spec) return null;
  return typeof spec.where === 'function' ? spec.where(thresholds()) : spec.where;
}

/** How many recordings each reason matches, with the empty ones dropped. */
export function counts() {
  const d = open();
  const out = [];
  for (const [key, { label, hint }] of Object.entries(REASONS)) {
    const { n, ms } = d.prepare(
      `SELECT COUNT(*) n, COALESCE(SUM(r.duration_ms), 0) ms FROM recordings r WHERE ${whereFor(key)}`,
    ).get();
    if (n) out.push({ key, label, hint, n, ms });
  }
  return out;
}

/** The ids behind one reason, for re-transcribing the lot. */
export function ids(reason) {
  const where = whereFor(reason);
  if (!where) return [];
  return open()
    .prepare(`SELECT r.id FROM recordings r WHERE ${where} ORDER BY r.duration_ms DESC`)
    .all().map((r) => r.id);
}
