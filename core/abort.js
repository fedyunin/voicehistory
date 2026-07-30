// One cancellation signal for every external process a job spawns.
//
// Stopping used to abort only the recognizer, which left the request looking
// ignored whenever the job happened to be inside ffmpeg instead — measuring a
// level or converting a 27-minute call. The loop then could not notice the stop
// until the whole recording was finished, minutes later.
//
// Kept in its own module so audio.js, transcribe.js and the job runner can all
// reach it without importing one another.
let controller = null;

/** Begins a cancellable stretch of work. */
export function begin() {
  controller = new AbortController();
  return controller.signal;
}

export function signal() {
  return controller?.signal;
}

/** @returns {boolean} whether there was anything to stop. */
export function abort() {
  if (!controller) return false;
  controller.abort();
  return true;
}

export function end() {
  controller = null;
}

/** Distinguishes "we stopped this" from a genuine failure. */
export function isAbortError(e) {
  return e?.name === 'AbortError' || /aborted|ABORT_ERR/i.test(String(e?.message ?? ''));
}
