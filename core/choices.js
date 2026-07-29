// Valid values for every setting, so the interface can offer a choice instead of
// asking the user to guess a format.
//
// These live in core rather than the renderer because the model list has to agree
// with what the licence tier allows, and because both shells serve them.

/** Languages whisper handles well, by usefulness rather than alphabetically. */
export const LANGUAGES = [
  { code: 'auto', name: 'Detect automatically' },
  { code: 'ru', name: 'Russian' },
  { code: 'en', name: 'English' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'kk', name: 'Kazakh' },
  { code: 'be', name: 'Belarusian' },
  { code: 'de', name: 'German' },
  { code: 'fr', name: 'French' },
  { code: 'es', name: 'Spanish' },
  { code: 'it', name: 'Italian' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'nl', name: 'Dutch' },
  { code: 'pl', name: 'Polish' },
  { code: 'cs', name: 'Czech' },
  { code: 'ro', name: 'Romanian' },
  { code: 'hu', name: 'Hungarian' },
  { code: 'el', name: 'Greek' },
  { code: 'bg', name: 'Bulgarian' },
  { code: 'sr', name: 'Serbian' },
  { code: 'hr', name: 'Croatian' },
  { code: 'tr', name: 'Turkish' },
  { code: 'ar', name: 'Arabic' },
  { code: 'he', name: 'Hebrew' },
  { code: 'fa', name: 'Persian' },
  { code: 'hi', name: 'Hindi' },
  { code: 'ur', name: 'Urdu' },
  { code: 'zh', name: 'Chinese' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'id', name: 'Indonesian' },
  { code: 'th', name: 'Thai' },
  { code: 'sv', name: 'Swedish' },
  { code: 'da', name: 'Danish' },
  { code: 'no', name: 'Norwegian' },
  { code: 'fi', name: 'Finnish' },
  { code: 'et', name: 'Estonian' },
  { code: 'lv', name: 'Latvian' },
  { code: 'lt', name: 'Lithuanian' },
  { code: 'hy', name: 'Armenian' },
  { code: 'ka', name: 'Georgian' },
  { code: 'az', name: 'Azerbaijani' },
  { code: 'uz', name: 'Uzbek' },
];

/**
 * Models, with the trade-off spelled out. The download size matters because the
 * user pays it once on a metered connection.
 */
export const MODELS = [
  { id: 'base', name: 'base — fastest, roughest', size: '~150 MB' },
  { id: 'small', name: 'small — quick, usable', size: '~500 MB' },
  { id: 'medium', name: 'medium — good, 2–3× slower than turbo', size: '~1.5 GB' },
  { id: 'large-v3-turbo', name: 'large-v3-turbo — recommended', size: '~1.5 GB' },
  { id: 'large-v3', name: 'large-v3 — best, several times slower', size: '~3 GB' },
];

/**
 * National numbering plans, offered as one choice instead of three cryptic
 * fields. Picking a country sets the dialling code, the domestic trunk prefix and
 * the subscriber-number length together, which is the only combination that makes
 * sense — getting one of the three wrong silently breaks contact merging.
 */
export const NUMBERING_PLANS = [
  { id: 'ru', name: 'Russia / Kazakhstan (+7)', countryCode: '7', trunkPrefix: '8', nsnLength: 10 },
  { id: 'us', name: 'United States / Canada (+1)', countryCode: '1', trunkPrefix: '', nsnLength: 10 },
  { id: 'gb', name: 'United Kingdom (+44)', countryCode: '44', trunkPrefix: '0', nsnLength: 10 },
  { id: 'de', name: 'Germany (+49)', countryCode: '49', trunkPrefix: '0', nsnLength: 10 },
  { id: 'fr', name: 'France (+33)', countryCode: '33', trunkPrefix: '0', nsnLength: 9 },
  { id: 'es', name: 'Spain (+34)', countryCode: '34', trunkPrefix: '', nsnLength: 9 },
  { id: 'it', name: 'Italy (+39)', countryCode: '39', trunkPrefix: '', nsnLength: 10 },
  { id: 'nl', name: 'Netherlands (+31)', countryCode: '31', trunkPrefix: '0', nsnLength: 9 },
  { id: 'pl', name: 'Poland (+48)', countryCode: '48', trunkPrefix: '', nsnLength: 9 },
  { id: 'ua', name: 'Ukraine (+380)', countryCode: '380', trunkPrefix: '0', nsnLength: 9 },
  { id: 'tr', name: 'Turkey (+90)', countryCode: '90', trunkPrefix: '0', nsnLength: 10 },
  { id: 'il', name: 'Israel (+972)', countryCode: '972', trunkPrefix: '0', nsnLength: 9 },
  { id: 'in', name: 'India (+91)', countryCode: '91', trunkPrefix: '0', nsnLength: 10 },
  { id: 'br', name: 'Brazil (+55)', countryCode: '55', trunkPrefix: '0', nsnLength: 11 },
  { id: 'au', name: 'Australia (+61)', countryCode: '61', trunkPrefix: '0', nsnLength: 9 },
  { id: 'ge', name: 'Georgia (+995)', countryCode: '995', trunkPrefix: '', nsnLength: 9 },
  { id: 'am', name: 'Armenia (+374)', countryCode: '374', trunkPrefix: '0', nsnLength: 8 },
  { id: 'uz', name: 'Uzbekistan (+998)', countryCode: '998', trunkPrefix: '', nsnLength: 9 },
];

/** Threshold below which a recording counts as having no signal. */
export const SILENCE_LEVELS = [
  { value: -45, name: '−45 dBFS — strict, may skip very quiet speech' },
  { value: -60, name: '−60 dBFS — recommended' },
  { value: -75, name: '−75 dBFS — lenient' },
  { value: -90, name: '−90 dBFS — only truly empty files' },
];

/** Which preset matches a stored plan, or null when it is a custom combination. */
export function matchPlan({ countryCode, trunkPrefix, nsnLength }) {
  return NUMBERING_PLANS.find((p) => p.countryCode === String(countryCode)
    && p.trunkPrefix === String(trunkPrefix ?? '')
    && Number(p.nsnLength) === Number(nsnLength))?.id ?? null;
}

export function all() {
  return {
    languages: LANGUAGES,
    models: MODELS,
    numberingPlans: NUMBERING_PLANS,
    silenceLevels: SILENCE_LEVELS,
  };
}
