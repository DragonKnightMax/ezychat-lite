// Installer identity of the desktop product. Pure: must not import 'electron' (unit tested under Node).
//
// Every value an installed copy depends on (app id, folders, service id, update feed) lives in one
// `Product`, so another edition (EzyChat Enterprise) can build its own installer from the same main
// process code. Lite's values are upgrade contracts: they stay byte-for-byte as shipped and are pinned
// by product.test.ts. Another edition picks its own values so both can be installed on one PC.
//
// The main process reads the active product. A different edition sets it once, before the main entry
// is loaded (ESM hoists static imports, so its entry must load main with a dynamic import):
//
//   import { defineProduct, setActiveProduct } from './product.js';
//   setActiveProduct(defineProduct({ ... }));
//   await import('./main.js');

import { checkStatusSections, type StatusSectionProvider } from './status-sections.js';

export type {
  StatusSectionContext,
  StatusSectionModel,
  StatusSectionProvider,
} from './status-sections.js';

export interface Product {
  /** Matches `edition` in /api/health (`lite` when the server omits it). */
  edition: string;
  /** Visible name: window, tray and dialog titles, privilege prompts. Also the current executable / .app name. */
  productName: string;
  /** electron-builder appId: Windows AppUserModelID, macOS CFBundleIdentifier. */
  appUserModelId: string;
  /** Machine data folder name (ProgramData / Library/Application Support) and its -run / -runtime / -updates siblings. */
  appDirName: string;
  /** Per-user Electron profile folder under the OS app-data folder (packaged builds). */
  profileDirName: string;
  /** Windows service id (WinSW) and its wrapper/config file names. */
  serviceId: string;
  /** Windows service display name and utility-process name. */
  serviceName: string;
  /** macOS LaunchDaemon label. */
  launchdLabel: string;
  /** `app` value in /api/health that identifies this product's server. */
  healthApp: string;
  /**
   * GitHub repository (owner/name) whose releases feed in-app updates when updateFeed is omitted.
   * With a 'url' feed it is not contacted (it still names the edition's release source).
   */
  releaseRepository: string;
  /** Repositories a release asset may be downloaded from: releaseRepository first, then legacy ones. */
  releaseRepositories: readonly string[];
  /** Installer file name prefixes (`<prefix>-<version>-<os>-<arch>.<ext>`): current first, then legacy. */
  artifactPrefixes: readonly string[];
  /** Program names accepted by the updater (`<name>.exe`, `<name>.app`): productName first, then legacy. */
  executableNames: readonly string[];
  /**
   * Where in-app updates come from. Omitted: the GitHub releases of releaseRepository (Lite).
   * A private edition uses { kind: 'url' }: an https JSON manifest (see update-checker.ts).
   */
  updateFeed?: UpdateFeed;
  /** Edition cards on the Status & Service page, above App updates (see status-sections.ts). */
  statusSections?: readonly StatusSectionProvider[];
  /**
   * Port of a new install (desktop.json keeps the chosen one). Omitted: 7420 (Lite). An edition that can be
   * installed next to Lite needs its own, or its server cannot start while Lite runs.
   */
  defaultPort?: number;
  /**
   * The product whose data this one can bring over on the same PC (design: Lite → Enterprise upgrade):
   * Enterprise passes LITE_PRODUCT; Lite has none. Only its identity (folders, service, health, port) is
   * read, never its feeds. Turns on the desktop's Lite import (lite-import/) and `window.watiLiteImport`.
   */
  adoptFrom?: ProductIdentity;
  /**
   * https JSON manifest of the edition the "Install EzyChat Enterprise" button downloads (upgrade/):
   * Lite: Enterprise's latest.json; others none. `null` or omitted hides the button (`window.watiUpgrade`).
   */
  upgradeInstallerFeed?: string | null;
}

/** Another product's installer identity (the one `adoptFrom` names). */
export type ProductIdentity = Product;

/** Enterprise's update manifest: Lite's "Install EzyChat Enterprise" downloads its installer. */
export const ENTERPRISE_INSTALLER_FEED = 'https://dl.ezychat.ai/enterprise/latest.json';

export type UpdateFeed = { kind: 'github'; repo: string } | { kind: 'url'; url: string };

/** The effective update feed: updateFeed, else the GitHub releases of releaseRepository. */
export function updateFeedOf(p: Product): UpdateFeed {
  return p.updateFeed ?? { kind: 'github', repo: p.releaseRepository };
}

/** EzyChat Lite. Upgrade contracts: never change these values (see AGENTS.md). */
export const LITE_PRODUCT: Product = Object.freeze({
  edition: 'lite',
  productName: 'EzyChat Lite',
  appUserModelId: 'org.ossmalaysia.wateaminbox',
  appDirName: 'wa-team-inbox',
  profileDirName: 'WA Team Inbox',
  serviceId: 'wa-team-inbox',
  serviceName: 'EzyChat Lite Server',
  launchdLabel: 'org.ossmalaysia.wateaminbox.server',
  healthApp: 'wa-team-inbox',
  releaseRepository: 'ossmalaysia/ezychat-lite',
  releaseRepositories: Object.freeze(['ossmalaysia/ezychat-lite', 'ossmalaysia/wa-team-inbox']),
  artifactPrefixes: Object.freeze(['EzyChat-Lite', 'WA-Team-Inbox']),
  executableNames: Object.freeze(['EzyChat Lite', 'WA Team Inbox']),
  upgradeInstallerFeed: ENTERPRISE_INSTALLER_FEED,
});

function httpsFeedUrl(field: string, value: string): string | null {
  let url: URL | null;
  try {
    url = new URL(value);
  } catch {
    url = null;
  }
  if (url && url.protocol === 'https:' && !url.username && !url.password && !url.hash)
    return url.href;
  throw new Error(`Invalid product ${field}: ${JSON.stringify(value)}`);
}

function checkInstallerFeed(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error('Invalid product upgradeInstallerFeed');
  return httpsFeedUrl('upgradeInstallerFeed', value);
}

function checkAdoptFrom(
  value: unknown,
  own: { edition: string; appDirName: string; profileDirName: string },
): Product {
  if (!value || typeof value !== 'object') throw new Error('Invalid product adoptFrom');
  const other = value as Product;
  if (other.adoptFrom !== undefined)
    throw new Error('Invalid product adoptFrom: it cannot adopt from another product itself');
  const checked = defineProduct(other);
  if (
    checked.edition === own.edition ||
    checked.appDirName === own.appDirName ||
    checked.profileDirName === own.profileDirName
  )
    throw new Error('Invalid product adoptFrom: it must be another edition');
  return checked;
}

function checkFeed(value: unknown, releaseRepository: string): UpdateFeed {
  const feed = value as UpdateFeed | null;
  if (feed && typeof feed === 'object' && feed.kind === 'github') {
    const repo = check('updateFeed.repo', feed.repo, REPOSITORY);
    if (repo !== releaseRepository)
      throw new Error('Invalid product updateFeed: repo must equal releaseRepository');
    return Object.freeze({ kind: 'github', repo });
  }
  if (feed && typeof feed === 'object' && feed.kind === 'url' && typeof feed.url === 'string') {
    let url: URL | null;
    try {
      url = new URL(feed.url);
    } catch {
      url = null;
    }
    if (url && url.protocol === 'https:' && !url.username && !url.password && !url.hash)
      return Object.freeze({ kind: 'url', url: url.href });
  }
  throw new Error(`Invalid product updateFeed: ${JSON.stringify(value)}`);
}

// Values end up inside PowerShell/bash single-quoted strings, regexes, XML, plists and file names,
// so each field accepts only characters that need no quoting anywhere.
const EDITION = /^[a-z][a-z0-9-]{0,31}$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const REVERSE_DNS = /^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/i;
const DISPLAY_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9 ._-]{0,62}[A-Za-z0-9])?$/;
const FILE_PREFIX = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;
const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

function check(field: string, value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value) || value.includes('..'))
    throw new Error(`Invalid product ${field}: ${JSON.stringify(value)}`);
  return value;
}

function checkList(
  field: string,
  value: unknown,
  pattern: RegExp,
  first: string,
): readonly string[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error(`Invalid product ${field}: needs at least one entry`);
  const list = value.map((v, i) => check(`${field}[${i}]`, v, pattern));
  if (list[0] !== first) throw new Error(`Invalid product ${field}: must start with ${first}`);
  if (new Set(list).size !== list.length)
    throw new Error(`Invalid product ${field}: duplicate entry`);
  return Object.freeze(list);
}

function checkPort(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1024 || value > 65535)
    throw new Error('Invalid product defaultPort: expected an integer from 1024 to 65535');
  return value;
}

/** Validates a product definition and returns a frozen copy. Throws on empty or malformed ids. */
export function defineProduct(p: Product): Product {
  if (!p || typeof p !== 'object') throw new Error('Invalid product: expected an object');
  const productName = check('productName', p.productName, DISPLAY_NAME);
  const releaseRepository = check('releaseRepository', p.releaseRepository, REPOSITORY);
  const artifactPrefixes: readonly unknown[] = Array.isArray(p.artifactPrefixes)
    ? p.artifactPrefixes
    : [];
  return Object.freeze({
    edition: check('edition', p.edition, EDITION),
    productName,
    appUserModelId: check('appUserModelId', p.appUserModelId, REVERSE_DNS),
    appDirName: check('appDirName', p.appDirName, SLUG),
    profileDirName: check('profileDirName', p.profileDirName, DISPLAY_NAME),
    serviceId: check('serviceId', p.serviceId, SLUG),
    serviceName: check('serviceName', p.serviceName, DISPLAY_NAME),
    launchdLabel: check('launchdLabel', p.launchdLabel, REVERSE_DNS),
    healthApp: check('healthApp', p.healthApp, SLUG),
    releaseRepository,
    releaseRepositories: checkList(
      'releaseRepositories',
      p.releaseRepositories,
      REPOSITORY,
      releaseRepository,
    ),
    artifactPrefixes: checkList(
      'artifactPrefixes',
      p.artifactPrefixes,
      FILE_PREFIX,
      String(artifactPrefixes[0] ?? ''),
    ),
    executableNames: checkList('executableNames', p.executableNames, DISPLAY_NAME, productName),
    // Optional fields are added only when given, so a definition without them round-trips unchanged.
    ...(p.updateFeed !== undefined
      ? { updateFeed: checkFeed(p.updateFeed, releaseRepository) }
      : {}),
    ...(p.statusSections !== undefined
      ? { statusSections: checkStatusSections(p.statusSections) }
      : {}),
    ...(p.defaultPort !== undefined ? { defaultPort: checkPort(p.defaultPort) } : {}),
    ...(p.adoptFrom !== undefined ? { adoptFrom: checkAdoptFrom(p.adoptFrom, p) } : {}),
    ...(p.upgradeInstallerFeed !== undefined
      ? { upgradeInstallerFeed: checkInstallerFeed(p.upgradeInstallerFeed) }
      : {}),
  });
}

let active: Product = LITE_PRODUCT;
let locked = false;

/** The product this process runs as (Lite unless an edition entry called setActiveProduct first). */
export function activeProduct(): Product {
  locked = true;
  return active;
}

/**
 * Selects the product for this process. Call once, before anything reads it (before loading main);
 * a late switch would mix two identities, so it throws once the product has been read.
 */
export function setActiveProduct(p: Product): void {
  const next = defineProduct(p);
  if (locked) throw new Error('The product is already in use; set it before loading the app');
  active = next;
}

/** Tests only: restore Lite and allow setActiveProduct again. */
export function resetActiveProductForTests(): void {
  active = LITE_PRODUCT;
  locked = false;
}

/** Escapes a value for use inside a regular expression (JS or POSIX ERE). */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
