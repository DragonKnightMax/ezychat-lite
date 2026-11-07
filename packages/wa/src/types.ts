import type { Logger } from 'pino';
import type { MessageType, WaStatus } from '@ezychat/shared';

export interface WaIncomingMessage {
  id: string;
  chatJid: string;
  /**
   * DM only: the same person's other address as WhatsApp delivered it (`key.remoteJidAlt`), PN for a
   * LID chat or the reverse, device suffix stripped. Null/absent for groups or when not provided.
   */
  chatJidAlt?: string | null;
  senderJid: string | null;
  /** Group sender's explicitly associated alternate phone/LID address. */
  senderJidAlt?: string | null;
  senderName: string | null;
  fromMe: boolean;
  type: MessageType;
  body: string | null;
  /** Explicit mentions from contextInfo; absent only for older adapters/imports. */
  mentionedJids?: string[];
  quotedId: string | null;
  /**
   * WhatsApp's forwarding score (`contextInfo.forwardingScore`, at least 1 when `isForwarded`); absent or
   * 0 = not forwarded. From `FORWARD_MANY_TIMES_SCORE` WhatsApp shows "Forwarded many times".
   */
  forwardingScore?: number;
  /** epoch ms */
  timestamp: number;
  media: null | {
    mime: string;
    fileName: string | null;
    download: () => Promise<Buffer>;
    /** What `downloadMedia` needs after a restart: opaque, stored by the server until the file is stored. */
    ref?: string;
    /** The image's size as reported with the message, when known. */
    width?: number;
    height?: number;
    /** WhatsApp's small JPEG preview of an image, when the message has one. */
    thumbnail?: Buffer;
  };
}

/**
 * One person's emoji reaction to a message. WhatsApp keeps one reaction per person and message: a
 * new emoji replaces the previous one, an empty `emoji` removes it.
 */
export interface WaReaction {
  /** WhatsApp id of the message that was reacted to. */
  targetId: string;
  /** The chat of both the reaction and the reacted message (as WhatsApp delivered it). */
  chatJid: string;
  /** DM only: the same person's other address (`key.remoteJidAlt`), as for messages. */
  chatJidAlt?: string | null;
  /** Who reacted: the group participant or the DM partner; null when `fromMe`. */
  senderJid: string | null;
  /** Group reactor's explicitly associated alternate phone/LID address. */
  senderJidAlt?: string | null;
  /** WhatsApp profile name delivered with the reaction (never inferred). */
  senderName: string | null;
  /** Reacted from the linked number (its phone or another linked device). */
  fromMe: boolean;
  /** The emoji; '' = the reaction was removed. */
  emoji: string;
  /** epoch ms */
  timestamp: number;
}

/**
 * Someone edited a message they sent (WhatsApp `MESSAGE_EDIT`): the customer, a group member or the
 * linked number itself (its phone or another linked device). Only text and captions are edited.
 */
export interface WaMessageEdit {
  /** WhatsApp id of the edited message. */
  targetId: string;
  /** The chat of the message (as WhatsApp delivered the edit). */
  chatJid: string;
  /** DM only: the same person's other address (`key.remoteJidAlt`), as for messages. */
  chatJidAlt?: string | null;
  /** Who edited: the group participant or the DM partner; null when `fromMe`. */
  senderJid: string | null;
  senderJidAlt?: string | null;
  /** Edited from the linked number (its phone or another linked device). */
  fromMe: boolean;
  /** The new text or caption. */
  body: string;
  /** epoch ms of the edit */
  timestamp: number;
}

/**
 * Someone deleted a message for everyone (WhatsApp `REVOKE`): its sender, the linked number, or in
 * a group an admin deleting a member's message.
 */
export interface WaMessageRevoke {
  /** WhatsApp id of the deleted message. */
  targetId: string;
  chatJid: string;
  chatJidAlt?: string | null;
  /** Who deleted it: the group participant or the DM partner; null when `fromMe`. */
  senderJid: string | null;
  senderJidAlt?: string | null;
  fromMe: boolean;
  /** epoch ms of the deletion */
  timestamp: number;
}

export interface WaChatInfo {
  jid: string;
  type: 'dm' | 'group';
  name: string | null;
}

export interface WaContactInfo {
  jid: string;
  pushName: string | null;
  savedName: string | null;
  /** Explicitly associated phone/LID identities, never inferred from names. */
  aliases?: string[];
}

/** Where an explicit PN/LID association was learned (stored in jid_aliases.source). */
export type WaAliasSource = 'message' | 'history' | 'contacts' | 'lid-mapping' | 'keystore';

export interface WaContactAlias {
  jid: string;
  alias: string;
  source?: WaAliasSource;
}

/** A member of a WhatsApp group, as WhatsApp lists it (names are not part of the list). */
export interface WaGroupParticipant {
  /** The member's address as the group lists it: a phone-number JID or a WhatsApp ID (LID). */
  jid: string;
  /** Phone-number JID when WhatsApp shares it (`…@s.whatsapp.net`), else null (number hidden). */
  phoneJid: string | null;
  /** WhatsApp ID (`…@lid`) when known, else null. */
  lidJid: string | null;
  /** WhatsApp username, only when WhatsApp sends it. */
  username: string | null;
  role: 'superadmin' | 'admin' | 'member';
}

export interface WaGroupInfo {
  jid: string;
  name: string | null;
  description: string | null;
  /** epoch ms, null when unknown */
  createdAt: number | null;
  /** Creator's phone-number JID or WhatsApp ID, when known. */
  ownerJid: string | null;
  /** Member count reported by WhatsApp (can exceed participants.length for very large groups). */
  size: number;
  participants: WaGroupParticipant[];
  /** WhatsApp's group settings, when the connection reports them (group management). */
  settings?: Partial<WaGroupSettings>;
}

/** WhatsApp's group settings EzyChat can change. */
export interface WaGroupSettings {
  /** Only admins can send messages. */
  announce: boolean;
  /** Only admins can edit the group name, photo and description. */
  locked: boolean;
  /** Who can add members. */
  memberAdd: 'admins' | 'all';
  /** New members need an admin's approval. */
  approval: boolean;
}

export type WaGroupSettingKey = keyof WaGroupSettings;

/**
 * What a connection can change in a group it is admin of (`WaCapabilities.groupAdmin`). Each flag
 * gates one optional `WaAdapter` group method; absent capability = read-only.
 */
export interface WaGroupAdminCapabilities {
  /** `setGroupSubject` + `setGroupDescription`. */
  editInfo: boolean;
  /** `updateGroupMembers(…, 'add')` (+ `sendGroupInvite` after a privacy refusal). */
  addMembers: boolean;
  /** People join only through the invite link (Business API). */
  inviteOnly: boolean;
  /** `updateGroupMembers(…, 'remove')`. */
  removeMembers: boolean;
  /** `updateGroupMembers(…, 'promote' | 'demote')`. */
  admins: boolean;
  /** `getGroupInviteLink`. */
  inviteLink: boolean;
  /** `resetGroupInviteLink`. */
  resetInviteLink: boolean;
  /** Settings `setGroupSettings` can change. */
  settings: WaGroupSettingKey[];
  /** `listGroupJoinRequests` + `decideGroupJoinRequest`. */
  joinRequests: boolean;
  /** Members besides the business number; null = WhatsApp's own limit. */
  maxMembers: number | null;
  /** Longest name the connection takes. */
  nameMax: number;
  /** Longest description the connection takes. */
  descriptionMax: number;
}

/** A private group invite WhatsApp hands back when a person's privacy settings refuse an add. */
export interface WaGroupInvite {
  code: string;
  /** epoch ms */
  expiresAt: number;
}

/** Outcome of a member change for one person. Never throws for a per-person refusal. */
export interface WaParticipantResult {
  jid: string;
  /**
   * ok; invite_needed (privacy refused an add: `invite` is set); already (already a member / admin);
   * not_member; not_allowed (WhatsApp refused, e.g. not admin or the creator); full; failed (other).
   */
  status: 'ok' | 'invite_needed' | 'already' | 'not_member' | 'not_allowed' | 'full' | 'failed';
  invite?: WaGroupInvite;
}

/** Someone asking to join a group (approval on). */
export interface WaGroupJoinRequest {
  /** The requester's address (phone JID or WhatsApp ID). */
  jid: string;
  /** Phone-number JID when WhatsApp shares it. */
  phoneJid: string | null;
  /** epoch ms, null when unknown */
  at: number | null;
}

export interface WaMessageStatusUpdate {
  id: string;
  chatJid: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  /** `failed` only: the error code WhatsApp gave, when it gave one (for the log). */
  error?: string;
}

export interface WaAdapterEvents {
  status: [WaStatus];
  message: [WaIncomingMessage, { source: 'live' | 'history' }];
  /** Someone reacted to a message, changed their reaction or removed it (live or history). */
  reaction: [WaReaction, { source: 'live' | 'history' }];
  /** A message was edited (live or history); never an echo of an edit this adapter sent. */
  messageEdited: [WaMessageEdit, { source: 'live' | 'history' }];
  /** A message was deleted for everyone (live or history); never an echo of this adapter's own. */
  messageDeleted: [WaMessageRevoke, { source: 'live' | 'history' }];
  messageStatus: [WaMessageStatusUpdate];
  chats: [WaChatInfo[]];
  contacts: [WaContactInfo[]];
  contactAliases: [WaContactAlias[]];
  /** A group's members or settings changed; cached member lists for it are stale. */
  groupChanged: [{ groupJid: string }];
}

/**
 * Saved copy of a quoted message (from the database). The adapter's live message cache is small and
 * cleared on reconnect, so a reply to an older message rebuilds the quote from this instead.
 */
export interface WaQuotedRef {
  id: string;
  fromMe: boolean;
  /** Group messages: who wrote it (needed so WhatsApp attributes the quote). */
  senderJid: string | null;
  type: MessageType;
  /** Text or caption; null for media without a caption. */
  text: string | null;
}

export interface WaSendOptions {
  /** Reply to this WhatsApp message id. */
  quotedId?: string;
  /** Used when the quoted message is no longer in the adapter's live cache. */
  quoted?: WaQuotedRef;
  /**
   * Text sends in groups: the members tagged in the text (each written as `@<user part of the JID>`).
   * Only for adapters with `capabilities.mentions`.
   */
  mentions?: string[];
  /**
   * Send under this WhatsApp message id instead of a new one (Retry of a message WhatsApp already
   * took): phones that already have that id ignore the copy, so no one sees it twice. An adapter
   * that cannot choose the id ignores it.
   */
  messageId?: string;
  /**
   * Send as WhatsApp "Forwarded" with this forwarding score (the source's score + 1). Only adapters with
   * `capabilities.forwardedMark` mark it; others send a normal message.
   */
  forwarded?: { score: number };
}

/**
 * The message a reaction, an edit or a delete points at: WhatsApp matches it by chat, id, side and
 * group author.
 */
export interface WaReactionTarget {
  /** WhatsApp id of the message. */
  id: string;
  /** The message was sent from the linked number. */
  fromMe: boolean;
  /** Group messages from someone else: who wrote it. */
  participant?: string | null;
}

export type WaMessageTarget = WaReactionTarget;

export interface SendResult {
  id: string;
  timestamp: number;
}

export interface WaSendFile {
  /** The file's bytes. Large files are given by `path` instead (streamed, never read into memory). */
  buffer: Buffer;
  /**
   * The stored file on disk. When set, an adapter that can stream reads it from there (Baileys
   * `{ url: path }`, which also lets its media cache upload one file once for several chats).
   */
  path?: string;
  /** Send any file (e.g. a video above the video limit) as a document. */
  asDocument?: boolean;
  mime: string;
  fileName: string;
  caption?: string;
  /** Send OGG/Opus audio as a voice note (push-to-talk), with its length and 64-bar waveform (0–100). */
  voiceNote?: { seconds: number; waveform: Uint8Array };
}

/**
 * What a connection type can do, so the core shows only what works (never by type name). An adapter
 * without `capabilities` is a linked phone: QR/pairing, history import, groups, no reply window.
 */
export interface WaCapabilities {
  /** Linked by a QR scan or a pairing code (`requestPairingCode`). */
  qrLink: boolean;
  /** Imports recent history when linked. */
  history: boolean;
  /** Takes part in groups. */
  groups: boolean;
  /**
   * Free-form messages only within this many hours of the customer's last message (WhatsApp
   * Business API: 24); after that only an approved template (`sendTemplate`). null: no window.
   */
  replyWindowHours: number | null;
  /** Lists and sends approved message templates (`listTemplates`, `sendTemplate`). */
  templates: boolean;
  /** Receives messages at a public https address (a webhook over Phone access / the tunnel). */
  needsPublicUrl: boolean;
  /**
   * Blocks and unblocks numbers (`setBlocked`). Optional so adapters written before WhatsApp Safety
   * keep compiling: absent = cannot block.
   */
  block?: boolean;
  /**
   * Blocking works only within this many hours of the number's last message (Business API: 24);
   * null or absent: any time.
   */
  blockWindowHours?: number | null;
  /** Sends WhatsApp mentions (`WaSendOptions.mentions`); absent: no. */
  mentions?: boolean;
  /** Edits a sent text or caption (`editText`). Absent: no. */
  editMessage?: boolean;
  /** Deletes a sent message for everyone (`deleteForEveryone`). Absent: no. */
  deleteForEveryone?: boolean;
  /** Deletes a message on the linked device itself (`deleteForMe`). Absent: no. */
  deleteForMe?: boolean;
  /** Changes groups it is admin of (group management). Absent: read-only Group info. */
  groupAdmin?: WaGroupAdminCapabilities;
  /**
   * What WhatsApp takes per message, in bytes: a video sent as a video, an image, audio, and any file
   * sent as a document. Absent (or a missing field) = no limit known; WhatsApp's answer decides.
   */
  mediaLimits?: WaMediaLimits;
  /** Sent copies can carry WhatsApp's "Forwarded" mark (`WaSendOptions.forwarded`). Absent: no. */
  forwardedMark?: boolean;
}

export interface WaMediaLimits {
  video?: number;
  image?: number;
  audio?: number;
  document?: number;
}

const MB = 1024 * 1024;
/**
 * A linked phone (design docs/features/forward-message/design.md → Large files): WhatsApp publishes no
 * limit for a video sent as a video, so 64 MB until a Dev Build measures it against real WhatsApp
 * (owner 2026-11-07); documents up to 2 GB (WhatsApp's announced limit).
 */
export const LINKED_PHONE_MEDIA_LIMITS: WaMediaLimits = Object.freeze({
  video: 64 * MB,
  image: 64 * MB,
  audio: 64 * MB,
  document: 2048 * MB,
});
/** Meta's published Cloud API limits (developers.facebook.com/docs/whatsapp/cloud-api/reference/media). */
export const BUSINESS_API_MEDIA_LIMITS: WaMediaLimits = Object.freeze({
  video: 16 * MB,
  image: 5 * MB,
  audio: 16 * MB,
  document: 100 * MB,
});

/** Everything a linked phone can change in a group (Baileys and the fake). */
export const LINKED_PHONE_GROUP_ADMIN: WaGroupAdminCapabilities = Object.freeze({
  editInfo: true,
  addMembers: true,
  inviteOnly: false,
  removeMembers: true,
  admins: true,
  inviteLink: true,
  resetInviteLink: true,
  settings: Object.freeze(['announce', 'locked', 'memberAdd', 'approval']) as WaGroupSettingKey[],
  joinRequests: true,
  maxMembers: null,
  nameMax: 100,
  descriptionMax: 2048,
}) as WaGroupAdminCapabilities;

/** The capabilities of an adapter that declares none: a phone linked by QR (Baileys, the fake). */
export const LINKED_PHONE_CAPABILITIES: WaCapabilities = Object.freeze({
  qrLink: true,
  history: true,
  groups: true,
  replyWindowHours: null,
  templates: false,
  needsPublicUrl: false,
  block: true,
  blockWindowHours: null,
  mentions: true,
  editMessage: true,
  deleteForEveryone: true,
  deleteForMe: true,
  groupAdmin: LINKED_PHONE_GROUP_ADMIN,
  mediaLimits: LINKED_PHONE_MEDIA_LIMITS,
  forwardedMark: true,
});

/** An approved message template of the number's business account. */
export interface WaTemplate {
  name: string;
  /** Meta language code, e.g. `en`, `ms`, `zh_CN`. */
  language: string;
  category: 'utility' | 'marketing' | 'authentication';
  /** Body text with {{1}}, {{2}} … variables. */
  body: string;
  /** Example value for each body variable, in order (may be shorter than the variable count). */
  examples: string[];
  /** A media header (image/document/video) or buttons: listed, not sent by EzyChat (v1). */
  header: 'text' | 'image' | 'document' | 'video' | null;
  buttons: boolean;
}

/** One template message to send: the template and its body variable values, in order. */
export interface WaTemplateSend {
  name: string;
  language: string;
  params: string[];
}

export interface WaAdapter {
  readonly status: WaStatus;
  /** What this connection can do; absent: a linked phone (`LINKED_PHONE_CAPABILITIES`). */
  readonly capabilities?: WaCapabilities;
  /** Approved templates (adapters with `capabilities.templates`). Throws WaUnavailableError offline. */
  listTemplates?(): Promise<WaTemplate[]>;
  /** Sends a template message (adapters with `capabilities.templates`). */
  sendTemplate?(chatJid: string, template: WaTemplateSend): Promise<SendResult>;
  on<K extends keyof WaAdapterEvents>(ev: K, fn: (...a: WaAdapterEvents[K]) => void): this;
  off<K extends keyof WaAdapterEvents>(ev: K, fn: (...a: WaAdapterEvents[K]) => void): this;
  /** idempotent */
  connect(): Promise<void>;
  /** close socket, keep auth */
  disconnect(): Promise<void>;
  /** unlink device + wipe auth */
  logout(): Promise<void>;
  /** reconnect after 'replaced' */
  takeover(): Promise<void>;
  /** link by phone number: returns the 8-character pairing code to enter on the phone */
  requestPairingCode(phone: string): Promise<string>;
  sendText(chatJid: string, text: string, opts?: WaSendOptions): Promise<SendResult>;
  sendMedia(chatJid: string, file: WaSendFile, opts?: WaSendOptions): Promise<SendResult>;
  /**
   * React to a message as the linked number (`emoji` '' removes the reaction). WhatsApp keeps one
   * reaction per number, so this replaces one made on the phone. Throws WaUnavailableError offline.
   */
  sendReaction(chatJid: string, target: WaReactionTarget, emoji: string): Promise<SendResult>;
  /**
   * Replaces the text (or caption) of a message the linked number sent (`capabilities.editMessage`).
   * WhatsApp shows the customer "Edited". Throws WaUnavailableError offline.
   */
  editText?(chatJid: string, target: WaMessageTarget, text: string): Promise<SendResult>;
  /** Deletes a message for everyone (`capabilities.deleteForEveryone`). Throws WaUnavailableError offline. */
  deleteForEveryone?(chatJid: string, target: WaMessageTarget): Promise<SendResult>;
  /**
   * Deletes a message on the linked phone only ("Delete for me", `capabilities.deleteForMe`);
   * `timestamp` is the message's (epoch ms). Throws WaUnavailableError offline.
   */
  deleteForMe?(chatJid: string, target: WaMessageTarget, timestamp: number): Promise<void>;
  markRead(chatJid: string, messageIds: string[]): Promise<void>;
  sendPresence(chatJid: string, presence: 'composing' | 'paused'): Promise<void>;
  /** re-download by id if still cached, else with the message's stored `media.ref` */
  downloadMedia(messageId: string, ref?: string | null): Promise<Buffer | null>;
  /** Photo URL; null when there is none or it is private. Throws when it cannot be read. */
  getProfilePicture(jid: string): Promise<string | null>;
  /** Members and details of a group this number belongs to. Throws WaUnavailableError when offline. */
  getGroupInfo(groupJid: string): Promise<WaGroupInfo>;
  // ---- group management (each gated by `capabilities.groupAdmin`; all throw WaUnavailableError
  // offline, change only groups the linked number is admin of, and emit nothing themselves:
  // WhatsApp's own group notifications raise `groupChanged`) ----
  /** Rename a group (`groupAdmin.editInfo`). */
  setGroupSubject?(groupJid: string, subject: string): Promise<void>;
  /** Set or clear (null) a group's description (`groupAdmin.editInfo`). */
  setGroupDescription?(groupJid: string, description: string | null): Promise<void>;
  /**
   * Add, remove, promote or demote exactly one member (a one-element tuple: bulk is impossible by
   * type). Per-person refusals come back as a result, never as a throw.
   */
  updateGroupMembers?(
    groupJid: string,
    jids: [string],
    action: 'add' | 'remove' | 'promote' | 'demote',
  ): Promise<WaParticipantResult[]>;
  /** Send the private invite from an `invite_needed` add result to that person (`groupAdmin.addMembers`). */
  sendGroupInvite?(groupJid: string, toJid: string, invite: WaGroupInvite): Promise<void>;
  /** The group's invite link (`https://chat.whatsapp.com/…`, `groupAdmin.inviteLink`). */
  getGroupInviteLink?(groupJid: string): Promise<string>;
  /** Revoke the invite link and return the new one (`groupAdmin.resetInviteLink`). */
  resetGroupInviteLink?(groupJid: string): Promise<string>;
  /** Change settings listed in `groupAdmin.settings`. */
  setGroupSettings?(groupJid: string, settings: Partial<WaGroupSettings>): Promise<void>;
  /** Pending join requests (`groupAdmin.joinRequests`). */
  listGroupJoinRequests?(groupJid: string): Promise<WaGroupJoinRequest[]>;
  /** Approve or reject one join request (`groupAdmin.joinRequests`). */
  decideGroupJoinRequest?(
    groupJid: string,
    jid: string,
    approve: boolean,
  ): Promise<WaParticipantResult>;
  /** A person's WhatsApp "About" text; null when hidden or unset. Throws when it cannot be read. */
  getAbout(jid: string): Promise<string | null>;
  /**
   * Ask WhatsApp whether a phone number (digits with country code, no `+`) has an account: its phone
   * JID, or null when it has none. Throws WaUnavailableError when offline.
   */
  checkNumber(phone: string): Promise<string | null>;
  /**
   * Block (true) or unblock a number (adapters with `capabilities.block`): it can no longer message
   * this number. Throws WaUnavailableError when offline.
   */
  setBlocked?(jid: string, blocked: boolean): Promise<void>;
  /** Resolve existing local phone/LID mappings only; must not query WhatsApp. */
  getContactAliases(jids: string[]): Promise<WaContactAlias[]>;
}

export interface WaAdapterOptions {
  authDir: string;
  /** days of history to import; a getter is re-read on every (re)connect / history batch */
  historyDays: number | (() => number);
  logger?: Logger;
}

export class WaUnavailableError extends Error {
  readonly code = 'wa_unavailable' as const;
  constructor(message = 'WhatsApp is not connected') {
    super(message);
    this.name = 'WaUnavailableError';
  }
}
