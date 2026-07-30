// ⚠️ PLATFORM-DEPENDENT MODULE. Together with transcribe.js these are the only
// two files that need to change when porting to another OS, or when shipping
// this commercially.
//
// Today: the ffmpeg CLI. For a personal archive its licensing is a non-issue.
// If commercialized: opencore-amr (Apache-2.0) to decode AMR plus libopus
// (BSD) to encode. Then PLAYBACK_FORMAT becomes 'opus' and that is the change.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import * as config from './config.js';
import { signal } from './abort.js';
import { bin } from './tools.js';

const exec = promisify(execFile);

/**
 * Every spawn carries the job's cancellation signal, so Stop reaches ffmpeg too,
 * and resolves the tool to an absolute path: a packaged app launched from the
 * Dock does not inherit a shell's PATH. See tools.js.
 */
const run = (name, args, opts = {}) => exec(bin(name), args, { ...opts, signal: signal() });

/** m4a/AAC plays everywhere including Safari. For a product → 'opus' (patent-free). */
export const PLAYBACK_FORMAT = 'm4a';

/**
 * Speech normalization, applied before both playback encoding and recognition.
 *
 * Measured on this archive, comparing baseline / gain / speechnorm / dynaudnorm
 * / loudnorm across four recordings:
 *
 *   • On a degraded 84 s call the baseline produced 0 capitals and 0 punctuation
 *     marks — the lowercase collapse described in transcribe.js. With speechnorm
 *     the same audio yielded 13 capitals and 20 punctuation marks, recovered
 *     speech at the start that had been missed entirely, and corrected words.
 *   • On a 40 s call it lifted 2 recognized segments to 6.
 *   • On already-clean audio it changed nothing measurable (835 vs 832 words).
 *
 * A plain `volume=10dB` boost changed almost nothing, which is the telling
 * result: whisper normalizes level internally, so what helps is compressing
 * DYNAMIC RANGE. Phone recordings are lopsided — the near-end speaker is loud
 * and the far-end speaker quiet — and evening that out is the actual win.
 *
 * loudnorm helped degraded audio too, but coarsened segmentation on good audio,
 * so speechnorm is preferred.
 *
 * Originals in recordings/ are never modified; this only affects derivatives.
 */
const SPEECH_FILTER = 'speechnorm';

/** Anything peaking below this is digital silence, not quiet speech. Configurable. */
export const silenceMaxDb = () => config.SILENCE_PEAK_DB;

/**
 * Peak and mean level in dBFS.
 *
 * Worth having because 3 of the first 11 test recordings measured -91 dBFS —
 * not "quiet" but literally silent, a known failure mode where the recorder
 * writes a file and captures nothing. Whisper answers such files with
 * hallucinated subtitle credits, so detecting them saves both compute and junk.
 */
export async function measureLevelDb(file) {
  try {
    const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'])
      .catch((e) => e);
    const mean = Number.parseFloat((/mean_volume: (-?[\d.]+)/.exec(stderr) ?? [])[1]);
    const max = Number.parseFloat((/max_volume: (-?[\d.]+)/.exec(stderr) ?? [])[1]);
    return {
      meanDb: Number.isFinite(mean) ? mean : null,
      maxDb: Number.isFinite(max) ? max : null,
    };
  } catch {
    return { meanDb: null, maxDb: null };
  }
}

export function isSilent({ maxDb }) {
  return maxDb !== null && maxDb < config.SILENCE_PEAK_DB;
}

export async function ffmpegAvailable() {
  try { await run('ffmpeg', ['-version']); return true; } catch { return false; }
}

/** Duration in ms via ffprobe — needed when Cube's .props sidecar is missing. */
export async function probeDurationMs(file) {
  try {
    const { stdout } = await run('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1', file,
    ]);
    const sec = Number.parseFloat(stdout.trim());
    return Number.isFinite(sec) ? Math.round(sec * 1000) : null;
  } catch { return null; }
}

/**
 * A playable copy for the UI. No browser can play AMR.
 * Normalized as well, because the quiet party in a phone call is often barely
 * audible in the raw recording.
 */
export async function toPlayable(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', src,
    '-af', SPEECH_FILTER,
    '-ac', '1', '-ar', '16000',
    '-c:a', 'aac', '-b:a', '32k',
    dest,
  ]);
  return dest;
}

/** whisper.cpp only accepts flac/mp3/ogg/wav and wants 16 kHz mono PCM. */
export async function toWhisperWav(src, dest, { normalize = true } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', src,
    ...(normalize ? ['-af', SPEECH_FILTER] : []),
    '-ac', '1', '-ar', '16000',
    '-c:a', 'pcm_s16le',
    dest,
  ]);
  return dest;
}
