// Every path in the project is derived here and nowhere else.
//
// The database stores RELATIVE paths, so the archive can be moved to another
// disk, another machine or another OS and still work.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Archive root. Override with VH_ROOT (needed under Electron, where cwd differs). */
export const root = path.resolve(process.env.VH_ROOT ?? pkgDir);

export const paths = {
  root,
  inbox: path.join(root, 'Import'),
  duplicates: path.join(root, 'Import', '_duplicates'),
  archive: path.join(root, 'archive'),
  audio: path.join(root, 'derived', 'audio'),
  transcripts: path.join(root, 'derived', 'transcripts'),
  db: path.join(root, 'db', 'index.sqlite'),
  bin: path.join(root, 'bin'),
  models: path.join(root, 'bin', 'models'),
  tmp: path.join(root, 'db', 'tmp'),
};

/** Absolute path → relative to root, for storage. Always forward slashes. */
export function rel(absPath) {
  return path.relative(root, absPath).split(path.sep).join('/');
}

/** Relative path from the database → absolute path on this machine. */
export function abs(relPath) {
  return path.join(root, ...relPath.split('/'));
}

export function ensureDirs() {
  for (const p of [paths.inbox, paths.archive, paths.audio, paths.transcripts,
                   paths.bin, paths.models, paths.tmp, path.dirname(paths.db)]) {
    fs.mkdirSync(p, { recursive: true });
  }
}

/**
 * archive/2026/2026-07 — grouped by month. Daily folders would mean ~1700
 * directories holding one or two files each, which is unusable to browse and
 * slow for backup tools.
 */
export function archiveDirFor(startedAt) {
  const [year, month] = startedAt.split('T')[0].split('-');
  return path.join(paths.archive, year, `${year}-${month}`);
}
