# Voice History

A local-first archive for recorded phone calls. It imports call-recorder
exports, files them by date, transcribes the speech, and turns years of
conversations into something you can actually search.

Nothing leaves your machine. There is no server, no account, and no cloud
service involved — the only network access in the whole project is a one-time
download of the speech model.

Built for a real archive: **5,372 recordings, 501 hours, spanning 2019–2026**,
exported from [Cube ACR](https://cubeacr.app/) as 8 kHz AMR files.

---

## Why

Call recorder apps quietly accumulate years of audio. Cube ACR alone has
55 million installs. That audio then sits in a folder as thousands of files
named `phone_20221005-143659_Mom.amr` — in a codec no browser can play, with no
way to search it, and no way to find the one conversation you remember.

Existing tools solve the transcription half well (MacWhisper, Whishper,
Scriberr). None of them solve the archive half: parsing recorder filenames into
people and dates, merging the same phone number written two different ways,
de-duplicating repeated exports, and browsing seven years by person and year.
That gap is what this project fills.

## Quick start

```bash
git clone https://github.com/fedyunin/voicehistory.git
cd voicehistory

npm install
npm run setup      # checks ffmpeg + whisper.cpp, downloads the model (~1.5 GB)
npm start          # → http://127.0.0.1:4321
```

Then use the interface: **Import** ingests a folder of recordings, **Transcribe**
runs the queue.

**Requirements:** Node 20+, [ffmpeg](https://ffmpeg.org/), and
[whisper.cpp](https://github.com/ggml-org/whisper.cpp).

```bash
# macOS
brew install ffmpeg whisper-cpp

# Debian/Ubuntu — ffmpeg from apt, whisper.cpp built from source
sudo apt install ffmpeg
```

`npm run doctor` tells you what is missing.

## Importing

Drop files into `Import/` and press **Import**. You can copy in an entire phone
export folder, `.props` metadata sidecars included — the structure is figured
out automatically.

Two things worth knowing:

**Nothing is ever deleted.** Duplicates are parked in `Import/_duplicates/` for
you to review, never removed.

**Re-importing is free.** A recording's identity is its SHA-256, not its
filename. Dropping in the same export ten times imports it once. This matters
because in practice you always re-export the whole recorder folder, not just
the new files.

The first import defaults to *copy* rather than *move*, so the original export
survives as a backup until you have verified the result.

## How it works

```
Import/                    drop new recordings here
archive/2026/2026-07/      originals, filed by month (+ .props sidecars)
derived/audio/             m4a copies — no browser can play AMR
derived/transcripts/       transcripts as JSON: RAW whisper output
db/index.sqlite            search index (SQLite + FTS5)

core/                      all logic. knows nothing about any interface
cli/                       CLI and HTTP server — thin adapters onto core/
app/renderer/              the UI: vanilla HTML/JS, no build step
```

Import runs in two deliberately separate phases. Phase one — hash, file away,
read metadata, build a playable copy — takes minutes, and recordings become
visible and audible immediately. Phase two — transcription — takes hours or
days and runs from a queue in the database, so text arrives progressively and
the job can be stopped and resumed at will.

### Three invariants

**Files are the source of truth; the database is derived.** SQLite holds nothing
that `archive/` and `derived/` do not. `npm run reindex` rebuilds it from
scratch. Schema changes therefore need no migrations, and an indexing bug can
never cost you data.

**Transcripts on disk hold raw whisper output.** Hallucination filtering is
applied at index time, not at transcription time. Improving the filter costs one
`reindex` — a second — instead of re-transcribing the archive, which costs days.

**Contacts are normalized to E.164.** Recorders write whatever form the dialler
used, so one person appears several times. In the source archive the most-called
contact showed up both as `8XXXXXXXXXX` (domestic form, 1,294 calls) and
`_7XXXXXXXXXX` (international form, 350 calls) — without merging, that person
looks like two strangers and no per-contact view makes sense.

The numbering plan is configurable rather than hardcoded, so the project is not
tied to one country:

```bash
VH_COUNTRY_CODE=1 VH_TRUNK_PREFIX= VH_NSN_LENGTH=10 npm start   # US / Canada
VH_COUNTRY_CODE=44 VH_TRUNK_PREFIX=0 npm start                  # UK
```

Defaults are country code 7, trunk prefix 8, 10-digit subscriber numbers.
Numbers that fit no rule are kept as-is in international form.

### Naming people

Recorder filenames only carry a name when the number was already in your
address book at the time of the call. Everything else arrives as bare digits, so
most of the archive starts out anonymous.

The **People** dialog fixes that two ways: import a `.vcf` address book exported
from your phone, or type names in by hand. vCard 2.1, 3.0 and 4.0 all parse,
including the quoted-printable encoding phones use for non-Latin names, and
imported numbers go through the *same* normalization as filenames — which is the
only reason matching works, since an address book writes numbers grouped and
spaced in international form while filenames carry bare local digits.

Names live in `contacts.json` at the archive root, keyed by normalized number:

```json
{ "+15550001234": "Mom", "+15550005678": "Sam" }
```

They are deliberately **not** in the database. The database is rebuilt from
files, so a name stored only there would be erased by the next `reindex`. The
file is plain JSON on purpose — edit it in a text editor if that is faster than
clicking.

Numbers from the address book that never appear in a call are stored anyway, and
get picked up automatically if such a call is imported later.

*Known limitation:* one person with several numbers still shows up as several
contacts that happen to share a name. Merging them into a single person is not
implemented.

### Search

SQLite FTS5 with the `unicode61` tokenizer, which handles Cyrillic correctly.
Query terms are crudely stemmed — clipped by two or three characters — before
prefix matching, because naive prefix search breaks on inflection: searching
*теплица* (greenhouse, nominative) would otherwise fail to match *теплицу*
(accusative) in the transcript, since the words diverge at the final character.

A real stemmer would be more precise, but this is not a precision problem. You
are looking for a conversation you half-remember, so recall matters far more
than a few extra matches.

### Portability

Only two files know anything about the operating system: `core/audio.js` (shells
out to ffmpeg) and `core/transcribe.js` (shells out to whisper.cpp). Porting
means swapping binaries, not rewriting logic. whisper.cpp was chosen precisely
for this — Metal on macOS, Vulkan or CUDA on Windows, CPU anywhere, all from the
same command line.

Paths in the database are relative, so the whole folder can be moved to another
disk or machine and still work. Set `VH_ROOT` to run the code from outside the
archive folder.

### The Electron seam

The UI talks to the backend through exactly one file, `app/renderer/api.js`.
Wrapping this in Electron means reimplementing that one module over IPC —
`cli/server.js` becomes `main.js`, the method names stay identical, and
`ui.js` is never opened. There is no build step and no framework, on purpose.

## Transcription settings, and why they are what they are

Every one of these came out of measurement against the real archive. Change
them with care.

| Setting | Finding |
|---|---|
| Priming prompt | **Required.** When decoding *with* timestamps, whisper emits lowercase text with no punctuation whatsoever. Seeding it with correctly punctuated speech restores both, at no cost to accuracy |
| `speechnorm` preprocessing | **Clear win.** On a degraded call the baseline produced 0 capitals and 0 punctuation marks; normalized, the same audio gave 13 and 20, recovered speech missed at the start, and corrected words. Neutral on already-clean audio |
| Plain gain (`volume=10dB`) | No meaningful effect — whisper normalizes level internally. What helps is compressing dynamic range, not raising volume |
| `loudnorm` | Helps degraded audio as much as speechnorm, but coarsens segmentation on good audio. Not used |
| `dynaudnorm` | No measurable effect on these recordings |
| `-bs 2` instead of beam 5 | 7.6x realtime versus 5.0x on the same file, with no visible difference in the text |
| `--no-fallback` | **Never use it.** Roughly twice as fast, but on phone-line noise the model degenerates into loops — `"Sound sound sound sound…"`. Temperature fallback is load-bearing |
| q5_0 quantized model | Faster than fp16, but noticeably worse at recognizing words. Rejected |
| VAD | Suppresses hallucinations effectively, but degrades the text and yields timestamps too coarse to seek by (~30 s). Not used |

Punctuation is not cosmetic here. An unpunctuated wall of text cannot be read,
and reading these conversations is the entire point.

### Silent recordings

Phone recorders fail silently. Of the first eleven test recordings, **three
peaked at −90 dBFS** — the recorder created a file and captured no signal at all,
including one that was fourteen minutes long.

Whisper does not return nothing for such files. It returns confident,
well-punctuated hallucinated subtitle credits, which then have to be filtered
back out.

So every recording is level-checked before transcription, and anything peaking
below −60 dBFS is marked `silent` and skipped. The check costs one fast decode
and saves a full whisper run — on the eleven test files it skipped 17 minutes of
audio. Levels are measured on the original, not the normalized copy, since
normalizing silence just amplifies the noise floor into something whisper will
happily invent words for.

### Hallucinations

Whisper was trained on YouTube subtitles, so on dial tones and static it
confidently produces translator credits. One noisy recording in the test set
transcribed, in full, as *"Субтитры сделал DimaTorzok"* — twice.

The filter list lives in `core/transcribe.js` and is meant to be extended.
Because raw output is preserved on disk, extending it is free.

### Configuration

Nothing about the language or numbering plan is hardcoded. Defaults match the
archive this was built against; override with environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `VH_LANGUAGE` | `ru` | Spoken language, or `auto` to detect |
| `VH_PROMPT` | Russian sample | Priming prompt — **must** be in the target language |
| `VH_COUNTRY_CODE` | `7` | Dialling code for interpreting local numbers |
| `VH_TRUNK_PREFIX` | `8` | Domestic long-distance prefix, empty if none |
| `VH_NSN_LENGTH` | `10` | Digits in a national subscriber number |
| `VH_ROOT` | project folder | Archive location |

```bash
VH_LANGUAGE=en VH_COUNTRY_CODE=1 VH_TRUNK_PREFIX= npm start
```

The hallucination filter ships Russian and English patterns; add your own in
`core/transcribe.js`. Widening it costs one `reindex`, never a re-transcription.

### Realistic throughput

About **6x realtime** on an Apple M1 with `large-v3-turbo`, which works out to
roughly four days of background processing for 500 hours of audio. Around 10 of
those hours are pure overhead from reloading the 1.5 GB model on every file;
running whisper.cpp as a persistent server instead would reclaim them.

The queue is interruptible, so this is genuinely a background job rather than
something you wait on.

## Watching a long run

Transcribing a large archive takes days, so progress is observable three ways.

**In the terminal that started it** — `import`, `transcribe` and `reindex` all
draw a progress bar with a running count and the file being worked on.

**In the browser** — jobs started from the UI stream progress over
Server-Sent Events. Close the tab and the job keeps going; reopen it and the bar
is still there, because job state lives in the database rather than in the page.

**From anywhere else** — a job started in the UI can be followed from a terminal,
and vice versa:

```bash
npm run watch      # live: transcribe: 412/5372  7%  elapsed 1h 20m  eta 17h 5m
npm run jobs       # history of every run: what finished, what failed, how long
```

`watch` is read-only and safe to leave running.

### One writer at a time

Both the server and the CLI can start jobs, so writes are guarded by an advisory
lock at `db/.lock` holding the owning pid. A second writer is refused with a
message pointing at `watch`; readers are never blocked.

This also makes crash recovery safe. A recording is flagged `running` while
whisper works on it, and after a kill that flag has to be cleared or the file
would never be picked up again. Recovery therefore runs only for whoever holds
the lock, and only when the previous holder is confirmed dead.

Getting that wrong is not theoretical: an earlier version ran recovery on every
database open, so merely starting `watch` alongside the server declared the
server's live job interrupted and re-queued the recording it was busy with.

## Commands

```bash
npm start                                 open the archive in a browser
npm run setup                             verify tools, fetch the model
npm run doctor                            environment check
npm run status                            summary: years, people, hours
npm run reindex                           rebuild the database from files

node cli/vh.js import DIR --copy          import without moving the sources
node cli/vh.js transcribe --limit 50      transcribe 50 recordings
node cli/vh.js transcribe --order newest  newest first instead of people first
node cli/vh.js serve --port 8080          serve on a different port
```

## Backups

Back up `archive/` and `derived/transcripts/`. Everything else is
reproducible — `derived/audio/` by re-encoding, `db/` with `reindex`. The
transcripts are worth keeping precisely because they represent days of compute.

## Privacy and legality

Call recordings are sensitive by nature, and in many jurisdictions recording a
call requires the consent of both parties. This tool is designed for organizing
recordings you already have and are entitled to keep: it runs entirely locally,
transmits nothing, and `.gitignore` is set up so your archive can never be
committed by accident.

## License

MIT
