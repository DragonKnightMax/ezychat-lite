import { describe, expect, it } from 'vitest';
import { findLeak } from '../src/ai/leak-check.js';

// An Internal item (lowest price, margin note).
const internal = 'Our floor price for the Pro plan is RM 1,180 a seat; never go lower than that.';

describe('findLeak', () => {
  it('catches a reply that quotes 40 characters of an Internal item verbatim', () => {
    const run = internal.slice(10, 50);
    expect(run).toHaveLength(40);
    expect(findLeak(`Sure!#${run}#`, [internal])).toBe(true);
  });

  it('lets a 39-character run through', () => {
    const run = internal.slice(10, 49);
    expect(run).toHaveLength(39);
    expect(findLeak(`Sure!#${run}#`, [internal])).toBe(false);
  });

  it('still catches the run with changed spacing and case (Review Focus 3)', () => {
    const run = internal.slice(10, 50);
    const disguised = run.toUpperCase().replace(/ /g, '  \n ');
    expect(findLeak(`Here you go:\n${disguised}`, [internal])).toBe(true);
    // The internal text itself may hold odd spacing too.
    expect(findLeak(run, [internal.replace(/ /g, '\t  ')])).toBe(true);
  });

  it('checks every Internal item and allows replies that quote none', () => {
    expect(findLeak('We open 9am to 6pm.', [])).toBe(false);
    expect(findLeak('We open 9am to 6pm.', ['short', internal])).toBe(false);
    expect(findLeak(internal, ['other text that is long enough to check here', internal])).toBe(
      true,
    );
  });

  it('honours a custom minimum run', () => {
    expect(findLeak('plan is RM 1,180 a', [internal], 15)).toBe(true);
    expect(findLeak('plan is RM 1,180 a', [internal])).toBe(false);
  });

  it('gives the same answer as a plain search of the reply for every window', () => {
    // The pre-index algorithm, kept as the reference: any window of an Internal text found in the reply.
    const normalise = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();
    const reference = (reply: string, texts: readonly string[], minRun: number) => {
      const haystack = normalise(reply);
      if (haystack.length < minRun) return false;
      return texts.some((raw) => {
        const text = normalise(raw);
        for (let start = 0; start + minRun <= text.length; start++)
          if (haystack.includes(text.slice(start, start + minRun))) return true;
        return false;
      });
    };
    const words = [
      'harga',
      'RM',
      '1,180',
      'stok',
      'Kopi',
      'teh',
      'seat',
      'never',
      'lower',
      'promo',
    ];
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
    const text = (count: number) =>
      Array.from({ length: count }, () => words[next() % words.length]).join(
        ['  ', ' ', '\n', '\t '][next() % 4],
      );
    let leaks = 0;
    for (let round = 0; round < 300; round++) {
      const texts = [text(40 + (next() % 80)), text(next() % 30)];
      const source = texts[0]!;
      // Half the replies quote a slice of an Internal text (with changed case), half do not.
      const planted =
        round % 2 === 0
          ? source.slice(next() % 50, 50 + (next() % 120)).toUpperCase()
          : text(next() % 60);
      const reply = `${text(next() % 40)} ${planted} ${text(next() % 20)}`;
      const minRun = [15, 25, 40][round % 3]!;
      const expected = reference(reply, texts, minRun);
      if (expected) leaks++;
      expect(findLeak(reply, texts, minRun), `round ${round}`).toBe(expected);
    }
    // Both outcomes were exercised.
    expect(leaks).toBeGreaterThan(50);
    expect(leaks).toBeLessThan(300);
  });
});
