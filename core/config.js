// Settings in effect, resolved from the open archive.
//
// Precedence, highest first:
//   1. environment variable        — override for a single command
//   2. archive.json → settings     — what the interface writes; travels with the data
//   3. built-in default
//
// These are exported as `let` on purpose. ES module bindings are live, so
// reassigning them here propagates to every importer, which is what lets the
// interface switch archives — or change the language — without restarting.
// NUMBERING is mutated in place for the same reason.
import { paths } from './paths.js';
import { readManifest, DEFAULT_SETTINGS } from './archive.js';

export let LANGUAGE = DEFAULT_SETTINGS.language;
export let MODEL = DEFAULT_SETTINGS.model;
export let PROMPT = DEFAULT_SETTINGS.prompt;
export let SILENCE_PEAK_DB = DEFAULT_SETTINGS.silencePeakDb;
export const NUMBERING = { ...DEFAULT_SETTINGS.numbering };

let stored = {};

const ENV = {
  language: 'VH_LANGUAGE',
  model: 'VH_MODEL',
  prompt: 'VH_PROMPT',
  silencePeakDb: 'VH_SILENCE_PEAK_DB',
  countryCode: 'VH_COUNTRY_CODE',
  trunkPrefix: 'VH_TRUNK_PREFIX',
  nsnLength: 'VH_NSN_LENGTH',
};

function env(key) {
  const v = process.env[ENV[key]];
  return v === undefined || v === '' ? undefined : v;
}

/** An empty string is meaningful for trunkPrefix ("no prefix"), so only nullish falls through. */
function pick(key, fileValue, fallback) {
  const e = env(key);
  if (e !== undefined) return e;
  return fileValue ?? fallback;
}

/** Re-reads the open archive's manifest. Called on open and after a settings change. */
export function reload() {
  const manifest = paths.root ? readManifest(paths.root) : null;
  stored = manifest?.settings ?? {};
  const num = stored.numbering ?? {};

  LANGUAGE = String(pick('language', stored.language, DEFAULT_SETTINGS.language));
  MODEL = String(pick('model', stored.model, DEFAULT_SETTINGS.model));
  PROMPT = env('prompt') ?? stored.prompt ?? DEFAULT_SETTINGS.prompt;
  SILENCE_PEAK_DB = Number(pick('silencePeakDb', stored.silencePeakDb, DEFAULT_SETTINGS.silencePeakDb));

  NUMBERING.countryCode =
    String(pick('countryCode', num.countryCode, DEFAULT_SETTINGS.numbering.countryCode)).replace(/\D/g, '')
    || DEFAULT_SETTINGS.numbering.countryCode;
  NUMBERING.trunkPrefix =
    String(pick('trunkPrefix', num.trunkPrefix, DEFAULT_SETTINGS.numbering.trunkPrefix)).replace(/\D/g, '');
  NUMBERING.nsnLength = Number(pick('nsnLength', num.nsnLength, DEFAULT_SETTINGS.numbering.nsnLength));

  return effective();
}

/** Every value in effect and where it came from — the interface shows this verbatim. */
export function effective() {
  const num = stored.numbering ?? {};
  const from = (key, fileValue) => {
    if (env(key) !== undefined) return 'environment';
    return fileValue !== undefined && fileValue !== null ? 'archive' : 'default';
  };
  return {
    values: {
      language: { value: LANGUAGE, from: from('language', stored.language) },
      model: { value: MODEL, from: from('model', stored.model) },
      prompt: {
        value: PROMPT ? `${String(PROMPT).slice(0, 46)}…` : 'built-in sample',
        from: from('prompt', stored.prompt),
      },
      silencePeakDb: { value: SILENCE_PEAK_DB, from: from('silencePeakDb', stored.silencePeakDb) },
      countryCode: { value: NUMBERING.countryCode, from: from('countryCode', num.countryCode) },
      trunkPrefix: { value: NUMBERING.trunkPrefix || '(none)', from: from('trunkPrefix', num.trunkPrefix) },
      nsnLength: { value: NUMBERING.nsnLength, from: from('nsnLength', num.nsnLength) },
    },
    // Raw stored values, for the edit form. The display copy above truncates the
    // prompt, and writing that truncation back would quietly corrupt it.
    stored: {
      language: stored.language ?? null,
      model: stored.model ?? null,
      prompt: stored.prompt ?? null,
      silencePeakDb: stored.silencePeakDb ?? null,
      numbering: { ...num },
    },
    // Which keys the interface must not offer to edit, because an environment
    // variable is winning and a written value would appear to do nothing.
    lockedByEnv: Object.keys(ENV).filter((k) => env(k) !== undefined),
  };
}
