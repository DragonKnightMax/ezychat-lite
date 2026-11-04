import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BusinessTemplateCard } from './BusinessTemplateCard';
import { BUSINESS_TEMPLATES } from './business-templates';

function setup(pendingItem: string | null = null, groupSetup: 'new' | 'existing' | null = null) {
  const onApply = vi.fn();
  render(
    <BusinessTemplateCard
      disabled={false}
      pendingItem={pendingItem}
      groupSetup={groupSetup}
      onApply={onApply}
    />,
  );
  return { onApply };
}

const radios = (gallery: HTMLElement) =>
  within(gallery)
    .queryAllByRole('radio')
    .map((r) => r.getAttribute('aria-label'));

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
});
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // Desktop width: ResponsiveDialog renders the centred Dialog.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('min-width'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openGallery() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Browse templates' }));
  const gallery = await screen.findByRole('dialog', { name: 'Business templates' });
  return { user, gallery };
}

describe('business template gallery', () => {
  it('says how many templates there are and what Save adds', () => {
    setup('Clinic details');
    expect(
      screen.getByText(new RegExp(`for ${BUSINESS_TEMPLATES.length} kinds of business`)),
    ).toBeTruthy();
    expect(
      screen.getByText(/Save also adds the Business context item “Clinic details”/),
    ).toBeTruthy();
  });

  it('lists every template, filters by category and by search words in any language', async () => {
    setup();
    const { user, gallery } = await openGallery();
    expect(radios(gallery)).toHaveLength(BUSINESS_TEMPLATES.length);

    await user.click(within(gallery).getByRole('button', { name: 'Food' }));
    expect(within(gallery).getByRole('button', { name: 'Food' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(radios(gallery)).toEqual([
      'Restaurant or cafe',
      'Bakery and cake shop',
      'Catering and events',
    ]);

    await user.click(within(gallery).getByRole('button', { name: 'All' }));
    const search = within(gallery).getByRole('searchbox', { name: 'Search templates' });
    // Search words: "aircond" is only in the home services keywords.
    await user.type(search, 'aircond');
    expect(radios(gallery)).toEqual(['Home services']);
    // Every word must match.
    await user.clear(search);
    await user.type(search, 'dental braces');
    expect(radios(gallery)).toEqual(['Dental clinic']);
    await user.clear(search);
    await user.type(search, 'spaceship');
    expect(radios(gallery)).toEqual([]);
    expect(within(gallery).getByRole('status').textContent).toMatch(/No template matches/);
  });

  it('applies the selected template and closes; Apply waits for a choice', async () => {
    const { onApply } = setup();
    const { user, gallery } = await openGallery();
    const apply = within(gallery).getByRole('button', { name: 'Apply template' });
    expect(apply).toHaveProperty('disabled', true);
    await user.click(within(gallery).getByRole('radio', { name: 'Tuition centre' }));
    await user.click(apply);
    expect(onApply).toHaveBeenCalledWith('tuition');
    expect(screen.queryByRole('dialog', { name: 'Business templates' })).toBeNull();
  });

  it('closes without applying on Cancel', async () => {
    const { onApply } = setup();
    const { user, gallery } = await openGallery();
    await user.click(within(gallery).getByRole('radio', { name: 'Gym and fitness' }));
    await user.click(within(gallery).getByRole('button', { name: 'Cancel' }));
    expect(onApply).not.toHaveBeenCalled();
  });

  it('lists the Claims agent under Team and operations, marked for WhatsApp groups', async () => {
    const { onApply } = setup();
    const { user, gallery } = await openGallery();
    await user.click(within(gallery).getByRole('button', { name: 'Team and operations' }));
    expect(radios(gallery)).toEqual(['Claims agent']);
    const option = within(gallery).getByRole('radio', { name: 'Claims agent' }).closest('label')!;
    expect(option.textContent).toContain('Custom · For WhatsApp groups');
    // Other templates show their type only.
    await user.click(within(gallery).getByRole('button', { name: 'All' }));
    const clinic = within(gallery).getByRole('radio', { name: 'Clinic' }).closest('label')!;
    expect(clinic.textContent).not.toContain('WhatsApp groups');
    // Found by its English words too.
    await user.type(within(gallery).getByRole('searchbox'), 'receipt');
    expect(radios(gallery)).toEqual(['Claims agent']);
    await user.click(within(gallery).getByRole('radio', { name: 'Claims agent' }));
    await user.click(within(gallery).getByRole('button', { name: 'Apply template' }));
    expect(onApply).toHaveBeenCalledWith('claims');
  });

  it('says what Save does for a new group agent, and what is left for an existing one', () => {
    setup('Claim rules', 'new');
    const note = screen.getByTestId('group-setup');
    expect(note.textContent).toContain('Save also makes it a group agent');
    expect(note.textContent).toContain('tab named Claims set to Add rows');
    cleanup();
    setup('Claim rules', 'existing');
    const left = screen.getByTestId('group-setup');
    expect(left.textContent).toContain('turn on Answer in groups and turn off Answer direct chats');
    expect(left.textContent).toContain('Reads every message');
  });

  it('shows no group note for other templates', () => {
    setup('Clinic details');
    expect(screen.queryByTestId('group-setup')).toBeNull();
  });
});
