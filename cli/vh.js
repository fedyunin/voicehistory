#!/usr/bin/env node
// A thin shell over core/. It occupies exactly the position an Electron
// main.js would — which is why it contains no logic, only argument parsing
// and progress printing.
import path from 'node:path';
import { paths, ensureDirs } from '../core/paths.js';
import { bus } from '../core/events.js';
import * as db from '../core/db.js';
import { importFiles, transcribePending, scanInbox } from '../core/ingest.js';
import { reindex } from '../core/reindex.js';
import { contacts, years } from '../core/search.js';
import { ffmpegAvailable } from '../core/audio.js';
import { whisperAvailable, modelAvailable, modelPath, DEFAULT_MODEL } from '../core/transcribe.js';
import { tier } from '../core/license.js';
import { serve } from './server.js';

const [cmd, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);

attachProgress();

try {
  switch (cmd) {
    case 'doctor':     await doctor(); break;
    case 'import':     await cmdImport(); break;
    case 'transcribe': await cmdTranscribe(); break;
    case 'status':     cmdStatus(); break;
    case 'reindex':    await cmdReindex(); break;
    case 'jobs':       cmdJobs(); break;
    case 'watch':      await cmdWatch(); break;
    case 'serve':      cmdServe(); break;
    default:           usage();
  }
} catch (e) {
  console.error(`\n✖ ${e.message}`);
  process.exitCode = 1;
} finally {
  // serve keeps the process alive until interrupted
  if (cmd !== 'serve') db.close();
}

/* ---------------- commands ---------------- */

async function doctor() {
  ensureDirs();
  const rows = [
    ['archive root', paths.root],
    ['ffmpeg', (await ffmpegAvailable()) ? 'found' : 'MISSING — brew install ffmpeg'],
    ['whisper-cli', (await whisperAvailable()) ? 'found' : 'MISSING — brew install whisper-cpp'],
    [`model ${DEFAULT_MODEL}`, modelAvailable() ? 'found' : `MISSING — run: npm run setup`],
    ['tier', tier()],
    ['files in Import/', String(scanInbox().length)],
  ];
  for (const [k, v] of rows) console.log(`${k.padEnd(24)} ${v}`);
}

async function cmdImport() {
  const src = flags._[0] ? path.resolve(flags._[0]) : paths.inbox;
  const mode = flags.copy ? 'copy' : 'move';
  console.log(`Importing from ${src}  (${mode === 'copy' ? 'copy, sources left in place' : 'move'})\n`);
  const r = await importFiles(src, { concurrency: Number(flags.concurrency ?? 4), mode });
  console.log(`\n✔ imported ${r.imported}, duplicates ${r.duplicates}, ` +
              `failed ${r.failed}, unrecognized names ${r.unparsed}`);
}

async function cmdTranscribe() {
  const limit = flags.limit ? Number(flags.limit) : Infinity;
  const r = await transcribePending({ limit, order: flags.order === 'newest' ? 'newest' : 'named' });
  console.log(`\n✔ transcribed ${r.done}, failed ${r.failed}`);
}

function cmdStatus() {
  const s = db.stats();
  console.log(`recordings       ${s.recordings}`);
  console.log(`contacts         ${s.contacts}`);
  console.log(`total audio      ${fmtDur(s.totalMs)}`);
  if (s.range?.a) console.log(`spanning         ${s.range.a.slice(0, 10)} … ${s.range.b.slice(0, 10)}`);
  console.log('\ntranscription:');
  for (const { s: st, n } of s.byStatus) console.log(`  ${String(st).padEnd(10)} ${n}`);
  const ys = years();
  if (ys.length) {
    console.log('\nby year:');
    for (const y of ys) console.log(`  ${y.year}  ${String(y.calls).padStart(5)}  ${fmtDur(y.total_ms)}`);
  }
  const top = contacts().slice(0, 12);
  if (top.length) {
    console.log('\nmost frequent:');
    for (const c of top) console.log(`  ${c.display_name.padEnd(26)} ${String(c.calls).padStart(5)}  ${fmtDur(c.total_ms)}`);
  }
}

async function cmdReindex() {
  console.log('Rebuilding the database from files on disk…\n');
  const r = await reindex();
  console.log(`\n✔ rows ${r.rows}, transcripts ${r.transcripts}, failed ${r.failed}`);
}

/** Job history. Useful after a multi-day run to see what actually happened. */
function cmdJobs() {
  const rows = db.jobs(Number(flags.limit ?? 20));
  if (!rows.length) return console.log('No jobs recorded yet.');
  console.log('kind        state      done/total  failed  started           took');
  for (const j of rows) {
    const took = j.finished_at
      ? fmtSpan(Date.parse(j.finished_at) - Date.parse(j.started_at))
      : 'running…';
    console.log(
      j.kind.padEnd(11),
      j.state.padEnd(10),
      `${j.done}/${j.total}`.padStart(11),
      String(j.failed).padStart(7),
      ' ',
      j.started_at.slice(0, 16).replace('T', ' '),
      took.padStart(9),
    );
  }
}

/**
 * Live view of a job started elsewhere — from the web UI, or from another
 * terminal. Reads the same jobs table the UI reads, so nothing extra is needed
 * to keep an eye on a run that takes days.
 */
async function cmdWatch() {
  const every = Math.max(1, Number(flags.interval ?? 3)) * 1000;
  process.stdout.write('Watching for activity — Ctrl+C to stop\n');
  let lastLine = '';
  for (;;) {
    const [j] = db.jobs(1);
    const s = db.stats();
    const pending = s.byStatus.find((x) => x.s === 'pending')?.n ?? 0;
    const done = s.byStatus.find((x) => x.s === 'done')?.n ?? 0;
    const line = j && j.state === 'running'
      ? `${j.kind}: ${j.done}/${j.total}` +
        `  ${pct(j.done, j.total)}  elapsed ${fmtSpan(Date.now() - Date.parse(j.started_at))}` +
        `  eta ${eta(j)}`
      : `idle — ${done} transcribed, ${pending} queued`;
    if (line !== lastLine) {
      process.stdout.write(`\r\x1b[K${line}`);
      lastLine = line;
    }
    await sleep(every);
  }
}

function cmdServe() {
  serve(Number(flags.port ?? 4321));
}

function usage() {
  console.log(`voicehistory — a local archive of recorded phone calls

  node cli/vh.js serve [--port 4321]        open the archive in a browser
  node cli/vh.js doctor                     check the environment
  node cli/vh.js import [dir] [--copy]      import (defaults to Import/)
  node cli/vh.js transcribe [--limit N] [--order named|newest]
  node cli/vh.js status                     archive summary
  node cli/vh.js reindex                    rebuild the database from files
  node cli/vh.js jobs [--limit 20]          history of import/transcribe runs
  node cli/vh.js watch [--interval 3]       live progress of a job running elsewhere`);
}

/* ---------------- progress output ---------------- */

function attachProgress() {
  let last = 0;
  bus.on('progress', (p) => {
    if (p.phase === 'log') { process.stdout.write(`\r\x1b[K  ! ${p.message}\n`); return; }
    const now = Date.now();
    const finished = p.total && p.done >= p.total;
    if (now - last < 120 && !finished) return;
    last = now;
    const pct = p.total ? Math.floor((p.done / p.total) * 100) : 0;
    const bar = '█'.repeat(Math.floor(pct / 4)).padEnd(25, '·');
    const name = p.file ? ` ${truncate(p.file, 42)}` : '';
    process.stdout.write(`\r\x1b[K${bar} ${String(pct).padStart(3)}% ${p.done}/${p.total}${name}`);
    if (finished) process.stdout.write('\n');
  });
}

/* ---------------- helpers ---------------- */

function parseFlags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      out[k] = v ?? (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true);
    } else out._.push(a);
  }
  return out;
}

function fmtDur(ms) {
  if (!ms) return '0h';
  const h = Math.floor(ms / 3600000);
  const m = Math.round((ms % 3600000) / 60000);
  return h ? `${h}h ${m}m` : `${m}m`;
}

function fmtSpan(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// Declared as functions, not consts: the command switch runs at module top
// level, above these lines, so a `const` would still be in its temporal dead
// zone when `watch` reaches its second loop iteration.
function pct(done, total) {
  return total ? `${Math.floor((done / total) * 100)}%` : '—';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Linear projection from elapsed time — crude, but honest about being a guess. */
function eta(job) {
  if (!job.done || !job.total) return '—';
  const elapsed = Date.now() - Date.parse(job.started_at);
  const remaining = (elapsed / job.done) * (job.total - job.done);
  return fmtSpan(remaining);
}

function truncate(s, n) { return s.length <= n ? s : s.slice(0, n - 1) + '…'; }
