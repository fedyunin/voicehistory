// What a year, or a person, was about.
//
// Not the most frequent words — those are "да", "ну", "вот" in every year, in
// every conversation, forever. What matters is contrast: the words that stand
// out HERE against everything else in the archive. Stop words score zero on that
// measure by construction, so no hand-written list of them is needed.
//
// Two things had to be learned by measurement rather than guessed:
//
//   • Count recordings, not occurrences. Scored by occurrences, one word shouted
//     across two long calls looked like the theme of a year — "катанем(1132)" —
//     and so did every consistent mistranscription. Counting each word once per
//     recording removed both without a single special case.
//   • Collapse inflections — but only in the finished list. Stemming the whole
//     corpus first was tried and made things worse: the crude clipping this
//     project uses for search merges unrelated words into one bucket, and the
//     scoring degenerated until "почти" and "теперь" outranked "карантин".
//     Folding by shared prefix among the winners keeps the signal and still
//     spares the reader five forms of one verb.
import { open } from './db.js';

/** Words of four letters or more; shorter ones carry no topic. */
const words = (text) => text.toLowerCase().match(/[а-яёa-z]{4,}/gu) ?? [];

/**
 * Phrases from the network rather than from anyone speaking: the operator's
 * recorded announcement appears in hundreds of recordings and would otherwise
 * read as a conversation topic.
 */
const NOT_SPEECH = /^(абонент\w*|недоступен|временно|вызываемый|аппарат\w*)$/;

/** One row per recording, with the year and person it belongs to. */
function corpus() {
  return open().prepare(`
    SELECT substr(r.started_at, 1, 4) AS year, c.display_name AS name, g.t AS text
    FROM recordings r
    LEFT JOIN contacts c ON c.id = r.contact_id
    JOIN (SELECT recording_id, GROUP_CONCAT(text, ' ') t FROM segments GROUP BY recording_id) g
      ON g.recording_id = r.id
  `).all();
}

/**
 * Builds document-frequency tables once, then scores any group against the rest.
 * The whole archive is under a million distinct word-uses, so this is a second
 * of work — cached per process and thrown away when the transcript count moves.
 */
let cache = null;

function tables() {
  const d = open();
  const n = d.prepare("SELECT COUNT(*) n FROM recordings WHERE transcript_status = 'done'").get().n;
  if (cache?.n === n) return cache;

  const byYear = new Map();
  const byName = new Map();
  const total = new Map();
  let docs = 0;

  const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);

  for (const row of corpus()) {
    const seen = new Set();
    for (const w of words(row.text)) {
      if (!NOT_SPEECH.test(w)) seen.add(w);
    }
    docs++;
    for (const w of seen) {
      bump(total, w);
      if (!byYear.has(row.year)) byYear.set(row.year, new Map());
      bump(byYear.get(row.year), w);
      if (row.name) {
        if (!byName.has(row.name)) byName.set(row.name, new Map());
        bump(byName.get(row.name), w);
      }
    }
  }

  // The denominator for scoring is the corpus in the SAME unit as the groups:
  // the sum of document frequencies, not the number of recordings. Using the
  // recording count inverted the normalization and put "почти" above "карантин".
  const sum = [...total.values()].reduce((a, b) => a + b, 0);
  cache = { n, byYear, byName, total, docs, sum };
  return cache;
}

/** Same word, different ending: keep the first, which scored higher. */
function sameRoot(a, b) {
  // Five characters: "свеклу" and "свеклы" are one word to a reader, and the
  // occasional false pair costs a slot, never a wrong claim.
  return a.length >= 5 && b.length >= 5 && a.slice(0, 5) === b.slice(0, 5);
}

/**
 * Log-odds of a stem inside this group against the whole archive. A word spread
 * evenly scores about zero; one concentrated here scores high.
 */
function distinctive(t, group, { top = 10 } = {}) {
  // A word has to appear in a share of the archive, not in a fixed number of
  // recordings. Four was right for 4,461 transcripts and impossible for 200.
  const minDocs = Math.max(2, Math.round(t.docs * 0.001));
  if (!group) return [];
  const size = [...group.values()].reduce((a, b) => a + b, 0);
  if (size < t.sum * 0.005) return [];    // too little text here to say anything
  const scored = [];
  for (const [w, n] of group) {
    if (n < minDocs) continue;
    const rest = (t.total.get(w) ?? 0) - n;
    const p = (n + 0.5) / (size + 1);
    const q = (rest + 0.5) / (t.sum - size + 1);
    scored.push({ word: w, calls: n, score: Math.log(p / q) });
  }
  scored.sort((a, b) => b.score - a.score);

  const kept = [];
  for (const c of scored) {
    if (kept.some((k) => sameRoot(k.word, c.word))) continue;
    kept.push(c);
    if (kept.length === top) break;
  }
  return kept;
}

export function byYear({ top = 8 } = {}) {
  const t = tables();
  return [...t.byYear.keys()].sort()
    .map((year) => ({ year, words: distinctive(t, t.byYear.get(year), { top }) }))
    .filter((y) => y.words.length);
}

export function forPerson(name, { top = 8 } = {}) {
  const t = tables();
  return distinctive(t, t.byName.get(name), { top });
}
