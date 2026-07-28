// Single source of truth for settings.
//
// Before this existed, every setting was read straight from process.env in
// whichever module needed it. That made them invisible (nothing on disk records
// your choices) and unsafe: setting a language for `npm start` but forgetting it
// for `node cli/vh.js transcribe` silently transcribed part of the archive with
// the wrong one.
//
// Precedence, highest first:
//   1. environment variable   — one-off override for a single command
//   2. config.json at the archive root  — your persistent settings
//   3. built-in default
//
// VH_ROOT is deliberately NOT part of config.json: the file lives inside the
// archive, so it cannot tell the program where the archive is.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './paths.js';

export const CONFIG_FILE = path.join(paths.root, 'config.json');

function fromFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.warn(`config.json could not be read (${e.message}); using defaults`);
    }
    return {};
  }
}

const file = fromFile();

const pick = (envKey, fileValue, fallback) => {
  const env = process.env[envKey];
  if (env !== undefined && env !== '') return env;
  // An empty string in the file is meaningful for trunkPrefix ("no prefix"),
  // so only undefined and null fall through to the default.
  if (fileValue !== undefined && fileValue !== null) return fileValue;
  return fallback;
};

const numbering = file.numbering ?? {};

/** Spoken language of the recordings, or 'auto' to detect per file. */
export const LANGUAGE = String(pick('VH_LANGUAGE', file.language, 'ru'));

/** Whisper model name, matching bin/models/ggml-<name>.bin */
export const MODEL = String(pick('VH_MODEL', file.model, 'large-v3-turbo'));

/**
 * Priming prompt. `null` means "use the built-in sample for LANGUAGE" — see
 * transcribe.js, which owns the samples.
 */
export const PROMPT = process.env.VH_PROMPT ?? file.prompt ?? null;

/** Peak level below which a recording is treated as silent, in dBFS. */
export const SILENCE_PEAK_DB = Number(pick('VH_SILENCE_PEAK_DB', file.silencePeakDb, -60));

/** National numbering plan, used to read numbers written in local form. */
export const NUMBERING = {
  countryCode: String(pick('VH_COUNTRY_CODE', numbering.countryCode, '7')).replace(/\D/g, '') || '7',
  trunkPrefix: String(pick('VH_TRUNK_PREFIX', numbering.trunkPrefix, '8')).replace(/\D/g, ''),
  nsnLength: Number(pick('VH_NSN_LENGTH', numbering.nsnLength, 10)),
};

/** Everything in effect right now, and where each value came from. */
export function effective() {
  const source = (envKey, fileValue) => {
    if (process.env[envKey] !== undefined && process.env[envKey] !== '') return 'environment';
    return fileValue !== undefined && fileValue !== null ? 'config.json' : 'default';
  };
  return {
    configFile: CONFIG_FILE,
    configFileExists: fs.existsSync(CONFIG_FILE),
    values: {
      language: { value: LANGUAGE, from: source('VH_LANGUAGE', file.language) },
      model: { value: MODEL, from: source('VH_MODEL', file.model) },
      prompt: {
        value: PROMPT ? `${PROMPT.slice(0, 42)}…` : 'built-in sample',
        from: source('VH_PROMPT', file.prompt),
      },
      silencePeakDb: { value: SILENCE_PEAK_DB, from: source('VH_SILENCE_PEAK_DB', file.silencePeakDb) },
      countryCode: { value: NUMBERING.countryCode, from: source('VH_COUNTRY_CODE', numbering.countryCode) },
      trunkPrefix: { value: NUMBERING.trunkPrefix || '(none)', from: source('VH_TRUNK_PREFIX', numbering.trunkPrefix) },
      nsnLength: { value: NUMBERING.nsnLength, from: source('VH_NSN_LENGTH', numbering.nsnLength) },
      archiveRoot: { value: paths.root, from: process.env.VH_ROOT ? 'environment' : 'default' },
    },
  };
}
