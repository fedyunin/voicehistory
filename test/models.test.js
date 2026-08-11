// Where the speech model is looked for, and what counts as having one.
//
// This decides whether a user re-downloads 1.5 GB, and whether a packaged app
// can download at all — before this logic existed the only write location was
// inside a read-only asar archive.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as models from '../core/models.js';
import { modelDirs, modelsWriteDir, appPaths } from '../core/paths.js';

/** Runs fn with VH_MODELS_DIR pointed at a fresh directory. */
function withModelsDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-models-'));
  const before = process.env.VH_MODELS_DIR;
  process.env.VH_MODELS_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (before === undefined) delete process.env.VH_MODELS_DIR;
    else process.env.VH_MODELS_DIR = before;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('an explicit models directory takes precedence', () => {
  withModelsDir((dir) => {
    assert.equal(modelDirs()[0], dir);
    assert.equal(modelsWriteDir(), dir, 'and it is where a download would land');
  });
});

test('the checkout is searched before the per-user folder', () => {
  // Order is the whole promise: an existing development setup must keep working
  // rather than silently re-fetching the model into a new location.
  delete process.env.VH_MODELS_DIR;
  const dirs = modelDirs();
  assert.ok(dirs.length >= 2, 'at least the checkout and the per-user folder');
  assert.ok(dirs[0].includes('bin'), `expected the checkout's bin/models first, got ${dirs[0]}`);
});

test('a model is only "available" once it is plausibly complete', () => {
  withModelsDir((dir) => {
    assert.equal(models.available('vhtest'), false, 'nothing there yet');

    // A truncated download is the dangerous case: reported as present, it would
    // fail much later inside the recognizer with an unhelpful error.
    fs.writeFileSync(path.join(dir, 'ggml-vhtest.bin'), Buffer.alloc(1024));
    assert.equal(models.available('vhtest'), false, 'a 1 KB file is not a model');

    fs.writeFileSync(path.join(dir, 'ggml-vhtest.bin'), Buffer.alloc(2_000_000));
    assert.equal(models.available('vhtest'), true);
    assert.equal(models.sizeOf('vhtest'), 2_000_000);
  });
});

test('pathFor returns an existing file, or where one would be written', () => {
  withModelsDir((dir) => {
    const expected = path.join(dir, 'ggml-vhtest.bin');
    assert.equal(models.pathFor('vhtest'), expected, 'the write location when absent');
    fs.writeFileSync(expected, Buffer.alloc(2_000_000));
    assert.equal(models.pathFor('vhtest'), expected, 'and the same file once present');
  });
});

test('the download URL names the requested model', () => {
  assert.match(models.urlFor('large-v3-turbo'), /^https:\/\/huggingface\.co\/.*ggml-large-v3-turbo\.bin$/);
});

test('fetching a model that is already there does nothing', async () => {
  await withModelsDir(async (dir) => {
    fs.writeFileSync(path.join(dir, 'ggml-vhtest.bin'), Buffer.alloc(2_000_000));
    const r = await models.fetch('vhtest');
    assert.equal(r.skipped, true, 'no network call for a model already on disk');
  });
});

test('an unwritable candidate is skipped rather than returned', () => {
  // This is the packaged-app case in miniature. There, the first candidate is
  // inside app.asar — a read-only archive — and returning it would leave the
  // in-app download writing to a path that cannot accept it. Any unwritable
  // directory exercises the same branch.
  if (process.platform === 'win32') return;      // chmod does not deny writes here
  if (process.getuid?.() === 0) return;          // root ignores the mode bits

  const locked = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-locked-'));
  fs.chmodSync(locked, 0o500);                   // readable, not writable
  const before = process.env.VH_MODELS_DIR;
  process.env.VH_MODELS_DIR = locked;
  try {
    assert.notEqual(modelsWriteDir(), locked,
      'a directory that cannot be written to must never be chosen for a download');
    assert.equal(modelDirs()[0], locked, 'though it is still searched for an existing model');
  } finally {
    if (before === undefined) delete process.env.VH_MODELS_DIR;
    else process.env.VH_MODELS_DIR = before;
    fs.chmodSync(locked, 0o700);
    fs.rmSync(locked, { recursive: true, force: true });
  }
});

test('a path containing a space is handled as a path, not as a URL', () => {
  // appPaths.bin is derived from this module's own location. Deriving it via
  // URL.pathname leaves percent-encoding, so an app installed as
  // "Voice History.app" looked for models under "Voice%20History.app" — a
  // directory that does not exist, and which the app then created and filled
  // with gigabytes of downloads.
  assert.ok(!appPaths.bin.includes('%20'), `bin path is percent-encoded: ${appPaths.bin}`);
  assert.ok(!modelDirs().some((d) => d.includes('%')), 'no candidate may be percent-encoded');
});

test('asking where a model would go does not create anything', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-probe-'));
  const target = path.join(base, 'deep', 'models');
  const before = process.env.VH_MODELS_DIR;
  process.env.VH_MODELS_DIR = target;
  try {
    assert.equal(modelsWriteDir(), target, 'it is writable, via an ancestor that exists');
    assert.equal(fs.existsSync(target), false,
      'a question about where a file would go must not put a directory on disk');
  } finally {
    if (before === undefined) delete process.env.VH_MODELS_DIR;
    else process.env.VH_MODELS_DIR = before;
    fs.rmSync(base, { recursive: true, force: true });
  }
});
