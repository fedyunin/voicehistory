// Records a short tour of the interface as an animated GIF.
//
// Scripted for the same reason the screenshots are: a recording made by hand goes
// stale the moment anything moves, and nobody re-records it. This drives the real
// app against the demo archive, captures frames, and hands them to ffmpeg.
//
//   node scripts/demo-archive.mjs /tmp/vh-demo
//   node scripts/tour.mjs /tmp/vh-demo
//
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const exec = promisify(execFile);
const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'voicehistory-demo'));
const out = path.join(repo, 'docs', 'tour.gif');

// 5 frames a second: enough for the eye to follow a click, few enough that the
// file stays small. A GIF is the format because it plays everywhere a link goes —
// GitHub, Reddit, a forum comment — with nothing to press.
const FPS = 5;
const STEP = 1000 / FPS;

const frames = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-tour-'));
let n = 0;

async function main() {
  const app = await electron.launch({
    args: [path.join(repo, 'app', 'main.cjs')],
    env: {
      ...process.env,
      VH_ROOT: root,
      VH_APP_CONFIG_DIR: path.join(root, '.tmp', 'tour-config'),
      ELECTRON_RUN_AS_NODE: undefined,
    },
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForSelector('#calls li', { timeout: 40_000 });
  await page.waitForTimeout(2500);

  /** Captures frames for the given time, so the tour reads at a human pace. */
  const hold = async (ms) => {
    for (let t = 0; t < ms; t += STEP) {
      await page.screenshot({ path: path.join(frames, `f${String(n++).padStart(4, '0')}.png`) });
      await page.waitForTimeout(STEP);
    }
  };

  // 1. What it opens on.
  await hold(2000);

  // 2. The years, then a day out of them.
  const pane = page.locator('.detail');
  await pane.evaluate((e) => e.scrollTo({ top: 520, behavior: 'smooth' }));
  await hold(2000);

  const day = page.locator('#detail .heat-cell:not(.none):not(.blank)').nth(40);
  await day.hover();
  await hold(1200);
  await day.click();
  await hold(1800);

  // 3. Back out, and into one person.
  await page.locator('#filters button').first().click();
  await hold(800);
  await page.locator('aside.side #contacts li').first().click();
  await hold(2400);

  // 4. A conversation, with the transcript.
  await page.locator('#calls li').nth(1).click();
  await hold(2200);

  // 5. Every word ever said.
  await page.locator('#filters button').first().click();
  await page.waitForTimeout(600);
  await page.click('#q');
  for (const ch of 'garden') {
    await page.keyboard.type(ch);
    await page.screenshot({ path: path.join(frames, `f${String(n++).padStart(4, '0')}.png`) });
    await page.waitForTimeout(90);
  }
  await hold(2600);

  await app.close();
  console.log(`captured ${n} frames`);

  // Two passes: one to choose a palette from the whole clip, one to encode. A
  // single pass picks its colours from the first frame and banding follows.
  const pal = path.join(frames, 'pal.png');
  const filters = 'fps=' + FPS + ',scale=1000:-1:flags=lanczos';
  await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-i', path.join(frames, 'f%04d.png'), '-vf', `${filters},palettegen=max_colors=128`, pal]);
  await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-i', path.join(frames, 'f%04d.png'), '-i', pal,
    '-lavfi', `${filters} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=3`,
    '-loop', '0', out]);

  const mb = (fs.statSync(out).size / 1048576).toFixed(1);
  console.log(`docs/tour.gif — ${mb} MB`);
  fs.rmSync(frames, { recursive: true, force: true });
}

main().catch((e) => { console.error(e); process.exit(1); });
