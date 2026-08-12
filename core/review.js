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
    where: `r.transcript_status = 'done' AND r.duration_ms > 120000
      AND (SELECT COUNT(*) FROM segments s WHERE s.recording_id = r.id) <= 3`,
  },
  sparse: {
    label: 'Very little text',
    hint: 'a long call with almost no words recognized',
    where: `r.transcript_status = 'done' AND r.duration_ms > 300000
      AND (SELECT COALESCE(SUM(LENGTH(text)), 0) FROM segments s WHERE s.recording_id = r.id) < 200`,
  },
  quiet: {
    label: 'Reported as no speech',
    hint: 'long enough that silence is worth double-checking',
    where: "r.transcript_status IN ('silent', 'empty') AND r.duration_ms > 180000",
  },
};

export function whereFor(reason) {
  return REASONS[reason]?.where ?? null;
}

/** How many recordings each reason matches, with the empty ones dropped. */
export function counts() {
  const d = open();
  const out = [];
  for (const [key, { label, hint, where }] of Object.entries(REASONS)) {
    const { n, ms } = d.prepare(
      `SELECT COUNT(*) n, COALESCE(SUM(r.duration_ms), 0) ms FROM recordings r WHERE ${where}`,
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
