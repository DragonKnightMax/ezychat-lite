import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  FixEnglishButton,
  FixEnglishCard,
  applyFixes,
  grammarMarks,
  insertedText,
  shiftIssues,
  type FixIssue,
} from './FixEnglish';

afterEach(cleanup);

const issue = (over: Partial<FixIssue> = {}): FixIssue => ({
  id: 'g4:the ',
  kind: 'grammar',
  start: 4,
  end: 8,
  original: 'the ',
  suggestions: [''],
  replacement: '',
  ...over,
});

describe('shiftIssues', () => {
  const marks = [
    { start: 0, end: 3 },
    { start: 8, end: 12 },
  ];
  it('moves marks after an edit and drops the one it touched', () => {
    expect(shiftIssues(marks, 'abc def ghij', 'abc defXX ghij')).toEqual([
      { start: 0, end: 3 },
      { start: 10, end: 14 },
    ]);
    expect(shiftIssues(marks, 'abc def ghij', 'abX def ghij')).toEqual([{ start: 8, end: 12 }]);
    expect(shiftIssues(marks, 'same', 'same')).toBe(marks);
  });
});

describe('applyFixes', () => {
  it('applies fixes from the end and skips a mark whose text changed', () => {
    const text = 'the the order';
    expect(applyFixes(text, [issue({ start: 0, end: 4 })])).toBe('the order');
    expect(applyFixes(text, [issue({ start: 0, end: 4, original: 'xyz ' })])).toBe(text);
    expect(applyFixes('teh cat', [issue({ start: 0, end: 3, original: 'teh' })], 'the')).toBe(
      'the cat',
    );
    expect(
      applyFixes('teh cat', [issue({ start: 0, end: 3, original: 'teh', replacement: null })]),
    ).toBe('teh cat');
  });
});

describe('insertedText', () => {
  it('names what a fix only inserts, and nothing for any other change', () => {
    expect(insertedText('email', 'email.')).toBe('.');
    expect(insertedText('email', 'your email')).toBe('your ');
    expect(insertedText('we', '. We')).toBe('');
    expect(insertedText('have', 'has')).toBe('');
    expect(insertedText('the ', '')).toBe('');
  });
});

describe('grammarMarks', () => {
  const g = (start: number, original: string, replacement: string) => ({
    start,
    end: start + original.length,
    original,
    replacement,
  });
  it('keeps one mark per piece of text, in order, with an id per range', () => {
    const marks = grammarMarks(
      [g(13, 'email', 'email.'), g(13, 'email', 'your email'), g(0, 'pls', 'Please')],
      [],
    );
    expect(marks.map((m) => [m.id, m.replacement])).toEqual([
      ['g0:3:pls', 'Please'],
      ['g13:18:email', 'email.'],
    ]);
  });
  it('never offers again an insertion this draft already got at that place', () => {
    const applied = [{ start: 13, end: 19, inserted: '.' }];
    expect(grammarMarks([g(13, 'email.', 'email..')], applied)).toEqual([]);
    // A different change there, or the same insertion elsewhere, is still offered.
    expect(grammarMarks([g(13, 'email.', 'emails.')], applied)).toHaveLength(1);
    expect(grammarMarks([g(30, 'soon', 'soon.')], applied)).toHaveLength(1);
  });
});

describe('FixEnglishCard', () => {
  const props = {
    position: { left: 0, bottom: 0 },
    touch: true,
    onPick: vi.fn(),
    onIgnore: vi.fn(),
    onAddWord: vi.fn(),
    onClose: vi.fn(),
    onHover: vi.fn(),
  };

  it('labels a removal "Remove" and shows a close button on touch', async () => {
    render(<FixEnglishCard issue={issue()} {...props} />);
    expect(screen.getByTestId('fix-english-card').textContent).toContain('Grammar');
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(props.onPick).toHaveBeenCalledWith('');
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(props.onClose).toHaveBeenCalled();
  });

  it('stays inside the screen when the word is near an edge', () => {
    const { rerender } = render(
      <FixEnglishCard issue={issue()} {...props} position={{ left: 5000, bottom: 40 }} />,
    );
    const card = screen.getByTestId('fix-english-card');
    // jsdom: the card has no width, so the room on a 1024 px window ends at 1016 px.
    expect(card.style.left).toBe(`${window.innerWidth - 8}px`);
    expect(card.style.bottom).toBe('40px');
    rerender(<FixEnglishCard issue={issue()} {...props} position={{ left: -20, bottom: 40 }} />);
    expect(screen.getByTestId('fix-english-card').style.left).toBe('8px');
  });

  it('shows up to three spelling choices, and a spinner while they load', () => {
    const spelling = issue({
      kind: 'spelling',
      original: 'wich',
      suggestions: ['which', 'with', 'rich'],
      replacement: null,
    });
    const { rerender } = render(<FixEnglishCard issue={spelling} {...props} />);
    expect(screen.getAllByTestId('fix-english-pick').map((b) => b.textContent)).toEqual([
      'which',
      'with',
      'rich',
    ]);
    rerender(<FixEnglishCard issue={{ ...spelling, suggestions: [], pending: true }} {...props} />);
    expect(screen.queryByTestId('fix-english-pick')).toBeNull();
    expect(screen.getByLabelText('Looking for suggestions')).toBeTruthy();
    expect(screen.queryByTestId('fix-english-add-word')).toBeNull();
  });
});

describe('FixEnglishButton', () => {
  const base = {
    count: 0,
    marks: 0,
    grammar: 'on' as const,
    touch: false,
    undo: null,
    onFixAll: vi.fn(),
    onUndo: vi.fn(),
  };
  it('shows the checking spinner while grammar runs', () => {
    render(<FixEnglishButton {...base} grammarStatus="checking" />);
    expect(screen.getByTestId('fix-english-checking')).toBeTruthy();
  });

  it('says when grammar is unavailable, and nothing more while marks have no fix', () => {
    render(<FixEnglishButton {...base} marks={1} grammar="unavailable" grammarStatus="idle" />);
    expect(screen.getByTestId('fix-english-unavailable').textContent).toContain(
      'Grammar check unavailable',
    );
    expect(screen.queryByTestId('fix-english-clean')).toBeNull();
  });

  it('shows Fix N with the shortcut on desktop and a large button on touch', () => {
    const { rerender } = render(<FixEnglishButton {...base} count={2} grammarStatus="done" />);
    expect(screen.getByTestId('fix-english-fix-all').textContent).toBe('Fix 2Ctrl J');
    rerender(<FixEnglishButton {...base} count={2} touch grammarStatus="done" />);
    expect(screen.getByTestId('fix-english-fix-all').textContent).toBe('Fix 2');
  });
});
