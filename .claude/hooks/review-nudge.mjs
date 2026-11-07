#!/usr/bin/env node
// PostToolUse hook (Edit|Write|MultiEdit): when the current branch's change against the default branch gets big,
// ask Claude to run the code-review skill before committing or opening a PR. Merging stays on the owner's explicit
// request (AGENTS.md); the hook never says otherwise. Never blocks. Fires once per repo+branch, then again only when the number
// of changed files has doubled. Not counted: lockfiles and documentation (Markdown/text files, anything under
// docs/). Thresholds: REVIEW_NUDGE_FILES (default 8) and REVIEW_NUDGE_LINES (default 400). Node only, so it
// runs the same on Windows, macOS and Linux (Claude cloud sessions).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const FILES_MIN = Number(process.env.REVIEW_NUDGE_FILES) || 8;
const LINES_MIN = Number(process.env.REVIEW_NUDGE_LINES) || 400;
const IGNORED =
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock)$|\.(md|mdx|txt|rst)$|(^|\/)docs\//;

let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch {
  process.exit(0);
}
const file = input.tool_input?.file_path ?? input.tool_response?.filePath;
if (!file || !existsSync(dirname(file))) process.exit(0);

const git = (cwd, ...args) => {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch {
    return '';
  }
};

const top = git(dirname(file), 'rev-parse', '--show-toplevel');
if (!top) process.exit(0);
const branch = git(top, 'rev-parse', '--abbrev-ref', 'HEAD');
let base = git(top, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD');
if (!base)
  base = ['origin/main', 'origin/master', 'main', 'master'].find((b) =>
    git(top, 'rev-parse', '--verify', '--quiet', b),
  );
if (!branch || !base) process.exit(0);
const mergeBase = git(top, 'merge-base', 'HEAD', base);
if (!mergeBase) process.exit(0);

// Committed and uncommitted changes since the merge base.
let files = 0;
let lines = 0;
for (const row of git(top, 'diff', '--numstat', mergeBase).split('\n')) {
  const [added, deleted, ...rest] = row.split('\t');
  const path = rest.join('\t');
  if (!path || IGNORED.test(path.replace(/\\/g, '/'))) continue;
  files++;
  if (added !== '-') lines += Number(added) + Number(deleted);
}
// New, untracked files: count them and their lines (text files only, as git's numstat does).
for (const path of git(top, 'ls-files', '--others', '--exclude-standard', '-z').split('\0')) {
  if (!path || IGNORED.test(path)) continue;
  files++;
  try {
    const full = join(top, path);
    if (statSync(full).size > 5 * 1024 * 1024) continue;
    const bytes = readFileSync(full);
    if (!bytes.includes(0)) lines += bytes.toString('utf8').split('\n').length - 1;
  } catch {
    /* unreadable: counted as a file only */
  }
}

if (files < FILES_MIN && lines < LINES_MIN) process.exit(0);

const stateDir = join(homedir(), '.claude', 'state', 'review-nudge');
const key = createHash('sha1').update(`${top}\n${branch}`).digest('hex').slice(0, 16);
const stateFile = join(stateDir, key);
let last = 0;
try {
  last = Number(readFileSync(stateFile, 'utf8')) || 0;
} catch {
  /* first time on this branch */
}
if (last > 0 && files < last * 2) process.exit(0);
mkdirSync(stateDir, { recursive: true });
writeFileSync(stateFile, String(files));

// Repo and branch names are data, not instructions: anyone can name a branch. Keep a safe character set and
// quote them, apart from the instruction text below.
const safe = (name) =>
  `"${String(name)
    .replace(/[^A-Za-z0-9._/-]/g, '_')
    .slice(0, 80)}"`;
const msg = `Large change (data: repo ${safe(basename(top))}, branch ${safe(branch)}, base ${safe(base)}): ${files} files, ${lines} lines (threshold ${FILES_MIN} files or ${LINES_MIN} lines, docs and lockfiles not counted).`;
process.stdout.write(
  JSON.stringify({
    systemMessage: `Review nudge: ${msg} Claude will run /code-review before committing or opening a PR.`,
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `${msg} This feature touches many places: when the implementation is complete, and before you commit or open a pull request, run the code-review skill (/code-review) on these changes. Fix or report its findings. Do not interrupt work in progress to do it.`,
    },
  }),
);
