/**
 * THE repository boundary of the GitHub connector (design "Rules" 1; spike Q4: a user token reads
 * any public repository, so nothing else keeps the AI to its repos). Every search query is rebuilt
 * here: the AI's words lose every qualifier, operator, quote and bracket, and the server adds one
 * `repo:` per allowed repository plus `is:issue` / `is:pr`. Every other call names a repo checked
 * with `allowedRepo`.
 */

/** Characters of the AI's search words kept (GitHub allows 256 without qualifiers). */
export const SEARCH_WORDS_CHARACTERS = 200;
/** Characters of a label filter. */
export const LABEL_CHARACTERS = 50;
/** A GitHub login (`dependabot[bot]` included). */
export const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;

// Fail closed: any word with a colon may be a qualifier (`repo:`, `-REPO:`, `+org:`), except a
// time or number such as 10:30.
const isQualifier = (word: string) => word.includes(':') && !/^[\d:.]+$/.test(word);
// Boolean operators: removed so the AI's words can never be OR-ed with the server's qualifiers.
const OPERATOR = /^(?:OR|AND|NOT)$/i;

/**
 * The AI's search words without anything GitHub's search syntax would read: no qualifiers (repo:,
 * org:, user:, owner:, is:, type:, in:, …), no OR/AND/NOT, no quotes, brackets or backslashes.
 * At most SEARCH_WORDS_CHARACTERS, cut at a word.
 */
export function searchWords(text: string): string {
  const words = text
    .normalize('NFKC')
    .replace(/["'`()\\[\]{}]/g, ' ')
    .split(/\s+/)
    .filter((word) => word && !isQualifier(word) && !OPERATOR.test(word))
    // A lone '-' (or one before a word) would exclude: keep only the word.
    .map((word) => word.replace(/^-+/, ''))
    .filter(Boolean);
  let out = '';
  for (const word of words) {
    const next = out ? `${out} ${word}` : word;
    if (next.length > SEARCH_WORDS_CHARACTERS) break;
    out = next;
  }
  return out;
}

/** A label for `label:"…"`: no quotes or backslashes, at most LABEL_CHARACTERS; null when empty. */
export function cleanLabel(label: string | undefined): string | null {
  const clean = (label ?? '')
    .normalize('NFKC')
    .replace(/["\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LABEL_CHARACTERS)
    .trim();
  return clean || null;
}

/**
 * The label as a search filter, or null. A label with a colon ("type: bug") is left out of the
 * query (fail closed: nothing with a colon reaches GitHub's search syntax); the tool filters the
 * results by it instead.
 */
export function searchLabel(label: string | undefined): string | null {
  const clean = cleanLabel(label);
  return clean && !clean.includes(':') ? clean : null;
}

export type SearchKind = 'issue' | 'pr';
export type SearchState = 'open' | 'closed' | 'merged';

/**
 * The full search query: the cleaned words, `repo:` for each allowed repo, the kind, and the
 * filters the server checked. `repos` must already be the agent's allowed and still-shared repos.
 */
export function buildSearchQuery(input: {
  words: string;
  repos: readonly string[];
  kind: SearchKind;
  state?: SearchState;
  label?: string;
  author?: string;
}): string {
  if (!input.repos.length) throw new Error('no repositories to search');
  const parts: string[] = [];
  const words = searchWords(input.words);
  if (words) parts.push(words);
  for (const repo of input.repos) parts.push(`repo:${repo}`);
  parts.push(input.kind === 'pr' ? 'is:pr' : 'is:issue');
  if (input.state === 'merged') parts.push(input.kind === 'pr' ? 'is:merged' : 'state:closed');
  else if (input.state) parts.push(`state:${input.state}`);
  const label = searchLabel(input.label);
  if (label) parts.push(`label:"${label}"`);
  if (input.author && GITHUB_LOGIN.test(input.author)) parts.push(`author:${input.author}`);
  return parts.join(' ');
}

/** The allowed repo the AI named (owner/name, any case), else null. */
export function allowedRepo<T extends { fullName: string }>(
  name: string | undefined,
  allowed: readonly T[],
): T | null {
  const wanted = (name ?? '').trim().toLowerCase();
  if (!wanted) return null;
  return allowed.find((repo) => repo.fullName.toLowerCase() === wanted) ?? null;
}

/** `owner/name` from an API url `https://api.github.com/repos/owner/name`, else null. */
export function repoOfApiUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const found = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)$/.exec(url);
  return found ? found[1]! : null;
}
