// Filename parsing for Cube ACR (Cube Call Recorder) exports.
//
// Shapes that occur in real exports (numbers below are illustrative):
//   phone_20191231-124849_15550001234.amr    plain number
//   phone_20230311-103633__15550001234.amr   number with a leading underscore
//   phone_20250102-170433.amr                no contact at all
//   viber_20221005-143659_Mom.amr            name from the address book
//   whatsapp_20240110-193355_Alice.amr
//   gmeet_20250926-120717_Team standup.amr

const NAME_RE = /^(?<source>[a-z]+)_(?<date>\d{8})-(?<time>\d{6})(?:_(?<contact>.*))?$/;

export const AUDIO_EXT = new Set([
  '.amr', '.mp3', '.m4a', '.wav', '.ogg', '.opus', '.aac', '.3gp', '.amr-wb',
]);

/**
 * @returns {{source, startedAt, rawContact}|null} startedAt is a naive local
 *   timestamp 'YYYY-MM-DDTHH:MM:SS'. Deliberately without a timezone: the
 *   recorder wrote phone-local time, and converting to UTC would shift every
 *   date in the archive.
 */
export function parseFilename(basename) {
  const stem = basename.replace(/\.[^.]+$/, '');
  const m = NAME_RE.exec(stem);
  if (!m) return null;
  const { source, date, time, contact } = m.groups;
  const startedAt =
    `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` +
    `T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`;
  if (!isValidDateTime(startedAt)) return null;
  return { source, startedAt, rawContact: (contact ?? '').trim() };
}

function isValidDateTime(s) {
  const [d, t] = s.split('T');
  const [y, mo, da] = d.split('-').map(Number);
  const [h, mi, se] = t.split(':').map(Number);
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return false;
  if (h > 23 || mi > 59 || se > 59) return false;
  if (y < 1990 || y > 2100) return false;
  // reject February 31st and friends
  const dt = new Date(y, mo - 1, da);
  return dt.getMonth() === mo - 1 && dt.getDate() === da;
}

/** Cube stores metadata beside the audio: <dir>/.props/<basename>.json */
export function propsPathFor(filePath, path) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath).replace(/\.[^.]+$/, '');
  return path.join(dir, '.props', `${base}.json`);
}

/** @returns {{durationMs, callee, direction, raw}|null} */
export function parseProps(raw) {
  try {
    const p = JSON.parse(raw);
    const ms = Number.parseInt(p.duration ?? '', 10);
    return {
      durationMs: Number.isFinite(ms) ? ms : null,
      callee: typeof p.callee === 'string' ? p.callee : null,
      direction: p.direction === 'Incoming' || p.direction === 'Outgoing' ? p.direction : null,
      raw,
    };
  } catch {
    return null;
  }
}
