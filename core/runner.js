// One long-running job at a time, plus cancellation.
//
// Needed because import and transcription are started from a button in the UI
// and then run for hours. State lives here rather than in the UI: close the
// tab and the job keeps going; reopen it and the progress is still there.
import { bus } from './events.js';

let current = null;      // {kind, startedAt, done, total, file, cancelled}

bus.on('progress', (p) => {
  if (!current || p.phase === 'log') return;
  if (p.done !== undefined) current.done = p.done;
  if (p.total !== undefined) current.total = p.total;
  if (p.file) current.file = p.file;
});

export function state() {
  return current ? { ...current, running: true } : { running: false };
}

export function isBusy() {
  return current !== null;
}

export function isCancelled() {
  return Boolean(current?.cancelled);
}

export function cancel() {
  if (current) current.cancelled = true;
}

/**
 * Starts a job in the background and returns immediately — the caller (an HTTP
 * handler) must not be left waiting for something that can take days.
 */
export function start(kind, fn) {
  if (current) throw new Error(`Already running: ${current.kind}`);
  current = { kind, startedAt: new Date().toISOString(), done: 0, total: 0, file: null, cancelled: false };
  bus.emit('job', { ...current, running: true });

  Promise.resolve()
    .then(fn)
    .then((result) => { bus.emit('job', { kind, running: false, result }); })
    .catch((e) => { bus.emit('job', { kind, running: false, error: e.message }); })
    .finally(() => { current = null; });

  return state();
}
