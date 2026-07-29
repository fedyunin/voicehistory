// Opening and switching archives.
//
// One entry point for both shells, because switching archives has to happen in a
// specific order: point the paths at the new folder, close the old database,
// re-read the new archive's settings, drop cached contact names. Getting that
// order wrong leaves one archive's names attached to another's recordings.
import * as appsettings from './appsettings.js';
import * as archive from './archive.js';
import * as config from './config.js';
import * as db from './db.js';
import { reload as reloadContactNames } from './contactbook.js';
import { paths, hasRoot } from './paths.js';

/**
 * Opens (or creates) an archive and makes it the current one.
 * @param {string} dir
 * @param {{remember?: boolean}} opts  remember=false for one-off CLI runs
 */
export function openArchive(dir, { remember = true } = {}) {
  db.close();
  const opened = archive.open(dir);
  config.reload();
  reloadContactNames();
  db.open();
  if (remember) appsettings.remember(opened.root);
  return opened;
}

/**
 * Restores the archive from the last session, if there is one.
 * @returns {{root: string, manifest: object}|null} null on first run, or when
 *   the remembered folder has gone (an unplugged external drive).
 */
export function restoreArchive() {
  const remembered = appsettings.resolveArchiveRoot();
  if (!remembered) return null;
  try {
    return openArchive(remembered, { remember: false });
  } catch (e) {
    // Do not fail to start over a missing drive — the interface will ask.
    return { error: e.message, root: remembered, missing: true };
  }
}

export function isOpen() {
  return hasRoot();
}

/** Everything the interface needs to render the archive picker. */
export function archiveState() {
  const manifest = hasRoot() ? archive.readManifest(paths.root) : null;
  return {
    open: hasRoot(),
    root: paths.root ?? null,
    formatVersion: manifest?.formatVersion ?? null,
    created: manifest?.created ?? null,
    recents: appsettings.recents().filter((p) => p !== paths.root),
    settingsFile: appsettings.settingsFile(),
    suggestion: archive.suggestDefaultLocation(),
  };
}
