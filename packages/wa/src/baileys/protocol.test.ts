import { describe, expect, it } from 'vitest';
import { proto, type WAMessage } from 'baileys';
import type { WaIncomingMessage, WaMessageEdit, WaMessageRevoke } from '../types.js';
import { WaUnavailableError } from '../types.js';
import { BaileysAdapter } from './adapter.js';
import { mapWAProtocol } from './protocol.js';

const DM = '60123456789@s.whatsapp.net';
const LID = '123456789@lid';
const GROUP = '120363000000001@g.us';
const { REVOKE, MESSAGE_EDIT, EPHEMERAL_SETTING } = proto.Message.ProtocolMessage.Type;
const SECONDS = 1_700_000_000;

/** A protocol message as WhatsApp delivers it: the outer key is the author of the change. */
function change(
  protocolMessage: Record<string, unknown>,
  key: Record<string, unknown> = { remoteJid: DM, fromMe: false, id: 'P1' },
  extra: Record<string, unknown> = {},
) {
  return {
    key,
    messageTimestamp: SECONDS,
    message: { protocolMessage },
    ...extra,
  } as unknown as WAMessage;
}

describe('mapWAProtocol', () => {
  it('reads a customer edit of a text message, with the edit time', () => {
    const m = change({
      type: MESSAGE_EDIT,
      key: { id: 'T1', remoteJid: DM, fromMe: true },
      editedMessage: { conversation: 'Make it 4 please' },
      timestampMs: (SECONDS + 5) * 1000,
    });
    expect(mapWAProtocol(m)).toEqual({
      kind: 'edit',
      edit: {
        targetId: 'T1',
        chatJid: DM,
        chatJidAlt: null,
        senderJid: DM,
        senderJidAlt: null,
        fromMe: false,
        body: 'Make it 4 please',
        timestamp: (SECONDS + 5) * 1000,
      },
    });
  });

  it('reads edited captions and extended text, and the wrapped form newer clients send', () => {
    const caption = change({
      type: MESSAGE_EDIT,
      key: { id: 'T2' },
      editedMessage: { imageMessage: { caption: 'New caption' } },
    });
    expect(mapWAProtocol(caption)).toMatchObject({
      kind: 'edit',
      edit: { body: 'New caption', timestamp: SECONDS * 1000 },
    });
    const extended = change({
      type: MESSAGE_EDIT,
      key: { id: 'T3' },
      editedMessage: { extendedTextMessage: { text: 'With a link https://x.example' } },
    });
    expect(mapWAProtocol(extended)).toMatchObject({
      edit: { body: 'With a link https://x.example' },
    });
    // `editedMessage: { message: { protocolMessage } }` unwraps to the same change.
    const wrapped = {
      key: { remoteJid: DM, fromMe: false, id: 'P9' },
      messageTimestamp: SECONDS,
      message: {
        editedMessage: {
          message: {
            protocolMessage: {
              type: MESSAGE_EDIT,
              key: { id: 'T4' },
              editedMessage: { conversation: 'wrapped' },
            },
          },
        },
      },
    } as unknown as proto.IWebMessageInfo;
    expect(mapWAProtocol(wrapped)).toMatchObject({ edit: { targetId: 'T4', body: 'wrapped' } });
  });

  it('reads a delete for everyone, a group member and our own phone as the author', () => {
    expect(mapWAProtocol(change({ type: REVOKE, key: { id: 'T5' } }))).toEqual({
      kind: 'revoke',
      revoke: {
        targetId: 'T5',
        chatJid: DM,
        chatJidAlt: null,
        senderJid: DM,
        senderJidAlt: null,
        fromMe: false,
        timestamp: SECONDS * 1000,
      },
    });
    const group = change(
      { type: REVOKE, key: { id: 'T6' } },
      {
        remoteJid: GROUP,
        fromMe: false,
        id: 'P2',
        participant: '601111@s.whatsapp.net',
        participantAlt: '901111@lid',
      },
    );
    expect(mapWAProtocol(group)).toMatchObject({
      revoke: { chatJid: GROUP, senderJid: '601111@s.whatsapp.net', senderJidAlt: '901111@lid' },
    });
    const mine = change(
      { type: REVOKE, key: { id: 'T7' } },
      { remoteJid: DM, fromMe: true, id: 'P3' },
    );
    expect(mapWAProtocol(mine)).toMatchObject({ revoke: { fromMe: true, senderJid: null } });
  });

  it('keeps the other address of a DM (LID chat with a phone-number alt)', () => {
    const m = change(
      { type: REVOKE, key: { id: 'T8' } },
      { remoteJid: LID, remoteJidAlt: DM, fromMe: false, id: 'P4' },
    );
    expect(mapWAProtocol(m)).toMatchObject({ revoke: { chatJid: LID, chatJidAlt: DM } });
  });

  it('ignores other protocol messages, missing targets, authors or text, and broadcast chats', () => {
    expect(mapWAProtocol(change({ type: EPHEMERAL_SETTING, key: { id: 'X' } }))).toBeNull();
    expect(mapWAProtocol(change({ type: REVOKE }))).toBeNull();
    expect(
      mapWAProtocol(change({ type: MESSAGE_EDIT, key: { id: 'X' }, editedMessage: {} })),
    ).toBeNull();
    expect(mapWAProtocol(change({ type: MESSAGE_EDIT, key: { id: 'X' } }))).toBeNull();
    expect(
      mapWAProtocol(
        change({ type: REVOKE, key: { id: 'X' } }, { remoteJid: GROUP, fromMe: false, id: 'P' }),
      ),
    ).toBeNull();
    expect(
      mapWAProtocol(
        change({ type: REVOKE, key: { id: 'X' } }, { remoteJid: 'status@broadcast', id: 'P' }),
      ),
    ).toBeNull();
    expect(
      mapWAProtocol({ key: { remoteJid: DM, id: 'P' }, message: { conversation: 'hi' } }),
    ).toBeNull();
    expect(mapWAProtocol({ message: { protocolMessage: { type: REVOKE } } })).toBeNull();
  });
});

function harness(historyDays = 3) {
  const a = new BaileysAdapter({ authDir: 'unused-auth-dir', historyDays });
  const edits: Array<{ e: WaMessageEdit; source: string }> = [];
  const revokes: Array<{ r: WaMessageRevoke; source: string }> = [];
  const msgs: WaIncomingMessage[] = [];
  a.on('messageEdited', (e, meta) => edits.push({ e, source: meta.source }));
  a.on('messageDeleted', (r, meta) => revokes.push({ r, source: meta.source }));
  a.on('message', (m) => msgs.push(m));
  return { a, edits, revokes, msgs };
}

function openWith(a: BaileysAdapter, sock: Record<string, unknown>) {
  Object.assign(a as unknown as Record<string, unknown>, {
    sock,
    _status: { state: 'open', me: null, qr: null, lastError: null },
  });
}

describe('BaileysAdapter edits and deletes', () => {
  it('reports live and history edits and deletes, never as messages; old history is skipped', () => {
    const { a, edits, revokes, msgs } = harness(3);
    const now = Math.floor(Date.now() / 1000);
    a.handleUpsert(
      [
        change(
          { type: MESSAGE_EDIT, key: { id: 'T1' }, editedMessage: { conversation: 'new' } },
          { remoteJid: DM, fromMe: false, id: 'P1' },
          { messageTimestamp: now },
        ),
        change(
          { type: REVOKE, key: { id: 'T2' } },
          { remoteJid: DM, fromMe: false, id: 'P2' },
          { messageTimestamp: now },
        ),
      ],
      'notify',
    );
    a.onHistory({
      chats: [],
      contacts: [],
      messages: [
        change(
          { type: REVOKE, key: { id: 'H1' } },
          { remoteJid: DM, fromMe: false, id: 'P3' },
          { messageTimestamp: now - 60 },
        ),
        change(
          { type: REVOKE, key: { id: 'OLD' } },
          { remoteJid: DM, fromMe: false, id: 'P4' },
          { messageTimestamp: now - 5 * 86400 },
        ),
      ],
      isLatest: true,
    } as never);
    expect(msgs).toEqual([]);
    expect(edits.map(({ e, source }) => [e.targetId, e.body, source])).toEqual([
      ['T1', 'new', 'live'],
    ]);
    expect(revokes.map(({ r, source }) => [r.targetId, source])).toEqual([
      ['T2', 'live'],
      ['H1', 'history'],
    ]);
  });

  it('edits with the WhatsApp key, updates the cached quote and skips its own echo once', async () => {
    const { a, edits } = harness();
    const calls: Array<{ jid: string; content: unknown }> = [];
    openWith(a, {
      sendMessage: async (jid: string, content: unknown) => {
        calls.push({ jid, content });
        // WhatsApp echoes the change back while the send is still running.
        a.handleUpsert(
          [
            change(
              { type: MESSAGE_EDIT, key: { id: 'M1' }, editedMessage: { conversation: 'echo' } },
              { remoteJid: DM, fromMe: true, id: 'E1' },
            ),
          ],
          'append',
        );
        return { key: { id: 'E1' }, messageTimestamp: SECONDS };
      },
    });
    const raw = (
      a as unknown as { raw: { get(id: string): unknown; set(id: string, v: unknown): void } }
    ).raw;
    raw.set('M1', {
      key: { id: 'M1', remoteJid: DM, fromMe: true },
      message: { conversation: 'old' },
    });

    await expect(a.editText(DM, { id: 'M1', fromMe: true }, 'new text')).resolves.toEqual({
      id: 'E1',
      timestamp: SECONDS * 1000,
    });
    expect(calls).toEqual([
      { jid: DM, content: { text: 'new text', edit: { remoteJid: DM, id: 'M1', fromMe: true } } },
    ]);
    expect(edits).toEqual([]);
    expect(raw.get('M1')).toMatchObject({ message: { conversation: 'new text' } });
    // The phone's own later edit of the same message is reported.
    a.handleUpsert(
      [
        change(
          { type: MESSAGE_EDIT, key: { id: 'M1' }, editedMessage: { conversation: 'from phone' } },
          { remoteJid: DM, fromMe: true, id: 'E2' },
        ),
      ],
      'notify',
    );
    expect(edits.map(({ e }) => [e.body, e.fromMe])).toEqual([['from phone', true]]);
  });

  it('updates the cached text of an extended message after an edit', async () => {
    const { a } = harness();
    openWith(a, { sendMessage: async () => ({ key: { id: 'E1' }, messageTimestamp: SECONDS }) });
    const raw = (
      a as unknown as { raw: { get(id: string): unknown; set(id: string, v: unknown): void } }
    ).raw;
    raw.set('M2', { key: { id: 'M2' }, message: { extendedTextMessage: { text: 'old' } } });
    await a.editText(DM, { id: 'M2', fromMe: true }, 'newer');
    expect(raw.get('M2')).toMatchObject({ message: { extendedTextMessage: { text: 'newer' } } });
  });

  it('deletes for everyone with the group author; a failed send forgets the pending echo', async () => {
    const { a, revokes } = harness();
    const calls: unknown[] = [];
    let fail: Error | null = null;
    openWith(a, {
      sendMessage: async (jid: string, content: unknown) => {
        if (fail) throw fail;
        calls.push({ jid, content });
        return { key: { id: 'D1' }, messageTimestamp: SECONDS };
      },
    });
    await a.deleteForEveryone(GROUP, { id: 'G1', fromMe: true, participant: '600@s.whatsapp.net' });
    expect(calls).toEqual([
      {
        jid: GROUP,
        content: {
          delete: { remoteJid: GROUP, id: 'G1', fromMe: true, participant: '600@s.whatsapp.net' },
        },
      },
    ]);
    fail = new Error('not-acceptable');
    await expect(a.deleteForEveryone(DM, { id: 'M9', fromMe: true })).rejects.toBe(fail);
    // Not sent: the phone's delete of the same message is the phone's, not an echo.
    a.handleUpsert(
      [change({ type: REVOKE, key: { id: 'M9' } }, { remoteJid: DM, fromMe: true, id: 'P' })],
      'notify',
    );
    expect(revokes.map(({ r }) => r.targetId)).toEqual(['M9']);
  });

  it('forgets an echo that never came after a minute', async () => {
    const { a, revokes } = harness();
    openWith(a, { sendMessage: async () => ({ key: { id: 'D2' }, messageTimestamp: SECONDS }) });
    await a.deleteForEveryone(DM, { id: 'LATE', fromMe: true });
    const own = (a as unknown as { ownChanges: Map<string, number> }).ownChanges;
    own.set('LATE', Date.now() - 61_000);
    a.handleUpsert(
      [change({ type: REVOKE, key: { id: 'LATE' } }, { remoteJid: DM, fromMe: true, id: 'P' })],
      'notify',
    );
    expect(revokes.map(({ r }) => r.targetId)).toEqual(['LATE']);
    // Expired entries are dropped when the next change is sent.
    own.set('STALE', Date.now() - 61_000);
    await a.deleteForEveryone(DM, { id: 'NEXT', fromMe: true });
    expect([...own.keys()]).toEqual(['NEXT']);
  });

  it('deletes for me on the linked phone in seconds; offline is unavailable', async () => {
    const { a } = harness();
    const mods: unknown[] = [];
    openWith(a, { chatModify: async (mod: unknown, jid: string) => void mods.push({ mod, jid }) });
    await a.deleteForMe(DM, { id: 'M3', fromMe: false }, 1_700_000_123_456);
    expect(mods).toEqual([
      {
        jid: DM,
        mod: {
          deleteForMe: {
            deleteMedia: true,
            key: { remoteJid: DM, id: 'M3', fromMe: false },
            timestamp: 1_700_000_123,
          },
        },
      },
    ]);
    const boom = Object.assign(new Error('Connection Closed'), { output: { statusCode: 428 } });
    openWith(a, { chatModify: async () => Promise.reject(boom) });
    await expect(a.deleteForMe(DM, { id: 'M3', fromMe: false }, 1)).rejects.toBeInstanceOf(
      WaUnavailableError,
    );
    const other = new Error('bad-request');
    openWith(a, { chatModify: async () => Promise.reject(other) });
    await expect(a.deleteForMe(DM, { id: 'M3', fromMe: false }, 1)).rejects.toBe(other);
    Object.assign(a as unknown as Record<string, unknown>, { sock: null });
    await expect(a.editText(DM, { id: 'M3', fromMe: true }, 'x')).rejects.toBeInstanceOf(
      WaUnavailableError,
    );
    await expect(a.deleteForMe(DM, { id: 'M3', fromMe: true }, 1)).rejects.toBeInstanceOf(
      WaUnavailableError,
    );
  });
});
