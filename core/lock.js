// Advisory single-writer lock.
//
// Two processes can legitimately want this archive at once: the server (started
// from `npm start`, running jobs from the UI) and the CLI (`vh transcribe`,
// `vh watch`). Reads are harmless — SQLite in WAL mode handles them — but two
// writers are not: both would pull the same rows off the queue and transcribe
// them twice.
//
// This also fixes a subtler bug. Crash recovery reclaims recordings stuck in
// 'running', which is correct after a kill but catastrophic while another
// process is legitimately working on them. Recovery therefore runs ONLY for
// whoever holds this lock, never on a plain database open.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './paths.js';

const FILE = () => path.join(paths.tmp, 'writer.lock');

let held = false;

function readLock() {
  try {
    return JSON.parse(fs.readFileSync(FILE(), 'utf8'));
  } catch {
    return null;
  }
}

/** Signal 0 tests for existence without touching the process. */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists but belongs to another user — still alive.
    return e.code === 'EPERM';
  }
}

/**
 * @returns {{stale: boolean}} stale=true when a previous holder died, which is
 *   the signal that crash recovery should run.
 * @throws if a live process already holds the lock.
 */
export function acquire(kind) {
  const existing = readLock();
  if (existing && existing.pid !== process.pid && alive(existing.pid)) {
    throw new Error(
      `Another process is already working on this archive: ${existing.kind} ` +
      `(pid ${existing.pid}, since ${existing.startedAt}). ` +
      `Stop it first, or use \`vh watch\` to follow its progress.`,
    );
  }
  const stale = Boolean(existing) && !alive(existing.pid);
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify({
    pid: process.pid, kind, startedAt: new Date().toISOString(),
  }));
  held = true;
  return { stale };
}

export function release() {
  if (!held) return;
  const existing = readLock();
  if (existing?.pid === process.pid) fs.rmSync(FILE(), { force: true });
  held = false;
}

/** Who holds the lock right now, if anyone alive does. */
export function holder() {
  const existing = readLock();
  return existing && alive(existing.pid) ? existing : null;
}

// Best effort: drop the lock if we exit normally or are interrupted.
for (const sig of ['exit', 'SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    release();
    if (sig !== 'exit') process.exit(sig === 'SIGINT' ? 130 : 143);
  });
}
