import { describe, expect, it } from 'vitest';
import type { WaStatus } from '@ezychat/shared';
import { FakeWaAdapter, WaUnavailableError } from '../index.js';
import type { WaContactAlias, WaIncomingMessage, WaMessageStatusUpdate } from '../index.js';

const tick = () => new Promise<void>((r) => setImmediate(r));

describe('FakeWaAdapter', () => {
  it('connect emits connecting then open with fake me', async () => {
    const wa = new FakeWaAdapter();
    const states: WaStatus[] = [];
    wa.on('status', (s) => states.push(s));
    await wa.connect();
    expect(states.map((s) => s.state)).toEqual(['connecting', 'open']);
    expect(wa.status.state).toBe('open');
    expect(wa.status.me).toEqual({ jid: '60000000000@s.whatsapp.net', name: 'Fake' });
  });

  it('connect is idempotent when already open', async () => {
    const wa = new FakeWaAdapter();
    await wa.connect();
    const states: string[] = [];
    wa.on('status', (s) => states.push(s.state));
    await wa.connect();
    expect(states).toEqual([]);
  });

  it('awaitScan shows a QR code until the scan, then reconnects open', async () => {
    const wa = new FakeWaAdapter({ awaitScan: true, idPrefix: 'FAKE2' });
    await wa.connect();
    expect(wa.status).toMatchObject({ state: 'qr', me: null, qr: 'FAKE-QR-FAKE2' });
    wa.setConnected(true);
    expect(wa.status.state).toBe('open');
    await wa.disconnect();
    await wa.connect();
    expect(wa.status.state).toBe('open');
  });

  it('autoOpen false stays connecting', async () => {
    const wa = new FakeWaAdapter({ autoOpen: false });
    await wa.connect();
    expect(wa.status.state).toBe('connecting');
  });

  it('simulateIncoming emits message with source live', async () => {
    const wa = new FakeWaAdapter();
    await wa.connect();
    const got: Array<[WaIncomingMessage, { source: string }]> = [];
    wa.on('message', (m, meta) => got.push([m, meta]));
    const m = wa.simulateIncoming({ chatJid: '601111@s.whatsapp.net', body: 'hi' });
    expect(m.id).toMatch(/^FAKE-[0-9a-z]+-\d+$/);
    expect(got).toHaveLength(1);
    expect(got[0]![0]).toEqual(m);
    expect(got[0]![1]).toEqual({ source: 'live' });
    expect(m.type).toBe('text');
    expect(m.fromMe).toBe(false);
    expect(m.body).toBe('hi');
    const m2 = wa.simulateIncoming({ chatJid: '601111@s.whatsapp.net', body: 'again' });
    expect(m2.id).not.toBe(m.id);
  });

  it('simulateReaction emits reactions: DM partner by default, group sender, fromMe, history', () => {
    const wa = new FakeWaAdapter();
    const got: Array<[unknown, { source: string }]> = [];
    wa.on('reaction', (r, meta) => got.push([r, meta]));
    const dm = wa.simulateReaction({
      chatJid: '601111@s.whatsapp.net',
      targetId: 'M1',
      emoji: '👍',
      timestamp: 5,
    });
    expect(dm).toEqual({
      targetId: 'M1',
      chatJid: '601111@s.whatsapp.net',
      chatJidAlt: null,
      senderJid: '601111@s.whatsapp.net',
      senderJidAlt: null,
      senderName: null,
      fromMe: false,
      emoji: '👍',
      timestamp: 5,
    });
    const group = wa.simulateReaction({ chatJid: '1@g.us', targetId: 'M2', emoji: '' });
    expect(group.senderJid).toBeNull();
    const named = wa.simulateReaction({
      chatJid: '1@g.us',
      targetId: 'M2',
      emoji: '😂',
      senderJid: '602@s.whatsapp.net',
      senderName: 'Ali',
    });
    expect(named).toMatchObject({ senderJid: '602@s.whatsapp.net', senderName: 'Ali' });
    const mine = wa.simulateReaction(
      { chatJid: '601111@s.whatsapp.net', targetId: 'M1', emoji: '❤️', fromMe: true },
      'history',
    );
    expect(mine.senderJid).toBeNull();
    expect(got.map(([, meta]) => meta.source)).toEqual(['live', 'live', 'live', 'history']);
  });

  it('sendReaction records it and echoes the linked number’s reaction; refuses while offline', async () => {
    const wa = new FakeWaAdapter();
    await expect(
      wa.sendReaction('601111@s.whatsapp.net', { id: 'M1', fromMe: false }, '👍'),
    ).rejects.toBeInstanceOf(WaUnavailableError);
    await wa.connect();
    const got: unknown[] = [];
    wa.on('reaction', (r) => got.push(r));
    const res = await wa.sendReaction('601111@s.whatsapp.net', { id: 'M1', fromMe: false }, '👍');
    expect(res.id).toMatch(/^FAKE-REACT-/);
    expect(wa.reactions).toEqual([
      { chatJid: '601111@s.whatsapp.net', target: { id: 'M1', fromMe: false }, emoji: '👍' },
    ]);
    expect(got).toEqual([
      expect.objectContaining({
        targetId: 'M1',
        fromMe: true,
        senderJid: null,
        emoji: '👍',
        timestamp: res.timestamp,
      }),
    ]);
  });

  it('sendText records and emits sent then delivered', async () => {
    const wa = new FakeWaAdapter();
    await wa.connect();
    const updates: WaMessageStatusUpdate[] = [];
    wa.on('messageStatus', (u) => updates.push(u));
    const res = await wa.sendText('601111@s.whatsapp.net', 'hello');
    expect(res.id).toMatch(/^FAKE-OUT-[0-9a-z]+-\d+$/);
    expect(typeof res.timestamp).toBe('number');
    expect(wa.sent).toEqual([{ chatJid: '601111@s.whatsapp.net', text: 'hello', id: res.id }]);
    expect(updates.map((u) => u.status)).toEqual(['sent']);
    await tick();
    expect(updates.map((u) => u.status)).toEqual(['sent', 'delivered']);
    expect(updates[1]).toEqual({
      id: res.id,
      chatJid: '601111@s.whatsapp.net',
      status: 'delivered',
    });
  });

  it('sendText while disconnected rejects WaUnavailableError', async () => {
    const wa = new FakeWaAdapter();
    await expect(wa.sendText('601111@s.whatsapp.net', 'x')).rejects.toBeInstanceOf(
      WaUnavailableError,
    );
    await wa.connect();
    wa.setConnected(false);
    const err = await wa.sendText('601111@s.whatsapp.net', 'x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WaUnavailableError);
    expect((err as WaUnavailableError).code).toBe('wa_unavailable');
    expect(wa.sent).toHaveLength(0);
    wa.setConnected(true);
    await expect(wa.sendText('601111@s.whatsapp.net', 'x')).resolves.toBeTruthy();
  });

  it('failNextSend rejects once', async () => {
    const wa = new FakeWaAdapter();
    await wa.connect();
    wa.failNextSend(new Error('boom'));
    await expect(wa.sendText('601111@s.whatsapp.net', 'x')).rejects.toThrow('boom');
    await expect(wa.sendText('601111@s.whatsapp.net', 'y')).resolves.toBeTruthy();
    expect(wa.sent).toHaveLength(1);
  });

  it('sendText under a given messageId reuses it, and skipNextDelivery withholds one receipt', async () => {
    const wa = new FakeWaAdapter();
    await wa.connect();
    const statuses: string[] = [];
    wa.on('messageStatus', (u) => statuses.push(`${u.id}:${u.status}`));
    wa.skipNextDelivery();
    const res = await wa.sendText('601111@s.whatsapp.net', 'again', { messageId: 'WA-SAME' });
    await new Promise((r) => setImmediate(r));
    expect(res.id).toBe('WA-SAME');
    expect(wa.sent.at(-1)?.id).toBe('WA-SAME');
    expect(statuses).toEqual(['WA-SAME:sent']);
    const media = await wa.sendMedia(
      '601111@s.whatsapp.net',
      { buffer: Buffer.from('x'), mime: 'image/png', fileName: 'a.png' },
      { messageId: 'WA-MEDIA' },
    );
    expect(media.id).toBe('WA-MEDIA');
  });

  it('sendMedia records file', async () => {
    const wa = new FakeWaAdapter();
    await wa.connect();
    const file = { buffer: Buffer.from('abc'), mime: 'image/png', fileName: 'a.png' };
    const res = await wa.sendMedia('601111@s.whatsapp.net', file);
    expect(wa.sent[0]).toEqual({ chatJid: '601111@s.whatsapp.net', file, id: res.id });
  });

  it('simulateStatus merges and emits', () => {
    const wa = new FakeWaAdapter();
    const states: WaStatus[] = [];
    wa.on('status', (s) => states.push(s));
    wa.simulateStatus({ state: 'qr', qr: 'QRDATA' });
    expect(wa.status.state).toBe('qr');
    expect(wa.status.qr).toBe('QRDATA');
    expect(states).toHaveLength(1);
  });

  it('logout sets logged_out and takeover reopens', async () => {
    const wa = new FakeWaAdapter();
    await wa.connect();
    wa.simulateStatus({ state: 'replaced' });
    await wa.takeover();
    expect(wa.status.state).toBe('open');
    await wa.logout();
    expect(wa.status.state).toBe('logged_out');
    expect(wa.status.me).toBeNull();
  });

  it('simulateIncoming carries chatJidAlt; simulateContactAliases emits explicit pairs', () => {
    const wa = new FakeWaAdapter();
    const seen: WaIncomingMessage[] = [];
    wa.on('message', (m) => seen.push(m));
    wa.simulateIncoming({ chatJid: '1@lid', chatJidAlt: '601@s.whatsapp.net', body: 'x' });
    wa.simulateIncoming({ chatJid: '602@s.whatsapp.net', body: 'y' });
    expect(seen.map((m) => m.chatJidAlt)).toEqual(['601@s.whatsapp.net', null]);

    const batches: WaContactAlias[][] = [];
    wa.on('contactAliases', (b) => batches.push(b));
    wa.simulateContactAliases([{ jid: '601@s.whatsapp.net', alias: '1@lid' }]);
    expect(batches).toEqual([[{ jid: '601@s.whatsapp.net', alias: '1@lid' }]]);
  });
});

describe('FakeWaAdapter groups', () => {
  it('returns set group info and About text while connected, and records calls', async () => {
    const wa = new FakeWaAdapter();
    await wa.connect();
    wa.setGroupInfo({
      jid: 'g1@g.us',
      name: 'Group',
      description: null,
      createdAt: null,
      ownerJid: null,
      size: 2,
      participants: [
        {
          jid: '60111@s.whatsapp.net',
          phoneJid: '60111@s.whatsapp.net',
          lidJid: null,
          username: null,
          role: 'admin',
        },
      ],
    });
    wa.setAbout('60111@s.whatsapp.net', 'Hello');
    expect((await wa.getGroupInfo('g1@g.us')).participants).toHaveLength(1);
    expect(await wa.getAbout('60111@s.whatsapp.net')).toBe('Hello');
    expect(wa.groupInfoCalls).toEqual(['g1@g.us']);
    const seen: string[] = [];
    wa.on('groupChanged', ({ groupJid }) => seen.push(groupJid));
    wa.simulateGroupChanged('g1@g.us');
    expect(seen).toEqual(['g1@g.us']);
  });

  it('refuses group info while disconnected', async () => {
    const wa = new FakeWaAdapter({ autoOpen: false });
    await expect(wa.getGroupInfo('g1@g.us')).rejects.toMatchObject({ code: 'wa_unavailable' });
    await expect(wa.getAbout('60111@s.whatsapp.net')).rejects.toMatchObject({
      code: 'wa_unavailable',
    });
    await expect(wa.getProfilePicture('60111@s.whatsapp.net')).rejects.toMatchObject({
      code: 'wa_unavailable',
    });
  });

  it('checks numbers: every valid number has WhatsApp unless a test says otherwise', async () => {
    const wa = new FakeWaAdapter();
    await wa.connect();
    wa.setNotOnWhatsApp('60111000003');
    expect(await wa.checkNumber('60128887777')).toBe('60128887777@s.whatsapp.net');
    expect(await wa.checkNumber('60111000003')).toBeNull();
    expect(await wa.checkNumber('12ab')).toBeNull();
    await wa.disconnect();
    await expect(wa.checkNumber('60128887777')).rejects.toMatchObject({ code: 'wa_unavailable' });
  });
});

describe('FakeWaAdapter options for several inboxes', () => {
  it('uses the given own identity', async () => {
    const wa = new FakeWaAdapter({ me: { jid: '60000000002@s.whatsapp.net', name: 'Catering' } });
    await wa.connect();
    expect(wa.status.me).toEqual({ jid: '60000000002@s.whatsapp.net', name: 'Catering' });
    wa.setConnected(false);
    wa.setConnected(true);
    expect(wa.status.me?.jid).toBe('60000000002@s.whatsapp.net');
    await wa.takeover();
    expect(wa.status.me?.jid).toBe('60000000002@s.whatsapp.net');
  });

  it('two instances with different id prefixes never produce the same message id', async () => {
    const a = new FakeWaAdapter();
    const b = new FakeWaAdapter({ idPrefix: 'FAKE2' });
    await a.connect();
    await b.connect();
    const ids = new Set<string>();
    for (let i = 0; i < 3; i++) {
      ids.add(a.simulateIncoming({ chatJid: '601111@s.whatsapp.net', body: 'x' }).id);
      ids.add(b.simulateIncoming({ chatJid: '601111@s.whatsapp.net', body: 'x' }).id);
      ids.add((await a.sendText('601111@s.whatsapp.net', 'y')).id);
      ids.add((await b.sendText('601111@s.whatsapp.net', 'y')).id);
      ids.add(
        (
          await b.sendMedia('601111@s.whatsapp.net', {
            buffer: Buffer.from('z'),
            mime: 'image/png',
            fileName: 'z.png',
          })
        ).id,
      );
    }
    expect(ids.size).toBe(15);
    expect(b.simulateIncoming({ chatJid: '601111@s.whatsapp.net', body: 'x' }).id).toMatch(
      /^FAKE2-[0-9a-z]+-\d+$/,
    );
    expect((await b.sendText('601111@s.whatsapp.net', 'y')).id).toMatch(
      /^FAKE2-OUT-[0-9a-z]+-\d+$/,
    );
  });

  it('declares no capabilities and no templates unless given', () => {
    const wa = new FakeWaAdapter();
    expect(wa.capabilities).toBeUndefined();
    expect(wa.listTemplates).toBeUndefined();
    expect(wa.sendTemplate).toBeUndefined();
  });

  it('with capabilities and templates: lists them, records template sends, refuses offline', async () => {
    const caps = {
      qrLink: false,
      history: false,
      groups: false,
      replyWindowHours: 24,
      templates: true,
      needsPublicUrl: true,
    };
    const template = {
      name: 'hello',
      language: 'en',
      category: 'utility' as const,
      body: 'Hi {{1}}',
      examples: ['Ann'],
      header: null,
      buttons: false,
    };
    const wa = new FakeWaAdapter({ capabilities: caps, templates: [template], idPrefix: 'API' });
    expect(wa.capabilities).toEqual(caps);
    await expect(wa.listTemplates!()).rejects.toBeInstanceOf(WaUnavailableError);
    await expect(
      wa.sendTemplate!('601@s.whatsapp.net', { name: 'hello', language: 'en', params: ['Ann'] }),
    ).rejects.toBeInstanceOf(WaUnavailableError);
    await wa.connect();
    const listed = await wa.listTemplates!();
    expect(listed).toEqual([template]);
    listed[0]!.examples.push('changed');
    expect((await wa.listTemplates!())[0]!.examples).toEqual(['Ann']);
    expect(wa.templateListCalls).toBe(2);
    const statuses: string[] = [];
    wa.on('messageStatus', (u) => statuses.push(u.status));
    const r = await wa.sendTemplate!('601@s.whatsapp.net', {
      name: 'hello',
      language: 'en',
      params: ['Ann'],
    });
    expect(r.id).toMatch(/^API-OUT-/);
    expect(wa.templateSends).toEqual([
      {
        chatJid: '601@s.whatsapp.net',
        template: { name: 'hello', language: 'en', params: ['Ann'] },
        id: r.id,
      },
    ]);
    await tick();
    expect(statuses).toEqual(['sent', 'delivered']);
  });
});
