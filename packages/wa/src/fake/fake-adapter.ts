import { boundedMediaBuffer, validateMediaDownloadOptions } from '../media-download.js';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import type { WaStatus } from '@ezychat/shared';
import {
  WaUnavailableError,
  type SendResult,
  type WaAdapter,
  type WaAdapterEvents,
  type WaMediaDownloadOptions,
  type WaCapabilities,
  type WaContactAlias,
  type WaGroupInfo,
  type WaGroupInvite,
  type WaGroupJoinRequest,
  type WaGroupSettings,
  type WaParticipantResult,
  type WaIncomingMessage,
  type WaMessageEdit,
  type WaMessageRevoke,
  type WaMessageTarget,
  type WaReaction,
  type WaReactionTarget,
  type WaSendFile,
  type WaSendOptions,
  type WaTemplate,
  type WaTemplateSend,
} from '../types.js';

const FAKE_ME = { jid: '60000000000@s.whatsapp.net', name: 'Fake' } as const;

export interface FakeSentRecord {
  chatJid: string;
  text?: string;
  file?: WaSendFile;
  id: string;
  /** Reply options as the real adapter would receive them. */
  reply?: WaSendOptions;
  /** Text sends: the members tagged (WhatsApp mentions). */
  mentions?: string[];
  /** Sent as WhatsApp "Forwarded" with this score (`WaSendOptions.forwarded`). */
  forwarded?: { score: number };
}

/**
 * In-memory WaAdapter for tests and `--fake-wa` dev mode. Never touches the network.
 */
/** Per-process id prefix, so a restarted dev server never reuses message ids stored in app.db. */
export const FAKE_RUN = Date.now().toString(36);

export class FakeWaAdapter extends EventEmitter implements WaAdapter {
  private _status: WaStatus = { state: 'disconnected', me: null, qr: null, lastError: null };
  private readonly autoOpen: boolean;
  private awaitScan: boolean;
  private readonly me: { jid: string; name: string; lid?: string };
  private readonly idPrefix: string;
  private inCounter = 0;
  private outCounter = 0;
  private nextSendError: Error | null = null;
  private skipDelivery = false;
  private readonly media = new Map<string, Buffer>();
  private readonly groups = new Map<string, WaGroupInfo>();
  private readonly abouts = new Map<string, string>();
  private readonly notOnWhatsApp = new Set<string>();
  /** Every getGroupInfo / getAbout call, for tests that check caching. */
  readonly groupInfoCalls: string[] = [];
  readonly aboutCalls: string[] = [];

  readonly sent: FakeSentRecord[] = [];
  readonly reactions: Array<{ chatJid: string; target: WaReactionTarget; emoji: string }> = [];
  /** Every edit, delete for everyone and delete for me sent (`editText`, `deleteFor…`). */
  readonly changes: Array<
    | { kind: 'edit'; chatJid: string; target: WaMessageTarget; text: string }
    | { kind: 'deleteForEveryone'; chatJid: string; target: WaMessageTarget }
    | { kind: 'deleteForMe'; chatJid: string; target: WaMessageTarget; timestamp: number }
  > = [];
  readonly reads: Array<{ chatJid: string; messageIds: string[] }> = [];
  readonly presences: Array<{ chatJid: string; presence: 'composing' | 'paused' }> = [];
  /** Every template sent (adapters given `templates`). */
  readonly templateSends: Array<{ chatJid: string; template: WaTemplateSend; id: string }> = [];
  /** What this fake connection can do; absent (a linked phone) unless given. */
  readonly capabilities?: WaCapabilities;
  /** Set when `templates` is given: the approved templates (offline → WaUnavailableError). */
  readonly listTemplates?: () => Promise<WaTemplate[]>;
  /** Set when `templates` is given: records the send like `sendText`. */
  readonly sendTemplate?: (chatJid: string, template: WaTemplateSend) => Promise<SendResult>;
  /** The templates `listTemplates` answers (tests may change them). */
  templates: WaTemplate[] = [];
  /** Number of listTemplates calls, for tests that check caching. */
  templateListCalls = 0;

  /**
   * `me`: the linked account (default the fake number 60000000000; `lid` its WhatsApp LID, as groups
   * and mentions show it); `idPrefix`: start of every
   * message id (default `FAKE`), so adapters of different inboxes never share an id.
   * `awaitScan`: a phone that was never linked — `connect()` shows a QR code and stays there
   * until `setConnected(true)` (the dev stand-in for the scan).
   * `capabilities`: what the connection reports (e.g. a Business API stand-in); `templates`: its
   * approved templates, which also turn on `listTemplates`/`sendTemplate`.
   */
  constructor(opts?: {
    autoOpen?: boolean;
    me?: { jid: string; name: string; lid?: string };
    idPrefix?: string;
    awaitScan?: boolean;
    capabilities?: WaCapabilities;
    templates?: WaTemplate[];
  }) {
    super();
    if (opts?.capabilities) this.capabilities = { ...opts.capabilities };
    if (opts?.templates) {
      this.templates = opts.templates.map((t) => ({ ...t, examples: [...t.examples] }));
      this.listTemplates = async () => {
        if (this._status.state !== 'open') throw new WaUnavailableError();
        this.templateListCalls++;
        return this.templates.map((t) => ({ ...t, examples: [...t.examples] }));
      };
      this.sendTemplate = async (chatJid, template) => {
        this.beforeSend();
        const id = `${this.idPrefix}-OUT-${FAKE_RUN}-${++this.outCounter}`;
        this.templateSends.push({
          chatJid,
          template: { ...template, params: [...template.params] },
          id,
        });
        return this.afterSend(chatJid, id);
      };
    }
    this.autoOpen = opts?.autoOpen ?? true;
    this.awaitScan = opts?.awaitScan ?? false;
    this.me = { ...(opts?.me ?? FAKE_ME) };
    this.idPrefix = opts?.idPrefix ?? 'FAKE';
  }

  get status(): WaStatus {
    return this._status;
  }

  override on<K extends keyof WaAdapterEvents>(
    ev: K,
    fn: (...a: WaAdapterEvents[K]) => void,
  ): this {
    return super.on(ev, fn as (...a: unknown[]) => void);
  }

  override off<K extends keyof WaAdapterEvents>(
    ev: K,
    fn: (...a: WaAdapterEvents[K]) => void,
  ): this {
    return super.off(ev, fn as (...a: unknown[]) => void);
  }

  private emitTyped<K extends keyof WaAdapterEvents>(ev: K, ...args: WaAdapterEvents[K]): void {
    this.emit(ev, ...args);
  }

  private setStatus(patch: Partial<WaStatus>): void {
    this._status = { ...this._status, ...patch };
    this.emitTyped('status', this._status);
  }

  async connect(): Promise<void> {
    if (this._status.state === 'open' || this._status.state === 'connecting') return;
    this.setStatus({ state: 'connecting', qr: null, lastError: null });
    if (this.awaitScan) this.setStatus({ state: 'qr', me: null, qr: `FAKE-QR-${this.idPrefix}` });
    else if (this.autoOpen) this.setStatus({ state: 'open', me: { ...this.me }, qr: null });
  }

  async disconnect(): Promise<void> {
    if (this._status.state === 'disconnected') return;
    this.setStatus({ state: 'disconnected', qr: null });
  }

  async logout(): Promise<void> {
    this.setStatus({ state: 'logged_out', me: null, qr: null });
  }

  async takeover(): Promise<void> {
    this.setStatus({ state: 'connecting', qr: null, lastError: null });
    this.setStatus({ state: 'open', me: { ...this.me }, qr: null });
  }

  /** test helper: last phone number a pairing code was requested for */
  pairingRequests: string[] = [];

  async requestPairingCode(phone: string): Promise<string> {
    if (this._status.state === 'open') throw new Error('A WhatsApp number is already linked');
    this.pairingRequests.push(phone.replace(/\D/g, ''));
    return 'FAKE1234';
  }

  private beforeSend(): void {
    if (this._status.state !== 'open') throw new WaUnavailableError();
    if (this.nextSendError) {
      const err = this.nextSendError;
      this.nextSendError = null;
      throw err;
    }
  }

  private afterSend(chatJid: string, id: string): SendResult {
    const timestamp = Date.now();
    this.emitTyped('messageStatus', { id, chatJid, status: 'sent' });
    if (this.skipDelivery) this.skipDelivery = false;
    else setImmediate(() => this.emitTyped('messageStatus', { id, chatJid, status: 'delivered' }));
    return { id, timestamp };
  }

  async sendText(chatJid: string, text: string, opts?: WaSendOptions): Promise<SendResult> {
    this.beforeSend();
    const id = opts?.messageId ?? `${this.idPrefix}-OUT-${FAKE_RUN}-${++this.outCounter}`;
    this.sent.push({
      chatJid,
      text,
      id,
      ...(opts?.quotedId ? { reply: opts } : {}),
      ...(opts?.mentions?.length ? { mentions: [...opts.mentions] } : {}),
      ...(opts?.forwarded ? { forwarded: { ...opts.forwarded } } : {}),
    });
    return this.afterSend(chatJid, id);
  }

  /** A file given by `path` is read from disk, as the real adapter streams it (its `buffer` untouched). */
  async sendMedia(chatJid: string, file: WaSendFile, opts?: WaSendOptions): Promise<SendResult> {
    this.beforeSend();
    const id = opts?.messageId ?? `${this.idPrefix}-OUT-${FAKE_RUN}-${++this.outCounter}`;
    const buffer = file.path ? readFileSync(file.path) : file.buffer;
    const recorded: WaSendFile = {
      buffer,
      mime: file.mime,
      fileName: file.fileName,
      ...(file.caption !== undefined ? { caption: file.caption } : {}),
      ...(file.voiceNote ? { voiceNote: file.voiceNote } : {}),
      ...(file.path ? { path: file.path } : {}),
      ...(file.asDocument ? { asDocument: true } : {}),
    };
    this.sent.push({
      chatJid,
      file: recorded,
      id,
      ...(opts?.quotedId ? { reply: opts } : {}),
      ...(opts?.forwarded ? { forwarded: { ...opts.forwarded } } : {}),
    });
    this.media.set(id, buffer);
    return this.afterSend(chatJid, id);
  }

  /** Like WhatsApp, the linked number's own reaction comes back as a `reaction` event first. */
  async sendReaction(
    chatJid: string,
    target: WaReactionTarget,
    emoji: string,
  ): Promise<SendResult> {
    this.beforeSend();
    const id = `${this.idPrefix}-REACT-${FAKE_RUN}-${++this.outCounter}`;
    const timestamp = Date.now();
    this.reactions.push({ chatJid, target: { ...target }, emoji });
    this.simulateReaction({ chatJid, targetId: target.id, emoji, fromMe: true, timestamp });
    return { id, timestamp };
  }

  /** Unlike reactions, WhatsApp's echo of our own edit or delete is never reported (as Baileys). */
  async editText(chatJid: string, target: WaMessageTarget, text: string): Promise<SendResult> {
    this.beforeSend();
    this.changes.push({ kind: 'edit', chatJid, target: { ...target }, text });
    return { id: `${this.idPrefix}-EDIT-${FAKE_RUN}-${++this.outCounter}`, timestamp: Date.now() };
  }

  async deleteForEveryone(chatJid: string, target: WaMessageTarget): Promise<SendResult> {
    this.beforeSend();
    this.changes.push({ kind: 'deleteForEveryone', chatJid, target: { ...target } });
    return {
      id: `${this.idPrefix}-REVOKE-${FAKE_RUN}-${++this.outCounter}`,
      timestamp: Date.now(),
    };
  }

  async deleteForMe(chatJid: string, target: WaMessageTarget, timestamp: number): Promise<void> {
    this.beforeSend();
    this.changes.push({ kind: 'deleteForMe', chatJid, target: { ...target }, timestamp });
  }

  async markRead(chatJid: string, messageIds: string[]): Promise<void> {
    this.reads.push({ chatJid, messageIds: [...messageIds] });
  }

  async sendPresence(chatJid: string, presence: 'composing' | 'paused'): Promise<void> {
    this.presences.push({ chatJid, presence });
  }

  async downloadMedia(messageId: string): Promise<Buffer | null> {
    return this.media.get(messageId) ?? null;
  }

  async downloadMediaBounded(
    messageId: string,
    options: WaMediaDownloadOptions,
  ): Promise<Buffer | null> {
    validateMediaDownloadOptions(options);
    const buffer = this.media.get(messageId);
    return buffer ? boundedMediaBuffer(buffer, options) : null;
  }

  async getProfilePicture(_jid: string): Promise<string | null> {
    if (this._status.state !== 'open') throw new WaUnavailableError();
    return null;
  }

  async getContactAliases(_jids: string[]): Promise<WaContactAlias[]> {
    return [];
  }

  async getGroupInfo(groupJid: string): Promise<WaGroupInfo> {
    if (this._status.state !== 'open') throw new WaUnavailableError();
    this.groupInfoCalls.push(groupJid);
    const g = this.groups.get(groupJid);
    const info = g ?? {
      jid: groupJid,
      name: null,
      description: null,
      createdAt: null,
      ownerJid: null,
      size: 0,
      participants: [],
    };
    return structuredClone(info);
  }

  async getAbout(jid: string): Promise<string | null> {
    if (this._status.state !== 'open') throw new WaUnavailableError();
    this.aboutCalls.push(jid);
    if (this.aboutFails) throw new Error('About lookup failed');
    return this.abouts.get(jid) ?? null;
  }

  checkNumber(phone: string): Promise<string | null> {
    if (this._status.state !== 'open') return Promise.reject(new WaUnavailableError());
    if (!/^\d{6,15}$/.test(phone) || this.notOnWhatsApp.has(phone)) return Promise.resolve(null);
    return Promise.resolve(`${phone}@s.whatsapp.net`);
  }

  /** Numbers blocked through `setBlocked` (test helper reads it). */
  readonly blocked = new Set<string>();

  async setBlocked(jid: string, blocked: boolean): Promise<void> {
    if (this._status.state !== 'open') throw new WaUnavailableError();
    if (blocked) this.blocked.add(jid);
    else this.blocked.delete(jid);
  }

  // ---- group management: changes the fake group in place and emits `groupChanged` like WhatsApp ----

  /** Every group-management call in order (tests assert on it). */
  readonly groupAdminCalls: Array<{ method: string; groupJid: string; args: unknown[] }> = [];
  private readonly inviteCodes = new Map<string, string>();
  private readonly joinRequests = new Map<string, WaGroupJoinRequest[]>();
  /** Phone JIDs whose privacy settings refuse direct adds (`invite_needed`). */
  private readonly privacyRefuses = new Set<string>();
  /** Invites sent with `sendGroupInvite`. */
  readonly groupInvites: Array<{ groupJid: string; toJid: string; invite: WaGroupInvite }> = [];
  /** Make the next group-management call reject with this error. */
  private nextGroupError: Error | null = null;
  private inviteCounter = 0;

  private groupCall(method: string, groupJid: string, ...args: unknown[]): WaGroupInfo {
    if (this._status.state !== 'open') throw new WaUnavailableError();
    this.groupAdminCalls.push({ method, groupJid, args });
    if (this.nextGroupError) {
      const err = this.nextGroupError;
      this.nextGroupError = null;
      throw err;
    }
    const g = this.groups.get(groupJid);
    if (!g) throw new Error('Fake group not found');
    return g;
  }

  private changed(groupJid: string): void {
    this.emitTyped('groupChanged', { groupJid });
  }

  private newInviteCode(): string {
    return `FAKEINVITE${String(++this.inviteCounter).padStart(12, '0')}`;
  }

  async setGroupSubject(groupJid: string, subject: string): Promise<void> {
    this.groupCall('setGroupSubject', groupJid, subject).name = subject;
    this.changed(groupJid);
  }

  async setGroupDescription(groupJid: string, description: string | null): Promise<void> {
    this.groupCall('setGroupDescription', groupJid, description).description = description || null;
    this.changed(groupJid);
  }

  async updateGroupMembers(
    groupJid: string,
    jids: [string],
    action: 'add' | 'remove' | 'promote' | 'demote',
  ): Promise<WaParticipantResult[]> {
    const g = this.groupCall('updateGroupMembers', groupJid, jids, action);
    const results = jids.map((jid): WaParticipantResult => {
      const i = g.participants.findIndex(
        (p) => p.jid === jid || p.phoneJid === jid || p.lidJid === jid,
      );
      const p = i >= 0 ? g.participants[i] : undefined;
      if (action === 'add') {
        if (p) return { jid, status: 'already' };
        if (this.privacyRefuses.has(jid))
          return {
            jid,
            status: 'invite_needed',
            invite: { code: this.newInviteCode(), expiresAt: Date.now() + 3 * 86_400_000 },
          };
        g.participants.push({ jid, phoneJid: jid, lidJid: null, username: null, role: 'member' });
        g.size = Math.max(g.size + 1, g.participants.length);
        return { jid, status: 'ok' };
      }
      if (!p) return { jid, status: 'not_member' };
      if (p.role === 'superadmin') return { jid, status: 'not_allowed' };
      if (action === 'remove') {
        g.participants.splice(i, 1);
        g.size = Math.max(g.size - 1, g.participants.length);
      } else if (action === 'promote') {
        if (p.role === 'admin') return { jid, status: 'already' };
        p.role = 'admin';
      } else {
        if (p.role === 'member') return { jid, status: 'already' };
        p.role = 'member';
      }
      return { jid, status: 'ok' };
    });
    if (results.some((r) => r.status === 'ok')) this.changed(groupJid);
    return results;
  }

  async sendGroupInvite(groupJid: string, toJid: string, invite: WaGroupInvite): Promise<void> {
    this.groupCall('sendGroupInvite', groupJid, toJid, invite);
    this.groupInvites.push({ groupJid, toJid, invite: { ...invite } });
  }

  async getGroupInviteLink(groupJid: string): Promise<string> {
    this.groupCall('getGroupInviteLink', groupJid);
    let code = this.inviteCodes.get(groupJid);
    if (!code) {
      code = this.newInviteCode();
      this.inviteCodes.set(groupJid, code);
    }
    return `https://chat.whatsapp.com/${code}`;
  }

  async resetGroupInviteLink(groupJid: string): Promise<string> {
    this.groupCall('resetGroupInviteLink', groupJid);
    const code = this.newInviteCode();
    this.inviteCodes.set(groupJid, code);
    this.changed(groupJid);
    return `https://chat.whatsapp.com/${code}`;
  }

  async setGroupSettings(groupJid: string, settings: Partial<WaGroupSettings>): Promise<void> {
    const g = this.groupCall('setGroupSettings', groupJid, settings);
    g.settings = { ...g.settings, ...settings };
    this.changed(groupJid);
  }

  async listGroupJoinRequests(groupJid: string): Promise<WaGroupJoinRequest[]> {
    this.groupCall('listGroupJoinRequests', groupJid);
    return structuredClone(this.joinRequests.get(groupJid) ?? []);
  }

  async decideGroupJoinRequest(
    groupJid: string,
    jid: string,
    approve: boolean,
  ): Promise<WaParticipantResult> {
    const g = this.groupCall('decideGroupJoinRequest', groupJid, jid, approve);
    const list = this.joinRequests.get(groupJid) ?? [];
    const i = list.findIndex((r) => r.jid === jid);
    if (i < 0) return { jid, status: 'not_member' };
    const [req] = list.splice(i, 1);
    if (approve)
      g.participants.push({
        jid: req!.jid,
        phoneJid: req!.phoneJid,
        lidJid: req!.jid.endsWith('@lid') ? req!.jid : null,
        username: null,
        role: 'member',
      });
    if (approve) g.size = Math.max(g.size + 1, g.participants.length);
    this.changed(groupJid);
    return { jid, status: 'ok' };
  }

  /** Someone asks to join (test helper; `phone` digits). */
  addJoinRequest(groupJid: string, phone: string, at = Date.now()): void {
    const jid = `${phone}@s.whatsapp.net`;
    const list = this.joinRequests.get(groupJid) ?? [];
    if (!list.some((r) => r.jid === jid)) list.push({ jid, phoneJid: jid, at });
    this.joinRequests.set(groupJid, list);
  }

  /** Adding this number answers `invite_needed` (its privacy settings refuse direct adds). */
  setPrivacyRefuses(phone: string): void {
    this.privacyRefuses.add(`${phone}@s.whatsapp.net`);
  }

  /** The next group-management call rejects with `err`. */
  failNextGroupChange(err: Error = new Error('Fake group change failure')): void {
    this.nextGroupError = err;
  }

  /** checkNumber answers null for this number (every other valid number has an account). */
  setNotOnWhatsApp(phone: string): void {
    this.notOnWhatsApp.add(phone);
  }

  /** Make the next getAbout calls fail, as a WhatsApp request error would. */
  aboutFails = false;

  // ---- test helpers ----

  /** What getGroupInfo returns for this group (members as WhatsApp lists them, no names). */
  setGroupInfo(info: WaGroupInfo): void {
    this.groups.set(info.jid, structuredClone(info));
  }

  /** What getAbout returns for this person. */
  setAbout(jid: string, about: string): void {
    this.abouts.set(jid, about);
  }

  /** Emit `groupChanged`, as WhatsApp does when members are added, removed, promoted or demoted. */
  simulateGroupChanged(groupJid: string): void {
    this.emitTyped('groupChanged', { groupJid });
  }

  /** makes downloadMedia(messageId) return `buffer` */
  setMedia(messageId: string, buffer: Buffer): void {
    this.media.set(messageId, buffer);
  }

  /** Emit explicit PN/LID pairs as the adapter does when WhatsApp reveals them. */
  simulateContactAliases(pairs: WaContactAlias[]): void {
    this.emitTyped(
      'contactAliases',
      pairs.map((p) => ({ ...p })),
    );
  }

  /** Emit an incoming live message. Generates id `FAKE-<run>-<n>` unless given. */
  simulateIncoming(
    p: Partial<WaIncomingMessage> & { chatJid: string; body: string },
  ): WaIncomingMessage {
    // Unique per process start: a restarted dev server must not reuse ids already stored in app.db.
    const id = p.id ?? `${this.idPrefix}-${FAKE_RUN}-${++this.inCounter}`;
    const isGroup = p.chatJid.endsWith('@g.us');
    const msg: WaIncomingMessage = {
      id,
      chatJid: p.chatJid,
      chatJidAlt: p.chatJidAlt ?? null,
      senderJid: p.senderJid !== undefined ? p.senderJid : isGroup ? null : p.chatJid,
      senderJidAlt: p.senderJidAlt ?? null,
      senderName: p.senderName ?? null,
      fromMe: p.fromMe ?? false,
      type: p.type ?? 'text',
      body: p.body,
      ...(p.mentionedJids !== undefined ? { mentionedJids: [...p.mentionedJids] } : {}),
      quotedId: p.quotedId ?? null,
      ...(p.forwardingScore ? { forwardingScore: p.forwardingScore } : {}),
      timestamp: p.timestamp ?? Date.now(),
      media: p.media
        ? {
            ...p.media,
            // Fake downloads are already-allocated fixtures, never untrusted network streams.
            downloadBounded:
              p.media.downloadBounded ??
              (async (options: WaMediaDownloadOptions) => {
                validateMediaDownloadOptions(options);
                return boundedMediaBuffer(await p.media!.download(), options);
              }),
          }
        : null,
    };
    this.emitTyped('message', msg, { source: 'live' });
    return msg;
  }

  /**
   * Emit a reaction (live unless `source` says history): `emoji` '' removes the person's reaction.
   * In a DM the reactor defaults to the chat partner; `fromMe` means the linked number reacted.
   */
  simulateReaction(
    p: Partial<WaReaction> & { chatJid: string; targetId: string; emoji: string },
    source: 'live' | 'history' = 'live',
  ): WaReaction {
    const isGroup = p.chatJid.endsWith('@g.us');
    const fromMe = p.fromMe ?? false;
    const reaction: WaReaction = {
      targetId: p.targetId,
      chatJid: p.chatJid,
      chatJidAlt: p.chatJidAlt ?? null,
      senderJid: fromMe
        ? null
        : p.senderJid !== undefined
          ? p.senderJid
          : isGroup
            ? null
            : p.chatJid,
      senderJidAlt: p.senderJidAlt ?? null,
      senderName: p.senderName ?? null,
      fromMe,
      emoji: p.emoji,
      timestamp: p.timestamp ?? Date.now(),
    };
    this.emitTyped('reaction', reaction, { source });
    return reaction;
  }

  /**
   * Emit an edit (live unless `source` says history). In a DM the editor defaults to the chat
   * partner; `fromMe` means the linked phone edited.
   */
  simulateEdit(
    p: Partial<WaMessageEdit> & { chatJid: string; targetId: string; body: string },
    source: 'live' | 'history' = 'live',
  ): WaMessageEdit {
    const edit: WaMessageEdit = { ...this.changeAuthor(p), body: p.body };
    this.emitTyped('messageEdited', edit, { source });
    return edit;
  }

  /** Emit a delete for everyone (live unless `source` says history), as `simulateEdit`. */
  simulateRevoke(
    p: Partial<WaMessageRevoke> & { chatJid: string; targetId: string },
    source: 'live' | 'history' = 'live',
  ): WaMessageRevoke {
    const revoke = this.changeAuthor(p);
    this.emitTyped('messageDeleted', revoke, { source });
    return revoke;
  }

  private changeAuthor(
    p: Partial<WaMessageRevoke> & { chatJid: string; targetId: string },
  ): WaMessageRevoke {
    const isGroup = p.chatJid.endsWith('@g.us');
    const fromMe = p.fromMe ?? false;
    return {
      targetId: p.targetId,
      chatJid: p.chatJid,
      chatJidAlt: p.chatJidAlt ?? null,
      senderJid: fromMe
        ? null
        : p.senderJid !== undefined
          ? p.senderJid
          : isGroup
            ? null
            : p.chatJid,
      senderJidAlt: p.senderJidAlt ?? null,
      fromMe,
      timestamp: p.timestamp ?? Date.now(),
    };
  }

  simulateStatus(s: Partial<WaStatus>): void {
    this.setStatus(s);
  }

  /** The next send gets its server ack but no delivered receipt (no phone took it). */
  skipNextDelivery(): void {
    this.skipDelivery = true;
  }

  failNextSend(err: Error = new Error('Fake send failure')): void {
    this.nextSendError = err;
  }

  setConnected(connected: boolean): void {
    if (connected) this.awaitScan = false;
    if (connected) this.setStatus({ state: 'open', me: { ...this.me }, qr: null, lastError: null });
    else this.setStatus({ state: 'disconnected', qr: null });
  }
}
