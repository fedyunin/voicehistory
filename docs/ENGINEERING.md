# Engineering notes

Findings from building this against a real 501-hour archive. Almost none of it
was predictable from documentation, and several settings look wrong until you see
the measurement behind them.

---

## Transcription settings

whisper.cpp is invoked as an external process rather than through bindings, on
purpose: the same command works with Metal on macOS, Vulkan or CUDA on Windows,
and CPU anywhere. Only the binary path differs, which is what keeps
`core/transcribe.js` and `core/audio.js` the only OS-aware files in the project.

| Setting | Finding |
|---|---|
| Priming prompt | **Required.** See below |
| `speechnorm` preprocessing | **Only when needed.** See below |
| Beam 5, not 2 | An earlier one-file measurement showed no difference and it was lowered for speed; on degraded audio beam 5 recovers a little more text for ~9% more time |
| `--no-fallback` | **Never.** Roughly twice as fast, but on line noise the model degenerates into loops — one file produced the same single word forty times over. Temperature fallback is load-bearing |
| Plain gain (`volume=10dB`) | No meaningful effect. Whisper normalizes level internally |
| `loudnorm` | Helps degraded audio as much as `speechnorm`, but coarsens segmentation on good audio |
| `dynaudnorm` | No measurable effect on these recordings |
| q5_0 quantized model | Faster than fp16, noticeably worse at recognizing words |
| `large-v3` instead of turbo | **Not worth it.** 2.7× realtime against 8.2×, and no better text — see below |
| VAD | Suppresses hallucinations well, but degrades text and yields timestamps too coarse to seek by (~30 s) |

### The priming prompt

Decoding **with** timestamps — which the interface needs, since clicking a line
of transcript to jump to that moment is half the point — makes the model emit
lowercase text with no punctuation whatsoever. Same audio, same model, purely a
consequence of timestamp tokens being in the decode.

Seeding the decoder with a few sentences of correctly punctuated conversational
speech restores both punctuation and capitalization at no cost to accuracy.

This is not cosmetic. An unpunctuated wall of text cannot be read, and reading
these conversations is the entire point of the archive.

The prompt must be written in the language being transcribed (`VH_PROMPT`).

### Speech normalization

Measured across four recordings, comparing baseline, gain, `speechnorm`,
`dynaudnorm` and `loudnorm`:

- On a degraded 84-second call the baseline produced **0 capitals and 0
  punctuation marks**. With `speechnorm`, the same audio gave **13 and 20**,
  recovered speech at the start that had been missed entirely, and corrected
  words the baseline got wrong.
- On a 40-second call it lifted 2 recognized segments to 6.
- On already-clean audio it changed nothing measurable — 835 words versus 832.

A plain `volume=10dB` boost changed almost nothing, and that is the telling
result: whisper normalizes level internally, so what helps is compressing
**dynamic range**, not raising volume. Phone recordings are lopsided — the
near-end speaker is loud, the far-end speaker quiet — and evening that out is the
actual win.

Normalization is applied to the playable copies too, since the quiet party is
often barely audible in the raw file. Originals in `recordings/` are never modified.

### …but only when the decode collapses

The finding above was drawn from one badly degraded file and wrongly generalized
to everything. Measured across more material, normalizing healthy audio **costs**
segmentation: on a three-minute excerpt it turned 45 recognized phrases into 27
and lost punctuation, because compressing dynamic range flattens the pauses the
model splits on. Coarser phrases also mean coarser seeking.

Level does not predict which files need it. The quietest sample measured, mean
−24 dBFS, decodes fine untouched, while a louder one collapses.

What does predict it is the output: a collapse arrives as an unbroken lowercase
run with no sentence punctuation, quantifiably distinct from healthy output —
zero capitals and zero punctuation per word against roughly 0.16 and 0.46.

So recognition runs on the audio as recorded, and only retries normalized when the
result looks collapsed. Just the affected minority pays for a second pass.

Re-transcribing three real calls this way: **punctuation up 17% overall and 30% on
the longest call**, words up slightly, segmentation coarser on one file of three.
A modest net win, mostly in readability.

### Why not a bigger model

`large-v3` has 32 decoder layers against turbo's 4, so it should win on hard
audio. It does not win here, and it costs three times the time: 2.7× realtime
against 8.2×.

On the same three-minute excerpt the two models produced three mutually
incompatible readings of the opening phrase, which is the tell — that audio is
genuinely unintelligible and every model is guessing. Elsewhere they largely
agree, and where they differ the score is even: large-v3 got a case ending right
that turbo missed, turbo got a verb right that large-v3 mangled.

The model is not the bottleneck. AMR-NB at 8 kHz and 12.2 kbit/s keeps 300–3400 Hz
and discards the rest, and no decoder recovers information the codec threw away.

---

## Silent recordings

Phone recorders fail silently. Of the first eleven test recordings, **three
peaked at −90 dBFS** — the recorder created a file and captured no signal at all,
including one fourteen minutes long.

Whisper does not return nothing for such files. It returns confident,
well-punctuated hallucinated subtitle credits.

So every recording is level-checked before transcription; anything peaking below
−60 dBFS is marked `silent` and skipped. The check costs one fast decode and
saves a full recognition run — on eleven files it skipped 17 minutes of audio.

Levels are measured on the **original**, not the normalized copy: normalizing
silence just amplifies the noise floor into something the model will happily
invent words for.

The verdict is written to disk alongside the transcripts, because otherwise every
`reindex` would put dead files back in the queue.

---

## Hallucinations

Whisper was trained on YouTube subtitles, so on dial tones and static it produces
subtitle and translator credits — a sign-off line naming whoever captioned the
video. One noisy file in the test set transcribed, in full, as the same
subtitler's credit line, twice.

The filter in `core/transcribe.js` drops segments that match one of these
patterns **in full**, then collapses consecutive duplicates, which is the other
classic looping artifact. Russian and English patterns ship; add your own freely.

This is why raw output is what gets written to disk. The first version stored
filtered segments, which meant that widening the list would have required
re-transcribing the archive — days of compute to fix a regex. Now it costs one
`reindex`.

---

## Search

SQLite FTS5 with the `unicode61` tokenizer, which handles non-Latin scripts
correctly.

Query terms are crudely stemmed — clipped by two or three characters — before
prefix matching, because naive prefix search breaks on inflection. In a heavily
inflected language a noun in the nominative will not match the same noun in the
accusative, since the forms diverge at the final character: searching for
*teplitsa* (greenhouse) found nothing, while the transcript plainly contained
*teplitsu*. Clipping to the shared stem finds every case form.

A real stemmer would be more precise, but this is not a precision problem. You
are looking for a conversation you half-remember, so recall matters far more than
a few extra matches.

---

## Contact normalization

Recorders write whatever form the dialler used, so one person appears several
times. In the source archive the most-called contact showed up both as
`8XXXXXXXXXX` (domestic form, 1,294 calls) and `_7XXXXXXXXXX` (international
form, 350 calls). Without merging, the most important person in the archive looks
like two strangers and no per-contact view makes sense.

Everything is reduced to E.164, which is also what makes address-book import
work at all: a phone exports numbers grouped and spaced in international form
while filenames carry bare local digits. Both sides go through the same
normalizer.

Names assigned by hand or imported from a `.vcf` live in `contacts.json` in the
archive, keyed by normalized number:

```json
{ "+15550001234": "Mom", "+15550005678": "Sam" }
```

They are deliberately **not** in the database. The database is rebuilt from
files, so a name stored only there would be erased by the next `reindex`.

vCard 2.1, 3.0 and 4.0 all parse, including the quoted-printable encoding phones
use for non-Latin names, and Apple's `item1.TEL` grouping. Numbers present in the
address book but never called are stored anyway, and get picked up if such a call
is imported later.

*Known limitation:* one person with several numbers still shows up as several
contacts that happen to share a name. Merging them into a single person entity is
not implemented.

---

## Concurrency

Both the server and the CLI can start jobs, so writes are guarded by an advisory
lock at `.tmp/writer.lock` in the archive, holding the owning pid. A second writer is refused with a
message pointing at `watch`; readers are never blocked.

This also makes crash recovery safe. A recording is flagged `running` while the
recognizer works on it, and after a kill that flag has to be cleared or the file
would never be picked up again. Recovery therefore runs only for whoever holds
the lock, and only when the previous holder is confirmed dead.

Getting that wrong is not theoretical: an earlier version ran recovery on every
database open, so merely starting `watch` alongside the server declared the
server's live job interrupted and re-queued the recording it was busy with — which
would then be transcribed twice.

For the same reason `reindex` empties its tables in a transaction rather than
deleting the database file: it can be triggered from the UI, which means it runs
inside the process serving requests, and pulling the file out from under live
readers is a race.

---

## Throughput

About **6× realtime** on an Apple M1 with `large-v3-turbo`, which works out to
roughly four days of background processing for 500 hours of audio.

Around 10 of those hours are pure overhead from reloading the 1.5 GB model on
every file. Running whisper.cpp as a persistent server instead would reclaim
them, and would also make transcription of newly imported files feel instant.
Not done yet.

The queue is interruptible and resumable, so this is genuinely a background job
rather than something to wait on.

---

## Portability

Paths in the database are relative, and the archive carries its own settings and
format version, so the folder can be moved to another disk or machine — or opened
by a later version of the app — and still work. That is the point of keeping the
archive entirely separate from the checkout.

The UI talks to the backend through exactly one file,
`app/renderer/api.js`. Wrapping this in Electron means reimplementing that single
module over IPC — `cli/server.js` becomes `main.js`, method names stay identical,
and `ui.js` is never opened. There is no build step and no framework, on purpose.

If this were ever packaged commercially, ffmpeg would need replacing:
opencore-amr (Apache-2.0) to decode plus libopus (BSD) to encode, avoiding
ffmpeg's GPL/LGPL obligations entirely.
