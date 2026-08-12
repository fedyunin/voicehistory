# Voice History

[![test](https://github.com/fedyunin/voicehistory/actions/workflows/test.yml/badge.svg)](https://github.com/fedyunin/voicehistory/actions/workflows/test.yml)
[![latest release](https://img.shields.io/github/v/release/fedyunin/voicehistory)](https://github.com/fedyunin/voicehistory/releases/latest)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A local-first archive for recorded phone calls. Point it at a folder of
call-recorder exports and it files them by date, transcribes the speech, and
turns years of conversations into something you can search and listen back to.

Your archive is a folder of your own choosing — on this disk or an external one —
holding the recordings, transcripts and search index and nothing else. The app
keeps no copy: move the folder and the archive moves with it. Clone, run, point
it at your folder.

Nothing leaves your machine. No server, no account, no cloud service — the only
network access in the project is a one-time download of the speech model.

Built against a real archive: **5,398 recordings, 505 hours, 2019–2026**,
exported from [Cube ACR](https://cubeacr.app/) as 8 kHz AMR files.

![A short tour: the archive overview, a day picked out of the activity map, one person's history, a conversation with its transcript, and a search across every word](docs/tour.gif)

![The window on opening: years, people and anything needing review on the left, calls in the middle, and the archive read as a whole on the right — this day in earlier years, what each year was about, hours a year, every day as a map, and who the time went to](docs/01-overview.png)

<sub>Screenshots use a generated demo archive — invented people, invented
conversations — and are produced by <code>npm run demo &amp;&amp; npm run screenshots</code>,
so they cannot drift from the interface. It follows your system light/dark
setting: <a href="docs/03-archive-dark.png">dark version</a>.</sub>

## Quick start

```bash
git clone https://github.com/fedyunin/voicehistory.git
cd voicehistory

npm install
npm run setup      # checks ffmpeg + whisper.cpp, downloads the model (~1.5 GB)

npm run app        # desktop window
npm start          # or in a browser → http://127.0.0.1:4321
```

You can skip `npm run setup` — the app checks the same things on launch and can
download the model itself.

Both open the same archive and the same interface; the desktop window adds a
native folder picker and keeps running without a terminal.

On first run the interface asks where to keep your archive. Nothing else needs
configuring.

Requires Node 20+, [ffmpeg](https://ffmpeg.org/) and
[whisper.cpp](https://github.com/ggml-org/whisper.cpp). On macOS:
`brew install ffmpeg whisper-cpp`. Run `npm run doctor` to see what is missing.

### Or download a build

| | |
|---|---|
| **macOS** — Apple Silicon | [VoiceHistory-mac-arm64.dmg](https://github.com/fedyunin/voicehistory/releases/latest/download/VoiceHistory-mac-arm64.dmg) |
| **macOS** — Intel | [VoiceHistory-mac-x64.dmg](https://github.com/fedyunin/voicehistory/releases/latest/download/VoiceHistory-mac-x64.dmg) |
| **Windows** — installer | [VoiceHistory-win-x64-setup.exe](https://github.com/fedyunin/voicehistory/releases/latest/download/VoiceHistory-win-x64-setup.exe) |
| **Windows** — portable | [VoiceHistory-win-x64-portable.exe](https://github.com/fedyunin/voicehistory/releases/latest/download/VoiceHistory-win-x64-portable.exe) |
| **Linux** — Debian/Ubuntu | [VoiceHistory-linux-amd64.deb](https://github.com/fedyunin/voicehistory/releases/latest/download/VoiceHistory-linux-amd64.deb) |
| **Linux** — AppImage | [VoiceHistory-linux-x86_64.AppImage](https://github.com/fedyunin/voicehistory/releases/latest/download/VoiceHistory-linux-x86_64.AppImage) |

Those links always resolve to the newest release — every version is built on
[GitHub Actions](.github/workflows/release.yml) with the same filenames, so
nothing here has to be edited when one ships. All builds, including the macOS
zips, are on the [releases page](https://github.com/fedyunin/voicehistory/releases).

The builds are ad-hoc signed but not notarized — that needs a paid Apple
Developer ID — so the first launch needs a nudge past the OS:

- **macOS** — right-click the app → **Open**, then confirm. Or, if macOS still
  refuses: `xattr -cr "/Applications/Voice History.app"`.
- **Windows** — *More info* → *Run anyway*.

They also expect `ffmpeg` and `whisper-cli` to be installed — see below.

## What it needs installed

Two established tools do the audio work, rather than this project reimplementing
them: [ffmpeg](https://ffmpeg.org/) to decode recordings and
[whisper.cpp](https://github.com/ggml-org/whisper.cpp) to recognize speech. On
macOS both are one command: `brew install ffmpeg whisper-cpp`.

The app checks on launch and says what is missing, where each tool was found, and
what to run. The speech model it downloads for you.

Binaries are left to you on purpose. Fetching them would mean shipping an
installer for someone else's software, taking on ffmpeg's licensing, and
verifying downloads — while the model is a single file of published weights that
nothing else can substitute. `npm run doctor` prints the same report in a
terminal.

## Using it

Three buttons do the work.

**Import** — takes a folder of recordings. Drop files into the archive's
`inbox/`, or paste the path to a phone export. Recordings are filed into
`recordings/YEAR/YEAR-MONTH/`, get a browser-playable copy, and appear in the
list within minutes.

**Transcribe** — drains a queue held in the database. Stop and resume any time;
transcripts appear as they land. Progress, the file in flight and a time
estimate stay on screen, and stopping takes effect within a second rather than
at the end of the current recording. Follow it from a terminal instead with
`npm run watch`.

**People** — imports a `.vcf` address book from your phone, or lets you type
names in. Numbers are normalized so the same person written two different ways
becomes one contact.

Then read it. The window opens on the archive as a whole rather than an empty
pane: this day in earlier years, what each year was about, hours a year, every
day as a map you can click, and who the time actually went to — ranked by hours,
not by number of calls, or a bank's notifications would outrank a parent.

Select a person and the same pane becomes their story: how long you have known
them, how it rose and fell year by year, their longest conversations, and the
words that stand out in them. People are grouped by name, so someone with four
numbers is one person.

![One person: calls, hours and years together, the words that stand out in them, their days as a map, and their longest conversations](docs/02-person.png)

Search across every transcript, and click any line to jump to that moment in the
audio — a search hit seeks to the phrase that matched, not to the start of the
call. Arrow keys walk the list without going back to it, Escape steps back out,
and the list extends itself as you reach the end of it.

| A recording open: player and transcript, synced | Full-text search across every transcript |
|---|---|
| ![A call with its player at the top and the transcript below, each line a click from that moment in the audio](docs/03-archive.png) | ![Search results, each showing the matching phrase highlighted in context](docs/04-search.png) |
| What recognition got wrong, found for you | Naming the people behind the numbers |
| ![The list narrowed to recordings whose transcription looks doubtful, with a chip naming the reason and a button to re-run them all](docs/05-review.png) | ![The People dialog, listing contacts with editable names](docs/06-people.png) |
| The transcription queue, resumable and skippable | What the app needs installed |
| ![The Transcription dialog: queue counts, ordering choice, and re-transcribe](docs/07-transcribe.png) | ![The Requirements dialog: the speech model with a Download button, and each tool shown with the path it was found at](docs/09-setup.png) |

Recognition does not fail loudly — for a recording it made nothing of, it
returns one plausible line as readily as a real transcript. **Needs review** in
the sidebar names the shapes worth doubting and offers to run them again.

## How it works

Your archive — anywhere you like, nothing of the app inside it:

```
<your archive folder>/
  archive.json             manifest: format version + settings for this data
  recordings/2026/2026-07/  originals, filed by month (+ .props sidecars)
  audio/2026/2026-07/       playable copies — no browser can play AMR
  transcripts/2026/2026-07/ raw model output, as JSON
  contacts.json             names you assigned
  index.sqlite              search index (SQLite + FTS5) — derived
  inbox/                    drop new recordings here
```

The checkout — no user data inside it:

```
core/                      all logic, with no knowledge of any interface
cli/                       CLI and HTTP server — thin adapters over core/
app/renderer/              the UI: vanilla HTML/JS, no build step
```

Which archive is open is remembered per machine, in the OS config location
(`~/Library/Application Support/voicehistory` on macOS). Everything describing
the DATA — language, numbering plan, model — lives in `archive.json` instead, so
it travels with the recordings. `archive.json` carries a **format version**, so a
later version of the app can tell what it is reading, and refuses an archive
newer than it understands rather than corrupting it.

Three rules hold the design together:

**Files are the source of truth; the database is derived.** SQLite holds nothing
that `recordings/` and `transcripts/` do not. `npm run reindex` rebuilds it from
scratch, so schema changes need no migrations and an indexing bug cannot cost
you data.

**A recording's identity is its SHA-256**, not its filename. Re-importing the
same export is a no-op, which matters because in practice you re-export the
whole recorder folder every time. Nothing is ever deleted — duplicates are
parked in `inbox/_duplicates/` for you to review.

**Raw model output is kept.** Filtering happens at index time, so improving it
costs one `reindex` instead of re-transcribing days of audio.

## Configuration

Settings are edited in **Settings → Language and region** in the interface. They
are stored in `archive.json` inside the archive, so they travel with the data:

```json
{
  "formatVersion": 1,
  "settings": {
    "language": "en",
    "model": "large-v3-turbo",
    "prompt": null,
    "silencePeakDb": -60,
    "numbering": { "countryCode": "1", "trunkPrefix": "", "nsnLength": 10 }
  }
}
```

Editing that file by hand works too. Nothing about the language or the phone numbering plan is
hardcoded; the defaults simply match the archive this was built against
(Russian, country code 7). `prompt` is the priming text that makes the
recognizer produce punctuation at all — it **must** be written in the language
you are transcribing, and `null` selects a built-in sample.

For a one-off run, an environment variable overrides the file:

```bash
VH_LANGUAGE=en npm run transcribe
```

`VH_LANGUAGE`, `VH_MODEL`, `VH_PROMPT`, `VH_SILENCE_PEAK_DB`,
`VH_COUNTRY_CODE`, `VH_TRUNK_PREFIX`, `VH_NSN_LENGTH`. `VH_ROOT` opens a
specific archive for one command — useful for scripts, and the only setting that
cannot live in the archive, since a file inside it cannot say where it is.

Fields whose value is currently coming from an environment variable are shown
disabled in the interface, rather than letting you save a value that would
appear to do nothing.

Settings shows every value in effect and whether it came from the file, the
environment or a default.

## Commands

```bash
npm run app        open the archive in a desktop window
npm start          open the archive in a browser
npm run setup      verify tools, fetch the model
npm test           run the test suite
npm run doctor     environment check
npm run status     summary: years, people, hours
npm run watch      follow a job running elsewhere
npm run jobs       history of past runs
npm run reindex    rebuild the database from files

npm run demo /tmp/vh-demo   build an archive of invented data to try things on
npm run screenshots /tmp/vh-demo   regenerate the README screenshots from it

node cli/vh.js archive               show the current archive and recent ones
node cli/vh.js archive /path/to/dir  open or create an archive there
```

The CLI has a little more: `node cli/vh.js` prints everything, including
importing without moving the sources and transcribing a limited batch.

## Building installers

```bash
npm run dist        # for the machine you are on
npm run dist:mac    # dmg + zip, x64 and arm64
npm run dist:win    # nsis installer + portable exe
npm run dist:linux  # AppImage + deb
```

Output lands in `dist/`. Each platform has to be built on itself — the native
SQLite module is compiled against Electron's ABI for the target — which is why
CI runs three runners in parallel and collects the artifacts into one draft
release. Tag to publish:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

## Notes on the hard parts

Most of the interesting decisions here came out of measurement rather than
theory — why the recognizer needs a priming prompt to produce punctuation at
all, why silent recordings have to be detected before transcription, why audio
normalization helps but volume does not, and why a single-writer lock turned out
to be load-bearing.

**→ [docs/ENGINEERING.md](docs/ENGINEERING.md)**

## Backups and maintenance

Back up the archive folder — or just `recordings/`, `transcripts/` and
`contacts.json` from it. Everything else in there is reproducible — playable copies by re-encoding, the index with `reindex`. The
transcripts are worth keeping precisely because they represent days of compute.

Settings shows what is on disk and what each destructive action would cost.
Anything irreversible states what it destroys and what survives, and needs a
phrase typed to confirm.

![The Settings dialog showing disk usage and a danger zone where each action states what it destroys and what survives](docs/08-settings.png)

## Privacy and legality

Call recordings are sensitive, and in many places recording a call requires the
consent of both parties. This tool is for organizing recordings you already have
and are entitled to keep: it runs entirely locally, transmits nothing, and the
archive lives outside the checkout entirely, so it cannot be committed by
accident.

## License

MIT
