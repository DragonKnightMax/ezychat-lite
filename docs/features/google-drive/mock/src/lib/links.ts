/** External links used for attribution and support across the app. */
export const ANCHOR_SPRINT_URL = 'https://www.anchorsprint.com';
export const GITHUB_REPO_URL = 'https://github.com/ossmalaysia/ezychat-lite';
export const GITHUB_ISSUES_URL = 'https://github.com/ossmalaysia/ezychat-lite/issues/new/choose';
/** Feedback and feature requests on the EzyChat website, one page per app language. */
const FEEDBACK_PAGE_EN = 'https://ezychat.ai/feedback';
const FEEDBACK_PAGE: Partial<Record<string, string>> = {
  ms: 'https://ezychat.ai/ms/feedback',
  'zh-CN': 'https://ezychat.ai/zh/feedback',
};

/** The website feedback form in the app's language, with the running version filled in. */
export function feedbackUrl(locale: string, version: string | null): string {
  const page = FEEDBACK_PAGE[locale] ?? FEEDBACK_PAGE_EN;
  return version ? `${page}?v=${encodeURIComponent(version)}` : page;
}
/** Contact Anchor Sprint for custom features. */
export const CUSTOM_FEATURE_URL = 'https://www.anchorsprint.com';
