import {
  BUSINESS_API_MEDIA_LIMITS,
  FakeWaAdapter,
  type WaCapabilities,
  type WaTemplate,
} from '@ezychat/wa';
import type { InboxTypeDefinition } from '../extensions.js';
import { PRIMARY_INBOX_ID } from './keys.js';
import type { InboxRow } from './repo.js';

/** The built-in dev inbox type (`--mode dev --fake-wa` only): a Business API stand-in. */
export const FAKE_API_TYPE = 'fake-api';

export const FAKE_API_CAPABILITIES: WaCapabilities = Object.freeze({
  qrLink: false,
  history: false,
  groups: false,
  replyWindowHours: 24,
  templates: true,
  needsPublicUrl: true,
  // Meta's Cloud API limits; no Forwarded mark (the Cloud API has none)
  mediaLimits: BUSINESS_API_MEDIA_LIMITS,
});

/** Demo templates: two sendable ones and one with an image header (listed, not sendable). */
export const FAKE_API_TEMPLATES: readonly WaTemplate[] = Object.freeze([
  {
    name: 'order_update',
    language: 'en',
    category: 'utility',
    body: 'Hi {{1}}, your order {{2}} is ready for pickup.',
    examples: ['Aisha', 'A-1024'],
    header: null,
    buttons: false,
  },
  {
    name: 'follow_up',
    language: 'en',
    category: 'marketing',
    body: 'Hi {{1}}, thanks for visiting us! Reply to this message if you have any questions.',
    examples: ['Aisha'],
    header: 'text',
    buttons: false,
  },
  {
    name: 'new_menu',
    language: 'en',
    category: 'marketing',
    body: 'Our new menu is here, {{1}}!',
    examples: ['Aisha'],
    header: 'image',
    buttons: false,
  },
]);

/** The fake number of an inbox, the same as its fake linked phone's (a type switch keeps it). */
export function fakeNumberOf(row: Pick<InboxRow, 'id' | 'name'>): { jid: string; name: string } {
  return row.id === PRIMARY_INBOX_ID
    ? { jid: '60000000000@s.whatsapp.net', name: 'Fake' }
    : { jid: `6000000000${row.id}@s.whatsapp.net`, name: row.name };
}

export const fakeApiInboxType: InboxTypeDefinition = {
  id: FAKE_API_TYPE,
  async createAdapter(_ctx, row) {
    return new FakeWaAdapter({
      me: fakeNumberOf(row),
      idPrefix: `FAKEAPI${row.id}`,
      capabilities: FAKE_API_CAPABILITIES,
      templates: FAKE_API_TEMPLATES.map((t) => ({ ...t, examples: [...t.examples] })),
    });
  },
};
