// Layout of an archive folder, and the current archive's location.
//
// An archive is a self-contained folder that lives WHEREVER THE USER WANTS —
// including an external drive — and holds nothing but their data:
//
//   <archive>/
//     archive.json      manifest: format version and the settings for this data
//     recordings/2026/2026-07/…        originals, by month (+ .props sidecars)
//     audio/2026/2026-07/…            playable copies (no browser plays AMR)
//     transcripts/2026/2026-07/…      raw model output
//     contacts.json                   names you assigned
//     index.sqlite                    search index — derived, rebuildable
//     inbox/                          default drop folder for new recordings
//
// Nothing here depends on where the code is checked out, and the database stores
// relative paths, so the folder can be moved or copied and still open.
//
// The root is settable at RUNTIME rather than fixed at import, so the interface
// can switch archives without restarting the process. Consumers must therefore
// read `paths.x` at call time and never destructure at module level.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Nothing is open yet on first run; the interface asks for a folder. */
let currentRoot = null;

export const paths = {};

function recompute() {
  const r = currentRoot;
  Object.assign(paths, {
    root: r,
    manifest: r && path.join(r, 'archive.json'),
    inbox: r && path.join(r, 'inbox'),
    duplicates: r && path.join(r, 'inbox', '_duplicates'),
    recordings: r && path.join(r, 'recordings'),
    audio: r && path.join(r, 'audio'),
    transcripts: r && path.join(r, 'transcripts'),
    contacts: r && path.join(r, 'contacts.json'),
    db: r && path.join(r, 'index.sqlite'),
    tmp: r && path.join(r, '.tmp'),
  });
}
recompute();

export function setRoot(dir) {
  currentRoot = dir ? path.resolve(dir) : null;
  recompute();
  return currentRoot;
}

export function hasRoot() {
  return currentRoot !== null;
}

/** Throws rather than silently operating on undefined paths. */
export function requireRoot() {
  if (!currentRoot) throw new Error('No archive is open — choose an archive folder first');
  return currentRoot;
}

/** Absolute path → relative to the archive root, for storage. Forward slashes always. */
export function rel(absPath) {
  return path.relative(requireRoot(), absPath).split(path.sep).join('/');
}

/** Relative path from the database → absolute path on this machine. */
export function abs(relPath) {
  return path.join(requireRoot(), ...relPath.split('/'));
}

/** Speech models and helper binaries belong to the installation, not the archive. */
export const appPaths = {
  bin: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'bin'),
  /** Where a model would be WRITTEN. To find one, use modelDirs(). */
  get models() { return modelsWriteDir(); },
};

/**
 * Per-user data location, for things too large to belong in a config folder.
 * Distinct from appsettings.configDir() on purpose: settings are small and worth
 * syncing or backing up, a 1.5 GB speech model is neither.
 */
function dataDir() {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'voicehistory');
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'voicehistory');
  }
  return path.join(process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'voicehistory');
}

/**
 * Everywhere a model may already be, most specific first.
 *
 * `bin/models` inside the checkout comes before the per-user folder so that an
 * existing development setup keeps working untouched — re-downloading 1.5 GB
 * because the code moved is not an acceptable upgrade.
 */
export function modelDirs() {
  const dirs = [];
  if (process.env.VH_MODELS_DIR) dirs.push(path.resolve(process.env.VH_MODELS_DIR));
  dirs.push(path.join(appPaths.bin, 'models'));
  dirs.push(path.join(dataDir(), 'models'));
  return [...new Set(dirs)];
}

/**
 * The first of those that can actually be written to.
 *
 * In a packaged app `bin/` resolves inside app.asar — a read-only archive — so
 * the per-user folder is the only candidate that works. This is why an in-app
 * download had to wait for this function: there was previously nowhere to put
 * the file.
 */
export function modelsWriteDir() {
  for (const dir of modelDirs()) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch { /* try the next one */ }
  }
  // Every candidate refused. Return the per-user path anyway so the caller
  // fails while trying to write, with a path in the message.
  return path.join(dataDir(), 'models');
}

export function ensureDirs() {
  requireRoot();
  for (const p of [paths.inbox, paths.recordings, paths.audio, paths.transcripts, paths.tmp]) {
    fs.mkdirSync(p, { recursive: true });
  }
  fs.mkdirSync(appPaths.models, { recursive: true });
}

/**
 * recordings/2026/2026-07 — grouped by month. Daily folders would mean ~1700
 * directories holding one or two files each: unusable to browse, slow to back up.
 */
export function archiveDirFor(startedAt) {
  const [year, month] = startedAt.split('T')[0].split('-');
  return path.join(paths.recordings, year, `${year}-${month}`);
}

/** recordings/2026/2026-07/x.amr → <base>/2026/2026-07/x.<ext> */
export function mirrorPath(base, recordingRelPath, ext) {
  const relDir = path.dirname(recordingRelPath).split('/').slice(1).join('/');
  const stem = path.basename(recordingRelPath).replace(/\.[^.]+$/, '');
  return path.join(base, relDir, `${stem}.${ext}`);
}
