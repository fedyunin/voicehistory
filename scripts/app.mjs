#!/usr/bin/env node
// Launches the desktop app.
//
// Exists for one reason: editors built on Electron — VS Code among them — export
// ELECTRON_RUN_AS_NODE=1 to their integrated terminals. With it set, the Electron
// binary runs as plain Node: `app` is undefined, `process.type` is unset,
// require('electron') returns the path to the binary, and nothing explains why.
// Deleting it here means `npm run app` behaves the same wherever it is run from.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [root, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
});

child.on('close', (code) => process.exit(code ?? 0));
