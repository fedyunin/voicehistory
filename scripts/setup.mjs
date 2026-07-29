#!/usr/bin/env node
// One-command bootstrap: verify tools, create folders, fetch the speech model.
// Safe to re-run — everything it does is idempotent.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { appPaths } from '../core/paths.js';
import { modelPath } from '../core/transcribe.js';
import { MODEL as DEFAULT_MODEL } from '../core/config.js';

const run = promisify(execFile);

const MODEL_URL = (name) =>
  `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${name}.bin`;

const INSTALL_HINTS = {
  darwin: 'brew install ffmpeg whisper-cpp',
  linux: 'sudo apt install ffmpeg  # and build whisper.cpp from source',
  win32: 'winget install ffmpeg  # and grab a whisper.cpp release build',
};

let failed = false;

console.log('\nSetting up voicehistory\n');

fs.mkdirSync(appPaths.models, { recursive: true });
console.log(`  ✔ model folder ready: ${appPaths.models}`);

await check('ffmpeg', ['-version'], 'ffmpeg');
await check('whisper-cli', ['--help'], 'whisper.cpp');
await fetchModel();

if (failed) {
  console.log(`\nSome tools are missing. Install them with:\n\n    ${INSTALL_HINTS[process.platform] ?? INSTALL_HINTS.linux}\n`);
  process.exitCode = 1;
} else {
  console.log('\nAll set. Start the app with:\n\n    npm start\n');
}

/* ------------------------------------------------------------------ */

async function check(bin, args, label) {
  try {
    await run(bin, args);
    console.log(`  ✔ ${label} found`);
  } catch {
    console.log(`  ✖ ${label} NOT found (${bin} is not on PATH)`);
    failed = true;
  }
}

async function fetchModel() {
  const dest = modelPath(DEFAULT_MODEL);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1_000_000) {
    console.log(`  ✔ model ${DEFAULT_MODEL} already downloaded`);
    return;
  }
  console.log(`  … downloading model ${DEFAULT_MODEL} (~1.5 GB, one time)`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  try {
    await download(MODEL_URL(DEFAULT_MODEL), tmp);
    fs.renameSync(tmp, dest);
    console.log(`\n  ✔ model saved to ${dest}`);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    console.log(`\n  ✖ model download failed: ${e.message}`);
    console.log(`    Fetch it manually:\n    curl -L -o ${dest} \\\n      ${MODEL_URL(DEFAULT_MODEL)}`);
    failed = true;
  }
}

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    https.get(url, { headers: { 'User-Agent': 'voicehistory-setup' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        return download(res.headers.location, dest, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const total = Number(res.headers['content-length'] ?? 0);
      let got = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', (c) => {
        got += c.length;
        if (total) process.stdout.write(`\r    ${((got / total) * 100).toFixed(1)}%  ${(got / 2 ** 30).toFixed(2)} GB`);
      });
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
      res.on('error', reject);
    }).on('error', reject);
  });
}
