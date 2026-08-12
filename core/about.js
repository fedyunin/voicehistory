// What this build is, where its pieces live, and how to reach the project.
//
// Worth having in the interface rather than only in a terminal: the first
// question about any bug is which version produced it, and an installed app
// gives no other way to find out. The paths are here for the same reason — the
// per-user model directory and the config file are the two locations people
// need when something is missing, and neither is guessable.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { paths, modelDirs, modelsWriteDir } from './paths.js';
import * as appsettings from './appsettings.js';
import { FORMAT_VERSION } from './archive.js';
import * as config from './config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function packageInfo() {
  try {
    const raw = fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8');
    const { name, version, homepage, repository } = JSON.parse(raw);
    return { name, version, homepage, repository };
  } catch {
    return {};
  }
}

export const REPO = 'https://github.com/fedyunin/voicehistory';

export function info() {
  const pkg = packageInfo();
  return {
    name: 'Voice History',
    version: pkg.version ?? 'unknown',
    repo: REPO,
    releases: `${REPO}/releases`,
    license: 'MIT',
    // The format version is the archive's, not the app's: it says what a later
    // build will make of this data.
    archiveFormat: FORMAT_VERSION,
    archiveRoot: paths.root,
    model: config.MODEL,
    modelDirs: modelDirs(),
    modelsWriteDir: modelsWriteDir(),
    settingsFile: appsettings.settingsFile(),
    runtime: {
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    },
  };
}
