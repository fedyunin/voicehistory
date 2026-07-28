// Directory walking, hashing and file transfer.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AUDIO_EXT } from './parse.js';

const SKIP_DIRS = new Set(['.props', '_duplicates', 'node_modules', '.git', 'derived', 'db', 'bin']);

/** Recursively collect audio files. */
export function collectAudioFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(path.join(d, e.name));
      } else if (e.isFile()) {
        if (e.name.startsWith('.')) continue;
        if (AUDIO_EXT.has(path.extname(e.name).toLowerCase())) out.push(path.join(d, e.name));
      }
    }
  };
  walk(dir);
  return out;
}

/** Streaming SHA-256 — never loads a whole file into memory. */
export function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(filePath);
    s.on('data', (c) => h.update(c));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * Move, falling back to copy+unlink when inbox and archive live on different
 * volumes. mode='copy' leaves the source untouched — that is how the first
 * import is meant to run, so the original phone export stays as a backup.
 */
export function transferFile(from, to, mode = 'move') {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (mode === 'copy') {
    fs.copyFileSync(from, to);
    return;
  }
  try {
    fs.renameSync(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}

/** First free name: file.amr, then file-2.amr, file-3.amr … */
export function freePath(dir, basename) {
  const ext = path.extname(basename);
  const stem = basename.slice(0, basename.length - ext.length);
  let candidate = path.join(dir, basename);
  let n = 2;
  while (fs.existsSync(candidate)) candidate = path.join(dir, `${stem}-${n++}${ext}`);
  return candidate;
}
