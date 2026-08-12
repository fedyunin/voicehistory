// Builds a synthetic archive: invented people, invented conversations, tone
// audio. Used for the README screenshots and for trying the interface without
// touching real recordings.
//
// Screenshots of a real call archive are a bad idea even blurred — dates,
// durations and contact counts leak through, and a blurred screenshot shows the
// interface badly. Invented data shows it honestly with nothing to hide.
//
// It goes through the real code paths: files are written to a staging folder,
// imported, given transcripts on disk, and picked up by a rebuild. So this also
// exercises import and reindex end to end.
//
//   node scripts/demo-archive.mjs [target-dir]
//
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { setRoot, paths, mirrorPath } from '../core/paths.js';
import * as archive from '../core/archive.js';
import * as config from '../core/config.js';
import { importFiles } from '../core/ingest.js';
import { reindex } from '../core/reindex.js';
import { normalizeContact } from '../core/contacts.js';
import * as contactbook from '../core/contactbook.js';

const exec = promisify(execFile);

const root = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'voicehistory-demo'));

// Fictional people, fictional numbers. +1555 01xx is the reserved fictional
// range, so nothing here can ring a real phone.
const PEOPLE = {
  '+15550100117': 'Mum',
  '+15550100142': 'Dad',
  '+15550100164': 'Ellie',
  '+15550100178': 'Marcus Reed',
  '+15550100191': 'Nadia',
  '+15550100203': 'Tom Bexley',
  '+15550100226': 'Riverside Dental',
  '+15550100238': 'Priya Raman',
  '+15550100255': 'Sam Whitfield',
  30303: 'Bank alerts',
};

// Conversations, as whisper would leave them: a start offset, an end offset and
// a line of speech. Written so that browsing, search and the synced transcript
// all have something real to show.
const CALLS = [
  {
    at: '20190714-114302', who: '+15550100117', app: 'phone', dir: 'Incoming',
    lines: [
      [0, 3100, 'Hello? Can you hear me now?'],
      [3600, 9200, 'Yes, much better. The reception in the kitchen is hopeless.'],
      [9800, 16400, 'I wanted to ask about Sunday — are you bringing the dog or leaving him with Ellie?'],
      [17100, 23800, 'Bringing him. He sulks for days if we leave him behind, it is not worth it.'],
      [24400, 31200, 'Good. Then I will do the roast at two and we can eat in the garden if it holds.'],
      [32000, 38600, 'It will hold. I looked at the forecast this morning, nothing until Tuesday.'],
    ],
  },
  {
    at: '20191231-234118', who: '+15550100142', app: 'phone', dir: 'Outgoing',
    lines: [
      [0, 4200, 'Happy new year! Are you still up?'],
      [4900, 11300, 'Barely. Your mother fell asleep on the sofa an hour ago, halfway through the film.'],
      [12000, 18700, 'Tell her I called. And tell her the garden looked wonderful in the photos.'],
      [19400, 26100, 'I will. She spent all of April on it, so she will be pleased you noticed.'],
    ],
  },
  {
    at: '20200328-160544', who: '+15550100164', app: 'whatsapp', dir: 'Incoming',
    lines: [
      [0, 5400, 'I am at the airport, they moved the gate again. Twice now.'],
      [6100, 13200, 'Of course they did. How long is the delay in the end?'],
      [13900, 20800, 'Two hours, maybe three. I will land after midnight so do not wait up for me.'],
      [21500, 29400, 'I will wait up anyway. Text me when you are actually in the air, not before.'],
      [30100, 36900, 'Deal. There is a queue at the coffee place halfway down the terminal, I am going to sit in it.'],
    ],
  },
  {
    at: '20210209-092217', who: '+15550100226', app: 'phone', dir: 'Outgoing',
    lines: [
      [0, 4800, 'Riverside Dental, good morning.'],
      [5500, 12100, 'Morning — I need to move my appointment on Thursday, something came up at work.'],
      [12800, 20600, 'Let me look. I can do the same time next Tuesday, or Friday at half past four.'],
      [21300, 26900, 'Friday is better. Half past four is fine.'],
    ],
  },
  {
    at: '20210817-181402', who: '+15550100178', app: 'phone', dir: 'Incoming',
    lines: [
      [0, 6200, 'Quick one — did the invoice go out to them on Friday or is it still sitting with you?'],
      [6900, 14400, 'It went out Friday afternoon. I copied you, check the thread from about four o clock.'],
      [15100, 22800, 'Found it. Right, then I will chase them on Monday if nothing lands by then.'],
      [23500, 31200, 'Chase them. They paid the last two late and nobody said anything, so they think it is fine.'],
    ],
  },
  {
    at: '20220405-201755', who: '+15550100191', app: 'phone', dir: 'Incoming',
    lines: [
      [0, 5100, 'Are you anywhere near a computer? I cannot get the file open.'],
      [5800, 12600, 'Give me a minute. Which one, the one from this morning?'],
      [13300, 20100, 'That one. It asks for a password and I have never had a password for it.'],
      [20800, 28400, 'That is because it is the wrong file. I sent a second one about an hour later, use that.'],
      [29100, 34800, 'Oh. Yes. There it is. Ignore everything I said.'],
    ],
  },
  {
    at: '20221005-143659', who: 'Team standup', app: 'gmeet', dir: null,
    lines: [
      [0, 7300, 'Right, quickly round the table — anything blocking anyone before Thursday?'],
      [8000, 15800, 'Nothing blocking. The migration finished overnight, I am checking the counts this morning.'],
      [16500, 24200, 'Counts matched when I looked at eight. I will put the numbers in the channel after this.'],
      [24900, 32600, 'Good. Then the only thing left for Thursday is the release notes, and I will write those.'],
    ],
  },
  {
    at: '20230311-103633', who: '+15550100203', app: 'phone', dir: 'Outgoing',
    lines: [
      [0, 5900, 'Tom, it is me. Are you still selling the bike?'],
      [6600, 13100, 'I am, but somebody is coming to look at it on Saturday morning.'],
      [13800, 21400, 'If they do not take it, call me. I will come with cash and I will not haggle.'],
      [22100, 28800, 'That is a good way to be first in the queue. I will let you know Saturday afternoon.'],
    ],
  },
  {
    at: '20231124-172208', who: '+15550100117', app: 'phone', dir: 'Incoming',
    lines: [
      [0, 4400, 'It is only me. Is this a bad time?'],
      [5100, 11900, 'Never a bad time. I am just walking back from the shop, keep talking.'],
      [12600, 20300, 'I found the box of photographs from the old house. You as a baby in the garden, all of it.'],
      [21000, 29700, 'Scan them, do not post them. I will bring the scanner at Christmas and we will do it together.'],
      [30400, 38200, 'Together is better. I would only put them in the wrong way round on my own.'],
    ],
  },
  {
    at: '20240110-193355', who: '+15550100238', app: 'whatsapp', dir: 'Incoming',
    lines: [
      [0, 6700, 'Are you free next weekend? We are trying to get everyone in one place for once.'],
      [7400, 14200, "Saturday yes, Sunday no. What is the plan, somebody else's house or out?"],
      [14900, 22600, "Priya's, she has the big garden. Everyone brings one thing and nobody cooks all day."],
      [23300, 30100, 'That is the correct way to do it. Put me down for the bread and something to drink.'],
    ],
  },
  {
    at: '20240622-084511', who: '+15550100255', app: 'phone', dir: 'Outgoing',
    lines: [
      [0, 5300, 'Sam, sorry to call so early. Is the van still free on Saturday?'],
      [6000, 12800, 'It is. What are we moving, and how many flights of stairs?'],
      [13500, 21200, 'A wardrobe and about thirty boxes. Second floor, and the lift has been broken since April.'],
      [21900, 29600, 'Of course it has. Bring two more people and I will bring the straps.'],
    ],
  },
  {
    at: '20250102-170433', who: null, app: 'phone', dir: 'Incoming',
    lines: [
      [0, 6100, 'Hello, am I speaking to the owner of the property? This will only take a moment.'],
      [6800, 11400, 'No, thank you. Please take this number off your list.'],
    ],
  },
  {
    at: '20250518-125940', who: 30303, app: 'phone', dir: 'Incoming',
    lines: [
      [0, 8200, 'This is an automated message about recent activity on your account. No action is needed.'],
    ],
  },
  {
    at: '20250926-120717', who: '+15550100164', app: 'phone', dir: 'Outgoing',
    lines: [
      [0, 5700, 'Where are you? I can hear an airport again.'],
      [6400, 13100, 'Because I am in one again. Same gate, same coffee queue, different city.'],
      [13800, 21500, 'You should write a book about airport coffee. You have the material for it by now.'],
      [22200, 30800, 'Nobody would read it. It would be forty pages of the same paragraph with the names changed.'],
      [31500, 39200, 'I would read it. Send me a photograph of the queue and I will start collecting them.'],
    ],
  },
  {
    at: '20260215-201133', who: '+15550100142', app: 'phone', dir: 'Incoming',
    lines: [
      [0, 5500, 'I am ringing about the garden again, so hang up now if you are busy.'],
      [6200, 12900, 'I am not busy. What has happened to the garden?'],
      [13600, 21300, 'Nothing has happened. I have decided to put the vegetables where the lawn is and I want an opinion.'],
      [22000, 30700, 'You have already decided, so my opinion is that it is a wonderful idea.'],
      [31400, 39100, 'That is the correct answer. Your mother said the same thing in fewer words.'],
    ],
  },
  // Two files with no signal at all — the recorder writes them and captures
  // nothing. Worth having in the demo: handling them is a real feature.
  { at: '20220719-141002', who: '+15550100191', app: 'phone', dir: 'Outgoing', silent: 19000 },
  { at: '20250803-094418', who: null, app: 'phone', dir: 'Incoming', silent: 31000 },
  // One imported but not yet transcribed, so the queue is not empty.
  { at: '20260530-173015', who: '+15550100178', app: 'phone', dir: 'Incoming', pending: true },
];

// Eighteen hand-written conversations show the interface; they do not show what
// it looks like with a history behind it. The activity map needs a month of days
// before it appears at all, and the review rules and year words are shares of the
// archive, so on a handful of recordings they correctly report nothing.
//
// So the demo also carries filler: enough calls, spread across the same years, for
// those views to have something true to display. Deterministic — a fixed
// generator rather than a random one, so two runs produce the same archive and a
// screenshot can be reproduced.
const FILLER_LINES = CALLS.flatMap((c) => c.lines ?? []).map(([, , text]) => text);
const FILLER_PEOPLE = Object.keys(PEOPLE);

function lcg(seed) {
  let x = seed;
  return () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
}

function generateFiller(count) {
  const rnd = lcg(20260812);
  const out = [];
  for (let i = 0; i < count; i++) {
    // Weighted across the years the hand-written calls span, so some years read
    // as busy and others as quiet — which is the whole point of the map.
    const year = [2019, 2020, 2020, 2020, 2021, 2021, 2022, 2022, 2022, 2023,
                  2024, 2025, 2025, 2026][Math.floor(rnd() * 14)];
    const month = 1 + Math.floor(rnd() * 12);
    const day = 1 + Math.floor(rnd() * 28);
    const hour = 8 + Math.floor(rnd() * 14);
    const min = Math.floor(rnd() * 60);
    const sec = Math.floor(rnd() * 60);
    const at = `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`
      + `-${String(hour).padStart(2, '0')}${String(min).padStart(2, '0')}${String(sec).padStart(2, '0')}`;

    const who = rnd() < 0.12 ? null : FILLER_PEOPLE[Math.floor(rnd() * FILLER_PEOPLE.length)];
    const n = 1 + Math.floor(rnd() * 7);
    const lines = [];
    let t = 0;
    for (let k = 0; k < n; k++) {
      const len = 2500 + Math.floor(rnd() * 6000);
      lines.push([t, t + len, FILLER_LINES[Math.floor(rnd() * FILLER_LINES.length)]]);
      t += len + 400 + Math.floor(rnd() * 1200);
    }
    out.push({
      at,
      who: who === null ? null : (String(who).startsWith('+') ? who : Number(who)),
      app: 'phone',
      dir: rnd() < 0.5 ? 'Incoming' : 'Outgoing',
      lines,
    });
  }
  return out;
}

CALLS.push(...generateFiller(260));

// A few recordings the recognizer plainly failed on, so the review section has
// something true to point at. Every real archive has these; a demo without them
// would show that feature as an empty heading.
CALLS.push(
  // Long calls with one phrase recovered out of them.
  { at: '20210620-104512', who: '+15550100117', app: 'phone', dir: 'Incoming',
    lines: [[0, 4200, 'Hello? Hello, can you hear me?']], minutes: 34 },
  { at: '20220914-201133', who: '+15550100142', app: 'phone', dir: 'Outgoing',
    lines: [[0, 3100, 'One moment.']], minutes: 21 },
  { at: '20250412-153001', who: '+15550100164', app: 'phone', dir: 'Incoming',
    lines: [[0, 2600, 'Yes?']], minutes: 47 },
  // A decode that collapsed: a long run with no sentence punctuation at all.
  { at: '20230715-181240', who: '+15550100191', app: 'phone', dir: 'Incoming',
    lines: [[0, 62000, ('so then we went round the back and it was still open so i said '
      + 'nothing and we waited a while and then the other one came out and asked us '
      + 'what we wanted and i said nothing again because there was no point ').repeat(3)]],
    minutes: 12 },
  // Minutes of audio the recognizer reported as having no speech in it.
  { at: '20200518-093000', who: '+15550100203', app: 'phone', dir: 'Incoming', silent: 640000 },
  { at: '20240301-171500', who: null, app: 'phone', dir: 'Incoming', silent: 420000 },
);

/** Cube's naming: app_YYYYMMDD-HHMMSS_contact.ext, number optionally underscored. */
function fileNameFor(call) {
  const who = call.who === null ? ''
    : typeof call.who === 'number' ? `_${call.who}`
    : call.who.startsWith('+') ? `_${call.who.slice(1)}`
    : `_${call.who}`;
  return `${call.app}_${call.at}${who}.m4a`;
}

const durationOf = (call) => (
  call.minutes ? call.minutes * 60000
  : call.lines ? call.lines.at(-1)[1] + 1800
  : call.silent ? call.silent
  : 47000);

/**
 * Tone audio at the length the call claims to be. Speech is not synthesized:
 * the transcripts are written directly, and inventing audio that matches them
 * would be a different project.
 */
async function makeAudio(dest, ms, { silent = false } = {}) {
  const sec = (ms / 1000).toFixed(2);
  const src = silent
    // Digital silence, so the app's own silence detection classifies it.
    ? ['-f', 'lavfi', '-i', `anullsrc=r=8000:cl=mono:d=${sec}`]
    // Otherwise something with a level, quiet and band-limited like a phone call.
    : ['-f', 'lavfi', '-i', `sine=frequency=320:sample_rate=8000:duration=${sec}`,
       '-af', 'volume=-24dB'];
  await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...src,
    '-ac', '1', '-ar', '8000', '-c:a', 'aac', '-b:a', '24k', dest]);
}

async function main() {
  if (!fs.existsSync(path.dirname(root))) {
    throw new Error(`Parent folder does not exist: ${path.dirname(root)}`);
  }
  console.log(`demo archive → ${root}`);
  fs.rmSync(root, { recursive: true, force: true });

  archive.open(root);
  setRoot(root);
  config.reload();

  // English demo data, so the language has to match or every transcript would
  // be labelled with the wrong one.
  archive.updateSettings({ language: 'en', numbering: { countryCode: '1', trunkPrefix: '', nsnLength: 10 } });
  config.reload();

  // Names go in before the import, and through contactbook rather than by
  // writing the file: it keeps the name map cached in memory, so a file written
  // behind its back is ignored for the rest of the process — which is exactly
  // how the first run of this script produced screenshots full of bare numbers.
  contactbook.reload();
  const named = contactbook.setMany(
    Object.entries(PEOPLE).map(([number, name]) => [normalizeContact(String(number)).key, name]),
  );
  console.log(`named ${named} contacts`);

  const staging = path.join(root, '.tmp', 'demo-source');
  fs.mkdirSync(path.join(staging, '.props'), { recursive: true });

  for (const call of CALLS) {
    const name = fileNameFor(call);
    const ms = durationOf(call);
    await makeAudio(path.join(staging, name), ms, { silent: call.silent });
    fs.writeFileSync(
      path.join(staging, '.props', `${name.replace(/\.[^.]+$/, '')}.json`),
      JSON.stringify({
        duration: String(ms),
        callee: typeof call.who === 'string' ? call.who : call.who === null ? '' : String(call.who),
        direction: call.dir ?? '',
      }, null, 1),
    );
  }
  console.log(`generated ${CALLS.length} recordings`);

  const imported = await importFiles(staging, { mode: 'move' });
  console.log(`imported ${imported.imported ?? imported.added ?? '?'}`);

  // Transcripts are written straight to disk, in the same shape the recognizer
  // leaves them, and a rebuild picks them up. That is the archive's own
  // contract: files are the source of truth.
  let written = 0;
  for (const call of CALLS) {
    if (call.pending) continue;
    const name = fileNameFor(call);
    const [y, m] = [call.at.slice(0, 4), call.at.slice(4, 6)];
    const relRec = `recordings/${y}/${y}-${m}/${name}`;
    const tPath = mirrorPath(paths.transcripts, relRec, 'json');
    fs.mkdirSync(path.dirname(tPath), { recursive: true });

    const body = call.silent
      ? { origName: name, relPath: relRec, silent: true,
          note: 'no audio signal (peak -91 dBFS)',
          level: { meanDb: -91, maxDb: -91 }, segments: [] }
      : { origName: name, relPath: relRec, model: 'large-v3-turbo', language: 'en',
          durationMs: durationOf(call),
          segments: call.lines.map(([t0, t1, text]) => ({ t0, t1, text: ` ${text}` })) };

    fs.writeFileSync(tPath, JSON.stringify(body, null, 1));
    written++;
  }
  console.log(`wrote ${written} transcripts`);

  // Names keyed the way the app keys them, so they attach to the right contacts.
  const stats = await reindex();
  console.log('reindexed:', JSON.stringify(stats));

  fs.rmSync(staging, { recursive: true, force: true });
  console.log(`\nready. open it with:\n  VH_ROOT=${root} npm run app`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
