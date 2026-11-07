import { describe, expect, it } from 'vitest';
import {
  forwardingScoreOf,
  jidType,
  mapStoredReactions,
  mapWAMessage,
  mapWAReaction,
} from './mapping.js';

const base = (over: Record<string, unknown> = {}) => ({
  key: { remoteJid: '60123456789@s.whatsapp.net', fromMe: false, id: 'ABC' },
  messageTimestamp: 1_700_000_000,
  pushName: 'Alice',
  ...over,
});

describe('mapWAMessage', () => {
  it('maps plain conversation text', () => {
    const m = mapWAMessage(base({ message: { conversation: 'hello' } }));
    expect(m).toMatchObject({
      id: 'ABC',
      chatJid: '60123456789@s.whatsapp.net',
      senderJid: '60123456789@s.whatsapp.net',
      senderName: 'Alice',
      fromMe: false,
      type: 'text',
      body: 'hello',
      quotedId: null,
      timestamp: 1_700_000_000_000,
      media: null,
    });
  });

  it('handles Long-like timestamps', () => {
    const m = mapWAMessage(
      base({
        messageTimestamp: {
          low: 1_700_000_000,
          high: 0,
          unsigned: true,
          toNumber: () => 1_700_000_000,
        },
        message: { conversation: 'x' },
      }),
    );
    expect(m?.timestamp).toBe(1_700_000_000_000);
  });

  it('maps extended text with quote', () => {
    const m = mapWAMessage(
      base({
        message: { extendedTextMessage: { text: 'reply', contextInfo: { stanzaId: 'Q1' } } },
      }),
    );
    expect(m?.type).toBe('text');
    expect(m?.body).toBe('reply');
    expect(m?.quotedId).toBe('Q1');
  });

  it.each(['extendedTextMessage', 'imageMessage', 'videoMessage', 'documentMessage'])(
    'preserves normalized mentions from %s context, including wrapped history',
    (type) => {
      const m = mapWAMessage(
        base({
          message: {
            ephemeralMessage: {
              message: {
                [type]: {
                  text: 'Hi @123',
                  caption: 'Hi @123',
                  contextInfo: {
                    stanzaId: 'Q1',
                    mentionedJid: ['123:4@lid', '60111@c.us', '123@lid', 'status@broadcast'],
                  },
                },
              },
            },
          },
        }),
      );
      expect(m?.mentionedJids).toEqual(['123@lid', '60111@s.whatsapp.net']);
      expect(m?.quotedId).toBe('Q1');
    },
  );

  it('distinguishes a message without mentions from an old import without metadata', () => {
    expect(mapWAMessage(base({ message: { conversation: 'Hi @123' } }))?.mentionedJids).toEqual([]);
  });

  it('preserves explicit alternate group sender identities with normalized device suffixes', () => {
    expect(
      mapWAMessage(
        base({
          key: {
            remoteJid: '1203@g.us',
            participant: '123:4@lid',
            participantAlt: '60111:9@s.whatsapp.net',
            id: 'G',
          },
          message: { conversation: 'Ok' },
        }),
      ),
    ).toMatchObject({ senderJid: '123@lid', senderJidAlt: '60111@s.whatsapp.net' });
  });

  it('maps image with caption and media download', () => {
    const m = mapWAMessage(
      base({ message: { imageMessage: { caption: 'look', mimetype: 'image/jpeg' } } }),
    );
    expect(m?.type).toBe('image');
    expect(m?.body).toBe('look');
    expect(m?.media?.mime).toBe('image/jpeg');
    expect(typeof m?.media?.download).toBe('function');
  });

  it('maps document with file name', () => {
    const m = mapWAMessage(
      base({ message: { documentMessage: { fileName: 'a.pdf', mimetype: 'application/pdf' } } }),
    );
    expect(m?.type).toBe('document');
    expect(m?.media?.fileName).toBe('a.pdf');
  });

  it('maps audio, video and sticker', () => {
    expect(
      mapWAMessage(base({ message: { audioMessage: { ptt: true, mimetype: 'audio/ogg' } } }))?.type,
    ).toBe('audio');
    expect(mapWAMessage(base({ message: { videoMessage: { mimetype: 'video/mp4' } } }))?.type).toBe(
      'video',
    );
    expect(
      mapWAMessage(base({ message: { stickerMessage: { mimetype: 'image/webp' } } }))?.type,
    ).toBe('sticker');
  });

  it('uses key.participant as sender in groups', () => {
    const m = mapWAMessage(
      base({
        key: {
          remoteJid: '1203630@g.us',
          fromMe: false,
          id: 'G1',
          participant: '60111@s.whatsapp.net',
        },
        message: { conversation: 'hi group' },
      }),
    );
    expect(m?.chatJid).toBe('1203630@g.us');
    expect(m?.senderJid).toBe('60111@s.whatsapp.net');
  });

  it('fromMe messages have null sender name', () => {
    const m = mapWAMessage(
      base({
        key: { remoteJid: '60123@s.whatsapp.net', fromMe: true, id: 'ME1' },
        message: { conversation: 'out' },
      }),
    );
    expect(m?.fromMe).toBe(true);
  });

  it('ignores reactions, protocol messages and key distribution', () => {
    expect(
      mapWAMessage(base({ message: { reactionMessage: { text: '👍', key: { id: 'ABC' } } } })),
    ).toBeNull();
    expect(mapWAMessage(base({ message: { protocolMessage: { type: 0 } } }))).toBeNull();
    expect(
      mapWAMessage(base({ message: { senderKeyDistributionMessage: { groupId: 'x' } } })),
    ).toBeNull();
  });

  it('ignores status broadcast and messages without content', () => {
    expect(
      mapWAMessage(
        base({
          key: { remoteJid: 'status@broadcast', id: 'S', fromMe: false },
          message: { conversation: 'x' },
        }),
      ),
    ).toBeNull();
    expect(mapWAMessage(base({ message: null }))).toBeNull();
  });

  it('unwraps ephemeral messages', () => {
    const m = mapWAMessage(
      base({ message: { ephemeralMessage: { message: { conversation: 'eph' } } } }),
    );
    expect(m?.body).toBe('eph');
  });

  it('carries the alternate address of a direct chat without its device suffix', () => {
    const m = mapWAMessage(
      base({
        key: {
          remoteJid: '123456789@lid',
          remoteJidAlt: '60123456789:12@s.whatsapp.net',
          fromMe: false,
          id: 'ALT',
        },
        message: { conversation: 'hi' },
      }),
    );
    expect(m?.chatJid).toBe('123456789@lid');
    expect(m?.chatJidAlt).toBe('60123456789@s.whatsapp.net');
  });

  it('has no alternate address for groups or when WhatsApp sends none', () => {
    expect(mapWAMessage(base({ message: { conversation: 'x' } }))?.chatJidAlt).toBeNull();
    const g = mapWAMessage(
      base({
        key: {
          remoteJid: '1203@g.us',
          remoteJidAlt: '60123456789@s.whatsapp.net',
          participant: '60123456789@s.whatsapp.net',
          fromMe: false,
          id: 'G',
        },
        message: { conversation: 'x' },
      }),
    );
    expect(g?.chatJidAlt).toBeNull();
  });
});

describe('jidType', () => {
  it.each([
    ['1203630@g.us', 'group'],
    ['60123@s.whatsapp.net', 'dm'],
    ['12345@lid', 'dm'],
    ['status@broadcast', 'other'],
    ['123@newsletter', 'other'],
    ['123@broadcast', 'other'],
    ['garbage', 'other'],
  ] as const)('%s -> %s', (jid, t) => {
    expect(jidType(jid)).toBe(t);
  });
});

describe('mapWAReaction', () => {
  const reaction = (text: string, over: Record<string, unknown> = {}, target = 'TARGET') =>
    base({
      key: { remoteJid: '60123456789@s.whatsapp.net', fromMe: false, id: 'R1' },
      message: {
        reactionMessage: { text, key: { id: target }, senderTimestampMs: 1_700_000_123_456 },
      },
      ...over,
    });

  it('maps a direct-chat reaction: the chat partner reacted to a message', () => {
    expect(mapWAReaction(reaction('👍'))).toEqual({
      targetId: 'TARGET',
      chatJid: '60123456789@s.whatsapp.net',
      chatJidAlt: null,
      senderJid: '60123456789@s.whatsapp.net',
      senderJidAlt: null,
      senderName: 'Alice',
      fromMe: false,
      emoji: '👍',
      timestamp: 1_700_000_123_456,
    });
  });

  it('an empty text is a removal; a change is just a new emoji', () => {
    expect(mapWAReaction(reaction(''))?.emoji).toBe('');
    expect(mapWAReaction(reaction('❤️'))?.emoji).toBe('❤️');
    const noText = base({ message: { reactionMessage: { key: { id: 'T' } } } });
    expect(mapWAReaction(noText)?.emoji).toBe('');
  });

  it('a group reaction names the participant (and its alternate address)', () => {
    const r = mapWAReaction(
      reaction('😂', {
        key: {
          remoteJid: '1203@g.us',
          fromMe: false,
          id: 'R2',
          participant: '999:4@lid',
          participantAlt: '60111111111@s.whatsapp.net',
        },
      }),
    );
    expect(r).toMatchObject({
      chatJid: '1203@g.us',
      chatJidAlt: null,
      senderJid: '999@lid',
      senderJidAlt: '60111111111@s.whatsapp.net',
      emoji: '😂',
    });
  });

  it('a reaction from the linked number is fromMe, without a sender', () => {
    const r = mapWAReaction(
      reaction('🙏', { key: { remoteJid: '1203@g.us', fromMe: true, id: 'R3' }, pushName: 'Me' }),
    );
    expect(r).toMatchObject({ fromMe: true, senderJid: null, senderName: null });
  });

  it('keeps the other address of a direct chat (LID chat, phone alt)', () => {
    const r = mapWAReaction(
      reaction('👍', {
        key: {
          remoteJid: '777@lid',
          remoteJidAlt: '60123@s.whatsapp.net',
          fromMe: false,
          id: 'R4',
        },
      }),
    );
    expect(r).toMatchObject({ chatJid: '777@lid', chatJidAlt: '60123@s.whatsapp.net' });
  });

  it('falls back to the message timestamp and reads Long-like milliseconds', () => {
    const plain = base({ message: { reactionMessage: { text: '👍', key: { id: 'T' } } } });
    expect(mapWAReaction(plain)?.timestamp).toBe(1_700_000_000_000);
    const long = base({
      message: {
        reactionMessage: {
          text: '👍',
          key: { id: 'T' },
          senderTimestampMs: { low: 5, high: 1, toNumber: () => 4_294_967_301 },
        },
      },
    });
    expect(mapWAReaction(long)?.timestamp).toBe(4_294_967_301);
    const lowHigh = base({
      message: {
        reactionMessage: { text: '👍', key: { id: 'T' }, senderTimestampMs: { low: 5, high: 1 } },
      },
    });
    expect(mapWAReaction(lowHigh)?.timestamp).toBe(4_294_967_301);
    const odd = base({
      message: { reactionMessage: { text: '👍', key: { id: 'T' }, senderTimestampMs: {} } },
    });
    expect(mapWAReaction(odd)?.timestamp).toBe(1_700_000_000_000);
  });

  it('ignores non-reactions, missing targets or reactors, and status/broadcast chats', () => {
    expect(mapWAReaction(base({ message: { conversation: 'hi' } }))).toBeNull();
    expect(mapWAReaction(base({ message: { reactionMessage: { text: '👍' } } }))).toBeNull();
    expect(
      mapWAReaction(reaction('👍', { key: { remoteJid: 'status@broadcast', id: 'S' } })),
    ).toBeNull();
    expect(
      mapWAReaction(reaction('👍', { key: { remoteJid: '1203@g.us', fromMe: false, id: 'R' } })),
    ).toBeNull();
    expect(mapWAReaction(base({ key: undefined }))).toBeNull();
  });
});

describe('mapStoredReactions (history sync)', () => {
  const stored = (reactions: unknown[], remoteJid = '1203@g.us') =>
    base({
      key: { remoteJid, fromMe: false, id: 'TARGET', participant: '601@s.whatsapp.net' },
      message: { conversation: 'durian cendol?' },
      reactions,
    });

  it('maps the reactions kept on a history message, skipping removed ones', () => {
    const list = mapStoredReactions(
      stored([
        {
          key: { remoteJid: '1203@g.us', participant: '602@s.whatsapp.net', fromMe: false },
          text: '👍',
          senderTimestampMs: 1_700_000_000_500,
        },
        { key: { remoteJid: '1203@g.us', fromMe: true }, text: '❤️' },
        { key: { remoteJid: '1203@g.us', participant: '603@s.whatsapp.net' }, text: '' },
        { text: '😮' },
        { key: { remoteJid: '1203@g.us' }, text: '😮' },
      ]),
    );
    expect(list).toEqual([
      {
        targetId: 'TARGET',
        chatJid: '1203@g.us',
        chatJidAlt: null,
        senderJid: '602@s.whatsapp.net',
        senderJidAlt: null,
        senderName: null,
        fromMe: false,
        emoji: '👍',
        timestamp: 1_700_000_000_500,
      },
      expect.objectContaining({
        fromMe: true,
        senderJid: null,
        emoji: '❤️',
        timestamp: 1_700_000_000_000,
      }),
    ]);
  });

  it('names the chat partner in a direct chat; nothing for plain messages', () => {
    const dmList = mapStoredReactions(
      stored(
        [{ key: { remoteJid: '60123@s.whatsapp.net', fromMe: false }, text: '👍' }],
        '60123@s.whatsapp.net',
      ),
    );
    expect(dmList[0]).toMatchObject({ senderJid: '60123@s.whatsapp.net', fromMe: false });
    expect(mapStoredReactions(base({ message: { conversation: 'x' } }))).toEqual([]);
    expect(mapStoredReactions(stored([{ text: '👍', key: {} }], 'status@broadcast'))).toEqual([]);
  });
});

describe('forwarded messages', () => {
  const ctx = (contextInfo: Record<string, unknown>) => contextInfo;
  it('reads the forwarding score from the content carrier (text, image, document, audio)', () => {
    const text = mapWAMessage(
      base({
        message: {
          extendedTextMessage: {
            text: 'fwd',
            contextInfo: ctx({ isForwarded: true, forwardingScore: 4 }),
          },
        },
      }),
    );
    expect(text?.forwardingScore).toBe(4);
    const image = mapWAMessage(
      base({
        message: { imageMessage: { caption: 'p', contextInfo: ctx({ isForwarded: true }) } },
      }),
    );
    // marked forwarded without a score: once
    expect(image?.forwardingScore).toBe(1);
    const doc = mapWAMessage(
      base({
        message: {
          documentMessage: {
            fileName: 'a.pdf',
            contextInfo: ctx({ isForwarded: true, forwardingScore: 127 }),
          },
        },
      }),
    );
    expect(doc?.forwardingScore).toBe(127);
    const audio = mapWAMessage(
      base({ message: { audioMessage: { ptt: true, contextInfo: ctx({ forwardingScore: 5 }) } } }),
    );
    expect(audio?.forwardingScore).toBe(5);
  });

  it('leaves a message that was not forwarded unmarked', () => {
    expect(mapWAMessage(base({ message: { conversation: 'own words' } }))).not.toHaveProperty(
      'forwardingScore',
    );
    expect(
      mapWAMessage(
        base({
          message: { extendedTextMessage: { text: 'x', contextInfo: ctx({ isForwarded: false }) } },
        }),
      ),
    ).not.toHaveProperty('forwardingScore');
    expect(forwardingScoreOf(null)).toBe(0);
    expect(forwardingScoreOf({ forwardingScore: 0, isForwarded: false })).toBe(0);
    expect(forwardingScoreOf({ forwardingScore: 2.5 })).toBe(2);
  });
});
