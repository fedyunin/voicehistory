// ⚠️ PLATFORM-DEPENDENT MODULE. The second and last environment-aware file.
//
// whisper.cpp is invoked as an external process rather than through bindings,
// on purpose. The exact same command works with Metal on macOS, with Vulkan or
// CUDA on Windows, and on CPU anywhere. Only the binary path differs.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paths, appPaths } from './paths.js';
import { assertModelAllowed } from './license.js';
import * as config from './config.js';
import { signal } from './abort.js';

const tmpDir = () => paths.tmp;

const exec = promisify(execFile);
const run = (bin, args, opts = {}) => exec(bin, args, { ...opts, signal: signal() });

/** Read through a function, not a constant: the archive can change at runtime. */
export const defaultModel = () => config.MODEL;
const THREADS = Math.max(4, Math.min(8, os.cpus().length - 2));

/**
 * Priming prompt. Established by measurement: when decoding WITH timestamps
 * (which we need for click-to-seek) the model emits lowercase text with no
 * punctuation at all. Seeding it with correctly punctuated speech restores
 * both punctuation and capitals at no cost to accuracy.
 *
 * This is not cosmetic — an unpunctuated wall of text is unreadable, and
 * reading these conversations is the entire point of the archive.
 *
 * The seed MUST be written in the language being transcribed, and should read
 * like ordinary phone conversation. Set it in the archive's settings to supply
 * your own; the samples below are used when you do not.
 */
const PROMPTS = {
  ru: 'Здравствуйте! Да, конечно. Хорошо, я перезвоню вам позже. Как дела?',
  en: 'Hello! Yes, of course. All right, I will call you back later. How are you?',
};

const punctuationSeed = () => config.PROMPT ?? PROMPTS[config.LANGUAGE] ?? PROMPTS.en;

/**
 * Whisper hallucinations on noise and silence. The model was trained on
 * YouTube subtitles, so on dial tones and static it confidently emits
 * subtitle and translator credits instead of nothing.
 *
 * Only segments matching in FULL are dropped. The list below covers Russian and
 * English; add patterns for your own language freely — because raw output is
 * kept on disk, widening the filter costs one `reindex` rather than a
 * re-transcription.
 */
const HALLUCINATIONS = [
  // Any mention of subtitles at all — nobody says "subtitles" on a phone call,
  // whereas the model produces endless variants of subtitle credits: "subtitles
  // by X", "thanks for the subtitles X", "subtitle editor X". Anchoring these to
  // the start of a segment missed the mid-phrase forms, so the word alone is the
  // signal.
  /субтитр/i,
  /subtitle/i,
  // A captioner's name that recurs verbatim in the training data.
  /dimatorzok/i,
  // Video sign-offs: "proofreader", "to be continued", "thanks for watching",
  // "welcome to our channel", "subscribe", "leave a like", "see you in the next
  // video", "enjoy the video", "this is the end of the video".
  /^корректор\b/i,
  /^продолжение следует[.…!]*$/i,
  /^спасибо за (просмотр|внимание)[.!…]*$/i,
  /добро пожаловать (в|на) (наш|мой|это)/i,
  /подписывайтесь/i,
  /ставьте лайк/i,
  /^не забудьте (поставить лайк|подписаться)/i,
  /^всем спасибо за просмотр/i,
  /до встречи в следующем видео/i,
  /^приятного просмотра/i,
  /^это конец видео/i,
  // English equivalents, for archives in other languages.
  /^thanks? for watching/i,
  /^subtitles? by\b/i,
  /^please subscribe/i,
  /^like and subscribe/i,
];

function isHallucination(text) {
  const t = text.trim();
  if (!t) return true;
  if (/^[^\p{L}\p{N}]+$/u.test(t)) return true;   // punctuation only
  return HALLUCINATIONS.some((re) => re.test(t));
}

/**
 * Artifact removal. Applied at INDEX time, not at transcription time — on
 * purpose. Raw whisper output costs days of compute and is kept in
 * transcripts/ forever, whereas the hallucination list will keep
 * growing. Improving it must cost one `reindex`, not a full re-transcription.
 *
 * @returns {{segments: Array, filtered: number}}
 */
export function filterSegments(rawSegments) {
  const kept = rawSegments.filter((s) => !isHallucination(s.text));
  // collapse consecutive identical phrases — the other classic looping artifact
  const out = [];
  for (const s of kept) {
    const prev = out[out.length - 1];
    if (prev && prev.text === s.text) { prev.t1 = s.t1; continue; }
    out.push({ ...s });
  }
  return { segments: out, filtered: rawSegments.length - out.length };
}

/**
 * Detects the decode collapse: text arrives as an unbroken lowercase run with no
 * sentence punctuation. It is a distinct failure, not merely poor recognition —
 * the same audio normalized produces properly cased, punctuated speech.
 *
 * Level does not predict it. The quietest sample measured here (mean −24 dBFS)
 * decodes fine, while a louder file collapses, so the only reliable signal is
 * the output itself.
 *
 * Thresholds sit far from both observed cases: healthy output runs about 0.16
 * capitals and 0.46 punctuation marks per word, a collapsed one exactly zero.
 */
export function looksCollapsed(segments) {
  const text = segments.map((s) => s.text).join(' ').trim();
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words < 20) return false;                    // too little to judge
  const caps = (text.match(/\p{Lu}/gu) ?? []).length;
  const punct = (text.match(/[.,!?;:]/g) ?? []).length;
  return caps / words < 0.03 && punct / words < 0.08;
}

/** Prefer a binary shipped next to the app, fall back to PATH. */
export function resolveBinary() {
  const bundled = path.join(appPaths.bin, process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
  return fs.existsSync(bundled) ? bundled : 'whisper-cli';
}

export function modelPath(model = config.MODEL) {
  return path.join(appPaths.models, `ggml-${model}.bin`);
}

export function modelAvailable(model = config.MODEL) {
  return fs.existsSync(modelPath(model));
}

export async function whisperAvailable() {
  try { await run(resolveBinary(), ['--help']); return true; } catch { return false; }
}

/**
 * Transcribe a 16 kHz mono wav.
 * @returns {{language: string, segments: Array<{t0,t1,text}>, model: string}}
 *   Segments are RAW; run them through filterSegments() before indexing.
 */
export async function transcribeWav(wavPath, {
  model = config.MODEL, language = config.LANGUAGE, prompt = punctuationSeed(),
} = {}) {
  assertModelAllowed(model);
  const mp = modelPath(model);
  if (!fs.existsSync(mp)) throw new Error(`Model not found: ${mp}`);

  const outBase = path.join(tmpDir(), `w_${process.pid}_${path.basename(wavPath, '.wav')}`);
  const args = [
    '-m', mp,
    '-f', wavPath,
    '-l', language,
    '-t', String(THREADS),
    '-oj',
    '-of', outBase,
    '-np',
    // Beam 5. An earlier measurement on one clean file showed no difference
    // against beam 2 and it was lowered for speed; re-measured on degraded phone
    // audio, beam 5 recovers a little more text and more punctuation for about
    // 9% more time. The q5_0 quantized model is faster than fp16 but noticeably
    // worse at recognizing words — rejected.
    '-bs', '5',
  ];
  // IMPORTANT: never add --no-fallback. Measured: without temperature fallback
  // the model degenerates into loops ("Sound sound sound sound…") on phone-line
  // noise. The fallback is load-bearing, not a nicety.
  if (prompt) args.push('--prompt', prompt);

  try {
    await run(resolveBinary(), args, { maxBuffer: 64 * 1024 * 1024 });
    const jsonPath = `${outBase}.json`;
    const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

    const segments = (parsed.transcription ?? []).map((t) => ({
      t0: Number(t.offsets?.from ?? 0),
      t1: Number(t.offsets?.to ?? 0),
      text: (t.text ?? '').trim(),
    })).filter((s) => s.text);

    return {
      language: parsed.result?.language ?? language,
      segments,
      model,
    };
  } finally {
    fs.rmSync(`${outBase}.json`, { force: true });
  }
}
