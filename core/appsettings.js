// Application settings, stored OUTSIDE any archive.
//
// This is the one piece of state that cannot live in the archive: which archive
// to open. It goes where the operating system expects application config, so a
// cloned checkout carries no user data and an archive carries no machine state.
//
//   macOS    ~/Library/Application Support/voicehistory/settings.json
//   Linux    ~/.config/voicehistory/settings.json
//   Windows  %APPDATA%\voicehistory\settings.json
//
// Everything that describes the DATA — language, numbering plan, model — lives
// in the archive's own manifest instead, so it travels with the recordings.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP = 'voicehistory';

export function configDir() {
  if (process.env.VH_APP_CONFIG_DIR) return path.resolve(process.env.VH_APP_CONFIG_DIR);
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', APP);
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? home, APP);
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), APP);
}

const FILE = () => path.join(configDir(), 'settings.json');

const DEFAULTS = { archiveRoot: null, recentArchives: [] };

export function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    return {
      archiveRoot: typeof raw.archiveRoot === 'string' ? raw.archiveRoot : null,
      recentArchives: Array.isArray(raw.recentArchives)
        ? raw.recentArchives.filter((p) => typeof p === 'string')
        : [],
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function write(settings) {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(FILE(), `${JSON.stringify(settings, null, 2)}\n`);
  return settings;
}

/** Records an archive as the current one and pushes it to the top of recents. */
export function remember(archiveRoot) {
  const s = read();
  const resolved = path.resolve(archiveRoot);
  const recents = [resolved, ...s.recentArchives.filter((p) => p !== resolved)].slice(0, 8);
  return write({ ...s, archiveRoot: resolved, recentArchives: recents });
}

export function forget(archiveRoot) {
  const s = read();
  const resolved = path.resolve(archiveRoot);
  return write({
    archiveRoot: s.archiveRoot === resolved ? null : s.archiveRoot,
    recentArchives: s.recentArchives.filter((p) => p !== resolved),
  });
}

/**
 * Which archive to open, highest precedence first:
 *   1. VH_ROOT           — explicit override for one command
 *   2. remembered choice — what you last opened in the interface
 *   3. null              — first run; the interface asks
 */
export function resolveArchiveRoot() {
  if (process.env.VH_ROOT) return path.resolve(process.env.VH_ROOT);
  return read().archiveRoot;
}

/** Recents that still exist on disk, so a detached external drive drops out quietly. */
export function recents() {
  return read().recentArchives.filter((p) => fs.existsSync(p));
}

export const settingsFile = FILE;
