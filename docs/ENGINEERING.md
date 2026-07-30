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

The UI talks to the backend through exactly one file, `app/renderer/api.js`, and
that seam is what made the desktop shell cheap. It picks its transport at load
time: `fetch` when served over HTTP, `contextBridge` IPC when `window.vh` exists.
Method names are identical on both sides, so `ui.js` — the largest file in the
project — was never opened while Electron was added. `cli/server.js` and
`app/main.cjs` are two adapters over the same core, not two implementations.

Two things about the main process are not obvious:

- It is CommonJS while everything else is ESM. An ESM entry point does not
  reliably receive Electron's real bindings, and the failure looks like `app`
  being undefined. The core is loaded from it by dynamic `import()`.
- `npm run app` goes through `scripts/app.mjs`, which deletes
  `ELECTRON_RUN_AS_NODE` before spawning. VS Code exports that variable into its
  integrated terminals, and it makes Electron start as a bare Node process — the
  same undefined-`app` symptom, from an entirely different cause.

Serving audio needed `protocol.registerSchemesAsPrivileged` with `stream: true`,
and then range requests implemented by hand: without `Accept-Ranges` and
`Content-Length` the browser reports the media as unseekable, which on a
27-minute call is the whole feature.

If this were ever packaged commercially, ffmpeg would need replacing:
opencore-amr (Apache-2.0) to decode plus libopus (BSD) to encode, avoiding
ffmpeg's GPL/LGPL obligations entirely.

## Finding the external tools

Spawning `ffmpeg` by bare name works in development and fails once installed.
A GUI application does not inherit the PATH a shell builds from a login profile —
on macOS it gets launchd's environment, roughly `/usr/bin:/bin:/usr/sbin:/sbin`.
Homebrew lives in `/opt/homebrew/bin`, which is not in it. So the first packaged
build reported ffmpeg missing on a machine with ffmpeg plainly installed, and
`npm run app` from a terminal worked on the same machine minutes earlier. That
contradiction is the whole bug, and it is worth stating because nothing about it
is visible while developing.

`core/tools.js` searches PATH first and then the places these tools actually
install to, and everything spawns by absolute path. Measured with a launchd-style
environment: bare `ffmpeg` gives ENOENT, the resolver returns
`/opt/homebrew/bin/ffmpeg`.

The resolver caches, including misses, so a repeated probe costs nothing — and
exposes `reload()`, because otherwise the interface's “Check again” button could
never succeed after the user installed something.

`probe()` reports where each tool was found, not just that it was. When PATH is
the problem, the path is the answer.

## The model has to live somewhere writable

`bin/models` next to the code is fine in a checkout and impossible in a packaged
app, where that path resolves inside `app.asar` — a read-only archive. So an
in-app download had nowhere to write, which is why `paths.js` now resolves a
per-user data directory.

Reads search every known location; writes go to the first writable one, with the
checkout ahead of the per-user folder. A developer with 1.5 GB already downloaded
must not be made to fetch it again because the code moved. A consequence worth
knowing: pointing `VH_MODELS_DIR` at an empty folder does not hide a model
installed elsewhere, since the search is deliberately exhaustive.

Downloads land in a `.part` file and are renamed on success. A truncated model
that looks complete fails later, inside the recognizer, with an error that says
nothing about the real cause.

The binaries are not fetched the same way, and that asymmetry is deliberate: the
model is one file of published weights with no substitute, while shipping ffmpeg
means distributing someone else's software under GPL/LGPL obligations, from
sources that differ per platform, with checksums to verify. That is an installer,
not a feature.

## Packaging

Installers are built by electron-builder, one runner per platform, because
better-sqlite3 is native and gets recompiled against Electron's ABI for each
target — cross-building it is not worth the trouble when a matrix is three lines
of YAML. Each runner uploads its artifacts and a single final job collects them
into one draft release; publishing from each runner instead would have three jobs
racing to create the same release.

Artifact names carry no version — `VoiceHistory-mac-arm64.dmg`, not
`VoiceHistory-0.1.0-mac-arm64.dmg`. That is what makes the README's download
links work: `releases/latest/download/<name>` resolves against the newest
published release, so the links never need editing, but only while the filename
stays identical between releases. Putting the version back into `artifactName`
would silently 404 every download link in the README.

Targets and their architectures live in `package.json`, not in the `dist:*`
scripts. Naming them on the command line (`electron-builder --mac dmg zip`)
overrides the configured architecture list and quietly builds for the host
architecture only — the first build produced arm64 alone and looked correct.

`mac.identity` must be `"-"`, not `null`, and this one cost a released build.

`null` skips signing altogether. The packaged app then keeps the ad-hoc
signature the linker left on the Electron binary — `Identifier=Electron`,
`adhoc, linker-signed` — which no longer describes the bundle it now sits in.
`codesign --verify` says so plainly:

```
code has no resources but signature indicates they must be present
```

macOS reports that as **“Voice History.app” is damaged and can’t be opened. You
should move it to the Trash** — which reads like a corrupted download rather than
a signing problem, and offers no way past it. `"-"` makes electron-builder
ad-hoc sign the bundle for real: `Identifier=ru.cranfan.voicehistory`,
`adhoc, runtime`, and `codesign --verify --deep --strict` passes.

Gatekeeper still rejects it, because ad-hoc is not notarization — but that
rejection is the ordinary "Apple cannot check it for malicious software" dialog,
which right-click → Open gets past. A broken signature has no such escape.

Worth knowing that electron-builder warns about ad-hoc signing needing
`com.apple.security.cs.disable-library-validation` under hardened runtime: it
already adds that entitlement itself, along with `allow-jit` and
`allow-unsigned-executable-memory`. Without it the native SQLite module would be
refused at load time. Verified by launching a copy taken from the dmg with
`com.apple.quarantine` set, which is the state a downloaded app is actually in.

`CSC_IDENTITY_AUTO_DISCOVERY: 'false'` stays in CI alongside it, so a build
machine that happens to hold a real certificate cannot quietly produce a
differently-signed artifact. Verified in that combination rather than assumed.

Real signing needs a paid Apple Developer ID and a Windows certificate; until
then the README says exactly what the OS will say and what to do about it.

`ffmpeg` and `whisper-cli` stay external. Bundling them means shipping platform
binaries plus a ~1.5 GB model, taking on ffmpeg's licensing, and maintaining
three build recipes — a different project from this one. The installers are
therefore a convenience; running from source is the supported path.
