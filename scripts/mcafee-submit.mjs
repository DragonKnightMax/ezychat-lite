#!/usr/bin/env node
// Report released installers on McAfee's "Dispute a Detection & Allowlisting" form, one file per report.
// Skill and rules: .claude/skills/submit-installers/SKILL.md
//
//   node scripts/mcafee-submit.mjs [--edition lite|enterprise|all] [--version 0.1.79]
//     [--only win,mac-arm64,mac-x64] [--dry-run] [--work <dir>]
//   node scripts/mcafee-submit.mjs --edition enterprise --run <Installers run id>   (before publishing)
//
// --dry-run does everything except clicking Submit. Every file is downloaded and checked before the first report
// goes out, and a report that went out is remembered in <work>/results.json, so a rerun does not send it twice.
// The reporter's details come only from REPORTER_FILE: its fields go to an outside form, so no argument can name
// another file.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { resolveTool } from './build-summary.mjs';

const FORM_URL =
  'https://www.mcafee.com/en-us/consumer-support/dispute-detection-allowlisting.html';
const LITE_REPO = 'ossmalaysia/ezychat-lite';
const ENTERPRISE_FEED = 'https://dl.ezychat.ai/enterprise';
const SIGNER = /CN="?Anchor Sprint Pte\. Ltd\./;
const MAC_SIGNER = 'Developer ID Application: Anchor Sprint Pte. Ltd. (4N9HTT975Q)';
const REPORTER_FILE = join(homedir(), '.ezychat', 'mcafee-reporter.json');
// System tools by fixed path, never through PATH. osslsigncode comes from Homebrew (Apple silicon or Intel).
const ZIP = '/usr/bin/zip';
const HDIUTIL = '/usr/bin/hdiutil';
const CODESIGN = '/usr/bin/codesign';
const SPCTL = '/usr/sbin/spctl';
const XCRUN = '/usr/bin/xcrun';
const OSSLSIGNCODE = ['/opt/homebrew/bin/osslsigncode', '/usr/local/bin/osslsigncode'];
const WINDOWS_POWERSHELL = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
// Microsoft's code-signing root (Artifact Signing and its timestamps chain to it), public, from
// microsoft.com/pkiops; SHA-256 fingerprint 53:67:F2:0C:7A:DE:0E:2B:CA:79:09:15:05:6D:08:6B:72:0C:33:C1:FA:2A:26:61:AC:F7:87:E3:29:2E:12:70.
// Windows trusts it already; osslsigncode on a Mac needs it next to the system list.
const MICROSOFT_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  'certs',
  'microsoft-identity-verification-root-2020.pem',
);

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
    // A draft's files are not public yet: they download through the API with the owner's gh login.
    apiUrl: release.draft ? a.url : undefined,
    size: a.size,
    sha256: (a.digest ?? '').replace(/^sha256:/, ''),
  }));
}

/**
 * The release of a tag from GitHub's release list, a draft included (`releases/tags/` does not find drafts): report the
 * installers before the release is published, so the files users get are the ones McAfee checked.
 */
export function releaseOfTag(releases, version) {
  const release = releases.find((r) => r.tag_name === `v${version}`);
  if (!release) throw new Error(`no release or draft for v${version}`);
  return release;
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

/**
 * Status and signer subject from `osslsigncode verify` output, in the terms of Get-AuthenticodeSignature: Valid only
 * when it ended with "Succeeded" (signature and timestamp chain verified). The signer is the first Subject after
 * "Signer #0" (the timestamp signer comes later).
 */
export function osslsigncodeStatus(output, exitCode) {
  const ok = exitCode === 0 && /^Succeeded\s*$/m.test(output);
  const lines = output.split('\n').map((line) => line.trim());
  const signer = lines.indexOf('Signer #0:');
  const next = signer === -1 ? '' : (lines[signer + 1] ?? '');
  const subject = next.startsWith('Subject:') ? next.slice('Subject:'.length).trim() : '';
  return { status: ok ? 'Valid' : 'NotValid', subject };
}

/** Null when the file may be reported as signed; otherwise why not. */
export function signatureProblem(status, subject) {
  if (status !== 'Valid') return `signature status is ${status}`;
  if (!SIGNER.test(subject)) return `signed by someone else: ${subject}`;
  return null;
}

/**
 * Null when the app inside a Mac installer may be reported as signed and notarized; otherwise why not.
 * `codesign` is the output of `codesign -dvv`, `spctl` of `spctl --assess --type execute -vv`.
 */
export function macSignatureProblem({ codesign, spctl, stapled }) {
  if (!codesign.includes(`Authority=${MAC_SIGNER}`)) return 'not signed with our Developer ID';
  if (!spctl.includes('source=Notarized Developer ID')) return 'not accepted as notarized';
  if (!stapled) return 'no stapled notarization ticket';
  return null;
}

/**
 * The report says only what was checked: a Windows file has a checked signature, a Mac file only when this run
 * checked the app inside it (`macSigned`, on a Mac).
 */
export function reportText({ edition, asset, zipName, macSigned = false }) {
  const { label } = KINDS[asset.kind];
  const windows = asset.kind === 'win';
  let heading = 'Allowlist request: business software, Mac installer.';
  let publisher = 'Publisher: Anchor Sprint Pte. Ltd.';
  if (windows) {
    heading = 'Allowlist request: signed business software.';
    publisher =
      'Publisher / code signature: Anchor Sprint Pte. Ltd. (valid Authenticode signature).';
  } else if (macSigned) {
    heading = 'Allowlist request: signed business software, Mac installer.';
    publisher = `Publisher / code signature: Anchor Sprint Pte. Ltd. (${MAC_SIGNER}, notarized by Apple).`;
  }
  return [
    heading,
    '',
    `This is the ${label} of a new release. We ask you to allowlist it, so that McAfee does not block it. ` +
      'McAfee already whitelisted an installer of the same publisher (EzyChat-Enterprise-0.1.26-win-x64.exe, your answer of 5 Nov 2026).',
    '',
    `Product: ${PRODUCTS[edition].text}`,
    publisher,
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

const ENTERPRISE_REPO = 'anchorsprint/ezychat-enterprise';

/**
 * Enterprise before it is published: the installers and latest.json of one Installers run (a build from main, which
 * never publishes), copied into the work folder, so the report goes out first and the very same files are published
 * afterwards (`node scripts/publish-release.mjs --run <id>` in the Enterprise repo).
 */
function loadEnterpriseRun(runId, work) {
  if (!/^\d+$/.test(runId)) throw new Error(`not a run id: ${runId}`);
  const from = mkdtempSync(join(tmpdir(), 'ezychat-run-'));
  execFileSync(resolveTool('gh'), ['run', 'download', runId, '-R', ENTERPRISE_REPO, '-D', from], {
    stdio: 'inherit',
  });
  const files = readdirSync(from, { recursive: true })
    .map(String)
    .filter((f) => !statSync(join(from, f)).isDirectory());
  const manifestPath = files.find((f) => basename(f) === 'latest.json');
  if (!manifestPath) throw new Error(`run ${runId} has no latest.json`);
  const feed = JSON.parse(readFileSync(join(from, manifestPath), 'utf8'));
  const version = checkVersion(feed.version);
  const dir = join(work, `enterprise-${version}`);
  mkdirSync(dir, { recursive: true });
  for (const f of files) copyFileSync(join(from, f), join(dir, basename(f)));
  console.log(`run ${runId}: EzyChat Enterprise ${version}, the files of that build`);
  return { version, assets: pickAssets('enterprise', version, feed.assets) };
}

async function loadRelease(edition, version) {
  if (edition === 'lite') {
    const gh = (path) =>
      JSON.parse(
        execFileSync(resolveTool('gh'), ['api', `repos/${LITE_REPO}/${path}`], {
          encoding: 'utf8',
          maxBuffer: 2 ** 26,
        }),
      );
    const release = version
      ? releaseOfTag(gh('releases?per_page=30'), version)
      : gh('releases/latest');
    if (release.draft)
      console.log(`v${version}: a draft (not public yet); files come through the API`);
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
  const response = asset.apiUrl
    ? await fetch(asset.apiUrl, {
        headers: {
          accept: 'application/octet-stream',
          authorization: `Bearer ${execFileSync(resolveTool('gh'), ['auth', 'token'], { encoding: 'utf8' }).trim()}`,
        },
      })
    : await fetch(asset.url);
  if (!response.ok) throw new Error(`${asset.apiUrl ?? asset.url} answered ${response.status}`);
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
  if (process.platform !== 'win32') return checkSignatureElsewhere(file);
  const [status, subject] = powershell(
    '$s = Get-AuthenticodeSignature -LiteralPath $env:TARGET_FILE; "$($s.Status)|$($s.SignerCertificate.Subject)"',
    { TARGET_FILE: file },
  ).split('|');
  const problem = signatureProblem(status, subject ?? '');
  if (problem) throw new Error(`${basename(file)}: ${problem}`);
}

// Off Windows: osslsigncode (Homebrew) checks the signature and the timestamp against the system list plus Microsoft's
// root, the same chain Windows checks.
function checkSignatureElsewhere(file) {
  const ca = join(mkdtempSync(join(tmpdir(), 'ezychat-ca-')), 'ca.pem');
  const system = ['/etc/ssl/cert.pem', '/etc/ssl/certs/ca-certificates.crt'].find((f) =>
    existsSync(f),
  );
  if (!system) throw new Error('no system certificate list for osslsigncode');
  writeFileSync(ca, readFileSync(system, 'utf8') + readFileSync(MICROSOFT_ROOT, 'utf8'));
  const tool = OSSLSIGNCODE.find((path) => existsSync(path));
  if (!tool)
    throw new Error(
      `${basename(file)}: osslsigncode is needed to check a Windows file off Windows (brew install osslsigncode)`,
    );
  const r = spawnSync(tool, ['verify', '-CAfile', ca, '-TSA-CAfile', ca, '-in', file], {
    encoding: 'utf8',
  });
  if (r.error)
    throw new Error(
      `${basename(file)}: osslsigncode is needed to check a Windows file off Windows (brew install osslsigncode)`,
    );
  const { status, subject } = osslsigncodeStatus(`${r.stdout}${r.stderr}`, r.status);
  const problem = signatureProblem(status, subject);
  if (problem) throw new Error(`${basename(file)}: ${problem}`);
}

function zipFile(file) {
  const zip = `${file}.zip`;
  if (existsSync(zip)) return zip;
  const partial = `${file}.partial.zip`;
  if (process.platform === 'win32')
    powershell(
      'Compress-Archive -LiteralPath $env:TARGET_FILE -DestinationPath $env:ZIP_FILE -Force',
      {
        TARGET_FILE: file,
        ZIP_FILE: partial,
      },
    );
  // -j: the file alone, without its folders; -X: no extra file attributes.
  else execFileSync(ZIP, ['-j', '-X', '-q', partial, file]);
  renameSync(partial, zip);
  return zip;
}

/**
 * On a Mac: mount the installer read-only and check the app inside it (Developer ID, notarized, ticket stapled).
 * True only when every check passed; elsewhere, or for an older ad-hoc build, false (the report then claims nothing).
 */
function checkMacSignature(file) {
  if (process.platform !== 'darwin') return false;
  const mount = mkdtempSync(join(tmpdir(), 'ezychat-dmg-'));
  execFileSync(HDIUTIL, [
    'attach',
    '-nobrowse',
    '-readonly',
    '-noautoopen',
    '-mountpoint',
    mount,
    file,
  ]);
  try {
    const app = readdirSync(mount).find((name) => name.endsWith('.app'));
    if (!app) throw new Error(`${basename(file)}: no app inside the installer`);
    const path = join(mount, app);
    // codesign and spctl write their findings to stderr; spctl exits non-zero when it refuses the app.
    const run = (command, args) => {
      const r = spawnSync(command, args, { encoding: 'utf8' });
      return { ok: r.status === 0, text: `${r.stdout}${r.stderr}` };
    };
    const problem = macSignatureProblem({
      codesign: run(CODESIGN, ['-dvv', path]).text,
      spctl: run(SPCTL, ['--assess', '--type', 'execute', '-vv', path]).text,
      stapled: run(XCRUN, ['stapler', 'validate', path]).ok,
    });
    const verdict = problem ?? `signed (${MAC_SIGNER}) and notarized`;
    console.log(`${basename(file)}: ${verdict}`);
    return problem === null;
  } finally {
    execFileSync(HDIUTIL, ['detach', mount, '-quiet']);
  }
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
      run: { type: 'string' },
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
  if (values.run && (values.edition !== 'enterprise' || values.version))
    throw new Error('--run is for --edition enterprise only, without --version (the run names it)');
  const kinds = selectKinds(values.only);
  const reporter = checkReporter(JSON.parse(readFileSync(REPORTER_FILE, 'utf8')));
  const dryRun = values['dry-run'];

  // Prepare everything first: a bad file then stops the run before any report goes out.
  const jobs = [];
  for (const edition of editions) {
    const release = values.run
      ? loadEnterpriseRun(values.run, values.work)
      : await loadRelease(edition, values.version);
    const dir = join(values.work, `${edition}-${release.version}`);
    mkdirSync(dir, { recursive: true });
    for (const asset of release.assets.filter((a) => kinds.includes(a.kind))) {
      const file = await download(asset, dir);
      if (asset.kind === 'win') checkSignature(file);
      const macSigned = asset.kind !== 'win' && checkMacSignature(file);
      const attach = asset.kind === 'win' ? file : zipFile(file);
      const zipName = attach === file ? undefined : basename(attach);
      jobs.push({
        edition,
        version: release.version,
        asset,
        attach,
        dir,
        details: reportText({ edition, asset, zipName, macSigned }),
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
