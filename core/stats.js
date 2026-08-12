// Seven years of calls, read as a whole.
//
// Everything here is one pass over 5,398 rows, so nothing is cached and nothing
// is precomputed: the archive is small, and a number that is always current is
// worth more than one that is fast.
//
// People are grouped by NAME, not by contact row. One person routinely has
// several numbers — in the archive this was built against, "Мама" is four of
// them and 1,897 calls — and counting rows would put a third of a relationship
// under a separate heading.
import { open } from './db.js';

/** Calls are counted by time, not by frequency; see topPeople. */
export function overview() {
  const d = open();
  const one = (sql) => d.prepare(sql).get();
  const all = (sql) => d.prepare(sql).all();

  const totals = one(`
    SELECT COUNT(*) recordings,
           COALESCE(SUM(duration_ms), 0) ms,
           COUNT(DISTINCT contact_id) numbers,
           MIN(started_at) first,
           MAX(started_at) last
    FROM recordings
  `);

  return {
    totals: {
      ...totals,
      // Same definition as the footer's: distinct names among contacts that
      // actually appear in a recording.
      people: one(`SELECT COUNT(*) n FROM (
        SELECT DISTINCT c.display_name FROM contacts c
        JOIN recordings r ON r.contact_id = c.id
        WHERE c.display_name IS NOT NULL)`).n,
      transcribed: one("SELECT COUNT(*) n FROM recordings WHERE transcript_status = 'done'").n,
    },

    byYear: all(`
      SELECT substr(started_at, 1, 4) AS year, COUNT(*) AS calls, SUM(duration_ms) AS ms
      FROM recordings GROUP BY year ORDER BY year
    `),

    // By time. Counting calls instead would rank a bank's notifications above a
    // parent: 2,315 recordings under a minute account for 17 hours, while 33
    // over an hour account for 49.
    topPeople: all(`
      SELECT c.display_name AS name,
             COUNT(r.id) AS calls,
             SUM(r.duration_ms) AS ms,
             COUNT(DISTINCT c.id) AS numbers,
             MIN(r.started_at) AS first,
             MAX(r.started_at) AS last
      FROM recordings r JOIN contacts c ON c.id = r.contact_id
      WHERE c.display_name IS NOT NULL
      GROUP BY c.display_name
      ORDER BY ms DESC
      LIMIT 12
    `),

    // Local time as recorded in the filename, which is what the phone showed.
    byHour: all(`
      SELECT CAST(substr(started_at, 12, 2) AS INTEGER) AS hour,
             COUNT(*) AS calls, SUM(duration_ms) AS ms
      FROM recordings GROUP BY hour ORDER BY hour
    `),

    byDirection: all(`
      SELECT COALESCE(direction, 'unknown') AS direction, COUNT(*) AS calls, SUM(duration_ms) AS ms
      FROM recordings GROUP BY direction
    `),

    byLength: all(`
      SELECT CASE
               WHEN duration_ms <   60000 THEN 'under a minute'
               WHEN duration_ms <  600000 THEN '1–10 minutes'
               WHEN duration_ms < 3600000 THEN '10–60 minutes'
               ELSE 'over an hour'
             END AS band,
             COUNT(*) AS calls, SUM(duration_ms) AS ms
      FROM recordings GROUP BY band
    `),

    longest: all(`
      SELECT r.id, r.duration_ms AS ms, r.started_at, c.display_name AS name
      FROM recordings r LEFT JOIN contacts c ON c.id = r.contact_id
      ORDER BY r.duration_ms DESC LIMIT 5
    `),
  };
}
