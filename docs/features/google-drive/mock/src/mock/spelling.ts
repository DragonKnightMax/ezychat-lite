import type { GrammarIssue } from './grammar';

/**
 * Proposed (grammar-fix): the spelling half of Fix English runs in the browser, at once, with no AI.
 * The app loads `nspell` with the British English Hunspell dictionary (`dictionary-en-gb`, about
 * 0.2 MB compressed, once, only while Fix English is on). This stand-in knows a fixed list instead,
 * so the demo is the same every time: known typos with their fix, and a few Malaysian words that a
 * plain English dictionary does not know (until the team adds them).
 */
const TYPOS: Record<string, string> = {
  pls: 'please',
  plz: 'please',
  recieve: 'receive',
  recieved: 'received',
  teh: 'the',
  tommorow: 'tomorrow',
  tomorow: 'tomorrow',
  alredy: 'already',
  allready: 'already',
  untill: 'until',
  wil: 'will',
  adress: 'address',
  deliverd: 'delivered',
  delievery: 'delivery',
  delivey: 'delivery',
  definately: 'definitely',
  seperate: 'separate',
  avaliable: 'available',
  availabe: 'available',
  thier: 'their',
  becuase: 'because',
  wich: 'which',
  dont: "don't",
  cant: "can't",
  wont: "won't",
  didnt: "didn't",
  doesnt: "doesn't",
  isnt: "isn't",
  im: "I'm",
  u: 'you',
  color: 'colour',
  canceled: 'cancelled',
};

/** Not in an English dictionary: underlined with "Add to team words" until someone adds them. */
const UNKNOWN = new Set(
  'kopi apong tarik lemak nasi cendol durian kopitiam georgetown lepas bayan gurney roti canai kuih'.split(
    ' ',
  ),
);

const MALAY = new Set(
  'saya awak boleh terima kasih tak nak sudah belum ada dengan untuk kami anda encik puan esok sini sana tunggu nanti'.split(
    ' ',
  ),
);

/** Malay or Chinese (or a mix with them) is not checked: Fix English is for English only. */
export function notEnglish(text: string): boolean {
  if (/[\p{Script=Han}\p{Script=Tamil}]/u.test(text)) return true;
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  return words.filter((w) => MALAY.has(w)).length >= 2;
}

/** Every word of the team list, lower case, multi-word entries split ("nasi lemak"). */
export function teamWordSet(words: readonly string[]): Set<string> {
  return new Set(words.flatMap((w) => w.toLowerCase().split(/\s+/)));
}

/**
 * The spelling mistakes in the text, at once. The word still being typed (no space or punctuation
 * after it yet) is left alone, as a phone keyboard does. Numbers, links and team words are never marked.
 */
export function checkSpelling(text: string, teamWords: Set<string>): GrammarIssue[] {
  if (notEnglish(text)) return [];
  const issues: GrammarIssue[] = [];
  const typing = /\p{L}$/u.test(text);
  for (const m of text.matchAll(/[\p{L}']+/gu)) {
    const word = m[0];
    const start = m.index;
    const end = start + word.length;
    if (typing && end === text.length) continue;
    if (/https?:\/\/\S*$|[@#]\S*$/.test(text.slice(0, start))) continue;
    if (/\d/.test(text.slice(Math.max(0, start - 1), end + 1))) continue;
    const lower = word.toLowerCase();
    if (teamWords.has(lower)) continue;
    const fix = TYPOS[lower];
    if (fix) {
      let replacement =
        fix.startsWith('I') || word[0] !== word[0]!.toUpperCase()
          ? fix
          : fix[0]!.toUpperCase() + fix.slice(1);
      // A word that starts a sentence keeps its capital: "pls" there becomes "Please".
      if (start === 0 || /[.!?]\s+$/.test(text.slice(0, start)))
        replacement = replacement[0]!.toUpperCase() + replacement.slice(1);
      issues.push({
        id: `s${start}:${word}`,
        start,
        end,
        original: word,
        replacement,
        kind: 'spelling',
      });
    } else if (UNKNOWN.has(lower)) {
      issues.push({
        id: `u${start}:${word}`,
        start,
        end,
        original: word,
        replacement: null,
        kind: 'spelling',
      });
    }
  }
  return issues;
}
