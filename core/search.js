// Archive queries. The signatures of these functions ARE the application's API:
// the HTTP server calls them today, ipcMain would call them under Electron, and
// neither shell adds any logic of its own.
import { open, customNames } from './db.js';
import { whereFor } from './review.js';

const PAGE = 50;

export function contacts() {
  const rows = open().prepare(`
    SELECT c.id, c.key, c.kind, c.display_name,
           COUNT(r.id) AS calls,
           COALESCE(SUM(r.duration_ms), 0) AS total_ms,
           MIN(r.started_at) AS first_call,
           MAX(r.started_at) AS last_call
    FROM contacts c JOIN recordings r ON r.contact_id = c.id
    GROUP BY c.id
    ORDER BY calls DESC
  `).all();
  // `custom` tells the UI which names came from contacts.json, so a user can
  // see at a glance what is still an unidentified number.
  const custom = customNames();
  for (const r of rows) r.custom = custom.has(r.key);
  return rows;
}

/**
 * The sidebar's list: one row per PERSON, not per number.
 *
 * contacts() stays as it is because the People dialog edits names per number,
 * which is the right unit there. Here the right unit is the person: "Мама" is
 * four numbers and 1,897 calls, and showing that as four rows made the sidebar
 * disagree with the archive overview about who you talk to most.
 */
export function people() {
  return open().prepare(`
    SELECT c.display_name AS name,
           COUNT(r.id) AS calls,
           COALESCE(SUM(r.duration_ms), 0) AS total_ms,
           COUNT(DISTINCT c.id) AS numbers,
           MIN(r.started_at) AS first_call,
           MAX(r.started_at) AS last_call
    FROM contacts c JOIN recordings r ON r.contact_id = c.id
    WHERE c.display_name IS NOT NULL
    GROUP BY c.display_name
    ORDER BY calls DESC
  `).all();
}

export function years() {
  return open().prepare(`
    SELECT substr(started_at, 1, 4) AS year, COUNT(*) AS calls,
           COALESCE(SUM(duration_ms), 0) AS total_ms
    FROM recordings GROUP BY 1 ORDER BY 1
  `).all();
}

/**
 * Recording list with filters. When q is present the query goes through FTS5
 * and each row carries a highlighted snippet.
 */
export function list({ q = '', contactId = null, contactName = null, day = null, year = null, source = null, review = null, offset = 0, limit = PAGE } = {}) {
  const d = open();
  const where = [];
  const args = {};
  if (contactId) { where.push('r.contact_id = @contactId'); args.contactId = contactId; }
  // By name, so selecting a person brings every number they have ever called from.
  if (contactName) { where.push('c.display_name = @contactName'); args.contactName = contactName; }
  if (year) { where.push("substr(r.started_at,1,4) = @year"); args.year = String(year); }
  if (day) { where.push("substr(r.started_at,1,10) = @day"); args.day = String(day); }
  if (source) { where.push('r.source = @source'); args.source = source; }
  // Doubtful recordings are a filter over the same list rather than a screen of
  // their own: everything that makes the list useful — opening one, reading it,
  // re-running it — already exists here.
  const reviewWhere = review ? whereFor(review) : null;
  if (reviewWhere) where.push(`(${reviewWhere})`);

  const base = `
    FROM recordings r
    LEFT JOIN contacts c ON c.id = r.contact_id
    ${q ? 'JOIN fts ON fts.rowid = r.id' : ''}
    ${q ? `WHERE fts MATCH @q ${where.length ? 'AND ' + where.join(' AND ') : ''}`
        : (where.length ? 'WHERE ' + where.join(' AND ') : '')}
  `;
  if (q) args.q = ftsQuery(q);

  const total = d.prepare(`SELECT COUNT(*) n ${base}`).get({ ...args }).n;
  const rows = d.prepare(`
    SELECT r.id, r.orig_name, r.rel_path, r.audio_path, r.source, r.started_at,
           r.direction, r.duration_ms, r.transcript_status,
           c.display_name AS contact, c.id AS contact_id
           ${q ? ", snippet(fts, 0, '<mark>', '</mark>', '…', 12) AS snippet, bm25(fts) AS rank" : ''}
    ${base}
    ORDER BY ${q ? 'rank' : review ? 'r.duration_ms DESC' : 'r.started_at DESC'}
    LIMIT @limit OFFSET @offset
  `).all({ ...args, limit, offset });

  // The stems go back with the results so the interface can locate the matching
  // phrase inside a recording without reimplementing the stemmer — one source of
  // truth for what "matching" means.
  return { total, offset, limit, rows, stems: q ? stems(q) : [] };
}

export function recording(id) {
  const d = open();
  const rec = d.prepare(`
    SELECT r.*, c.display_name AS contact, c.key AS contact_key
    FROM recordings r LEFT JOIN contacts c ON c.id = r.contact_id
    WHERE r.id = ?
  `).get(id);
  if (!rec) return null;
  rec.segments = d.prepare('SELECT idx, t0, t1, text FROM segments WHERE recording_id = ? ORDER BY idx').all(id);
  return rec;
}

/**
 * User input → FTS5 syntax. Every term is quoted so hyphens, quotes and FTS
 * operators cannot break the query, and every term is prefix-matched.
 *
 * Terms are crudely stemmed by clipping the tail before prefix-matching. This
 * exists because heavily inflected languages break naive prefix search: a noun
 * in the nominative will not match the same noun in the accusative, since the
 * forms diverge at the final character. Clipping to the shared stem finds every
 * case form — searching "teplitsa" (greenhouse) found nothing while transcripts
 * plainly contained "teplitsu".
 *
 * A real stemmer would be more precise, but it would be a dependency and this
 * is not a precision problem: in a personal archive you are trying to find a
 * conversation you half-remember, so recall matters far more than a few extra
 * matches.
 */
export function stem(word) {
  if (word.length >= 8) return word.slice(0, -3);
  if (word.length >= 5) return word.slice(0, -2);
  return word;
}

function terms(input) {
  return input.trim().split(/\s+/).map((w) => w.replace(/["*^:()]/g, '')).filter(Boolean);
}

/** The stems a query reduces to, lowercased — what actually gets matched. */
export function stems(input) {
  return terms(input).map((w) => stem(w).toLowerCase());
}

function ftsQuery(input) {
  const words = terms(input);
  if (!words.length) return '""';
  return words.map((w) => `"${stem(w)}"*`).join(' AND ');
}
