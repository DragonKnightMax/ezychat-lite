import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INBOX_CAPABILITIES,
  FORWARD_MANY_TIMES_SCORE,
  FORWARD_MAX_CHATS,
  ForwardMessageBody,
  InboxCapabilitiesSchema,
  MEDIA_UPLOAD_LIMIT_BYTES,
  MessageSchema,
  forwardedManyTimes,
} from './index.js';

describe('ForwardMessageBody', () => {
  it('takes 1 to 5 chats and defaults sendAs to the original type', () => {
    const body = ForwardMessageBody.parse({ to: ['a@s.whatsapp.net'], clientRequestId: 'r1' });
    expect(body.sendAs).toBe('original');
    expect(
      ForwardMessageBody.parse({
        to: ['a', 'b', 'c', 'd', 'e'],
        clientRequestId: 'r',
        sendAs: 'file',
      }).sendAs,
    ).toBe('file');
  });

  it('refuses no chat, more than 5 chats, an unknown sendAs and a missing request id', () => {
    expect(ForwardMessageBody.safeParse({ to: [], clientRequestId: 'r' }).success).toBe(false);
    const six = Array.from({ length: FORWARD_MAX_CHATS + 1 }, (_, i) => `c${i}`);
    expect(ForwardMessageBody.safeParse({ to: six, clientRequestId: 'r' }).success).toBe(false);
    expect(
      ForwardMessageBody.safeParse({ to: ['a'], clientRequestId: 'r', sendAs: 'zip' }).success,
    ).toBe(false);
    expect(ForwardMessageBody.safeParse({ to: ['a'] }).success).toBe(false);
  });
});

describe('forwardedManyTimes', () => {
  it('is true from WhatsApp’s many-times score', () => {
    expect(forwardedManyTimes(1)).toBe(false);
    expect(forwardedManyTimes(FORWARD_MANY_TIMES_SCORE - 1)).toBe(false);
    expect(forwardedManyTimes(FORWARD_MANY_TIMES_SCORE)).toBe(true);
  });
});

describe('forward fields on Message and inbox capabilities', () => {
  const message = {
    id: 'm1',
    chatJid: 'a@s.whatsapp.net',
    senderJid: null,
    senderName: null,
    fromMe: true,
    sentByUserId: 1,
    type: 'text',
    body: 'hi',
    mediaUrl: null,
    mediaMime: null,
    mediaName: null,
    mediaStatus: 'none',
    quotedId: null,
    status: 'sent',
    error: null,
    timestamp: 1,
    clientId: null,
  };

  it('keeps forwarded and mediaSize, and accepts messages without them', () => {
    const parsed = MessageSchema.parse({
      ...message,
      forwarded: { manyTimes: true },
      mediaSize: 70 * 1024 * 1024,
    });
    expect(parsed.forwarded).toEqual({ manyTimes: true });
    expect(parsed.mediaSize).toBe(70 * 1024 * 1024);
    expect(MessageSchema.parse(message).forwarded).toBeUndefined();
  });

  it('accepts partial media limits and the forwarded mark, and keeps old capabilities valid', () => {
    const caps = InboxCapabilitiesSchema.parse({
      ...DEFAULT_INBOX_CAPABILITIES,
      mediaLimits: { video: 16, document: 100 },
      forwardedMark: false,
    });
    expect(caps.mediaLimits).toEqual({ video: 16, document: 100 });
    expect(InboxCapabilitiesSchema.parse(DEFAULT_INBOX_CAPABILITIES).mediaLimits).toBeUndefined();
  });

  it('allows uploads up to 100 MB', () => {
    expect(MEDIA_UPLOAD_LIMIT_BYTES).toBe(100 * 1024 * 1024);
  });
});
