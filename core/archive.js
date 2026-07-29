// The archive manifest: what makes a folder recognizably an archive, and what
// lets a future version read one written by this one.
//
// `archive.json` carries a format version and the settings that describe the
// DATA rather than the machine — the language it was transcribed in, the
// numbering plan its contacts were normalized under, the model that produced the
// transcripts. Those belong with the recordings: move the folder to another
// computer, or open it with a later version of the app, and the values that
// explain the contents travel with them.
//
// Anything machine-specific (which archive is open) lives in appsettings.js.
import fs from 'node:fs';
import path from 'node:path';
import { paths, setRoot, ensureDirs } from './paths.js';

/**
 * Bump when the on-disk layout changes in a way older code cannot read.
 * A newer archive opened by an older build is refused rather than corrupted.
 */
export const FORMAT_VERSION = 1;

const MARKER = 'voicehistory-archive';

export const DEFAULT_SETTINGS = {
  language: 'ru',
  model: 'large-v3-turbo',
  prompt: null,
  silencePeakDb: -60,
  numbering: { countryCode: '7', trunkPrefix: '8', nsnLength: 10 },
};

/* ---------------- inspection ---------------- */

/**
 * Describes a folder without opening it, so the interface can explain what will
 * happen before anything is written.
 * @returns {{path, exists, writable, isArchive, formatVersion, tooNew, recordings, empty, error}}
 */
export function inspect(dir) {
  const resolved = path.resolve(expandHome(dir ?? ''));
  const out = {
    path: resolved,
    exists: false,
    writable: false,
    isArchive: false,
    formatVersion: null,
    tooNew: false,
    recordings: 0,
    empty: false,
    error: null,
  };
  if (!dir) { out.error = 'no folder given'; return out; }
  if (!fs.existsSync(resolved)) {
    // A missing folder is fine — it can be created. Its parent must exist.
    out.writable = canWrite(path.dirname(resolved));
    out.empty = true;
    if (!out.writable) out.error = 'parent folder does not exist or is not writable';
    return out;
  }
  if (!fs.statSync(resolved).isDirectory()) { out.error = 'that is a file, not a folder'; return out; }

  out.exists = true;
  out.writable = canWrite(resolved);
  const manifestPath = path.join(resolved, 'archive.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (m.marker === MARKER || m.voicehistory === true) {
        out.isArchive = true;
        out.formatVersion = Number(m.formatVersion ?? 1);
        out.tooNew = out.formatVersion > FORMAT_VERSION;
        if (out.tooNew) {
          out.error = `archive format ${out.formatVersion} is newer than this build understands (${FORMAT_VERSION})`;
        }
      } else {
        out.error = 'archive.json is present but is not a voicehistory manifest';
      }
    } catch (e) {
      out.error = `archive.json could not be read: ${e.message}`;
    }
  }
  out.recordings = countRecordings(path.join(resolved, 'recordings'));
  out.empty = fs.readdirSync(resolved).filter((n) => !n.startsWith('.')).length === 0;
  if (!out.writable && !out.error) out.error = 'folder is not writable';
  return out;
}

/* ---------------- manifest ---------------- */

export function readManifest(dir = paths.root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'archive.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function writeManifest(dir, manifest) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'archive.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function freshManifest(nowIso) {
  return {
    marker: MARKER,
    formatVersion: FORMAT_VERSION,
    created: nowIso,
    updated: nowIso,
    settings: structuredClone(DEFAULT_SETTINGS),
  };
}

/**
 * Opens a folder as the current archive, creating the manifest and skeleton if
 * it is not one yet. Idempotent.
 */
export function open(dir, { nowIso = new Date().toISOString() } = {}) {
  const info = inspect(dir);
  if (info.error) throw new Error(info.error);

  setRoot(info.path);
  ensureDirs();

  let manifest = readManifest(info.path);
  if (!manifest) {
    manifest = writeManifest(info.path, freshManifest(nowIso));
  } else {
    // Fill in keys added by later versions without discarding the user's values.
    manifest.settings = { ...structuredClone(DEFAULT_SETTINGS), ...(manifest.settings ?? {}) };
    manifest.settings.numbering = {
      ...DEFAULT_SETTINGS.numbering,
      ...(manifest.settings.numbering ?? {}),
    };
    manifest.updated = nowIso;
    writeManifest(info.path, manifest);
  }
  return { root: info.path, manifest, created: !info.isArchive };
}

/** Merges a partial settings patch into the manifest and returns the result. */
export function updateSettings(patch, { nowIso = new Date().toISOString() } = {}) {
  const dir = paths.root;
  if (!dir) throw new Error('No archive is open');
  const manifest = readManifest(dir) ?? freshManifest(nowIso);
  const next = { ...manifest.settings, ...patch };
  if (patch.numbering) next.numbering = { ...manifest.settings.numbering, ...patch.numbering };
  manifest.settings = next;
  manifest.updated = nowIso;
  writeManifest(dir, manifest);
  return manifest.settings;
}

/**
 * A sensible default location, so first run is one click rather than typing a
 * path. Documents is chosen over the home root because an archive grows to
 * gigabytes and belongs somewhere users already back up.
 */
export function suggestDefaultLocation() {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '.';
  const docs = path.join(home, 'Documents');
  return path.join(fs.existsSync(docs) ? docs : home, 'Voice History');
}

/* ---------------- helpers ---------------- */

export function expandHome(p) {
  return p.replace(/^~(?=\/|\\|$)/, process.env.HOME ?? process.env.USERPROFILE ?? '~');
}

function canWrite(dir) {
  try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; }
}

function countRecordings(dir) {
  let n = 0;
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) { if (e.name !== '.props') walk(path.join(d, e.name)); }
      else if (!e.name.startsWith('.')) n++;
    }
  };
  walk(dir);
  return n;
}
