import { EventEmitter } from 'node:events';
import {
  Browsers,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  makeWASocket,
  proto,
  type AnyMessageContent,
  type BaileysEventMap,
  type Chat,
  type Contact,
  type GroupMetadata,
  type MessageUpsertType,
  type MessageUserReceiptUpdate,
  type SignalKeyStore,
  type WAMessageUpdate,
  type WAMessage,
  type WAMessageKey,
  type WASocket,
} from 'baileys';
import { pino, type Logger } from 'pino';
import type { WaStatus } from '@ezychat/shared';
import {
  WaUnavailableError,
  type SendResult,
  type WaAdapter,
  type WaAdapterEvents,
  type WaAdapterOptions,
  type WaChatInfo,
  type WaContactInfo,
  type WaAliasSource,
  type WaContactAlias,
  type WaGroupInfo,
  type WaMessageStatusUpdate,
  type WaMessageTarget,
  type WaReactionTarget,
  type WaSendFile,
  type WaSendOptions,
} from '../types.js';
import { createAuthStore, type AuthStore } from './auth-store.js';
import { backoffMs, classifyDisconnect } from './disconnect.js';
import { Lru } from './lru.js';
import { jidType, mapStoredReactions, mapWAMessage, mapWAReaction, toMs } from './mapping.js';
import { quotedForChat, quotedFromRef } from './quoted.js';
import { mapWAProtocol } from './protocol.js';
import { contactAliasPair, normalizeContactJid } from './contact-aliases.js';
import { checkedNumberJid } from './number-check.js';
import { profilePhoto } from './photos.js';
import { aboutFromStatusResult, mapGroupMetadata } from './groups.js';

type ILogger = NonNullable<Parameters<typeof makeWASocket>[0]['logger']>;

const RAW_CACHE_MAX = 2000;
/** How long an edit or delete this adapter sent waits for WhatsApp's echo of it. */
const OWN_CHANGE_TTL_MS = 60_000;
const DAY_MS = 86_400_000;

type BoomLike = { output?: { statusCode?: number }; message?: string };

/** Boom status codes Baileys uses when the socket is closed / lost / replaced / unavailable. */
const CONNECTION_STATUS_CODES = new Set([408, 428, 440, 503]);

/** True when a send error means "the connection went away" (retry later) rather than a real rejection. */
export function isConnectionError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as BoomLike & { isBoom?: boolean };
  const code = e.output?.statusCode;
  if (code !== undefined && CONNECTION_STATUS_CODES.has(code)) return true;
  return /connection (closed|lost|terminated)|socket (closed|hang up)|not open/i.test(
    String(e.message ?? ''),
  );
}

/** Per-participant group receipt → our status (read wins over delivered). */
export function receiptStatus(
  r: MessageUserReceiptUpdate['receipt'],
): WaMessageStatusUpdate['status'] | null {
  if (r.readTimestamp || r.playedTimestamp) return 'read';
  if (r.receiptTimestamp) return 'delivered';
  return null;
}

/** proto.WebMessageInfo.Status → our status. */
function mapAck(status: number | null | undefined): WaMessageStatusUpdate['status'] | null {
  switch (status) {
    case proto.WebMessageInfo.Status.ERROR:
      return 'failed';
    case proto.WebMessageInfo.Status.SERVER_ACK:
      return 'sent';
    case proto.WebMessageInfo.Status.DELIVERY_ACK:
      return 'delivered';
    case proto.WebMessageInfo.Status.READ:
    case proto.WebMessageInfo.Status.PLAYED:
      return 'read';
    default:
      return null;
  }
}

/**
 * Real WhatsApp connection via Baileys (WhatsApp Web multi-device protocol).
 * This is the only module in the repo allowed to import `baileys`.
 */
/**
 * Browser identity sent at registration. WhatsApp terminates the registration (428 before any QR)
 * for 'Desktop' identities such as Browsers.appropriate('Desktop'); a Chrome web client is accepted
 * and is also required for phone-number pairing codes.
 */
export const WA_BROWSER = Browsers.ubuntu('Chrome');

/** Digits only, with country code (8–15 digits, E.164 without '+'). */
export function normalizePairingPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) {
    throw new Error('Enter the phone number with country code, e.g. +60 12-345 6789');
  }
  return digits;
}

const PAIRING_READY_TIMEOUT_MS = 20_000;

export class BaileysAdapter extends EventEmitter implements WaAdapter {
  private _status: WaStatus = { state: 'disconnected', me: null, qr: null, lastError: null };
  private sock: WASocket | null = null;
  private readonly auth: AuthStore;
  private readonly logger: Logger;
  private readonly historyDaysOpt: WaAdapterOptions['historyDays'];
  private raw = new Lru<string, WAMessage>(RAW_CACHE_MAX);
  /**
   * Target ids of edits and deletes this adapter sent → when: WhatsApp echoes them back like the
   * phone's own, and the core already recorded them with the teammate who made them.
   */
  private readonly ownChanges = new Map<string, number>();
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  /** true when the socket was closed on purpose (disconnect/logout/replaced/blocked). */
  private stopped = true;
  private connecting: Promise<void> | null = null;
  private signalKeys: SignalKeyStore | null = null;
  private readonly contactAliases = new Map<string, string>();
  /** Invalidates local-key reads when a socket closes or the linked account changes. */
  private aliasGeneration = 0;

  constructor(opts: WaAdapterOptions) {
    super();
    this.auth = createAuthStore(opts.authDir);
    this.historyDaysOpt = opts.historyDays;
    this.logger = opts.logger ?? pino({ level: 'silent' });
  }

  /** current history_days (re-read each time so a settings change applies on the next relink) */
  private get historyDays(): number {
    const v =
      typeof this.historyDaysOpt === 'function' ? this.historyDaysOpt() : this.historyDaysOpt;
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
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
    try {
      this.emit(ev, ...args);
    } catch (err) {
      this.logger.error({ err, ev }, 'wa listener threw');
    }
  }

  private setStatus(patch: Partial<WaStatus>): void {
    this._status = { ...this._status, ...patch };
    this.emitTyped('status', this._status);
  }

  // ---------------------------------------------------------------- lifecycle

  async connect(): Promise<void> {
    this.stopped = false;
    if (this.sock || this.connecting) return this.connecting ?? undefined;
    this.clearReconnect();
    this.connecting = this.open().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    this.clearReconnect();
    await this.closeSocket();
    this.setStatus({ state: 'disconnected', qr: null });
  }

  async logout(): Promise<void> {
    this.stopped = true;
    this.clearContactAliases();
    this.clearReconnect();
    const sock = this.sock;
    if (sock) {
      try {
        await sock.logout();
      } catch (err) {
        this.logger.warn({ err }, 'wa logout request failed; wiping auth anyway');
      }
    }
    await this.closeSocket();
    await this.auth.wipe();
    this.setStatus({ state: 'logged_out', me: null, qr: null });
  }

  async takeover(): Promise<void> {
    this.attempt = 0;
    await this.closeSocket();
    await this.connect();
  }

  /**
   * Link by phone number instead of QR: returns the 8-character code the user types in
   * WhatsApp → Linked devices → Link with phone number instead.
   */
  async requestPairingCode(phone: string): Promise<string> {
    const digits = normalizePairingPhone(phone);
    if (this._status.state === 'open') throw new Error('A WhatsApp number is already linked');
    await this.connect();
    await this.waitForPairingReady();
    const sock = this.sock;
    if (!sock) throw new WaUnavailableError();
    return sock.requestPairingCode(digits);
  }

  /** The socket can request a code once the server has offered a QR (i.e. registration started). */
  private waitForPairingReady(): Promise<void> {
    if (this.sock && this._status.state === 'qr') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('status', onStatus);
        reject(new WaUnavailableError());
      }, PAIRING_READY_TIMEOUT_MS);
      const onStatus = (s: WaStatus) => {
        if (s.state === 'qr' && this.sock) {
          clearTimeout(timer);
          this.off('status', onStatus);
          resolve();
        }
      };
      this.on('status', onStatus);
    });
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private async closeSocket(): Promise<void> {
    this.signalKeys = null;
    this.aliasGeneration++;
    const sock = this.sock;
    this.sock = null;
    if (!sock) return;
    sock.ev.removeAllListeners('connection.update');
    try {
      await sock.end(undefined);
    } catch {
      /* already closed */
    }
  }

  private scheduleReconnect(immediate = false): void {
    if (this.stopped) return;
    this.clearReconnect();
    const delay = immediate ? 0 : backoffMs(this.attempt++);
    this.logger.info({ delay, attempt: this.attempt }, 'wa reconnect scheduled');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((err) => {
        this.logger.error({ err }, 'wa reconnect failed');
        this.setStatus({
          state: 'disconnected',
          lastError: String((err as Error)?.message ?? err),
        });
        this.scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async open(): Promise<void> {
    this.setStatus({ state: 'connecting', qr: null });
    const { state, saveCreds } = await this.auth.load();

    let version: [number, number, number] | undefined;
    try {
      const latest = await fetchLatestBaileysVersion();
      version = latest.version;
    } catch (err) {
      this.logger.warn({ err }, 'could not fetch latest WA version; using bundled default');
    }

    if (this.stopped) return; // disconnect() was called while loading

    const blog = this.logger.child({ module: 'baileys' }) as unknown as ILogger;
    const keys = makeCacheableSignalKeyStore(state.keys, blog);
    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: { creds: state.creds, keys },
      logger: blog,
      browser: WA_BROWSER,
      syncFullHistory: this.historyDays > 0,
      markOnlineOnConnect: false,
      // Per-message filtering by historyDays happens in onHistory/ingest.
      shouldSyncHistoryMessage: () => this.historyDays > 0,
      getMessage: async (key) =>
        key.id ? (this.raw.get(key.id)?.message ?? undefined) : undefined,
    });
    this.sock = sock;
    this.signalKeys = keys;
    this.aliasGeneration++;

    const alive = () => !this.stopped && this.sock === sock;

    sock.ev.on('creds.update', () => {
      if (!alive()) return;
      saveCreds().catch((err) => this.logger.error({ err }, 'saveCreds failed'));
    });

    sock.ev.on('connection.update', (u) => {
      if (!alive()) return;
      this.onConnectionUpdate(sock, u);
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (!alive()) return;
      this.handleUpsert(messages, type);
    });

    sock.ev.on('messaging-history.set', (h) => {
      if (!alive()) return;
      this.onHistory(h);
    });

    sock.ev.on('messages.update', (updates) => {
      if (!alive()) return;
      this.handleMessageUpdates(updates);
    });

    // Group chats: delivered/read arrive as per-participant receipts, not messages.update.
    sock.ev.on('message-receipt.update', (updates) => {
      if (!alive()) return;
      this.handleReceipts(updates);
    });

    sock.ev.on('contacts.upsert', (cs) => alive() && this.emitContacts(cs));
    sock.ev.on('contacts.update', (cs) => alive() && this.emitContacts(cs));
    sock.ev.on('lid-mapping.update', ({ lid, pn }) => {
      if (alive()) this.emitAliasPairs([[lid, pn]], 'lid-mapping');
    });
    sock.ev.on('chats.upsert', (cs) => alive() && this.emitChats(cs));
    sock.ev.on('groups.upsert', (gs) => alive() && this.emitGroups(gs));
    sock.ev.on('groups.update', (gs) => {
      if (!alive()) return;
      this.emitGroups(gs);
      for (const g of gs) if (g.id) this.emitTyped('groupChanged', { groupJid: g.id });
    });
    sock.ev.on('group-participants.update', ({ id }) => {
      if (alive() && id) this.emitTyped('groupChanged', { groupJid: id });
    });
  }

  private onConnectionUpdate(sock: WASocket, u: BaileysEventMap['connection.update']): void {
    if (u.qr) {
      // The server is talking to us again; don't let earlier failures stretch the next retry.
      this.attempt = 0;
      this.setStatus({ state: 'qr', qr: u.qr });
    }
    if (u.connection === 'connecting' && this._status.state !== 'qr') {
      this.setStatus({ state: 'connecting' });
    }
    if (u.connection === 'open') {
      this.attempt = 0;
      const user = sock.user;
      this.setStatus({
        state: 'open',
        qr: null,
        lastError: null,
        me: user
          ? {
              jid: jidNormalizedUser(user.id),
              name: user.name ?? user.notify ?? null,
              lid: user.lid ? jidNormalizedUser(user.lid) : null,
            }
          : null,
      });
    }
    if (u.connection === 'close') {
      const err = u.lastDisconnect?.error as BoomLike | undefined;
      const code = err?.output?.statusCode;
      const message = err?.message ?? (code ? `closed (${code})` : 'connection closed');
      this.sock = null;
      this.signalKeys = null;
      this.aliasGeneration++;
      void this.handleClose(code, message);
    }
  }

  private async handleClose(code: number | undefined, message: string): Promise<void> {
    if (this.stopped) {
      this.setStatus({ state: 'disconnected', qr: null });
      return;
    }
    const action = classifyDisconnect(code);
    this.logger.warn({ code, action, message }, 'wa connection closed');
    switch (action) {
      case 'reconnect':
        this.setStatus({ state: 'connecting', lastError: message });
        // 515 restartRequired is expected right after pairing: reconnect at once.
        this.scheduleReconnect(code === 515);
        return;
      case 'logged_out':
        this.stopped = true;
        this.clearContactAliases();
        await this.auth.wipe().catch((e) => this.logger.error({ err: e }, 'auth wipe failed'));
        this.setStatus({ state: 'logged_out', me: null, qr: null, lastError: message });
        return;
      case 'replaced':
        this.stopped = true;
        this.setStatus({ state: 'replaced', qr: null, lastError: message });
        return;
      case 'bad_session':
        this.clearContactAliases();
        try {
          const bak = await this.auth.backup();
          this.logger.warn({ bak }, 'bad session: auth backed up, wiping to request relink');
          await this.auth.wipe();
        } catch (e) {
          this.logger.error({ err: e }, 'bad session backup/wipe failed');
        }
        this.setStatus({ state: 'connecting', me: null, qr: null, lastError: message });
        this.scheduleReconnect(true);
        return;
      case 'blocked':
        this.stopped = true;
        this.setStatus({ state: 'blocked', qr: null, lastError: message });
        return;
    }
  }

  // ---------------------------------------------------------------- inbound

  private historyCutoff(): number {
    return this.historyDays > 0 ? Date.now() - this.historyDays * DAY_MS : Number.POSITIVE_INFINITY;
  }

  /**
   * messages.upsert. 'notify' = live; 'append' = messages queued while we were offline (or our own
   * sends / notifications) — also live: they are new to us, must bump unread / reopen / notify, and
   * must never be dropped by the history cutoff. Only messaging-history.set is history.
   * @internal exposed for tests
   */
  handleUpsert(messages: WAMessage[], _type: MessageUpsertType): void {
    for (const m of messages) this.ingest(m, 'live');
  }

  /** @internal exposed for tests */
  handleMessageUpdates(updates: WAMessageUpdate[]): void {
    for (const { key, update } of updates) {
      if (!key.id || !key.remoteJid || !key.fromMe) continue;
      const status = mapAck(update.status);
      if (!status) continue;
      const code = status === 'failed' ? update.messageStubParameters?.[0] : undefined;
      this.emitTyped('messageStatus', {
        id: key.id,
        chatJid: key.remoteJid,
        status,
        ...(typeof code === 'string' && code ? { error: code } : {}),
      });
    }
  }

  /** @internal exposed for tests */
  handleReceipts(updates: MessageUserReceiptUpdate[]): void {
    for (const { key, receipt } of updates) {
      if (!key.id || !key.remoteJid || !key.fromMe) continue;
      const status = receiptStatus(receipt);
      if (status) this.emitTyped('messageStatus', { id: key.id, chatJid: key.remoteJid, status });
    }
  }

  private ingest(m: WAMessage, source: 'live' | 'history'): void {
    this.emitAliasPairs(
      [
        [m.key?.remoteJid, m.key?.remoteJidAlt],
        [m.key?.participant, m.key?.participantAlt],
      ],
      source === 'history' ? 'history' : 'message',
    );
    const id = m.key?.id;
    if (!id) return;
    // A reaction arrives as its own message in messages.upsert (live) and in history batches.
    // Baileys also emits messages.reaction for the same live reaction: that event is not
    // subscribed, so a reaction is counted once.
    const reaction = mapWAReaction(m);
    if (reaction) {
      if (source === 'history' && reaction.timestamp < this.historyCutoff()) return;
      this.emitTyped('reaction', reaction, { source });
      return;
    }
    // Edits and deletes arrive as protocol messages naming the changed message. Baileys also
    // reports them as messages.update; only this path is read, so each change counts once.
    const change = mapWAProtocol(m);
    if (change) {
      const { targetId, fromMe, timestamp } = change.kind === 'edit' ? change.edit : change.revoke;
      if (source === 'history' && timestamp < this.historyCutoff()) return;
      if (fromMe && this.takeOwnChange(targetId)) return;
      if (change.kind === 'edit') this.emitTyped('messageEdited', change.edit, { source });
      else this.emitTyped('messageDeleted', change.revoke, { source });
      return;
    }
    if (m.message) this.raw.set(id, m);
    // History sync keeps earlier reactions on the reacted message itself.
    if (source === 'history')
      for (const r of mapStoredReactions(m)) this.emitTyped('reaction', r, { source });
    const mapped = mapWAMessage(m, (raw) => this.download(raw));
    if (!mapped) return;
    if (source === 'history' && mapped.timestamp < this.historyCutoff()) return;
    this.emitTyped('message', mapped, { source });
  }

  /** @internal exposed for tests */
  onHistory(h: BaileysEventMap['messaging-history.set']): void {
    this.emitAliasPairs(
      (h.lidPnMappings ?? []).map(({ lid, pn }) => [lid, pn]),
      'history',
    );
    if (h.contacts?.length) this.emitContacts(h.contacts);
    if (h.chats?.length) this.emitChats(h.chats);
    const cutoff = this.historyCutoff();
    for (const m of h.messages ?? []) {
      if (toMs(m.messageTimestamp as number | null | undefined, 0) < cutoff) continue;
      this.ingest(m, 'history');
    }
  }

  private emitContacts(cs: Array<Partial<Contact>>): void {
    this.emitAliasPairs(
      cs.flatMap((c) => [
        [c.id, c.lid],
        [c.id, c.phoneNumber],
        [c.lid, c.phoneNumber],
      ]),
      'contacts',
    );
    const out: WaContactInfo[] = [];
    for (const c of cs) {
      const jid = normalizeContactJid(c.id);
      if (!jid) continue;
      const alias = this.contactAliases.get(jid);
      out.push({
        jid,
        pushName: c.notify?.trim() || c.verifiedName?.trim() || null,
        savedName: c.name?.trim() || null,
        ...(alias ? { aliases: [alias] } : {}),
      });
    }
    if (out.length) this.emitTyped('contacts', out);
    // The synchronous name event is stored first; late local mappings then connect it to the chat.
    const generation = this.aliasGeneration;
    void this.getContactAliases(out.map((c) => c.jid))
      .then((aliases) => {
        if (generation === this.aliasGeneration && aliases.length)
          this.emitTyped('contactAliases', aliases);
      })
      .catch(() => {
        this.logger.warn({ contactCount: out.length }, 'local contact alias lookup failed');
      });
  }

  private clearContactAliases(): void {
    this.contactAliases.clear();
    this.raw = new Lru<string, WAMessage>(RAW_CACHE_MAX);
    this.signalKeys = null;
    this.aliasGeneration++;
  }

  /** Cache and emit only explicit PN/LID associations; reject contradictory associations. */
  private emitAliasPairs(pairs: Array<[unknown, unknown]>, source: WaAliasSource): void {
    const out: WaContactAlias[] = [];
    for (const [first, second] of pairs) {
      const pair = contactAliasPair(first, second);
      if (pair && this.rememberAlias(pair)) out.push({ ...pair, source });
    }
    if (out.length) {
      this.logger.debug({ mappingCount: out.length, source }, 'contact aliases received');
      this.emitTyped('contactAliases', out);
    }
  }

  private rememberAlias({ jid, alias }: WaContactAlias): boolean {
    const oldAlias = this.contactAliases.get(jid);
    const oldJid = this.contactAliases.get(alias);
    if ((oldAlias && oldAlias !== alias) || (oldJid && oldJid !== jid)) return false;
    if (oldAlias === alias && oldJid === jid) return false;
    this.contactAliases.set(jid, alias);
    this.contactAliases.set(alias, jid);
    return true;
  }

  async getContactAliases(jids: string[]): Promise<WaContactAlias[]> {
    const normalized = [
      ...new Set(jids.map(normalizeContactJid).filter((jid): jid is string => !!jid)),
    ];
    const keys = this.signalKeys;
    const generation = this.aliasGeneration;
    const pending = normalized.filter((jid) => !this.contactAliases.has(jid));
    // keys.get reads files concurrently: bound each batch for large imported address books.
    if (keys) {
      for (let start = 0; start < pending.length; start += 256) {
        const batch = pending.slice(start, start + 256);
        const ids = batch.map((jid) =>
          jid.endsWith('@lid') ? `${jid.split('@')[0]}_reverse` : jid.split('@')[0]!,
        );
        const stored = await keys.get('lid-mapping', ids);
        if (generation !== this.aliasGeneration || keys !== this.signalKeys) return [];
        for (let i = 0; i < batch.length; i++) {
          const jid = batch[i]!;
          const user = stored[ids[i]!];
          if (typeof user !== 'string' || !/^\d+$/.test(user)) continue;
          const pair = contactAliasPair(
            jid,
            `${user}@${jid.endsWith('@lid') ? 's.whatsapp.net' : 'lid'}`,
          );
          if (pair) this.rememberAlias(pair);
        }
      }
    }
    const out = new Map<string, WaContactAlias>();
    for (const jid of normalized) {
      const alias = this.contactAliases.get(jid);
      const pair = contactAliasPair(jid, alias);
      if (pair) out.set(pair.jid, { ...pair, source: 'keystore' });
    }
    return [...out.values()];
  }

  private emitChats(cs: Array<Partial<Chat>>): void {
    const out: WaChatInfo[] = [];
    for (const c of cs) {
      if (!c.id) continue;
      const t = jidType(c.id);
      if (t === 'other') continue;
      out.push({ jid: c.id, type: t, name: c.name ?? null });
    }
    if (out.length) this.emitTyped('chats', out);
  }

  private emitGroups(gs: Array<Partial<GroupMetadata>>): void {
    const out: WaChatInfo[] = [];
    for (const g of gs) {
      if (!g.id || jidType(g.id) !== 'group') continue;
      out.push({ jid: g.id, type: 'group', name: g.subject ?? null });
    }
    if (out.length) this.emitTyped('chats', out);
  }

  private async download(raw: WAMessage): Promise<Buffer> {
    const sock = this.sock;
    const buf = await downloadMediaMessage(
      raw,
      'buffer',
      {},
      sock
        ? { reuploadRequest: sock.updateMediaMessage, logger: this.logger as unknown as ILogger }
        : undefined,
    );
    return buf as Buffer;
  }

  // ---------------------------------------------------------------- outbound

  private requireOpen(): WASocket {
    if (!this.sock || this._status.state !== 'open') throw new WaUnavailableError();
    return this.sock;
  }

  private async send(
    chatJid: string,
    content: AnyMessageContent,
    opts?: WaSendOptions,
    /** keep the sent message for quotes and media (not for reactions) */
    cache = true,
  ): Promise<SendResult> {
    const sock = this.requireOpen();
    // The live cache is small and cleared on reconnect; rebuild older quotes from the saved copy.
    // Either way the quote points at the chat the reply goes to (phone number or WhatsApp ID).
    const cached = opts?.quotedId ? this.raw.get(opts.quotedId) : undefined;
    const quoted = cached
      ? quotedForChat(cached, chatJid)
      : opts?.quotedId && opts.quoted
        ? quotedFromRef(opts.quoted, chatJid)
        : undefined;
    let res: WAMessage | undefined;
    try {
      const options = {
        ...(quoted ? { quoted } : {}),
        ...(opts?.messageId ? { messageId: opts.messageId } : {}),
      };
      res = await sock.sendMessage(
        chatJid,
        content,
        Object.keys(options).length ? options : undefined,
      );
    } catch (err) {
      // connection dropped mid-send: report as unavailable so the queue keeps the job pending
      if (isConnectionError(err) || this.sock !== sock || this._status.state !== 'open') {
        throw new WaUnavailableError(
          `WhatsApp connection lost: ${String((err as Error)?.message ?? err)}`,
        );
      }
      throw err;
    }
    const id = res?.key?.id;
    if (!res || !id) throw new Error('send returned no message id');
    if (cache) this.raw.set(id, res);
    return { id, timestamp: toMs(res.messageTimestamp as number | null | undefined) };
  }

  sendText(chatJid: string, text: string, opts?: WaSendOptions): Promise<SendResult> {
    // A tag is `@<number>` in the text plus the member's address in `mentions` (contextInfo).
    const mentions = opts?.mentions?.length ? { mentions: [...opts.mentions] } : {};
    return this.send(chatJid, { text, ...mentions }, opts);
  }

  sendMedia(chatJid: string, file: WaSendFile, opts?: WaSendOptions): Promise<SendResult> {
    const { buffer, mime, fileName, caption } = file;
    let content: AnyMessageContent;
    if (mime.startsWith('image/') && mime !== 'image/webp') {
      content = { image: buffer, mimetype: mime, ...(caption ? { caption } : {}) };
    } else if (mime === 'image/webp') {
      content = { sticker: buffer, mimetype: mime };
    } else if (mime.startsWith('video/')) {
      content = { video: buffer, mimetype: mime, ...(caption ? { caption } : {}) };
    } else if (file.voiceNote) {
      // Seconds and waveform are given, so Baileys needs neither music-metadata nor audio-decode.
      // Baileys copies `waveform` into the audio message but leaves it out of its content type.
      const voice: AnyMessageContent & { waveform: Uint8Array } = {
        audio: buffer,
        mimetype: 'audio/ogg; codecs=opus',
        ptt: true,
        seconds: file.voiceNote.seconds,
        waveform: file.voiceNote.waveform,
      };
      content = voice;
    } else if (mime.startsWith('audio/')) {
      content = { audio: buffer, mimetype: mime };
    } else {
      content = { document: buffer, mimetype: mime, fileName, ...(caption ? { caption } : {}) };
    }
    return this.send(chatJid, content, opts);
  }

  /** The key WhatsApp matches a message by; the cached key carries the group author as delivered. */
  private targetKey(chatJid: string, target: WaMessageTarget): WAMessageKey {
    const participant = this.raw.get(target.id)?.key?.participant ?? target.participant;
    return {
      remoteJid: chatJid,
      id: target.id,
      fromMe: target.fromMe,
      ...(participant && chatJid.endsWith('@g.us') ? { participant } : {}),
    };
  }

  sendReaction(chatJid: string, target: WaReactionTarget, emoji: string): Promise<SendResult> {
    return this.send(
      chatJid,
      { react: { text: emoji, key: this.targetKey(chatJid, target) } },
      undefined,
      false,
    );
  }

  /** Remember an edit/delete we send, so its echo is not reported as the phone's. */
  private markOwnChange(targetId: string): void {
    const t = Date.now();
    for (const [id, at] of this.ownChanges)
      if (t - at > OWN_CHANGE_TTL_MS) this.ownChanges.delete(id);
    this.ownChanges.set(targetId, t);
  }

  /** True (and forgotten) when a fromMe change of `targetId` is the echo of our own. */
  private takeOwnChange(targetId: string): boolean {
    const at = this.ownChanges.get(targetId);
    if (at === undefined) return false;
    this.ownChanges.delete(targetId);
    return Date.now() - at <= OWN_CHANGE_TTL_MS;
  }

  private async sendChange(
    chatJid: string,
    target: WaMessageTarget,
    content: AnyMessageContent,
  ): Promise<SendResult> {
    this.markOwnChange(target.id);
    try {
      return await this.send(chatJid, content, undefined, false);
    } catch (err) {
      this.ownChanges.delete(target.id);
      throw err;
    }
  }

  editText(chatJid: string, target: WaMessageTarget, text: string): Promise<SendResult> {
    const key = this.targetKey(chatJid, target);
    const cached = this.raw.get(target.id);
    return this.sendChange(chatJid, target, { text, edit: key }).then((r) => {
      // Later quotes of the message show the new text.
      const m = cached?.message;
      if (m?.conversation != null) m.conversation = text;
      else if (m?.extendedTextMessage) m.extendedTextMessage.text = text;
      return r;
    });
  }

  deleteForEveryone(chatJid: string, target: WaMessageTarget): Promise<SendResult> {
    return this.sendChange(chatJid, target, { delete: this.targetKey(chatJid, target) });
  }

  async deleteForMe(chatJid: string, target: WaMessageTarget, timestamp: number): Promise<void> {
    const sock = this.requireOpen();
    try {
      await sock.chatModify(
        {
          deleteForMe: {
            deleteMedia: true,
            key: this.targetKey(chatJid, target),
            timestamp: Math.floor(timestamp / 1000),
          },
        },
        chatJid,
      );
    } catch (err) {
      if (isConnectionError(err) || this.sock !== sock || this._status.state !== 'open')
        throw new WaUnavailableError(
          `WhatsApp connection lost: ${String((err as Error)?.message ?? err)}`,
        );
      throw err;
    }
  }

  async markRead(chatJid: string, messageIds: string[]): Promise<void> {
    const sock = this.requireOpen();
    const keys: WAMessageKey[] = messageIds.map((id) => {
      const raw = this.raw.get(id);
      return raw?.key
        ? { remoteJid: chatJid, id, fromMe: false, participant: raw.key.participant ?? undefined }
        : { remoteJid: chatJid, id, fromMe: false };
    });
    if (keys.length) await sock.readMessages(keys);
  }

  async sendPresence(chatJid: string, presence: 'composing' | 'paused'): Promise<void> {
    const sock = this.requireOpen();
    await sock.sendPresenceUpdate(presence, chatJid);
  }

  async downloadMedia(messageId: string): Promise<Buffer | null> {
    const raw = this.raw.get(messageId);
    if (!raw) return null;
    try {
      return await this.download(raw);
    } catch (err) {
      this.logger.warn({ err, messageId }, 'media download failed');
      return null;
    }
  }

  async getGroupInfo(groupJid: string): Promise<WaGroupInfo> {
    const sock = this.requireOpen();
    return mapGroupMetadata(await sock.groupMetadata(groupJid));
  }

  async checkNumber(phone: string): Promise<string | null> {
    const sock = this.requireOpen();
    const jid = await checkedNumberJid(phone, (j) => sock.onWhatsApp(j));
    // Result only, never the number: whether WhatsApp knows it.
    this.logger.info({ found: jid !== null }, 'number check');
    return jid;
  }

  async setBlocked(jid: string, blocked: boolean): Promise<void> {
    const sock = this.requireOpen();
    await sock.updateBlockStatus(jid, blocked ? 'block' : 'unblock');
    // The action only, never the number.
    this.logger.info({ blocked }, 'block status');
  }

  async getAbout(jid: string): Promise<string | null> {
    if (!this.sock || this._status.state !== 'open') throw new WaUnavailableError();
    const kind = jid.endsWith('@lid') ? 'lid' : 'pn';
    try {
      const list = await this.sock.fetchStatus(jid);
      const about = aboutFromStatusResult(list);
      // Shape only, never the text: tells "WhatsApp returned nothing" apart from a parsing problem.
      const first = Array.isArray(list)
        ? (list[0] as { status?: { status?: unknown } } | undefined)
        : undefined;
      const inner = first?.status?.status;
      this.logger.info(
        {
          kind,
          entries: Array.isArray(list) ? list.length : null,
          // '' = hidden by the person's privacy settings (code 401), null = none set
          status: inner === '' ? 'private' : inner === null ? 'none' : typeof inner,
          found: about !== null,
        },
        'about read',
      );
      return about;
    } catch (err) {
      // Thrown, not null: a failed lookup must never be remembered as "no About".
      this.logger.warn({ err, kind }, 'about unavailable');
      throw err;
    }
  }

  async getProfilePicture(jid: string): Promise<string | null> {
    // Offline is a failed lookup, never "no photo".
    if (!this.sock || this._status.state !== 'open') throw new WaUnavailableError();
    const sock = this.sock;
    return profilePhoto(() => sock.profilePictureUrl(jid, 'preview'));
  }
}
