// User-assigned contact names, and vCard import.
//
// WHY A SEPARATE FILE: display names that the user typed, or imported from a
// phone address book, exist in no recording and no sidecar. The database is
// rebuilt from files on disk, so storing these only in SQLite would mean
// `reindex` silently erased every name you had entered.
//
// contacts.json therefore sits at the archive root as plain, hand-editable
// JSON keyed by normalized contact key:
//
//   { "+15550001234": "Mom", "+15550005678": "Sam" }
//
// Precedence: this file  >  name found in the recording filename  >  formatted
// number. An explicit human decision outranks anything inferred.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './paths.js';
import { normalizeContact } from './contacts.js';

const FILE = () => path.join(paths.root, 'contacts.json');

let cache = null;

export function overrides() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    cache = new Map(Object.entries(raw).filter(([, v]) => typeof v === 'string' && v.trim()));
  } catch {
    cache = new Map();
  }
  return cache;
}

export function overrideFor(key) {
  return overrides().get(key) ?? null;
}

function persist() {
  const obj = Object.fromEntries([...overrides()].sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(FILE(), `${JSON.stringify(obj, null, 2)}\n`);
}

/** @param {string|null} name  null or '' removes the override. */
export function setOverride(key, name) {
  const m = overrides();
  const clean = (name ?? '').trim();
  if (clean) m.set(key, clean); else m.delete(key);
  persist();
  return clean || null;
}

export function setMany(pairs) {
  const m = overrides();
  let n = 0;
  for (const [key, name] of pairs) {
    const clean = (name ?? '').trim();
    if (!clean) continue;
    m.set(key, clean);
    n++;
  }
  persist();
  return n;
}

/* ============================ vCard ============================ */

/**
 * Parses vCard 2.1 / 3.0 / 4.0 — the format every phone exports.
 * @returns {Array<{name: string, phones: string[]}>}
 */
export function parseVCards(text) {
  // Unfold: continuation lines begin with a space or tab.
  const unfolded = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
  const out = [];

  for (const block of unfolded.split(/BEGIN:VCARD/i).slice(1)) {
    const body = block.split(/END:VCARD/i)[0];
    let name = '';
    let structured = '';
    const phones = [];

    for (const line of body.split('\n')) {
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const rawKey = line.slice(0, colon);
      const value = decodeValue(line.slice(colon + 1), rawKey);
      // strip Apple-style grouping: item1.TEL;type=CELL
      const prop = rawKey.split(';')[0].split('.').pop().toUpperCase();

      if (prop === 'FN' && value.trim()) name ||= value.trim();
      else if (prop === 'N' && value.trim()) structured ||= value;
      else if (prop === 'TEL' && value.trim()) phones.push(value.trim());
    }

    if (!name && structured) {
      // N:Last;First;Middle;Prefix;Suffix → "First Last"
      const [last, first] = structured.split(';');
      name = [first, last].filter(Boolean).join(' ').trim();
    }
    if (name && phones.length) out.push({ name, phones });
  }
  return out;
}

/** vCard 2.1 commonly quoted-printable-encodes non-ASCII names. */
function decodeValue(value, rawKey) {
  if (!/quoted-printable/i.test(rawKey)) return value;
  const bytes = [];
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '=' && /^[0-9a-f]{2}$/i.test(value.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(value.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(value.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Maps a parsed address book onto normalized contact keys.
 * Phone numbers go through the SAME normalization as filenames, which is what
 * makes matching work at all: an address book writes numbers grouped and
 * spaced in international form, while filenames carry bare local digits.
 *
 * @returns {{pairs: Array<[string,string]>, cards: number, numbers: number}}
 */
export function vcardsToOverrides(text) {
  const cards = parseVCards(text);
  const pairs = [];
  let numbers = 0;
  for (const { name, phones } of cards) {
    for (const phone of phones) {
      const { key, kind } = normalizeContact(phone);
      if (kind === 'unknown') continue;
      numbers++;
      pairs.push([key, name]);
    }
  }
  return { pairs, cards: cards.length, numbers };
}

/** Reset the in-memory cache — used by tests and after external edits. */
export function reload() {
  cache = null;
  return overrides();
}
