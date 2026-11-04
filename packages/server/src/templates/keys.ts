import { CONNECTOR_LIST_PUBLIC_KEYS } from '../connectors/list/keys.js';

/**
 * The template list is signed with the connector list's keys (one protected `release` environment in
 * anchorsprint/ezychat-connectors), over `TEMPLATE_SIGNING_CONTEXT` + the list bytes, so neither
 * list can stand in for the other. Replacing a key needs an app release.
 */
export const TEMPLATE_LIST_PUBLIC_KEYS: readonly string[] = CONNECTOR_LIST_PUBLIC_KEYS;

/** Where `templates-v1.json` and its signature are published. */
export const TEMPLATE_LIST_BASE_URL = 'https://dl.ezychat.ai/templates/';
