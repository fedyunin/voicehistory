// Finding the external binaries this project shells out to.
//
// A bare name like 'ffmpeg' relies on PATH, and PATH is not what you expect
// inside a packaged desktop app: an app launched from Finder or the Dock
// inherits launchd's environment — roughly /usr/bin:/bin:/usr/sbin:/sbin — not
// the PATH your shell builds from a login profile. So Homebrew's /opt/homebrew/bin
// is absent, and a machine with ffmpeg plainly installed reports it missing.
// That is a confusing failure: the user has done everything right and the app
// says otherwise.
//
// So: search PATH first, then the handful of places these tools actually live.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appPaths } from './paths.js';

const exec = promisify(execFile);

const isWin = process.platform === 'win32';
const exe = (name) => (isWin ? `${name}.exe` : name);

/**
 * Where these tools install on each platform. Not a guess list — Homebrew on
 * both Apple Silicon and Intel, MacPorts, the usual Linux prefixes, and the
 * package managers Windows users actually use.
 */
function searchDirs() {
  const home = os.homedir();
  if (isWin) {
    const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
    return [
      path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Microsoft', 'WinGet', 'Links'),
      path.join(pf, 'ffmpeg', 'bin'),
      'C:\\ffmpeg\\bin',
      path.join(process.env.ChocolateyInstall ?? 'C:\\ProgramData\\chocolatey', 'bin'),
      path.join(home, 'scoop', 'shims'),
    ];
  }
  return [
    '/opt/homebrew/bin',          // Homebrew, Apple Silicon
    '/usr/local/bin',             // Homebrew on Intel, and hand-built installs
    '/opt/local/bin',             // MacPorts
    '/usr/bin',
    '/bin',
    '/snap/bin',
    '/var/lib/flatpak/exports/bin',
    path.join(home, '.local', 'bin'),
    path.join(home, 'bin'),
  ];
}

/** Directories from PATH, which is still the right first answer when it works. */
function pathDirs() {
  return (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
}

const cache = new Map();

/**
 * An absolute path to the binary, or null.
 *
 * A binary shipped inside the app wins outright: if a future build bundles
 * these, that copy is the one that was tested against this version.
 */
export function find(name) {
  if (cache.has(name)) return cache.get(name);

  const candidates = [
    path.join(appPaths.bin, exe(name)),
    ...pathDirs().map((d) => path.join(d, exe(name))),
    ...searchDirs().map((d) => path.join(d, exe(name))),
  ];

  let found = null;
  for (const c of candidates) {
    try {
      // X_OK matters: a same-named directory or an unexecutable file would
      // otherwise pass and fail later, at a much less obvious moment.
      fs.accessSync(c, fs.constants.X_OK);
      if (fs.statSync(c).isFile()) { found = c; break; }
    } catch { /* next candidate */ }
  }

  cache.set(name, found);
  return found;
}

/**
 * The path to use when spawning. Falls back to the bare name so the process
 * still spawns — and fails with the OS's own message — rather than us throwing
 * a different error from the one the user would recognize.
 */
export function bin(name) {
  return find(name) ?? exe(name);
}

/** Forget what was found. Needed after the user installs something and retries. */
export function reload() {
  cache.clear();
}

/** Does it run? Presence on disk is not the same as being usable. */
async function works(name, args) {
  const b = find(name);
  if (!b) return false;
  try { await exec(b, args); return true; } catch { return false; }
}

/** Per-platform install instructions, shown verbatim in the interface. */
export const INSTALL_COMMAND = {
  darwin: 'brew install ffmpeg whisper-cpp',
  linux: 'sudo apt install ffmpeg && sudo snap install whisper-cpp',
  win32: 'winget install ffmpeg',
};

export const INSTALL_URL = {
  ffmpeg: 'https://ffmpeg.org/download.html',
  'whisper-cli': 'https://github.com/ggml-org/whisper.cpp#quick-start',
};

/**
 * What is installed and what is not, in a shape the interface can render
 * directly. Kept here rather than in the UI so the CLI's doctor and the app's
 * setup screen can never disagree about what "missing" means.
 */
export async function probe() {
  reload();
  const [ffmpeg, ffprobe, whisper] = await Promise.all([
    works('ffmpeg', ['-version']),
    works('ffprobe', ['-version']),
    works('whisper-cli', ['--help']),
  ]);

  return {
    ffmpeg: { ok: ffmpeg, path: find('ffmpeg'), name: 'ffmpeg', why: 'decodes recordings and prepares audio for recognition' },
    ffprobe: { ok: ffprobe, path: find('ffprobe'), name: 'ffprobe', why: 'reads durations when a recording has no sidecar' },
    'whisper-cli': { ok: whisper, path: find('whisper-cli'), name: 'whisper-cli', why: 'the speech recognizer itself' },
    installCommand: INSTALL_COMMAND[process.platform] ?? INSTALL_COMMAND.linux,
    platform: process.platform,
  };
}
