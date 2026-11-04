import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import nspell from 'nspell';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { FixEnglishStatus } from '@ezychat/shared';
import { fetchGrammar } from '@/api/fix-english';
import { loadSpeller } from '@/lib/dictionary';
import { Composer, type ComposerProps } from './Composer';

vi.mock('@/api/fix-english', () => ({ fetchGrammar: vi.fn() }));
vi.mock('@/lib/dictionary', () => ({ loadSpeller: vi.fn() }));

const here = dirname(fileURLToPath(import.meta.url));
const dictionary = join(here, '../../public/dictionaries/en-GB');
const speller = nspell(
  readFileSync(join(dictionary, 'index.aff')),
  readFileSync(join(dictionary, 'index.dic')),
);

const JID = '60126677889@s.whatsapp.net';
const ON: FixEnglishStatus = {
  enabled: true,
  connected: true,
  spelling: 'on',
  grammar: 'on',
  upgraded: false,
};
const DRAFT = 'Hi Farah, your parcel have been shiped tommorow. pls check you emial ';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= function () {};
});
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.mocked(loadSpeller).mockResolvedValue(speller);
  vi.mocked(fetchGrammar).mockResolvedValue({ status: 'checked', issues: [] });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const setup = (
  over: Partial<NonNullable<ComposerProps['fixEnglish']>> = {},
  props: Partial<ComposerProps> = {},
) => {
  const onSend = vi.fn();
  const onAddWord = vi.fn().mockResolvedValue(undefined);
  render(
    <Composer
      quickReplies={[]}
      onSend={onSend}
      onAttach={vi.fn()}
      fixEnglish={{
        chatJid: JID,
        chatName: 'Farah Aziz',
        status: ON,
        teamWords: new Set(['kopitiam']),
        onAddWord,
        ...over,
      }}
      {...props}
    />,
    { wrapper: MemoryRouter },
  );
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const box = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
  return { onSend, onAddWord, user, box };
};
const marked = () =>
  [...document.querySelectorAll<HTMLElement>('[data-testid=fix-english-marks] [data-issue]')].map(
    (el) => el.textContent,
  );
/** Spelling suggestions are looked up one word per tick: let them all arrive. */
const settle = async () => {
  for (let i = 0; i < 12; i++) await act(() => vi.advanceTimersByTimeAsync(5));
};
/** jsdom has no layout: put every mark "under" the pointer so a click opens its card. */
const everyMarkHit = (word: string) =>
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
    const hit = this instanceof HTMLElement && this.textContent === word && !!this.dataset.issue;
    return (hit ? [{ left: 0, right: 500, top: 0, bottom: 500 }] : []) as unknown as DOMRectList;
  });

describe('Composer Fix English: spelling', () => {
  it('marks misspelt words at once, without the AI, and turns off the browser spell-check', async () => {
    const { box } = setup();
    fireEvent.change(box, { target: { value: DRAFT } });
    await waitFor(() => expect(marked()).toEqual(['shiped', 'tommorow', 'pls', 'emial']));
    expect(box.getAttribute('spellcheck')).toBe('false');
    // No AI request before the pause.
    expect(fetchGrammar).not.toHaveBeenCalled();
  });

  it('never marks team words, the chat name, or anything while Fix English is off', async () => {
    const { box } = setup();
    fireEvent.change(box, { target: { value: 'Farah, the kopitiam opens tommorow. ' } });
    await waitFor(() => expect(marked()).toEqual(['tommorow']));
    cleanup();
    const off = setup({ status: { ...ON, enabled: false, spelling: 'off', grammar: 'off' } });
    fireEvent.change(off.box, { target: { value: 'tommorow pls ' } });
    await settle();
    expect(marked()).toEqual([]);
    expect(off.box.getAttribute('spellcheck')).toBe('true');
    expect(screen.queryByTestId('fix-english-fix-all')).toBeNull();
  });

  it('fixes every safe mark with Fix all, then Undo brings the draft back', async () => {
    const { box, user } = setup();
    fireEvent.change(box, { target: { value: 'pls send tommorow. i will check ' } });
    await settle();
    const fixAll = await screen.findByTestId('fix-english-fix-all');
    expect(fixAll.textContent).toContain('Fix 3');
    await user.click(fixAll);
    expect(box.value).toBe('Please send tomorrow. I will check ');
    expect(screen.getByTestId('fix-english-undo').textContent).toContain('3 fixed');
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(box.value).toBe('pls send tommorow. i will check ');
  });

  it('fixes all with Ctrl+J, and the Undo note goes after five seconds', async () => {
    const { box, user } = setup();
    fireEvent.change(box, { target: { value: 'tommorow is ok ' } });
    await settle();
    box.focus();
    await user.keyboard('{Control>}j{/Control}');
    expect(box.value).toBe('Tomorrow is ok ');
    expect(screen.getByTestId('fix-english-undo')).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(5_100));
    expect(screen.queryByTestId('fix-english-undo')).toBeNull();
  });

  it('opens a card on a marked word: pick a fix, or Ignore it', async () => {
    const { box, user } = setup();
    fireEvent.change(box, { target: { value: 'see you tommorow then ' } });
    await settle();
    everyMarkHit('tommorow');
    fireEvent.click(box, { clientX: 10, clientY: 10 });
    const card = await screen.findByTestId('fix-english-card');
    expect(card.textContent).toContain('Spelling');
    await user.click(screen.getByRole('button', { name: 'tomorrow' }));
    expect(box.value).toBe('see you tomorrow then ');
    expect(screen.queryByTestId('fix-english-card')).toBeNull();

    fireEvent.change(box, { target: { value: 'see you tommorow then ' } });
    await settle();
    fireEvent.click(box, { clientX: 10, clientY: 10 });
    await user.click(await screen.findByRole('button', { name: 'Ignore' }));
    expect(marked()).toEqual([]);
  });

  it('keeps the card open, under its word, when the box scrolls (focus on a phone)', async () => {
    const { box } = setup();
    fireEvent.change(box, { target: { value: 'see you tommorow then ' } });
    await settle();
    everyMarkHit('tommorow');
    fireEvent.click(box, { clientX: 10, clientY: 10 });
    await screen.findByTestId('fix-english-card');
    fireEvent.scroll(box);
    expect(screen.getByTestId('fix-english-card')).toBeTruthy();
  });

  it('offers Add to team words for a word the dictionary does not know', async () => {
    const { box, user, onAddWord } = setup();
    fireEvent.change(box, { target: { value: 'the zxqvbn is ready ' } });
    await settle();
    everyMarkHit('zxqvbn');
    fireEvent.click(box, { clientX: 10, clientY: 10 });
    expect((await screen.findByTestId('fix-english-card')).textContent).toContain(
      'Not in the dictionary',
    );
    // A word with no fix is not counted by Fix all.
    expect(screen.queryByTestId('fix-english-fix-all')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Add to team words' }));
    expect(onAddWord).toHaveBeenCalledWith('zxqvbn');
  });

  it('closes the card with Escape and when the pointer leaves', async () => {
    const { box } = setup();
    fireEvent.change(box, { target: { value: 'see you tommorow then ' } });
    await settle();
    everyMarkHit('tommorow');
    fireEvent.mouseMove(box, { clientX: 10, clientY: 10 });
    await screen.findByTestId('fix-english-card');
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByTestId('fix-english-card')).toBeNull();
    fireEvent.mouseMove(box, { clientX: 10, clientY: 10 });
    await screen.findByTestId('fix-english-card');
    vi.mocked(Element.prototype.getClientRects).mockReturnValue([] as unknown as DOMRectList);
    fireEvent.mouseMove(box, { clientX: 900, clientY: 900 });
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(screen.queryByTestId('fix-english-card')).toBeNull();
  });
});

describe('Composer Fix English: grammar', () => {
  it('asks the AI after a pause and marks its fixes', async () => {
    const text = 'Your order have been ready. ';
    vi.mocked(fetchGrammar).mockResolvedValue({
      status: 'checked',
      issues: [{ start: 11, end: 15, original: 'have', replacement: 'has' }],
    });
    const { box, user } = setup();
    fireEvent.change(box, { target: { value: text } });
    await act(() => vi.advanceTimersByTimeAsync(600));
    expect(fetchGrammar).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(fetchGrammar).toHaveBeenCalledWith(JID, text, expect.any(AbortSignal));
    await waitFor(() => expect(marked()).toEqual(['have']));
    expect(document.querySelector('[data-issue]')!.className).toContain('decoration-info');
    await user.click(screen.getByTestId('fix-english-fix-all'));
    expect(box.value).toBe('Your order has been ready. ');
  });

  it('drops grammar marks the teammate typed over, before the next check', async () => {
    const text = 'Your order have been ready. ';
    vi.mocked(fetchGrammar).mockResolvedValue({
      status: 'checked',
      issues: [{ start: 11, end: 15, original: 'have', replacement: 'has' }],
    });
    const { box } = setup();
    fireEvent.change(box, { target: { value: text } });
    await act(() => vi.advanceTimersByTimeAsync(800));
    await waitFor(() => expect(marked()).toEqual(['have']));
    fireEvent.change(box, { target: { value: 'Your parcel is ready. ' } });
    expect(marked()).toEqual([]);
    expect(screen.queryByTestId('fix-english-fix-all')).toBeNull();
    // A mark after the edit moves with the text.
    fireEvent.change(box, { target: { value: text } });
    await act(() => vi.advanceTimersByTimeAsync(800));
    await waitFor(() => expect(marked()).toEqual(['have']));
    fireEvent.change(box, { target: { value: `Hi! ${text}` } });
    expect(marked()).toEqual(['have']);
    expect(screen.getByTestId('fix-english-fix-all').textContent).toContain('Fix 1');
  });

  it('never offers the same insertion again after it was applied (no double full stop)', async () => {
    // The model answers each check on its own: here it adds a full stop every time.
    vi.mocked(fetchGrammar).mockImplementation(async (_jid, text) => {
      const at = text.indexOf('email');
      const original = text.slice(at).trimEnd();
      return {
        status: 'checked',
        issues: [{ start: at, end: at + original.length, original, replacement: `${original}.` }],
      };
    });
    const { box, user } = setup();
    fireEvent.change(box, { target: { value: 'Please check your email' } });
    await act(() => vi.advanceTimersByTimeAsync(800));
    await waitFor(() => expect(marked()).toEqual(['email']));
    await user.click(screen.getByTestId('fix-english-fix-all'));
    expect(box.value).toBe('Please check your email.');
    await act(() => vi.advanceTimersByTimeAsync(800));
    expect(fetchGrammar).toHaveBeenLastCalledWith(
      JID,
      'Please check your email.',
      expect.any(AbortSignal),
    );
    await settle();
    expect(marked()).toEqual([]);
    expect(screen.queryByTestId('fix-english-fix-all')).toBeNull();
    expect(box.value).toBe('Please check your email.');

    // Undo brings the draft back, and with it the fix.
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(box.value).toBe('Please check your email');
    await act(() => vi.advanceTimersByTimeAsync(800));
    await waitFor(() => expect(marked()).toEqual(['email']));
  });

  it('shows one mark when two fixes meet on one word, and applies it once', async () => {
    vi.mocked(fetchGrammar).mockResolvedValue({
      status: 'checked',
      issues: [
        { start: 13, end: 18, original: 'email', replacement: 'your email' },
        { start: 13, end: 18, original: 'email', replacement: 'email.' },
      ],
    });
    const { box, user } = setup();
    fireEvent.change(box, { target: { value: 'Please check email' } });
    await act(() => vi.advanceTimersByTimeAsync(800));
    await waitFor(() => expect(marked()).toEqual(['email']));
    const fixAll = screen.getByTestId('fix-english-fix-all');
    expect(fixAll.textContent).toContain('Fix 1');
    await user.click(fixAll);
    expect(box.value).toBe('Please check your email');
  });

  it('ignores an answer for text that is no longer in the box', async () => {
    let answer: (value: Awaited<ReturnType<typeof fetchGrammar>>) => void = () => undefined;
    vi.mocked(fetchGrammar).mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const { box } = setup();
    fireEvent.change(box, { target: { value: 'Your order have been ready. ' } });
    await act(() => vi.advanceTimersByTimeAsync(800));
    expect(fetchGrammar).toHaveBeenCalledTimes(1);
    fireEvent.change(box, { target: { value: 'Your order has been ready. ' } });
    await act(async () =>
      answer({
        status: 'checked',
        issues: [{ start: 11, end: 15, original: 'have', replacement: 'has' }],
      }),
    );
    expect(marked()).toEqual([]);
    expect(screen.queryByTestId('fix-english-fix-all')).toBeNull();
  });

  it('shows "No mistakes" when both checks find nothing', async () => {
    const { box } = setup();
    fireEvent.change(box, { target: { value: 'Your order is ready. ' } });
    await act(() => vi.advanceTimersByTimeAsync(800));
    expect(await screen.findByTestId('fix-english-clean')).toBeTruthy();
  });

  it('keeps spelling working when the grammar check is down', async () => {
    vi.mocked(fetchGrammar).mockRejectedValue(new Error('503'));
    const { box } = setup();
    fireEvent.change(box, { target: { value: 'see you tommorow then ' } });
    await act(() => vi.advanceTimersByTimeAsync(800));
    await settle();
    expect(await screen.findByTestId('fix-english-unavailable')).toBeTruthy();
    expect(marked()).toEqual(['tommorow']);
    expect(screen.getByTestId('fix-english-fix-all')).toBeTruthy();
  });

  it('never asks the AI without a connection (spelling only)', async () => {
    const { box } = setup({ status: { ...ON, connected: false, grammar: 'none' } });
    fireEvent.change(box, { target: { value: 'Your order is ready. ' } });
    await act(() => vi.advanceTimersByTimeAsync(800));
    expect(fetchGrammar).not.toHaveBeenCalled();
    expect(await screen.findByTestId('fix-english-clean')).toBeTruthy();
  });

  it('sends exactly what is in the box, marks or not', async () => {
    const { box, onSend } = setup();
    fireEvent.change(box, { target: { value: 'see you tommorow' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('see you tommorow'));
  });
});
