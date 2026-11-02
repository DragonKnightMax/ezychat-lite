import { describe, expect, it } from 'vitest';
import { DEFAULT_INBOX_CAPABILITIES, type Message } from '@ezychat/shared';
import {
  DELETE_WINDOW_MS,
  EDIT_WINDOW_MS,
  NO_RIGHTS,
  hasActions,
  messageRights,
} from './message-changes';

const NOW = 1_700_000_000_000;
const base: Message = {
  id: 'M1',
  chatJid: '601@s.whatsapp.net',
  senderJid: null,
  senderName: null,
  fromMe: true,
  sentByUserId: 7,
  type: 'text',
  body: 'hi',
  mediaUrl: null,
  mediaMime: null,
  mediaName: null,
  mediaStatus: 'none',
  quotedId: null,
  status: 'sent',
  error: null,
  timestamp: NOW - 1000,
  clientId: null,
  reactions: [],
};
const daniel = { id: 7, role: 'agent' };
const aisyah = { id: 1, role: 'admin' };
const phone = DEFAULT_INBOX_CAPABILITIES;

describe('messageRights', () => {
  it('the teammate who sent it edits and deletes for everyone within the windows', () => {
    expect(messageRights(base, daniel, phone, NOW)).toEqual({
      canEdit: true,
      editWindowClosed: false,
      canDeleteForEveryone: true,
      deleteWindowClosed: false,
      canDeleteForMe: false,
    });
    const later = messageRights(base, daniel, phone, NOW + EDIT_WINDOW_MS);
    expect(later).toMatchObject({
      canEdit: true,
      editWindowClosed: true,
      deleteWindowClosed: false,
    });
    expect(messageRights(base, daniel, phone, NOW + DELETE_WINDOW_MS)).toMatchObject({
      deleteWindowClosed: true,
    });
  });

  it('admins change any team message and delete any message for the team; agents not', () => {
    const fromPhone = { ...base, sentByUserId: null };
    expect(messageRights(fromPhone, daniel, phone, NOW)).toEqual(NO_RIGHTS);
    expect(messageRights(fromPhone, aisyah, phone, NOW)).toMatchObject({
      canEdit: true,
      canDeleteForMe: true,
    });
    const customer = { ...base, fromMe: false, sentByUserId: null };
    expect(messageRights(customer, aisyah, phone, NOW)).toEqual({
      ...NO_RIGHTS,
      canDeleteForMe: true,
    });
    expect(messageRights(customer, daniel, phone, NOW)).toEqual(NO_RIGHTS);
  });

  it('only text and captions edit; templates, media without a caption, sending, failed, deleted', () => {
    expect(
      messageRights({ ...base, template: { name: 'x', language: 'en' } }, daniel, phone, NOW)
        .canEdit,
    ).toBe(false);
    expect(messageRights({ ...base, type: 'image', body: null }, daniel, phone, NOW).canEdit).toBe(
      false,
    );
    expect(messageRights({ ...base, type: 'image', body: 'cap' }, daniel, phone, NOW).canEdit).toBe(
      true,
    );
    expect(
      messageRights({ ...base, id: 'local-1', status: 'pending' }, aisyah, phone, NOW),
    ).toEqual(NO_RIGHTS);
    expect(messageRights({ ...base, status: 'failed' }, aisyah, phone, NOW)).toEqual({
      ...NO_RIGHTS,
      canDeleteForMe: true,
    });
    expect(messageRights({ ...base, deletedAt: NOW }, aisyah, phone, NOW)).toEqual(NO_RIGHTS);
    expect(messageRights({ ...base, type: 'system' }, aisyah, phone, NOW)).toEqual(NO_RIGHTS);
    expect(messageRights(base, null, phone, NOW)).toEqual(NO_RIGHTS);
  });

  it('a connection that cannot (WhatsApp Business API) offers nothing', () => {
    const api = { editMessage: undefined, deleteForEveryone: undefined, deleteForMe: undefined };
    const r = messageRights(base, aisyah, api, NOW);
    expect(r).toEqual(NO_RIGHTS);
    expect(hasActions(r)).toBe(false);
    expect(hasActions(messageRights(base, aisyah, phone, NOW))).toBe(true);
  });
});
