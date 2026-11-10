import { describe, expect, it } from 'vitest';
import {
  SEARCH_WORDS_CHARACTERS,
  allowedRepo,
  buildSearchQuery,
  cleanLabel,
  repoOfApiUrl,
  searchLabel,
  searchWords,
} from './query.js';

const ALLOWED = ['acme/helpdesk', 'acme/website'];
const build = (words: string, extra: Partial<Parameters<typeof buildSearchQuery>[0]> = {}) =>
  buildSearchQuery({ words, repos: ALLOWED, kind: 'issue', ...extra });

/** Every repo: qualifier of a built query. */
const reposOf = (q: string) => [...q.matchAll(/(?:^|\s)repo:(\S+)/g)].map((m) => m[1]);

describe('GitHub search query', () => {
  it('keeps the words and adds the allowed repos and the kind', () => {
    expect(build('login fails')).toBe('login fails repo:acme/helpdesk repo:acme/website is:issue');
    expect(build('login', { kind: 'pr', state: 'merged', author: 'dev-amir' })).toBe(
      'login repo:acme/helpdesk repo:acme/website is:pr is:merged author:dev-amir',
    );
    expect(build('x', { state: 'closed', label: 'good first issue' })).toBe(
      'x repo:acme/helpdesk repo:acme/website is:issue state:closed label:"good first issue"',
    );
    // Merged has no meaning for issues: closed.
    expect(build('x', { state: 'merged' })).toContain('state:closed');
    expect(() => buildSearchQuery({ words: 'x', repos: [], kind: 'issue' })).toThrow();
  });

  it.each([
    'foo repo:evil/x',
    'foo "repo:evil/x"',
    'foo REPO:evil/x',
    'foo Repo:Evil/X',
    'foo -repo:acme/helpdesk',
    'foo +repo:evil/x',
    'foo repo:"evil/x"',
    'foo repo：evil/x', // full-width colon (NFKC makes it ':')
    'foo org:evil',
    'foo user:evil',
    'foo owner:evil',
    'foo is:pr',
    'foo is:issue',
    'foo is:public',
    'foo type:pr',
    'foo in:title',
    'foo (repo:evil/x)',
    'foo OR repo:evil/x',
    'foo or bar OR (baz AND NOT qux)',
    'foo "bar repo:evil/x"',
    "foo 'repo:evil/x'",
    'foo \\"repo:evil/x\\"',
    'foo repo:evil/x repo:evil/y org:evil user:evil',
  ])('never lets the words reach another repository: %s', (words) => {
    const q = build(words);
    expect(reposOf(q)).toEqual(ALLOWED);
    // Only the server's qualifiers have a colon.
    expect(q.split(' ').filter((w) => w.includes(':'))).toEqual([
      'repo:acme/helpdesk',
      'repo:acme/website',
      'is:issue',
    ]);
    expect(q).not.toMatch(/\b(?:OR|AND|NOT)\b/);
    expect(q).not.toMatch(/[()"\\]/);
    expect(q).not.toMatch(/(?:^|\s)(?:org|user|owner|type|in):/i);
    // The kind is the server's only.
    expect(q.match(/is:\S+/g)).toEqual(['is:issue']);
    expect(q.startsWith('foo')).toBe(true);
  });

  it('keeps times and numbers, and drops a leading minus', () => {
    expect(searchWords('error at 10:30 on v2.1 -beta - x')).toBe('error at 10:30 on v2.1 beta x');
    expect(searchWords('   ')).toBe('');
    // Only qualifiers: the query is the repos and the kind.
    expect(build('repo:evil/x is:pr')).toBe('repo:acme/helpdesk repo:acme/website is:issue');
  });

  it('cuts very long words at a word, below the cap', () => {
    const long = `${'word '.repeat(500)}repo:evil/x`;
    const words = searchWords(long);
    expect(words.length).toBeLessThanOrEqual(SEARCH_WORDS_CHARACTERS);
    expect(words.endsWith('word')).toBe(true);
    expect(searchWords('x'.repeat(5000))).toBe('');
    expect(reposOf(build(long))).toEqual(ALLOWED);
  });

  it('cleans labels and refuses odd authors', () => {
    expect(cleanLabel('  bug" repo:evil/x \\ ')).toBe('bug repo:evil/x');
    // A label with a colon never reaches the query (the tool filters by it instead).
    expect(build('x', { label: 'a" repo:evil/x "b' })).toBe(
      'x repo:acme/helpdesk repo:acme/website is:issue',
    );
    expect(searchLabel('type: bug')).toBeNull();
    expect(searchLabel('bug')).toBe('bug');
    expect(cleanLabel('')).toBeNull();
    expect(cleanLabel(undefined)).toBeNull();
    expect(cleanLabel('x'.repeat(80))).toHaveLength(50);
    expect(build('x', { kind: 'pr', author: 'evil repo:evil/x' })).not.toContain('author:');
    expect(build('x', { kind: 'pr', author: 'dependabot[bot]' })).toContain(
      'author:dependabot[bot]',
    );
  });

  it('matches a named repo only from the allowed list', () => {
    const allowed = [{ fullName: 'acme/helpdesk', id: 1 }];
    expect(allowedRepo('ACME/Helpdesk', allowed)).toEqual(allowed[0]);
    expect(allowedRepo(' acme/helpdesk ', allowed)).toEqual(allowed[0]);
    expect(allowedRepo('octo/public-tools', allowed)).toBeNull();
    expect(allowedRepo('acme/helpdesk/../x', allowed)).toBeNull();
    expect(allowedRepo('', allowed)).toBeNull();
    expect(allowedRepo(undefined, allowed)).toBeNull();
  });

  it('reads the repo of an API url', () => {
    expect(repoOfApiUrl('https://api.github.com/repos/acme/helpdesk')).toBe('acme/helpdesk');
    expect(repoOfApiUrl('https://evil.example/repos/acme/helpdesk')).toBeNull();
    expect(repoOfApiUrl(42)).toBeNull();
  });
});
