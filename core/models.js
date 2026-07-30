// Locating and fetching the speech model.
//
// Split out of scripts/setup.mjs so the desktop app can offer the same download
// the CLI does. A packaged app cannot tell the user to go and run a shell
// script, and it is the one dependency we can honestly fetch ourselves: a single
// file, from the upstream project's own published weights, needed before
// anything else works.
//
// The external binaries are a different matter and stay a user install — see
// tools.js for why.
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { modelDirs, modelsWriteDir } from './paths.js';
import * as config from './config.js';

const URL_FOR = (name) =>
  `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${name}.bin`;

const fileName = (model) => `ggml-${model}.bin`;

/** Anything smaller than this is a truncated download, not a model. */
const MIN_BYTES = 1_000_000;

/**
 * Where this model is, or where it would go.
 * An existing copy anywhere in the search order wins over the write location,
 * so a development checkout and an installed app can share one download.
 */
export function pathFor(model = config.MODEL) {
  for (const dir of modelDirs()) {
    const p = path.join(dir, fileName(model));
    if (fs.existsSync(p)) return p;
  }
  return path.join(modelsWriteDir(), fileName(model));
}

export function available(model = config.MODEL) {
  try {
    return fs.statSync(pathFor(model)).size > MIN_BYTES;
  } catch {
    return false;
  }
}

export function sizeOf(model = config.MODEL) {
  try { return fs.statSync(pathFor(model)).size; } catch { return 0; }
}

export function urlFor(model = config.MODEL) {
  return URL_FOR(model);
}

/**
 * Fetch the model to its write location.
 *
 * Downloads to a `.part` file and renames on success, so an interrupted
 * download can never be mistaken for a usable model — the failure mode here is
 * a half-file that makes the recognizer fail much later with something
 * unhelpful.
 *
 * @param {object} opts
 * @param {(p: {received: number, total: number}) => void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 */
export async function fetch(model = config.MODEL, { onProgress, signal } = {}) {
  if (available(model)) return { path: pathFor(model), skipped: true };

  const dir = modelsWriteDir();
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, fileName(model));
  const part = `${dest}.part`;

  try {
    await pipe(URL_FOR(model), part, { onProgress, signal });
    fs.renameSync(part, dest);
    return { path: dest, skipped: false };
  } catch (e) {
    fs.rmSync(part, { force: true });
    throw e;
  }
}

function pipe(url, dest, { onProgress, signal, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    if (signal?.aborted) return reject(new Error('aborted'));

    const req = https.get(url, { headers: { 'User-Agent': 'voicehistory' } }, (res) => {
      // Hugging Face serves the weights from a CDN behind a redirect.
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        return pipe(res.headers.location, dest, { onProgress, signal, redirects: redirects + 1 })
          .then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      const total = Number(res.headers['content-length'] ?? 0);
      let received = 0;
      let lastReport = 0;
      const out = fs.createWriteStream(dest);

      res.on('data', (chunk) => {
        received += chunk.length;
        // Throttled: this fires thousands of times over 1.5 GB, and every
        // report crosses a process boundary to reach the interface.
        if (onProgress && (received - lastReport > 4_000_000 || received === total)) {
          lastReport = received;
          onProgress({ received, total });
        }
      });

      res.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
      out.on('error', reject);
      res.on('error', reject);
    });

    req.on('error', reject);
    signal?.addEventListener('abort', () => {
      req.destroy(new Error('aborted'));
    }, { once: true });
  });
}
