import { describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/context.js';
import { profilePhotoLookup } from '../src/http/profile-images.js';

const URL_OK = 'https://pps.whatsapp.net/v/photo.jpg';

function setup() {
  const inbox1 = { getProfilePicture: vi.fn(async () => URL_OK) };
  const inbox2 = { getProfilePicture: vi.fn(async () => null) };
  const adapter = vi.fn((id: number) => {
    if (id === 2) return inbox2;
    throw new Error('Inbox removed');
  });
  const ctx = { wa: inbox1, inboxes: { connections: { adapter } } } as unknown as AppContext;
  return { ctx, inbox1, inbox2, adapter };
}

describe('profile photo lookup', () => {
  it("asks the chat's own phone with its WhatsApp JID", async () => {
    const { ctx, inbox1, inbox2 } = setup();
    expect(await profilePhotoLookup(ctx, '60111@s.whatsapp.net')()).toBe(URL_OK);
    expect(inbox1.getProfilePicture).toHaveBeenCalledExactlyOnceWith('60111@s.whatsapp.net');
    expect(await profilePhotoLookup(ctx, '60111@s.whatsapp.net#2')()).toBeNull();
    expect(inbox2.getProfilePicture).toHaveBeenCalledExactlyOnceWith('60111@s.whatsapp.net');
  });

  it('rejects (not "no photo") for a removed inbox or a failed lookup', async () => {
    const { ctx, inbox1 } = setup();
    await expect(profilePhotoLookup(ctx, '60111@s.whatsapp.net#3')()).rejects.toThrow(
      'Inbox removed',
    );
    inbox1.getProfilePicture.mockRejectedValueOnce(new Error('timed out'));
    await expect(profilePhotoLookup(ctx, '60111@s.whatsapp.net')()).rejects.toThrow('timed out');
  });
});
