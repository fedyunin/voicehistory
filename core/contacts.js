// Contact normalization.
//
// Why this exists: call recorders write the same number in whatever form the
// dialler happened to use, so one person shows up several times. In the archive
// this was built against, the most-called contact appeared both as
// `8XXXXXXXXXX` (domestic form, 1,294 calls) and `_7XXXXXXXXXX` (international
// form, 350 calls). Without normalization that person looks like two strangers,
// and no per-contact view of the archive makes sense.
//
// Everything is reduced to E.164 (`+<country><subscriber>`), which is also what
// makes address-book import work: a phone exports `+X XXX XXX-XX-XX` while
// filenames carry bare digits.

/**
 * National numbering plan, used to interpret numbers written in local form.
 * Deliberately configurable rather than hardcoded, so the project is not tied
 * to the country its author happened to live in:
 *
 *   VH_COUNTRY_CODE   international dialling code, no '+'        (default 7)
 *   VH_TRUNK_PREFIX   domestic long-distance prefix, '' if none  (default 8)
 *   VH_NSN_LENGTH     digits in a national subscriber number     (default 10)
 *
 * Examples of other plans: US/Canada → code 1, no trunk prefix, 10 digits.
 * UK → code 44, trunk prefix 0, 10 digits. Germany → code 49, trunk prefix 0,
 * but variable length, so numbers there are better left in international form.
 */
const PLAN = {
  countryCode: String(process.env.VH_COUNTRY_CODE ?? '7').replace(/\D/g, '') || '7',
  trunkPrefix: String(process.env.VH_TRUNK_PREFIX ?? '8').replace(/\D/g, ''),
  nsnLength: Number(process.env.VH_NSN_LENGTH ?? 10),
};

const SHORTCODE_MAX = 6;

/**
 * Reduces a raw contact string from a filename or address book to a canonical key.
 * @returns {{key: string, kind: 'phone'|'shortcode'|'name'|'unknown', display: string}}
 */
export function normalizeContact(rawContact, calleeFromProps = null) {
  const raw = (rawContact || '').trim() || (calleeFromProps || '').trim();
  if (!raw) return { key: 'unknown', kind: 'unknown', display: 'Unknown number' };

  const stripped = raw.replace(/^[_+\s]+/, '');
  const digits = stripped.replace(/[\s()\-.]/g, '');

  if (/^\d+$/.test(digits)) {
    if (digits.length <= SHORTCODE_MAX) {
      // Service short codes — banks, carriers, delivery. Kept verbatim, since
      // they are not subscriber numbers and have no country.
      return { key: digits, kind: 'shortcode', display: digits };
    }
    const e164 = toE164(digits);
    return { key: e164, kind: 'phone', display: formatPhone(e164) };
  }

  // A name from the address book. The key is prefixed so a contact literally
  // named "7" can never collide with a phone number.
  return { key: `name:${digits.toLowerCase()}`, kind: 'name', display: raw };
}

function toE164(digits) {
  const { countryCode: cc, trunkPrefix: tp, nsnLength } = PLAN;

  // Domestic form: trunk prefix followed by the subscriber number.
  if (tp && digits.length === tp.length + nsnLength && digits.startsWith(tp)) {
    return `+${cc}${digits.slice(tp.length)}`;
  }
  // Already carries the country code.
  if (digits.length === cc.length + nsnLength && digits.startsWith(cc)) {
    return `+${digits}`;
  }
  // Bare subscriber number, no prefix of any kind.
  if (digits.length === nsnLength) return `+${cc}${digits}`;
  // Anything else is assumed to already be an international number. Countries
  // sharing a dialling code fall through here correctly, since the code plus
  // subscriber length is all that matters.
  return `+${digits}`;
}

/** Pretty form for the configured plan; other numbers stay as plain E.164. */
function formatPhone(e164) {
  const cc = PLAN.countryCode;
  const m = new RegExp(`^\\+${cc}(\\d{3})(\\d{3})(\\d{2})(\\d{2})$`).exec(e164);
  return m ? `+${cc} ${m[1]} ${m[2]}-${m[3]}-${m[4]}` : e164;
}
