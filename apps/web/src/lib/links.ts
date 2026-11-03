import { tipGuideUrl, type TipGuide } from './tips';

/** External links used for attribution and support across the app. */
export const ANCHOR_SPRINT_URL = 'https://www.anchorsprint.com';
export const EZYCHAT_WEBSITE_URL = 'https://ezychat.ai/';
export const GITHUB_REPO_URL = 'https://github.com/ossmalaysia/ezychat-lite';
export const GITHUB_ISSUES_URL = 'https://github.com/ossmalaysia/ezychat-lite/issues/new/choose';
/** Contact Anchor Sprint for custom features. */
export const CUSTOM_FEATURE_URL = 'https://www.anchorsprint.com';

/**
 * The outside links the UI shows (About, Report an issue, release notes, support).
 * Another product build overrides them through `createInboxApp({ links })`; `null` hides a link.
 */
export interface AppLinks {
  /** Product website (About, and the share link when there is no source code link). */
  website: string;
  /** "Report an issue" page; when null, an email link to `supportEmail` is shown instead. */
  reportIssue: string | null;
  /** Public source code ("View on GitHub" in About). */
  sourceCode: string | null;
  /**
   * Release notes for one version, shown by the desktop update panel. Lite opens its GitHub
   * release through the desktop bridge; another value is opened as a plain link.
   */
  releaseNotes: ((version: string) => string | null) | null;
  /** Support email address (mailto link where there is no report-issue page). */
  supportEmail: string | null;
  /** "Upgrade to Enterprise" page (Lite's limits, account menu, About); null hides every upgrade link. */
  upgrade: string | null;
  /**
   * Admin → Connectors "Vote for this connector" / "Ask for a connector": the address that opens a
   * ready message (in the UI language) to the team. Nothing is counted in the app. null hides them.
   */
  connectorRequest: ((message: string) => string) | null;
  /**
   * "Full guide" in the "?" tips (`InfoTip`): the guide page for a slug in the UI language, with the
   * tip's topic for campaign tags. null hides the link (the tip keeps its text and outside page).
   */
  guide: ((guide: TipGuide, locale: string, topic: string) => string) | null;
}

/**
 * The EzyChat Enterprise section of the website. The campaign tag lets the website count upgrade
 * visits from the app; the app itself sends nothing (no tracking in Lite).
 */
export const ENTERPRISE_UPGRADE_URL =
  'https://ezychat.ai/?utm_source=ezychat-lite&utm_medium=app&utm_campaign=upgrade#enterprise';

/** The EzyChat team's WhatsApp number (the website's contact number) for connector requests. */
export const CONNECTOR_REQUEST_WHATSAPP = '601159246128';

/** A WhatsApp chat with the EzyChat team, with `message` ready to send. */
export function connectorRequestUrl(message: string): string {
  return `https://wa.me/${CONNECTOR_REQUEST_WHATSAPP}?text=${encodeURIComponent(message)}`;
}

const liteReleaseNotes = (version: string): string =>
  `${GITHUB_REPO_URL}/releases/tag/v${encodeURIComponent(version)}`;

/** Lite's links: GitHub repository and issues, the website. */
export const LITE_APP_LINKS: Readonly<AppLinks> = Object.freeze({
  website: EZYCHAT_WEBSITE_URL,
  reportIssue: GITHUB_ISSUES_URL,
  sourceCode: GITHUB_REPO_URL,
  releaseNotes: liteReleaseNotes,
  supportEmail: null,
  upgrade: ENTERPRISE_UPGRADE_URL,
  connectorRequest: connectorRequestUrl,
  guide: tipGuideUrl,
});

/** Lite's links with the given overrides (an explicit `null` hides that link). */
export function resolveAppLinks(overrides: Partial<AppLinks> = {}): AppLinks {
  const links: AppLinks = { ...LITE_APP_LINKS };
  for (const key of Object.keys(overrides) as (keyof AppLinks)[]) {
    const value = overrides[key];
    if (value !== undefined) (links as unknown as Record<string, unknown>)[key] = value;
  }
  return links;
}

/** True when the release notes are Lite's own GitHub releases (opened via the desktop bridge). */
export function isLiteReleaseNotes(links: AppLinks): boolean {
  return links.releaseNotes === liteReleaseNotes;
}

/** Where "Report an issue" points: the page, else an email to support, else nothing. */
export function reportIssueHref(links: AppLinks): string | null {
  if (links.reportIssue) return links.reportIssue;
  if (links.supportEmail) return `mailto:${links.supportEmail}`;
  return null;
}

/** The link the share-the-app actions share: the source code page, else the website. */
export function shareAppUrl(links: AppLinks): string {
  return links.sourceCode ?? links.website;
}
