// Finding external binaries. Pinned because the failure this guards against is
// invisible in development: a packaged app launched from the Dock or Start menu
// gets a minimal PATH, so a tool the developer has installed reads as missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as tools from '../core/tools.js';

const exeName = (n) => (process.platform === 'win32' ? `${n}.exe` : n);

/** A directory holding one executable, wired onto PATH. */
function fakeTool(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-tools-'));
  const file = path.join(dir, exeName(name));
  fs.writeFileSync(file, process.platform === 'win32' ? 'rem noop' : '#!/bin/sh\nexit 0\n');
  fs.chmodSync(file, 0o755);
  return { dir, file };
}

test('a tool on PATH is resolved to an absolute path', () => {
  const { dir, file } = fakeTool('vhfake');
  const before = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${before}`;
  try {
    tools.reload();
    assert.equal(tools.find('vhfake'), file,
      'spawning by absolute path is what makes this work outside a shell');
  } finally {
    process.env.PATH = before;
    fs.rmSync(dir, { recursive: true, force: true });
    tools.reload();
  }
});

test('a tool absent everywhere resolves to null, and bin() still yields a spawnable name', () => {
  tools.reload();
  assert.equal(tools.find('vh-definitely-not-installed'), null);
  // Falling back to the bare name matters: the OS then produces its own
  // "not found" error, which is the message a user can act on.
  assert.equal(tools.bin('vh-definitely-not-installed'), exeName('vh-definitely-not-installed'));
});

test('the search does not depend on PATH alone', () => {
  // The point of the module: with PATH emptied, anything installed in a standard
  // location must still be found. /bin/sh stands in for such a location because
  // it exists on every POSIX runner.
  if (process.platform === 'win32') return;
  const before = process.env.PATH;
  process.env.PATH = '';
  try {
    tools.reload();
    assert.equal(tools.find('sh'), '/bin/sh');
  } finally {
    process.env.PATH = before;
    tools.reload();
  }
});

test('a directory sharing a tool name is not mistaken for the tool', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-tools-'));
  fs.mkdirSync(path.join(dir, exeName('vhdir')));
  const before = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${before}`;
  try {
    tools.reload();
    assert.equal(tools.find('vhdir'), null,
      'a directory is executable by permission, so only the file check rules it out');
  } finally {
    process.env.PATH = before;
    fs.rmSync(dir, { recursive: true, force: true });
    tools.reload();
  }
});

test('reload() picks up a tool installed after a failed lookup', () => {
  const { dir, file } = fakeTool('vhlate');
  const before = process.env.PATH;
  try {
    tools.reload();
    assert.equal(tools.find('vhlate'), null);      // not on PATH yet
    process.env.PATH = `${dir}${path.delimiter}${before}`;
    assert.equal(tools.find('vhlate'), null, 'the miss is cached, as intended');
    tools.reload();
    assert.equal(tools.find('vhlate'), file,
      'without this the "Check again" button could never succeed');
  } finally {
    process.env.PATH = before;
    fs.rmSync(dir, { recursive: true, force: true });
    tools.reload();
  }
});

test('every platform has install instructions to show', () => {
  for (const p of ['darwin', 'linux', 'win32']) {
    assert.match(tools.INSTALL_COMMAND[p], /\S/, `${p} needs a command the user can run`);
  }
});
