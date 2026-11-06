import { describe, expect, it } from 'vitest';
import { chosenChatsOnly } from './chat-scope';

describe('chosenChatsOnly', () => {
  it('is true only for an agent limited to chosen chats', () => {
    expect(chosenChatsOnly({ role: 'agent', chatScope: 'chosen' })).toBe(true);
    expect(chosenChatsOnly({ role: 'agent', chatScope: 'all' })).toBe(false);
    expect(chosenChatsOnly({ role: 'agent' })).toBe(false);
    expect(chosenChatsOnly({ role: 'admin', chatScope: 'chosen' })).toBe(false);
    expect(chosenChatsOnly(null)).toBe(false);
    expect(chosenChatsOnly(undefined)).toBe(false);
  });
});
