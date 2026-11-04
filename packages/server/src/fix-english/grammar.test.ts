import { describe, expect, it } from 'vitest';
import { GRAMMAR_ISSUES_MAX, grammarIssues } from './grammar.js';

const pairs = (text: string, corrected: string) =>
  grammarIssues(text, corrected).map((i) => {
    expect(text.slice(i.start, i.end)).toBe(i.original);
    return [i.original, i.replacement];
  });

/** What the composer's Fix all does: every mark, from the end. */
const applyAll = (text: string, issues: ReturnType<typeof grammarIssues>) =>
  [...issues]
    .sort((a, b) => b.start - a.start)
    .reduce((t, i) => t.slice(0, i.start) + i.replacement + t.slice(i.end), text);

describe('grammarIssues', () => {
  it('marks each changed word on the original positions', () => {
    expect(
      pairs(
        'Hi Farah, your order have been ship. pls check you email for a update.',
        'Hi Farah, your order has been shipped. Please check your email for an update.',
      ),
    ).toEqual([
      ['have', 'has'],
      ['ship', 'shipped'],
      ['pls', 'Please'],
      ['you', 'your'],
      ['a', 'an'],
    ]);
  });

  it('attaches an insertion to the next word, or the word before at the end', () => {
    expect(pairs('please check email now', 'please check your email now')).toEqual([
      ['email', 'your email'],
    ]);
    expect(pairs('i will send it tomorrow', 'I will send it tomorrow.')).toEqual([
      ['i', 'I'],
      ['tomorrow', 'tomorrow.'],
    ]);
  });

  it('marks a removed word', () => {
    expect(pairs('the the order is ready', 'the order is ready')).toEqual([['the ', '']]);
  });

  it('never touches numbers, links, emails or mentions', () => {
    expect(pairs('The price is RM12 for 2 pax', 'The price is RM15 for two pax')).toEqual([]);
    expect(pairs('see www.kopi.my/menu ok', 'see www.kopi.my/menus ok')).toEqual([]);
    expect(pairs('mail aisyah@kopi.my pls', 'mail aisyah@kopi.com pls')).toEqual([]);
  });

  it('drops a rewrite: long phrases, or half the words changed', () => {
    expect(
      pairs(
        'Hi, can you send me your address?',
        'Hello, could you please kindly send over your full home address to us today?',
      ),
    ).toEqual([]);
    expect(
      pairs('we go there tomorrow', 'we shall travel to that place by tomorrow morning'),
    ).toEqual([]);
  });

  it('ignores unchanged text, spacing-only changes and an empty answer', () => {
    expect(pairs('ok lah, see you', 'ok lah, see you')).toEqual([]);
    expect(pairs('ok  lah see you', 'ok lah see you')).toEqual([]);
    expect(pairs('ok lah see you', '   ')).toEqual([]);
  });

  it('never gives two marks on one word: changes that meet become one mark', () => {
    // Before and after the same word: one mark with both, not "your email" and "email." apart.
    expect(pairs('please check email', 'Please check your email.')).toEqual([
      ['please', 'Please'],
      ['email', 'your email.'],
    ]);
    // A full stop inserted before a word that also changes.
    expect(
      pairs('Thanks for your order we will ship', 'Thanks for your order. We will ship'),
    ).toEqual([[' we', '. We']]);
  });

  it('applying every mark gives the corrected text, and the fixed text gets no new mark', () => {
    const cases: Array<[string, string]> = [
      ['please check email', 'Please check your email.'],
      [
        'Thanks for your order we will ship it soon',
        'Thanks for your order. We will ship it soon.',
      ],
      ['ok noted , will update', 'OK noted, will update.'],
      ['hello how are you', 'Hello, how are you?'],
    ];
    for (const [text, corrected] of cases) {
      const fixed = applyAll(text, grammarIssues(text, corrected));
      expect(grammarIssues(fixed, corrected)).toEqual([]);
      expect(fixed.replace(/ ,/gu, ',')).toBe(corrected);
    }
  });

  it('applying one mark never adds what is already there (no double punctuation)', () => {
    // An insertion the diff lined up next to a deletion: "email!" + "!" would read "email!!".
    for (const [text, corrected] of [
      ['email! email! the!', '!! email! the!'],
      ['a, email! email.', ',, email! email.'],
      ['email. the! a,', 'email. !! a,'],
    ] as const)
      for (const issue of grammarIssues(text, corrected)) {
        const once = applyAll(text, [issue]);
        expect(once).not.toMatch(/([!,.?])\1/u);
      }
    // The model checks the fixed draft afresh and adds the same full stop or word again.
    expect(pairs('Please check your email.', 'Please check your email..')).toEqual([]);
    expect(pairs('send the quote', 'send the the quote')).toEqual([]);
    // A real insertion next to other punctuation is kept.
    expect(pairs('ok, see you', 'ok, see you.')).toEqual([['you', 'you.']]);
  });

  it(`returns at most ${GRAMMAR_ISSUES_MAX} marks`, () => {
    const text = Array.from({ length: 120 }, () => 'i go and').join(' ');
    const corrected = Array.from({ length: 120 }, () => 'I go and').join(' ');
    expect(grammarIssues(text, corrected)).toHaveLength(GRAMMAR_ISSUES_MAX);
  });
});
