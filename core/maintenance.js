// Destructive maintenance, kept in one place so the blast radius of each action
// is written down next to the code that performs it.
//
// The guiding distinction: audio is irreplaceable, transcripts cost days of
// compute, and the index costs seconds. Every action states which of the three
// it destroys, and nothing deletes audio unless that is explicitly the point.
import fs from 'node:fs';
import path from 'node:path';
import { paths, ensureDirs } from './paths.js';
import { AUDIO_EXT } from './parse.js';
import * as db from './db.js';
import { reindex } from './reindex.js';

const CONFIRM = {
  transcripts: 'DELETE TRANSCRIPTS',
  names: 'DELETE NAMES',
  everything: 'DELETE EVERYTHING',
};

export const ACTIONS = {
  reindex: {
    title: 'Rebuild index',
    destroys: 'nothing',
    survives: 'audio, transcripts, names',
    detail: 'Re-reads every file on disk and rebuilds the search index. '
          + 'Safe — this is how the archive is meant to be repaired.',
    confirm: null,
  },
  names: {
    title: 'Clear contact names',
    destroys: 'contacts.json — every name you typed or imported',
    survives: 'audio, transcripts',
    detail: 'Contacts fall back to formatted phone numbers.',
    confirm: CONFIRM.names,
  },
  transcripts: {
    title: 'Delete transcripts',
    destroys: 'every transcript — days of compute',
    survives: 'audio files, contact names',
    detail: 'All recordings return to the transcription queue. '
          + 'Use this after changing the model or language.',
    confirm: CONFIRM.transcripts,
  },
  everything: {
    title: 'Delete everything',
    destroys: 'audio, transcripts, index and names — the entire archive',
    survives: 'nothing inside this folder',
    detail: 'Files imported in "move" mode exist nowhere else. '
          + 'Make sure your original export still exists before doing this.',
    confirm: CONFIRM.everything,
  },
};

/** Byte sizes, so the UI can show what is actually at stake. */
export function usage() {
  // `only` restricts the file count to real recordings: archive/ also holds
  // .props sidecars, and counting those as audio doubled the reported number.
  const dirSize = (dir, only = null) => {
    let bytes = 0, files = 0;
    const walk = (d) => {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (!only || only.has(path.extname(e.name).toLowerCase())) {
          bytes += fs.statSync(p).size;
          files++;
        }
      }
    };
    walk(dir);
    return { bytes, files };
  };
  const fileSize=(f)=>{try{return {bytes:fs.statSync(f).size,files:1}}catch{return {bytes:0,files:0}}};
  return {
    root: paths.root,
    recordings: dirSize(paths.recordings, AUDIO_EXT),
    audio: dirSize(paths.audio),
    transcripts: dirSize(paths.transcripts),
    index: fileSize(paths.db),
    names: fs.existsSync(paths.contacts),
  };
}

/**
 * Validates an action and its confirmation phrase.
 *
 * Separate from run() and called SYNCHRONOUSLY by the caller before the job is
 * scheduled. Checking only inside run() meant the API answered "started" to a
 * request with a wrong confirmation phrase, and the rejection surfaced later as
 * a failed background job — badly misleading for operations that delete an
 * archive.
 */
export function assertConfirmed(action, confirm) {
  const spec = ACTIONS[action];
  if (!spec) throw new Error(`Unknown action: ${action}`);
  if (spec.confirm && confirm !== spec.confirm) {
    throw new Error(`This action requires typing "${spec.confirm}" to confirm`);
  }
  return spec;
}

/**
 * @param {keyof ACTIONS} action
 * @param {string} confirm  must equal ACTIONS[action].confirm when one is required
 */
export async function run(action, confirm) {
  const spec = assertConfirmed(action, confirm);   // defence in depth

  switch (action) {
    case 'reindex':
      return { action, ...(await reindex()) };

    case 'names': {
      const file = paths.contacts;
      const existed = fs.existsSync(file);
      fs.rmSync(file, { force: true });
      db.reloadContactNames();
      const r = await reindex();
      return { action, cleared: existed, rows: r.rows };
    }

    case 'transcripts': {
      const before = usage().transcripts;
      fs.rmSync(paths.transcripts, { recursive: true, force: true });
      ensureDirs();
      const r = await reindex();
      return { action, deletedFiles: before.files, requeued: r.rows };
    }

    case 'everything': {
      const before = usage();
      db.close();
      // The archive FOLDER and its manifest survive — only the contents go, so
      // the user keeps the location they chose and it stays a valid archive.
      for (const dir of [paths.recordings, paths.audio, paths.transcripts]) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      for (const f of [paths.db, `${paths.db}-wal`, `${paths.db}-shm`, paths.contacts]) {
        fs.rmSync(f, { force: true });
      }
      ensureDirs();
      db.open();
      db.reloadContactNames();
      return {
        action,
        deletedRecordings: before.recordings.files,
        deletedBytes: before.recordings.bytes + before.audio.bytes + before.transcripts.bytes,
      };
    }
    default:
      throw new Error(`Unhandled action: ${action}`);
  }
}
