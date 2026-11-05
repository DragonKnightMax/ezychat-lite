import type { TFunction } from 'i18next';
import { formatDate } from '@/lib/format';

/** Audit action → translation key in the `admin` namespace. */
const LABEL_KEYS = {
  'auth.login': 'audit.actions.authLogin',
  'auth.login_failed': 'audit.actions.authLoginFailed',
  'auth.logout': 'audit.actions.authLogout',
  'auth.change_password': 'audit.actions.authChangePassword',
  'auth.reset_admin_cli': 'audit.actions.authResetAdminCli',
  'setup.admin': 'audit.actions.setupAdmin',
  'user.create': 'audit.actions.userCreate',
  'user.update': 'audit.actions.userUpdate',
  'user.reset_password': 'audit.actions.userResetPassword',
  'user.revoke_sessions': 'audit.actions.userRevokeSessions',
  'quick_reply.create': 'audit.actions.quickReplyCreate',
  'quick_reply.update': 'audit.actions.quickReplyUpdate',
  'quick_reply.delete': 'audit.actions.quickReplyDelete',
  'wa.logout': 'audit.actions.waLogout',
  'wa.relink': 'audit.actions.waRelink',
  'wa.takeover': 'audit.actions.waTakeover',
  'wa.pairing_code': 'audit.actions.waPairingCode',
  'tunnel.start': 'audit.actions.tunnelStart',
  'tunnel.stop': 'audit.actions.tunnelStop',
  'cloudflare.login': 'audit.actions.cloudflareLogin',
  'cloudflare.create': 'audit.actions.cloudflareCreate',
  'settings.update': 'audit.actions.settingsUpdate',
  'chats.resolve_all': 'audit.actions.chatsResolveAll',
  'chat.merge': 'audit.actions.chatMerge',
  'chat.start_from_group': 'audit.actions.chatStartFromGroup',
  'logs.download': 'audit.actions.logsDownload',
  'ai.connection_update': 'audit.actions.aiConnectionUpdate',
  'ai.member_update': 'audit.actions.aiMemberUpdate',
  'ai.document_add': 'audit.actions.aiDocumentAdd',
  'ai.document_update': 'audit.actions.aiDocumentUpdate',
  'ai.document_remove': 'audit.actions.aiDocumentRemove',
  'ai.handoff': 'audit.actions.aiHandoff',
  'ai.resolve': 'audit.actions.aiResolve',
  'ai.voice_update': 'audit.actions.aiVoiceUpdate',
  'ai.voice_model_download': 'audit.actions.aiVoiceModelDownload',
  'ai.voice_model_cancel': 'audit.actions.aiVoiceModelCancel',
  'ai.voice_model_remove': 'audit.actions.aiVoiceModelRemove',
  'customer.profile_update': 'audit.actions.customerProfileUpdate',
  'api_token.create': 'audit.actions.apiTokenCreate',
  'api_token.revoke': 'audit.actions.apiTokenRevoke',
  'api_token.auth_failed': 'audit.actions.apiTokenAuthFailed',
  'mcp.enable': 'audit.actions.mcpEnable',
  'mcp.disable': 'audit.actions.mcpDisable',
} as const;

type KnownAction = keyof typeof LABEL_KEYS;

const isKnown = (action: string): action is KnownAction => Object.hasOwn(LABEL_KEYS, action);

/** "customer.profile_update" → "Customer profile update", so unknown actions wrap between words. */
function humanize(id: string): string {
  const words = id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[._\s-]+/)
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Human label for an audit action; an action the catalog does not know yet is spelled out in words. */
export function auditActionLabel(action: string, t: TFunction<'admin'>): string {
  return isKnown(action) ? t(LABEL_KEYS[action]) : humanize(action);
}

/** Routine sign-ins and sign-outs, which the audit page can hide. Failed sign-ins stay visible. */
export function isSignInAction(action: string): boolean {
  return action === 'auth.login' || action === 'auth.logout';
}

/** Meta field → translation key (`admin` namespace) for its label. */
const FIELD_KEYS: Record<string, string> = {
  chatJid: 'audit.fields.chat',
  groupJid: 'audit.fields.group',
  from: 'audit.fields.from',
  to: 'audit.fields.to',
  targetId: 'audit.fields.member',
  assignedTo: 'audit.fields.assignedTo',
  reason: 'audit.fields.reason',
  enabled: 'audit.fields.enabled',
  disabled: 'audit.fields.disabled',
  role: 'audit.fields.role',
  mode: 'audit.fields.mode',
  model: 'audit.fields.model',
  kind: 'audit.fields.kind',
  size: 'audit.fields.size',
  documentId: 'audit.fields.document',
  transcription: 'audit.fields.transcription',
  resolvedCount: 'audit.fields.resolvedCount',
  username: 'audit.fields.username',
  displayName: 'audit.fields.displayName',
  id: 'audit.fields.id',
  shortcut: 'audit.fields.shortcut',
  hostname: 'audit.fields.hostname',
  subdomain: 'audit.fields.subdomain',
  tunnelName: 'audit.fields.tunnelName',
  domainId: 'audit.fields.domain',
  restartRequired: 'audit.fields.restartRequired',
  moved: 'audit.fields.moved',
  name: 'audit.fields.name',
  tags: 'audit.fields.tags',
  company: 'audit.customerFields.company',
  email: 'audit.customerFields.email',
  otherPhone: 'audit.customerFields.otherPhone',
  address: 'audit.customerFields.address',
  instructions: 'audit.fields.instructions',
  handoffRules: 'audit.fields.handoffRules',
  text: 'audit.fields.text',
  token: 'audit.fields.token',
  port: 'audit.fields.port',
  lanEnabled: 'audit.fields.lanEnabled',
  historyDays: 'audit.fields.historyDays',
  prefix: 'audit.fields.token',
  expiresAt: 'audit.fields.expires',
};

/**
 * Internal ids that mean nothing to a reader (a token's name and prefix identify it), and `via`,
 * which the Who column shows as the access token's name.
 */
const HIDDEN_FIELDS = new Set(['tokenId', 'via']);

/** Known enum values → translation keys (`admin` namespace, or `common:` prefixed). */
const VALUE_KEYS: Record<string, Record<string, string>> = {
  mode: {
    api: 'ai.modeApi',
    chatgpt: 'ai.modeChatgpt',
    off: 'tunnel.modes.off',
    quick: 'tunnel.modes.quick',
    named: 'tunnel.modes.named',
  },
  kind: { file: 'ai.contextPanel.kindFile', text: 'ai.contextPanel.kindText' },
  transcription: { off: 'ai.voice.off', local: 'ai.voice.local', cloud: 'ai.voice.cloud' },
  role: { admin: 'common:roles.admin', agent: 'common:roles.agent', sales: 'ai.roleBadge' },
  reason: {
    rate_limited: 'audit.reasons.rateLimited',
    invalid: 'audit.reasons.invalid',
    // Failed AI assistant token sign-ins (api_token.auth_failed).
    malformed: 'audit.reasons.malformed',
    unknown: 'audit.reasons.unknown',
    revoked: 'audit.reasons.revoked',
    expired: 'audit.reasons.expired',
    user_inactive: 'audit.reasons.userInactive',
    not_admin: 'audit.reasons.notAdmin',
    must_change_password: 'audit.reasons.mustChangePassword',
  },
};

const JID_FIELDS = new Set(['chatJid', 'groupJid', 'from', 'to']);
const USER_FIELDS = new Set(['targetId', 'assignedTo']);
const SUBJECT_FIELDS = new Set(['chatJid', 'from', 'to', 'targetId', 'documentId', 'shortcut']);
/** Boolean flags that only say "this changed" (shown in the Changed list, never as Yes/No). */
const CHANGE_FLAGS: Record<string, string> = {
  renamed: 'name',
  edited: 'text',
  tokenChanged: 'token',
  instructionsChanged: 'instructions',
  handoffRulesChanged: 'handoffRules',
};

/** `123@s.whatsapp.net` → `+123`; other ids (LIDs, groups) keep their local part. */
function chatLabel(jid: string): string {
  const local = jid.split('@')[0]?.split(':')[0] ?? jid;
  return jid.endsWith('@s.whatsapp.net') && /^\d+$/.test(local) ? `+${local}` : local;
}

/**
 * One readable line for an audit entry's details: names instead of ids, phone numbers instead of
 * JIDs, "Changed a, b" instead of arrays and flags. Empty values are left out.
 */
export function auditDetails(
  meta: Record<string, unknown>,
  t: TFunction<'admin'>,
  userName: (id: number) => string | undefined,
): string {
  const label = (key: string) => {
    const k = FIELD_KEYS[key];
    return k ? t(k as never) : humanize(key);
  };
  // "Port" → "port", but "LAN access" keeps its acronym.
  const inSentence = (key: string) => {
    const l = label(key);
    return /^\p{Lu}\p{Ll}/u.test(l) ? l.charAt(0).toLowerCase() + l.slice(1) : l;
  };
  const value = (key: string, v: unknown): string | null => {
    if (v === null || v === undefined || v === '' || HIDDEN_FIELDS.has(key)) return null;
    if (key === 'expiresAt' && typeof v === 'number') return formatDate(v);
    if (key === 'prefix' && typeof v === 'string') return `${v}…`;
    if (JID_FIELDS.has(key) && typeof v === 'string')
      // An opaque WhatsApp ID (LID) means nothing to a reader and is never shown.
      return v.endsWith('@lid') ? null : chatLabel(v);
    if (USER_FIELDS.has(key) && typeof v === 'number')
      return userName(v) ?? t('audit.userNumber', { id: v });
    if (typeof v === 'boolean') return v ? t('audit.yes') : t('audit.no');
    if (typeof v === 'string' || typeof v === 'number') {
      const known = VALUE_KEYS[key]?.[String(v)];
      return known ? t(known as never) : String(v);
    }
    if (Array.isArray(v)) return v.map(String).join(', ');
    if (typeof v === 'object') {
      // e.g. a chat merge's `moved: { messages: 12, notes: 1 }` → "messages 12, notes 1".
      const inner = Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => ['string', 'number', 'boolean'].includes(typeof x))
        .map(([k, x]) => {
          const shown =
            typeof x === 'boolean' ? t(x ? 'audit.yes' : 'audit.no') : String(x as string | number);
          return `${inSentence(k)} ${shown}`;
        });
      return inner.length ? inner.join(', ') : null;
    }
    return null;
  };

  // What the entry is about (chat, member, item) comes first, then what changed, then the rest.
  const subjects: string[] = [];
  const parts: string[] = [];
  const changed: string[] = [];
  for (const [key, v] of Object.entries(meta)) {
    if (key in CHANGE_FLAGS) {
      if (v === true) changed.push(CHANGE_FLAGS[key]!);
      continue;
    }
    if (key === 'changed' && Array.isArray(v)) {
      changed.push(...v.map(String));
      continue;
    }
    if (key === 'changes' && v && typeof v === 'object' && !Array.isArray(v)) {
      changed.push(...Object.keys(v));
      continue;
    }
    const shown = value(key, v);
    if (shown === null) continue;
    (SUBJECT_FIELDS.has(key) ? subjects : parts).push(`${label(key)}: ${shown}`);
  }
  const changedPart = changed.length
    ? [t('audit.changed', { fields: changed.map(inSentence).join(', ') })]
    : [];
  return [...subjects, ...changedPart, ...parts].join(' · ');
}
