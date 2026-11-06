export type DiffLine = { type: 'same' | 'add' | 'del'; text: string };
/** Unchanged lines folded away in a review ("⋯ 12 unchanged lines"). */
export type DiffSkip = { type: 'skip'; count: number };

/**
 * A review-sized diff: each change keeps `context` unchanged lines around it; longer unchanged runs
 * fold into one skip entry. A single unchanged line is shown rather than folded.
 */
export function collapseDiff(lines: DiffLine[], context = 1): Array<DiffLine | DiffSkip> {
  const near = lines.map((_, index) =>
    lines
      .slice(Math.max(0, index - context), index + context + 1)
      .some((line) => line.type !== 'same'),
  );
  const out: Array<DiffLine | DiffSkip> = [];
  let run: DiffLine[] = [];
  const flush = () => {
    if (run.length === 1) out.push(run[0]!);
    else if (run.length > 1) out.push({ type: 'skip', count: run.length });
    run = [];
  };
  lines.forEach((line, index) => {
    if (line.type === 'same' && !near[index]) {
      run.push(line);
      return;
    }
    flush();
    out.push(line);
  });
  flush();
  return out;
}

/** Lines of a text; a trailing newline does not add an empty last line, and '' has no lines. */
function linesOf(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/**
 * Most line pairs compared one by one (the comparison table holds one number per pair, so this
 * bounds it at ~8 MB). Larger changed middles show as one block out, then one block in.
 */
export const DIFF_MAX_LINE_PAIRS = 1_000_000;

/**
 * A line diff of `before` → `after`: shared first and last lines are kept as they are, and the
 * changed middle is compared line by line (longest common subsequence) when small enough. In each
 * changed block the removed lines come before the added ones, so a rewritten line reads "old, then
 * new".
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const all = { a: linesOf(before), b: linesOf(after) };
  let start = 0;
  while (start < all.a.length && start < all.b.length && all.a[start] === all.b[start]) start++;
  let end = 0;
  while (
    end < all.a.length - start &&
    end < all.b.length - start &&
    all.a[all.a.length - 1 - end] === all.b[all.b.length - 1 - end]
  )
    end++;
  const same = (text: string): DiffLine => ({ type: 'same', text });
  const head = all.a.slice(0, start).map(same);
  const tail = all.a.slice(all.a.length - end).map(same);
  const a = all.a.slice(start, all.a.length - end);
  const b = all.b.slice(start, all.b.length - end);
  if (a.length * b.length > DIFF_MAX_LINE_PAIRS)
    return [
      ...head,
      ...a.map((text): DiffLine => ({ type: 'del', text })),
      ...b.map((text): DiffLine => ({ type: 'add', text })),
      ...tail,
    ];
  return [...head, ...middleDiff(a, b), ...tail];
}

/** Longest-common-subsequence diff of two (small) line lists. */
function middleDiff(a: string[], b: string[]): DiffLine[] {
  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:].
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = () => {
    out.push(...dels, ...adds);
    dels = [];
    adds = [];
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      flush();
      out.push({ type: 'same', text: a[i]! });
      i++;
      j++;
    } else if (j >= b.length || (i < a.length && lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      dels.push({ type: 'del', text: a[i]! });
      i++;
    } else {
      adds.push({ type: 'add', text: b[j]! });
      j++;
    }
  }
  flush();
  return out;
}
