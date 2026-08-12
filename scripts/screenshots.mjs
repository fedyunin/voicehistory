// Takes the README screenshots from the desktop app, driven rather than
// captured by hand, so they can be regenerated after any interface change
// instead of slowly going out of date.
//
//   node scripts/demo-archive.mjs /tmp/vh-demo
//   node scripts/screenshots.mjs /tmp/vh-demo
//
// Captures the window contents, not the native frame, which is why the shots
// have no title bar.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const outDir = path.join(repo, 'docs');
const root = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'voicehistory-demo'));

if (!fs.existsSync(path.join(root, 'archive.json'))) {
  console.error(`No archive at ${root}. Run: node scripts/demo-archive.mjs ${root}`);
  process.exit(1);
}

const shots = [];

async function main() {
  const app = await electron.launch({
    args: [path.join(repo, 'app', 'main.cjs')],
    env: {
      ...process.env,
      // Opens the demo archive without disturbing whichever archive the user
      // last had open.
      VH_ROOT: root,
      // A throwaway app-config dir, so the shots do not show the list of
      // archives this machine has actually opened — and so running this does
      // not disturb them either.
      VH_APP_CONFIG_DIR: path.join(root, '.tmp', 'screenshot-config'),
      // VS Code exports this into integrated terminals and it makes Electron
      // start as plain Node. Same reason scripts/app.mjs strips it.
      ELECTRON_RUN_AS_NODE: undefined,
    },
  });

  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1420, height: 900 });
  await page.waitForSelector('#calls li', { timeout: 30_000 });

  const shot = async (name, opts = {}) => {
    const file = path.join(outDir, `${name}.png`);
    await page.screenshot({ path: file, ...opts });
    shots.push(name);
    console.log(`  ${name}.png`);
  };

  const settle = () => page.waitForTimeout(700);

  // 01 — what the window opens on: the archive as a whole. Taller, because this
  // pane runs from "on this day" down through the activity map.
  await page.setViewportSize({ width: 1420, height: 1500 });
  await settle();
  await shot('01-overview');
  await page.setViewportSize({ width: 1420, height: 900 });
  await settle();

  // 02 — one person: how long you have known them, and their days.
  await page.locator('aside.side #contacts li').first().click();
  await page.waitForSelector('#detail .heat-year', { timeout: 15_000 });
  await page.setViewportSize({ width: 1420, height: 1500 });
  await settle();
  await shot('02-person');
  await page.setViewportSize({ width: 1420, height: 900 });
  await page.locator('#filters button').first().click();     // Show everything
  await settle();

  // 03 — a call open: list, player, synced transcript.
  await page.locator('#calls li').nth(2).click();
  await page.waitForSelector('#detail audio', { timeout: 15_000 });
  await settle();
  await shot('03-archive');

  await page.emulateMedia({ colorScheme: 'dark' });
  await settle();
  await shot('03-archive-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await settle();

  // 02 — search. A word that appears in several conversations, so the shot
  // shows matches in context rather than a single hit.
  await page.fill('#q', 'garden');
  await page.waitForTimeout(1200);
  await shot('04-search');

  await page.fill('#q', '');
  await page.waitForTimeout(900);

  // 03 — filters: narrowing by person, and how to get back out again.
  // 05 — the recordings recognition got wrong, which the archive points at
  // rather than leaving to be found by scrolling.
  await page.locator('aside.side #review li').last().click();
  await page.waitForSelector('#filters:not([hidden])', { timeout: 10_000 });
  await settle();
  await shot('05-review');

  await page.locator('#filters button').first().click();
  await settle();

  const dialog = async (opener, sel, name) => {
    await page.click(opener);
    await page.waitForSelector(`${sel}[open]`, { timeout: 10_000 });
    await settle();
    await shot(name);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  };

  // 04 — the people dialog, 05 — transcription queue.
  await dialog('#btn-people', '#dlg-people', '06-people');
  await dialog('#btn-jobs', '#dlg-jobs', '07-transcribe');

  // 06 — settings, on a taller window: the dialog runs from disk usage down to
  // the danger zone, and half of it in shot would misrepresent the point, which
  // is that every destructive action states its cost up front.
  await page.setViewportSize({ width: 1420, height: 1700 });
  await settle();
  await dialog('#btn-settings', '#dlg-settings', '08-settings');

  await app.close();

  // 07 — the requirements dialog, which only appears when something is missing.
  // Asking for a model that is genuinely not downloaded makes that state real
  // rather than mocked: the dialog opens itself, as it would on a fresh machine.
  // Pointing VH_MODELS_DIR at an empty folder would not do it — the search looks
  // in every known location, on purpose, so an existing model is never missed.
  const fresh = await electron.launch({
    args: [path.join(repo, 'app', 'main.cjs')],
    env: {
      ...process.env,
      VH_ROOT: root,
      VH_APP_CONFIG_DIR: path.join(root, '.tmp', 'screenshot-config'),
      // Must name a model NOT downloaded on the machine taking the shots — the
      // dialog only appears when something is genuinely missing, and the search
      // looks in every known location, so an empty models directory will not do.
      VH_MODEL: 'medium',
      ELECTRON_RUN_AS_NODE: undefined,
    },
  });
  const p2 = await fresh.firstWindow();
  await p2.setViewportSize({ width: 1420, height: 900 });
  await p2.waitForSelector('#dlg-setup[open]', { timeout: 30_000 });
  await p2.waitForTimeout(900);
  await p2.screenshot({ path: path.join(outDir, '09-setup.png') });
  shots.push('09-setup');
  console.log('  09-setup.png');
  await fresh.close();
}

main().then(
  () => { console.log(`\n${shots.length} screenshots → docs/`); process.exit(0); },
  (e) => { console.error(e); process.exit(1); },
);
