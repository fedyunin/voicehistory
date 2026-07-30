#!/usr/bin/env node
// One-command bootstrap: verify tools, fetch the speech model.
// Safe to re-run — everything it does is idempotent.
//
// The work itself lives in core/: tools.js decides what counts as installed and
// models.js does the download, so this script and the app's setup screen can
// never disagree with each other.
import * as tools from '../core/tools.js';
import * as models from '../core/models.js';
import { MODEL } from '../core/config.js';

console.log('\nSetting up voicehistory\n');

const probe = await tools.probe();
for (const key of ['ffmpeg', 'ffprobe', 'whisper-cli']) {
  const t = probe[key];
  console.log(t.ok ? `  ✔ ${key}  ${t.path}` : `  ✖ ${key} NOT found — ${t.why}`);
}

const missing = ['ffmpeg', 'ffprobe', 'whisper-cli'].filter((k) => !probe[k].ok);
let failed = missing.length > 0;

if (models.available(MODEL)) {
  console.log(`  ✔ model ${MODEL}  ${models.pathFor(MODEL)}`);
} else {
  console.log(`  … downloading model ${MODEL} (~1.5 GB, one time)`);
  try {
    const { path: dest } = await models.fetch(MODEL, {
      onProgress: ({ received, total }) => {
        const pct = total ? `${((received / total) * 100).toFixed(1)}%` : '';
        process.stdout.write(`\r    ${pct}  ${(received / 2 ** 30).toFixed(2)} GB`);
      },
    });
    console.log(`\n  ✔ model saved to ${dest}`);
  } catch (e) {
    console.log(`\n  ✖ model download failed: ${e.message}`);
    console.log(`    Fetch it manually:\n    curl -L --create-dirs -o ${models.pathFor(MODEL)} \\\n      ${models.urlFor(MODEL)}`);
    failed = true;
  }
}

if (failed) {
  if (missing.length) console.log(`\nInstall the missing tools with:\n\n    ${probe.installCommand}\n`);
  process.exitCode = 1;
} else {
  console.log('\nAll set. Start the app with:\n\n    npm run app\n');
}
