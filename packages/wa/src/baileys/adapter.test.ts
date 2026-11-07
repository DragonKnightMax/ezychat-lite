import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type * as Baileys from 'baileys';
import { proto } from 'baileys';
import { createBaileysAdapter } from '../index.js';
import { WaUnavailableError } from '../types.js';
import type {
  WaContactAlias,
  WaContactInfo,
  WaIncomingMessage,
  WaMessageStatusUpdate,
  WaReaction,
} from '../types.js';
import {
  BaileysAdapter,
  MEDIA_UPLOAD_TIMEOUT_MS,
  WA_BROWSER,
  forwardedContext,
  isConnectionError,
  mediaContent,
  normalizePairingPhone,
  receiptStatus,
} from './adapter.js';
import { createAuthStore } from './auth-store.js';
import { MediaCache } from './media-cache.js';
import { contactAliasPair, normalizeContactJid } from './contact-aliases.js';

const socketFactory = vi.hoisted(() => vi.fn());
vi.mock('baileys', async (importOriginal) => ({
  ...(await importOriginal<typeof Baileys>()),
  fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
  makeWASocket: socketFactory,
}));

/** An open adapter whose socket records every `sendMessage` (ids `<prefix>1`, `<prefix>2`, …). */
function openAdapterRecording(prefix: string) {
  const a = new BaileysAdapter({ authDir: 'unused-auth-dir', historyDays: 7 });
  const calls: Array<{ jid: string; content: unknown }> = [];
  Object.assign(a as unknown as Record<string, unknown>, {
    sock: {
      sendMessage: async (jid: string, content: unknown) => {
        calls.push({ jid, content });
        return { key: { id: `${prefix}${calls.length}` }, messageTimestamp: 1_700_000_000 };
      },
    },
    _status: { state: 'open', me: null, qr: null, lastError: null },
  });
  return { a, calls };
}

/** Like openAdapterRecording, but also records the send options and returns the id it was given. */
function openAdapterWithOptions() {
  const a = new BaileysAdapter({ authDir: 'unused-auth-dir', historyDays: 7 });
  const options: unknown[] = [];
  Object.assign(a as unknown as Record<string, unknown>, {
    sock: {
      sendMessage: async (_jid: string, _content: unknown, opts?: { messageId?: string }) => {
        options.push(opts);
        return { key: { id: opts?.messageId ?? 'NEW-ID' }, messageTimestamp: 1_700_000_000 };
      },
    },
    _status: { state: 'open', me: null, qr: null, lastError: null },
  });
  return { a, options };
}

describe('pairing identity', () => {
  // WhatsApp terminates registration (428 before any QR) for 'Desktop' browser identities;
  // a Chrome web identity gets a QR and is accepted for phone-number pairing codes.
  it('identifies as a Chrome web client', () => {
    expect(WA_BROWSER[0]).toBe('Ubuntu');
    expect(WA_BROWSER[1]).toBe('Chrome');
  });

  it('resets reconnect backoff when a QR arrives', () => {
    const a = new BaileysAdapter({ authDir: 'unused-auth-dir', historyDays: 0 });
    Object.assign(a as unknown as Record<string, unknown>, { attempt: 41 });
    (a as unknown as { onConnectionUpdate: (s: unknown, u: unknown) => void }).onConnectionUpdate(
      {},
      { qr: 'QR' },
    );
    expect((a as unknown as { attempt: number }).attempt).toBe(0);
    expect(a.status).toMatchObject({ state: 'qr', qr: 'QR' });
  });
});

describe('requestPairingCode', () => {
  it('normalizes phone numbers to digits with country code', () => {
    expect(normalizePairingPhone('+60 12-345 6789')).toBe('60123456789');
    expect(() => normalizePairingPhone('12345')).toThrow(/phone/i);
    expect(() => normalizePairingPhone('+1234567890123456')).toThrow(/phone/i);
  });

  it('asks the socket for a code once it is ready to pair', async () => {
    const a = new BaileysAdapter({ authDir: 'unused-auth-dir', historyDays: 0 });
    const calls: string[] = [];
    Object.assign(a as unknown as Record<string, unknown>, {
      stopped: false,
      sock: { requestPairingCode: async (p: string) => (calls.push(p), 'ABCD1234') },
      _status: { state: 'qr', me: null, qr: 'QR', lastError: null },
    });
    await expect(a.requestPairingCode('+60 12-345 6789')).resolves.toBe('ABCD1234');
    expect(calls).toEqual(['60123456789']);
  });

  it('refuses when a number is already linked', async () => {
    const a = new BaileysAdapter({ authDir: 'unused-auth-dir', historyDays: 0 });
    Object.assign(a as unknown as Record<string, unknown>, {
      _status: {
        state: 'open',
        me: { jid: '1@s.whatsapp.net', name: null },
        qr: null,
        lastError: null,
      },
    });
    await expect(a.requestPairingCode('60123456789')).rejects.toThrow(/already linked/i);
  });
});

describe('linked account identity', () => {
  it('reports the account LID from the session (groups and mentions show it instead of the number)', () => {
    const a = new BaileysAdapter({ authDir: 'unused-auth-dir', historyDays: 0 });
    const open = (user: Record<string, string>) =>
      (
        a as unknown as {
          onConnectionUpdate(sock: unknown, u: { connection: string }): void;
        }
      ).onConnectionUpdate({ user }, { connection: 'open' });
    open({ id: '60123456789:12@s.whatsapp.net', lid: '81071886581878:12@lid', notify: 'Kopi' });
    expect(a.status.me).toEqual({
      jid: '60123456789@s.whatsapp.net',
      name: 'Kopi',
      lid: '81071886581878@lid',
    });
    open({ id: '60123456789:12@s.whatsapp.net' });
    expect(a.status.me).toEqual({ jid: '60123456789@s.whatsapp.net', name: null, lid: null });
  });
});

describe('createBaileysAdapter (offline smoke)', () => {
  it('starts disconnected and refuses to send without connecting', async () => {
    const a = createBaileysAdapter({ authDir: 'unused-auth-dir', historyDays: 7 });
    expect(a.status.state).toBe('disconnected');
    await expect(a.sendText('1@s.whatsapp.net', 'hi')).rejects.toBeInstanceOf(WaUnavailableError);
    expect(await a.downloadMedia('nope')).toBeNull();
    await expect(a.getProfilePicture('1@s.whatsapp.net')).rejects.toBeInstanceOf(
      WaUnavailableError,
    );
    await a.disconnect();
    expect(a.status.state).toBe('disconnected');
  });
});

const dm = (id: string, over: Record<string, unknown> = {}) =>
  ({
    key: { remoteJid: '60123456789@s.whatsapp.net', fromMe: false, id },
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: 'Alice',
    message: { conversation: `msg ${id}` },
    ...over,
  }) as never;

function collect(a: BaileysAdapter) {
  const msgs: Array<{ m: WaIncomingMessage; source: string }> = [];
  const statuses: WaMessageStatusUpdate[] = [];
  a.on('message', (m, meta) => msgs.push({ m, source: meta.source }));
  a.on('messageStatus', (s) => statuses.push(s));
  return { msgs, statuses };
}

describe('BaileysAdapter event handling', () => {
  it('passes the WhatsApp error code of an ERROR ack, and only for failures', () => {
    const a = new BaileysAdapter({ authDir: 'unused-auth-dir', historyDays: 0 });
    const { statuses } = collect(a);
    const key = { id: 'OUT1', remoteJid: '120363000000000001@g.us', fromMe: true };
    a.handleMessageUpdates([
      {
        key,
        update: { status: proto.WebMessageInfo.Status.ERROR, messageStubParameters: ['479'] },
      },
      { key, update: { status: proto.WebMessageInfo.Status.ERROR } },
      {
        key,
        update: { status: proto.WebMessageInfo.Status.SERVER_ACK, messageStubParameters: ['x'] },
      },
    ] as never);
    expect(statuses).toEqual([
      { id: 'OUT1', chatJid: key.remoteJid, status: 'failed', error: '479' },
      { id: 'OUT1', chatJid: key.remoteJid, status: 'failed' },
      { id: 'OUT1', chatJid: key.remoteJid, status: 'sent' },
    ]);
  });

  it('re-sends under the given WhatsApp id and otherwise passes no options', async () => {
    const { a, options } = openAdapterWithOptions();
    expect((await a.sendText('g@g.us', 'again', { messageId: 'WA-SAME' })).id).toBe('WA-SAME');
    expect((await a.sendText('g@g.us', 'new')).id).toBe('NEW-ID');
    expect(options).toEqual([{ messageId: 'WA-SAME' }, undefined]);
  });

  it("treats upsert 'append' (offline-queued) messages as live, even with history_days=0", () => {
    const a = new BaileysAdapter({ authDir: 'unused-auth-dir', historyDays: 0 });
    const { msgs } = collect(a);
    a.handleUpsert(
      [dm('OFF1', { messageTimestamp: Math.floor(Date.now() / 1000) - 3600 })],
      'append',
    );
    a.handleUpsert([dm('LIVE1')], 'notify');
    expect(msgs.map((x) => [x.m.id, x.source])).toEqual([
      ['OFF1', 'live'],
      ['LIVE1', 'live'],
    ]);
  });

  it('emits a live reaction as a reaction event, never as a message', () => {
    const a = new BaileysAdapter({ authDir: 'unused-auth-dir', historyDays: 0 });
    const { msgs } = collect(a);
    const reactions: Array<{ r: WaReaction; source: string }> = [];
    a.on('reaction', (r, meta) => reactions.push({ r, source: meta.source }));
    a.handleUpsert(
      [dm('R1', { message: { reactionMessage: { text: '👍', key: { id: 'TARGET' } } } })],
      'notify',
    );
    expect(msgs).toEqual([]);
    expect(reactions).toEqual([
      { r: expect.objectContaining({ targetId: 'TARGET', emoji: '👍' }), source: 'live' },
    ]);
    // The reaction is not kept in the quote/media cache.
    expect((a as unknown as { raw: { get(id: string): unknown } }).raw.get('R1')).toBeUndefined();
  });

  it('history: reaction messages and reactions kept on messages, within history_days', () => {
    const a = new BaileysAdapter({ authDir: 'unused-auth-dir', historyDays: 3 });
    const { msgs } = collect(a);
    const reactions: Array<{ r: WaReaction; source: string }> = [];
    a.on('reaction', (r, meta) => reactions.push({ r, source: meta.source }));
    const now = Math.floor(Date.now() / 1000);
    a.onHistory({
      chats: [],
      contacts: [],
      messages: [
        dm('H1', {
          reactions: [{ key: { remoteJid: '60123456789@s.whatsapp.net' }, text: '❤️' }],
        }),
        dm('H2', { message: { reactionMessage: { text: '😂', key: { id: 'H1' } } } }),
        dm('OLD', {
          messageTimestamp: now - 2 * 86400,
          message: {
            reactionMessage: {
              text: '😮',
              key: { id: 'H1' },
              senderTimestampMs: (now - 5 * 86400) * 1000,
            },
          },
        }),
      ],
      isLatest: true,
    } as never);
    expect(msgs.map((x) => x.m.id)).toEqual(['H1']);
    expect(reactions.map(({ r, source }) => [r.targetId, r.emoji, source])).toEqual([
      ['H1', '❤️', 'history'],
      ['H1', '😂', 'history'],
    ]);
  });

  it('history batches use the current history_days getter', () => {
    let days = 0;
    const a = new BaileysAdapter({ authDir: 'unused-auth-dir', historyDays: () => days });
    const { msgs } = collect(a);
    const old = dm('H1', { messageTimestamp: Math.floor(Date.now() / 1000) - 2 * 86400 });
    a.onHistory({ chats: [], contacts: [], messages: [old], isLatest: true } as never);
    expect(msgs).toEqual([]);
    days = 7;
    a.onHistory({ chats: [], contacts: [], messages: [old], isLatest: true } as never);
    expect(msgs.map((x) => [x.m.id, x.source])).toEqual([['H1', 'history']]);
  });

  it('maps group per-participant receipts to delivered / read for our own messages', () => {
    const a = new BaileysAdapter({ authDir: 'unused-auth-dir', historyDays: 7 });
    const { statuses } = collect(a);
    const key = (id: string, fromMe = true) => ({
      remoteJid: '1203@g.us',
      id,
      fromMe,
      participant: '6011@s.whatsapp.net',
    });
    a.handleReceipts([
      { key: key('G1'), receipt: { userJid: '6011@s.whatsapp.net', receiptTimestamp: 1 } },
      { key: key('G2'), receipt: { userJid: '6011@s.whatsapp.net', readTimestamp: 2 } },
      { key: key('G3', false), receipt: { userJid: '6011@s.whatsapp.net', readTimestamp: 2 } },
    ] as never);
    expect(statuses).toEqual([
      { id: 'G1', chatJid: '1203@g.us', status: 'delivered' },
      { id: 'G2', chatJid: '1203@g.us', status: 'read' },
    ]);
    expect(receiptStatus({ userJid: 'x' } as never)).toBeNull();
  });

  it('wraps connection-closed send errors as WaUnavailableError', async () => {
    expect(isConnectionError({ output: { statusCode: 428 }, message: 'Connection Closed' })).toBe(
      true,
    );
    expect(isConnectionError({ output: { statusCode: 408 } })).toBe(true);
    expect(isConnectionError(new Error('Connection Closed'))).toBe(true);
    expect(isConnectionError({ output: { statusCode: 400 }, message: 'bad request' })).toBe(false);

    const a = new BaileysAdapter({ authDir: 'unused-auth-dir', historyDays: 7 });
    const boom = Object.assign(new Error('Connection Closed'), {
      output: { statusCode: 428 },
      isBoom: true,
    });
    const fakeSock = { sendMessage: async () => Promise.reject(boom) };
    Object.assign(a as unknown as Record<string, unknown>, {
      sock: fakeSock,
      _status: { state: 'open', me: null, qr: null, lastError: null },
    });
    await expect(a.sendText('1@s.whatsapp.net', 'hi')).rejects.toBeInstanceOf(WaUnavailableError);

    const other = new Error('not-acceptable');
    Object.assign(a as unknown as Record<string, unknown>, {
      sock: { sendMessage: async () => Promise.reject(other) },
    });
    await expect(a.sendText('1@s.whatsapp.net', 'hi')).rejects.toBe(other);
  });

  it('sends tagged members as WhatsApp mentions and plain text without them', async () => {
    const { a, calls } = openAdapterRecording('T');
    await a.sendText('1203@g.us', 'Hi @900111', { mentions: ['900111@lid'] });
    await a.sendText('1203@g.us', 'Hi all', { mentions: [] });
    await a.sendText('1@s.whatsapp.net', 'Hi');
    expect(calls.map((c) => c.content)).toEqual([
      { text: 'Hi @900111', mentions: ['900111@lid'] },
      { text: 'Hi all' },
      { text: 'Hi' },
    ]);
  });

  it('sends a reaction with the key WhatsApp matches; the group author comes from the cache first', async () => {
    const { a, calls } = openAdapterRecording('R');
    const raw = (
      a as unknown as { raw: { get(id: string): unknown; set(id: string, v: unknown): void } }
    ).raw;
    raw.set('CACHED', { key: { id: 'CACHED', participant: '900111@lid' } });

    const res = await a.sendReaction('1@s.whatsapp.net', { id: 'M1', fromMe: true }, '👍');
    expect(res).toEqual({ id: 'R1', timestamp: 1_700_000_000_000 });
    await a.sendReaction(
      '1203@g.us',
      { id: 'G1', fromMe: false, participant: '6011@s.whatsapp.net' },
      '',
    );
    await a.sendReaction(
      '1203@g.us',
      { id: 'CACHED', fromMe: false, participant: '6011@s.whatsapp.net' },
      '❤️',
    );
    // A direct chat never carries a participant, even when one is passed.
    await a.sendReaction(
      '1@s.whatsapp.net',
      { id: 'M2', fromMe: false, participant: '6011@s.whatsapp.net' },
      '😮',
    );
    expect(calls).toEqual([
      {
        jid: '1@s.whatsapp.net',
        content: {
          react: { text: '👍', key: { remoteJid: '1@s.whatsapp.net', id: 'M1', fromMe: true } },
        },
      },
      {
        jid: '1203@g.us',
        content: {
          react: {
            text: '',
            key: {
              remoteJid: '1203@g.us',
              id: 'G1',
              fromMe: false,
              participant: '6011@s.whatsapp.net',
            },
          },
        },
      },
      {
        jid: '1203@g.us',
        content: {
          react: {
            text: '❤️',
            key: { remoteJid: '1203@g.us', id: 'CACHED', fromMe: false, participant: '900111@lid' },
          },
        },
      },
      {
        jid: '1@s.whatsapp.net',
        content: {
          react: { text: '😮', key: { remoteJid: '1@s.whatsapp.net', id: 'M2', fromMe: false } },
        },
      },
    ]);
    // Sent reactions stay out of the quote/media cache.
    expect(raw.get('R1')).toBeUndefined();

    Object.assign(a as unknown as Record<string, unknown>, { sock: null });
    await expect(
      a.sendReaction('1@s.whatsapp.net', { id: 'M1', fromMe: true }, '👍'),
    ).rejects.toBeInstanceOf(WaUnavailableError);
  });
});

const PN = '60123456789@s.whatsapp.net';
const LID = '123456789@lid';
const ALIAS = { jid: PN, alias: LID };

function contactHarness() {
  const a = new BaileysAdapter({ authDir: 'unused-auth-dir', historyDays: 3 });
  const aliases: WaContactAlias[] = [];
  const contacts: WaContactInfo[] = [];
  a.on('contactAliases', (batch) => aliases.push(...batch));
  a.on('contacts', (batch) => contacts.push(...batch));
  return { a, aliases, contacts };
}

describe('contact identity mapping', () => {
  it('normalizes both explicit orientations and rejects unrelated or invalid IDs', () => {
    expect(
      contactAliasPair(`${PN.split('@')[0]}:2@s.whatsapp.net`, `${LID.split('@')[0]}:9@lid`),
    ).toEqual(ALIAS);
    expect(contactAliasPair(LID, PN)).toEqual(ALIAS);
    expect(normalizeContactJid('60123456789@c.us')).toBe(PN);
    for (const other of [
      'group@g.us',
      'status@broadcast',
      'Alice@lid',
      '+60123456789@s.whatsapp.net',
      PN,
    ]) {
      expect(contactAliasPair(PN, other)).toBeNull();
    }
  });

  it('preserves names and all explicit history associations before chats are emitted', async () => {
    const { a, aliases, contacts } = contactHarness();
    const order: string[] = [];
    a.on('contactAliases', () => order.push('aliases'));
    a.on('contacts', () => order.push('contacts'));
    a.on('chats', () => order.push('chats'));
    a.onHistory({
      contacts: [{ id: PN, name: ' Saved business name ', notify: ' Push name ' }],
      lidPnMappings: [{ lid: LID, pn: PN }],
      chats: [{ id: LID }],
      messages: [],
      isLatest: true,
    } as never);
    expect(aliases[0]).toEqual({ ...ALIAS, source: 'history' });
    expect(contacts).toEqual([
      { jid: PN, aliases: [LID], savedName: 'Saved business name', pushName: 'Push name' },
    ]);
    expect(order.slice(0, 3)).toEqual(['aliases', 'contacts', 'chats']);
    await expect(a.getContactAliases([PN, LID])).resolves.toEqual([
      { ...ALIAS, source: 'keystore' },
    ]);
  });

  it('extracts contacts in either orientation and enriches later name-only updates', () => {
    for (const contact of [
      { id: PN, lid: LID },
      { id: LID, phoneNumber: PN },
      { id: `${LID.split('@')[0]}:4@lid`, lid: LID, phoneNumber: PN },
    ]) {
      const { a, aliases, contacts } = contactHarness();
      a.onHistory({ contacts: [contact], chats: [], messages: [] } as never);
      a.onHistory({
        contacts: [{ id: PN, name: 'Updated saved name' }],
        chats: [],
        messages: [],
      } as never);
      expect(aliases).toEqual([{ ...ALIAS, source: 'contacts' }]);
      expect(contacts.at(-1)).toMatchObject({
        jid: PN,
        aliases: [LID],
        savedName: 'Updated saved name',
      });
    }
  });

  it('learns message alternate chat and group participant identities even for unrendered protocol messages', () => {
    const { a, aliases } = contactHarness();
    a.handleUpsert(
      [
        {
          key: { remoteJid: LID, remoteJidAlt: PN, id: 'IDENTITY' },
          message: { protocolMessage: {} },
        },
        {
          key: {
            remoteJid: '1203@g.us',
            participant: '999@lid',
            participantAlt: '60111111111@s.whatsapp.net',
            id: 'GROUP',
          },
          message: { conversation: 'hi' },
        },
      ] as never,
      'notify',
    );
    expect(aliases).toEqual([
      { ...ALIAS, source: 'message' },
      { jid: '60111111111@s.whatsapp.net', alias: '999@lid', source: 'message' },
    ]);
  });

  it('reads both persisted signal-key orientations from an isolated auth directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wati-contact-alias-'));
    try {
      const auth = createAuthStore(directory);
      const { state } = await auth.load();
      await state.keys.set({
        'lid-mapping': { '60123456789': '123456789', '123456789_reverse': '60123456789' },
      });
      for (const jid of [PN, LID]) {
        const { a } = contactHarness();
        const reloaded = await auth.load();
        Object.assign(a, { signalKeys: reloaded.state.keys });
        await expect(a.getContactAliases([jid])).resolves.toEqual([
          { ...ALIAS, source: 'keystore' },
        ]);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('bounds file-key concurrency and performs no network lookups for missing mappings', async () => {
    const { a } = contactHarness();
    const get = vi.fn(async () => ({}));
    const network = vi.fn(() => {
      throw new Error('No network lookup allowed');
    });
    Object.assign(a, {
      signalKeys: { get },
      sock: { signalRepository: { lidMapping: { getLIDForPN: network, getPNForLID: network } } },
    });
    const ids = Array.from({ length: 600 }, (_, index) => `${60000000000 + index}@s.whatsapp.net`);
    await expect(a.getContactAliases([...ids, 'group@g.us'])).resolves.toEqual([]);
    expect(get.mock.calls.map((call) => (call as unknown as [string, string[]])[1].length)).toEqual(
      [256, 256, 88],
    );
    expect(network).not.toHaveBeenCalled();
  });

  it('discards asynchronous local-key results after socket closure', async () => {
    const { a } = contactHarness();
    let resolve!: (value: Record<string, string>) => void;
    Object.assign(a, {
      signalKeys: {
        get: () =>
          new Promise<Record<string, string>>((done) => {
            resolve = done;
          }),
      },
    });
    const pending = a.getContactAliases([LID]);
    await a.disconnect();
    resolve({ '123456789_reverse': '60123456789' });
    await expect(pending).resolves.toEqual([]);
    await expect(a.getContactAliases([LID])).resolves.toEqual([]);
  });

  it('handles late socket mapping events and ignores old account events after logout', async () => {
    const { a, aliases, contacts } = contactHarness();
    const ev = new EventEmitter();
    const sock = {
      ev,
      end: vi.fn(),
      logout: vi.fn(),
      signalRepository: { lidMapping: { getLIDForPN: vi.fn() } },
    };
    socketFactory.mockReturnValueOnce(sock);
    const wipe = vi.fn(async () => {});
    Object.assign(a, {
      auth: {
        load: async () => ({
          state: { creds: {}, keys: { get: async () => ({}), set: async () => {} } },
          saveCreds: async () => {},
        }),
        wipe,
      },
    });
    await a.connect();
    ev.emit('contacts.upsert', [{ id: PN, name: 'Saved name' }]);
    ev.emit('lid-mapping.update', { pn: PN, lid: LID });
    ev.emit('contacts.update', [{ id: PN, name: 'New name' }]);
    a.handleUpsert([dm('OLD-ACCOUNT')], 'notify');
    expect(aliases).toEqual([{ ...ALIAS, source: 'lid-mapping' }]);
    expect(contacts.at(-1)).toMatchObject({ savedName: 'New name', aliases: [LID] });
    await a.logout();
    ev.emit('lid-mapping.update', { pn: PN, lid: LID });
    ev.emit('contacts.upsert', [{ id: PN, name: 'Old account' }]);
    await expect(a.getContactAliases([PN])).resolves.toEqual([]);
    await expect(a.downloadMedia('OLD-ACCOUNT')).resolves.toBeNull();
    expect(contacts.at(-1)?.savedName).toBe('New name');
    expect(wipe).toHaveBeenCalledOnce();
    expect(sock.signalRepository.lidMapping.getLIDForPN).not.toHaveBeenCalled();
  });
});

describe('forwarding and large files', () => {
  it('marks text as Forwarded with its score and keeps the mentions', async () => {
    const { a, calls } = openAdapterRecording('F');
    await a.sendText('1203@g.us', 'Hi @900111', {
      mentions: ['900111@lid'],
      forwarded: { score: 3 },
    });
    await a.sendText('1@s.whatsapp.net', 'Plain', { forwarded: { score: 0 } });
    expect(calls.map((c) => c.content)).toEqual([
      {
        text: 'Hi @900111',
        mentions: ['900111@lid'],
        contextInfo: { isForwarded: true, forwardingScore: 3 },
      },
      { text: 'Plain' },
    ]);
  });

  it('builds file content from a path, as a document on request, with the Forwarded mark', () => {
    const file = {
      buffer: Buffer.from('x'),
      path: '/data/media/v.mp4',
      mime: 'video/mp4',
      fileName: 'v.mp4',
    };
    const fwd = { forwarded: { score: 2 } };
    const ctx = { contextInfo: { isForwarded: true, forwardingScore: 2 } };
    expect(mediaContent({ ...file, caption: 'hall' }, fwd)).toEqual({
      video: { url: '/data/media/v.mp4' },
      mimetype: 'video/mp4',
      caption: 'hall',
      ...ctx,
    });
    expect(mediaContent({ ...file, asDocument: true }, fwd)).toEqual({
      document: { url: '/data/media/v.mp4' },
      mimetype: 'video/mp4',
      fileName: 'v.mp4',
      ...ctx,
    });
    const buf = Buffer.from('img');
    expect(mediaContent({ buffer: buf, mime: 'image/png', fileName: 'a.png' })).toEqual({
      image: buf,
      mimetype: 'image/png',
    });
    expect(mediaContent({ buffer: buf, mime: 'image/webp', fileName: 's.webp' }, fwd)).toEqual({
      sticker: buf,
      mimetype: 'image/webp',
      ...ctx,
    });
    const voice = mediaContent(
      {
        buffer: buf,
        path: '/v.ogg',
        mime: 'audio/ogg; codecs=opus',
        fileName: 'v.ogg',
        voiceNote: { seconds: 3, waveform: new Uint8Array([1]) },
      },
      fwd,
    );
    expect(voice).toMatchObject({ audio: { url: '/v.ogg' }, ptt: true, seconds: 3, ...ctx });
    expect(mediaContent({ buffer: buf, mime: 'audio/mpeg', fileName: 'a.mp3' })).toEqual({
      audio: buf,
      mimetype: 'audio/mpeg',
    });
    expect(
      mediaContent({ buffer: buf, mime: 'application/pdf', fileName: 'm.pdf', caption: 'menu' }),
    ).toEqual({ document: buf, mimetype: 'application/pdf', fileName: 'm.pdf', caption: 'menu' });
    expect(forwardedContext({ forwarded: { score: 2.7 } })).toEqual({
      contextInfo: { isForwarded: true, forwardingScore: 2 },
    });
    expect(forwardedContext(undefined)).toEqual({});
  });

  it('gives media sends a long upload time and the socket a media cache', async () => {
    const { a, options } = openAdapterWithOptions();
    await a.sendMedia('1@s.whatsapp.net', {
      buffer: Buffer.from('x'),
      mime: 'application/pdf',
      fileName: 'a.pdf',
    });
    expect(options).toEqual([{ mediaUploadTimeoutMs: MEDIA_UPLOAD_TIMEOUT_MS }]);

    const b = new BaileysAdapter({ authDir: 'unused-auth-dir', historyDays: 0 });
    socketFactory.mockReturnValueOnce({ ev: new EventEmitter(), end: vi.fn() });
    Object.assign(b, {
      auth: {
        load: async () => ({
          state: { creds: {}, keys: { get: async () => ({}), set: async () => {} } },
          saveCreds: async () => {},
        }),
        wipe: async () => {},
      },
    });
    await b.connect();
    expect(socketFactory.mock.calls.at(-1)![0].mediaCache).toBeInstanceOf(MediaCache);
    await b.disconnect();
  });
});
