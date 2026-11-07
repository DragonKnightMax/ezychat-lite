#!/usr/bin/env node
// Report released installers on McAfee's "Dispute a Detection & Allowlisting" form, one file per report.
// Skill and rules: .claude/skills/submit-installers/SKILL.md
//
//   node scripts/mcafee-submit.mjs [--edition lite|enterprise|all] [--version 0.1.79]
//     [--only win,mac-arm64,mac-x64] [--dry-run] [--work <dir>]
//
// --dry-run does everything except clicking Submit. Every file is downloaded and checked before the first report
// goes out, and a report that went out is remembered in <work>/results.json, so a rerun does not send it twice.
// The reporter's details come only from REPORTER_FILE: its fields go to an outside form, so no argument can name
// another file.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { resolveTool } from './build-summary.mjs';

const FORM_URL =
  'https://www.mcafee.com/en-us/consumer-support/dispute-detection-allowlisting.html';
const LITE_REPO = 'ossmalaysia/ezychat-lite';
const ENTERPRISE_FEED = 'https://dl.ezychat.ai/enterprise';
const SIGNER = /CN="?Anchor Sprint Pte\. Ltd\./;
const REPORTER_FILE = join(homedir(), '.ezychat', 'mcafee-reporter.json');
const WINDOWS_POWERSHELL = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;

export const KINDS = {
  win: { suffix: 'win-x64.exe', label: 'Windows installer' },
  'mac-arm64': { suffix: 'mac-arm64.dmg', label: 'Mac installer for Apple silicon' },
  'mac-x64': { suffix: 'mac-x64.dmg', label: 'Mac installer for Intel' },
};

const PRODUCTS = {
  lite: { name: 'Lite', text: 'EzyChat Lite, an open-source WhatsApp team inbox for businesses.' },
  enterprise: {
    name: 'Enterprise',
    text: 'EzyChat Enterprise, a WhatsApp team inbox for businesses.',
  },
};

/** The three versioned installers of a release; the same files under permanent names are left out. */
export function pickAssets(edition, version, assets) {
  const { name } = PRODUCTS[edition];
  return Object.keys(KINDS).map((kind) => {
    const wanted = `EzyChat-${name}-${version}-${KINDS[kind].suffix}`;
    const asset = assets.find((a) => a.name === wanted);
    if (!asset) throw new Error(`release ${version} has no ${wanted}`);
    if (!/^[0-9a-f]{64}$/.test(asset.sha256 ?? '') || !(asset.size > 0))
      throw new Error(`${wanted} has no SHA-256 or size`);
    return { kind, ...asset };
  });
}

export function liteAssets(release) {
  return release.assets.map((a) => ({
    name: a.name,
    url: a.browser_download_url,
    size: a.size,
    sha256: (a.digest ?? '').replace(/^sha256:/, ''),
  }));
}

/** A version goes into URLs and folder names, so it is x.y.z and nothing else, also when a release feed supplies it. */
export function checkVersion(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version))
    throw new Error(`not a version: ${version}`);
  return version;
}

export function selectKinds(only) {
  if (!only) return Object.keys(KINDS);
  const kinds = only.split(',').map((k) => k.trim());
  for (const kind of kinds) if (!KINDS[kind]) throw new Error(`unknown file type: ${kind}`);
  return kinds;
}

/** Null when the file may be reported as signed; otherwise why not. */
export function signatureProblem(status, subject) {
  if (status !== 'Valid') return `signature status is ${status}`;
  if (!SIGNER.test(subject)) return `signed by someone else: ${subject}`;
  return null;
}

/** The report says only what was checked: a Windows file has a checked signature, a Mac report claims no signature. */
export function reportText({ edition, asset, zipName }) {
  const { label } = KINDS[asset.kind];
  const windows = asset.kind === 'win';
  return [
    windows
      ? 'Allowlist request: signed business software.'
      : 'Allowlist request: business software, Mac installer.',
    '',
    `This is the ${label} of a new release. We ask you to allowlist it, so that McAfee does not block it. ` +
      'McAfee already whitelisted an installer of the same publisher (EzyChat-Enterprise-0.1.26-win-x64.exe, your answer of 5 Nov 2026).',
    '',
    `Product: ${PRODUCTS[edition].text}`,
    windows
      ? 'Publisher / code signature: Anchor Sprint Pte. Ltd. (valid Authenticode signature).'
      : 'Publisher: Anchor Sprint Pte. Ltd.',
    '',
    ...(zipName
      ? [`Attached: ${zipName} (a ZIP with this one file, because the form does not accept .dmg)`]
      : []),
    `File: ${asset.name}`,
    `SHA-256: ${asset.sha256}`,
    `Size: ${asset.size} bytes`,
    `Download: ${asset.url}`,
    '',
    'Please whitelist this file.',
  ].join('\n');
}

export function checkReporter(reporter) {
  for (const field of ['fullName', 'email', 'company']) {
    if (typeof reporter[field] !== 'string' || !reporter[field].trim())
      throw new Error(`reporter file has no ${field}`);
  }
  return reporter;
}

async function loadRelease(edition, version) {
  if (edition === 'lite') {
    const path = version ? `tags/v${version}` : 'latest';
    const release = JSON.parse(
      execFileSync(resolveTool('gh'), ['api', `repos/${LITE_REPO}/releases/${path}`], {
        encoding: 'utf8',
        maxBuffer: 2 ** 26,
      }),
    );
    const found = checkVersion(release.tag_name.replace(/^v/, ''));
    return { version: found, assets: pickAssets(edition, found, liteAssets(release)) };
  }
  const url = version
    ? `${ENTERPRISE_FEED}/v${version}/latest.json`
    : `${ENTERPRISE_FEED}/latest.json`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const feed = await response.json();
  const found = checkVersion(feed.version);
  return { version: found, assets: pickAssets(edition, found, feed.assets) };
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function matches(file, asset) {
  return (
    existsSync(file) && statSync(file).size === asset.size && (await sha256(file)) === asset.sha256
  );
}

async function download(asset, dir) {
  const file = join(dir, asset.name);
  if (await matches(file, asset)) return file;
  const response = await fetch(asset.url);
  if (!response.ok) throw new Error(`${asset.url} answered ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
  if (!(await matches(file, asset)))
    throw new Error(`${asset.name}: the download differs from the release's SHA-256 or size`);
  return file;
}

/** PowerShell 7 passes on its own PSModulePath, and Windows PowerShell then cannot load its signature and archive commands. */
export function powershellEnv(parent, env) {
  const result = { ...parent, ...env };
  for (const name of Object.keys(result)) {
    if (name.toLowerCase() === 'psmodulepath') delete result[name];
  }
  return result;
}

// Windows PowerShell only reads the file; the path goes through the environment, never into the command text.
function powershell(command, env) {
  return execFileSync(WINDOWS_POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    env: powershellEnv(process.env, env),
  }).trim();
}

function checkSignature(file) {
  const [status, subject] = powershell(
    '$s = Get-AuthenticodeSignature -LiteralPath $env:TARGET_FILE; "$($s.Status)|$($s.SignerCertificate.Subject)"',
    { TARGET_FILE: file },
  ).split('|');
  const problem = signatureProblem(status, subject ?? '');
  if (problem) throw new Error(`${basename(file)}: ${problem}`);
}

function zipFile(file) {
  const zip = `${file}.zip`;
  if (existsSync(zip)) return zip;
  const partial = `${file}.partial.zip`;
  powershell(
    'Compress-Archive -LiteralPath $env:TARGET_FILE -DestinationPath $env:ZIP_FILE -Force',
    {
      TARGET_FILE: file,
      ZIP_FILE: partial,
    },
  );
  renameSync(partial, zip);
  return zip;
}

/** One report in its own Chrome window. Returns true when the page confirms it, or after a dry run's checks. */
async function submitOne(browser, { attach, details, reporter, out, dryRun }) {
  mkdirSync(out, { recursive: true });
  const size = statSync(attach).size;
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(FORM_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.locator('#fullName').waitFor({ timeout: 60_000 });
    await page.locator('#fullName').fill(reporter.fullName);
    await page.locator('#emailAddress').fill(reporter.email);
    await page.locator('#companyName').fill(reporter.company);
    await page.locator('#details').fill(details);
    const input = page.locator('input[type=file][name=files]');
    await input.setInputFiles(attach);

    const attached = await input.evaluate((i) => [...i.files].map((f) => [f.name, f.size]));
    if (attached.length !== 1 || attached[0][0] !== basename(attach) || attached[0][1] !== size) {
      throw new Error(`the form did not attach the file: ${JSON.stringify(attached)}`);
    }
    // A captcha is for the owner to solve: never work around one.
    if (await page.locator('[class*=captcha],[id*=captcha],iframe[src*=captcha]').count()) {
      throw new Error('the page shows a captcha: ask the owner');
    }
    await page.screenshot({ path: join(out, 'before.png'), fullPage: true });
    if (dryRun) return true;

    await page.locator('#submitButton').click({ timeout: 30_000 });
    const done = page.getByText('The form has been submitted', { exact: false }).first();
    const refused = page.getByText('Invalid File Extension', { exact: false }).first();
    const answer = await Promise.race([
      done.waitFor({ state: 'visible', timeout: 480_000 }).then(() => 'done'),
      refused.waitFor({ state: 'visible', timeout: 480_000 }).then(() => 'refused'),
    ]);
    if (answer === 'refused') throw new Error('the form refused the file: Invalid File Extension');
    return true;
  } finally {
    await page.screenshot({ path: join(out, 'after.png'), fullPage: true }).catch(() => {});
    await page.close();
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      edition: { type: 'string', default: 'all' },
      version: { type: 'string' },
      only: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      work: { type: 'string', default: join(tmpdir(), 'ezychat-mcafee') },
    },
  });
  const editions = values.edition === 'all' ? ['lite', 'enterprise'] : [values.edition];
  if (!editions.every((e) => PRODUCTS[e])) throw new Error(`unknown edition: ${values.edition}`);
  if (values.version && editions.length > 1)
    throw new Error(
      '--version needs --edition lite or enterprise: the two have different versions',
    );
  if (values.version) checkVersion(values.version);
  const kinds = selectKinds(values.only);
  const reporter = checkReporter(JSON.parse(readFileSync(REPORTER_FILE, 'utf8')));
  const dryRun = values['dry-run'];

  // Prepare everything first: a bad file then stops the run before any report goes out.
  const jobs = [];
  for (const edition of editions) {
    const release = await loadRelease(edition, values.version);
    const dir = join(values.work, `${edition}-${release.version}`);
    mkdirSync(dir, { recursive: true });
    for (const asset of release.assets.filter((a) => kinds.includes(a.kind))) {
      const file = await download(asset, dir);
      if (asset.kind === 'win') checkSignature(file);
      const attach = asset.kind === 'win' ? file : zipFile(file);
      const zipName = attach === file ? undefined : basename(attach);
      jobs.push({
        edition,
        version: release.version,
        asset,
        attach,
        dir,
        details: reportText({ edition, asset, zipName }),
      });
      console.log(`ready ${asset.name} sha256=${asset.sha256}`);
    }
  }

  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  try {
    for (const job of jobs) {
      const resultsFile = join(job.dir, 'results.json');
      const results = existsSync(resultsFile) ? JSON.parse(readFileSync(resultsFile, 'utf8')) : {};
      if (results[job.asset.sha256] && !dryRun) {
        console.log(
          `SKIPPED ${job.asset.name}: submitted ${results[job.asset.sha256].submittedAt}`,
        );
        continue;
      }
      const started = Date.now();
      const out = join(job.dir, dryRun ? 'dry-run' : 'submit', job.asset.kind);
      await submitOne(browser, { attach: job.attach, details: job.details, reporter, out, dryRun });
      const seconds = Math.round((Date.now() - started) / 1000);
      if (dryRun) {
        console.log(
          `DRY RUN ok ${job.asset.name}: form filled and file attached, not submitted (${seconds} s). Screenshots: ${out}`,
        );
        continue;
      }
      results[job.asset.sha256] = { file: job.asset.name, submittedAt: new Date().toISOString() };
      writeFileSync(resultsFile, JSON.stringify(results, null, 2));
      console.log(`SUBMITTED ${job.asset.name} (${seconds} s). Screenshots: ${out}`);
    }
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`STOPPED ${error.message}`);
    process.exit(1);
  });
}
