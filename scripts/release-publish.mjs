#!/usr/bin/env node
// Checks for the approved one-click release (docs/release.md §4, .github/workflows/release-approve.yml and the
// publish job of release.yml). Every check runs before a write and fails with a reason.
//
//   node scripts/release-publish.mjs version <x.y.z>                    the input is a plain release version
//   node scripts/release-publish.mjs draft <x.y.z> <release.json>       the draft is complete (6 installers + notes)
//
// release.json is `gh release view v<x.y.z> --json isDraft,body,assets`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PRESERVED_NOTE } from './release-notes.mjs';

const VERSION = /^\d+\.\d+\.\d+$/;

/** True for a plain `x.y.z` release version (no `v`, no pre-release, nothing a shell could read). */
export function isReleaseVersion(value) {
  return typeof value === 'string' && VERSION.test(value);
}

/** The six files release.yml uploads: each installer under its versioned name and as an unversioned copy. */
export function expectedInstallers(version) {
  const bases = ['win-x64.exe', 'mac-arm64.dmg', 'mac-x64.dmg'];
  return [
    ...bases.map((b) => `EzyChat-Lite-${version}-${b}`),
    ...bases.map((b) => `EzyChat-Lite-${b}`),
  ];
}

/** What is wrong with the draft release before publishing it; empty when it can be published. */
export function draftProblems(release, version) {
  const problems = [];
  if (!release || typeof release !== 'object') return ['no release found'];
  if (release.isDraft !== true) problems.push('the release is not a draft (already published?)');
  const assets = new Map((release.assets ?? []).map((a) => [a.name, a]));
  for (const name of expectedInstallers(version)) {
    const asset = assets.get(name);
    if (!asset) problems.push(`missing installer ${name}`);
    else if (typeof asset.size !== 'number' || asset.size <= 0)
      problems.push(`empty installer ${name}`);
    else if (asset.state && asset.state !== 'uploaded')
      problems.push(`installer ${name} is ${asset.state}`);
  }
  const body = typeof release.body === 'string' ? release.body.trim() : '';
  if (!body || body === PRESERVED_NOTE) problems.push('the release notes are empty');
  else if (!body.includes(PRESERVED_NOTE))
    problems.push('the release notes do not come from release-notes.mjs');
  return problems;
}

/** Runs one command; returns the exit code and writes reasons to `err`. */
export function main(
  argv,
  { read = (p) => readFileSync(p, 'utf8'), out = console.log, err = console.error } = {},
) {
  const [command, version, file] = argv;
  if (!isReleaseVersion(version)) {
    err(`not a release version (x.y.z): ${JSON.stringify(version ?? '')}`);
    return 2;
  }
  if (command === 'version') return 0;
  if (command === 'draft' && file) {
    let release;
    try {
      release = JSON.parse(read(file));
    } catch (error) {
      err(`cannot read ${file}: ${error.message}`);
      return 1;
    }
    const problems = draftProblems(release, version);
    for (const p of problems) err(`::error::v${version}: ${p}`);
    if (problems.length === 0)
      out(`v${version}: draft has ${expectedInstallers(version).length} installers and notes`);
    return problems.length === 0 ? 0 : 1;
  }
  err('usage: release-publish.mjs version <x.y.z> | draft <x.y.z> <release.json>');
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
