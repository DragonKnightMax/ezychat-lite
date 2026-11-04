import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ChatAvatar } from './ChatAvatar';
import { ProfileImageContext } from './ProfileImageContext';

afterEach(cleanup);

it('shows initials while loading, displays a photo, and recovers when a different photo fails', () => {
  const view = render(<ChatAvatar name="Alex Chen" src="/api/photo/one" />);
  expect(screen.getByText('AC')).toBeTruthy();
  const image = view.container.querySelector('img')!;
  expect(image.getAttribute('loading')).toBe('lazy');
  expect(image.getAttribute('referrerpolicy')).toBe('no-referrer');
  fireEvent.load(image);
  expect(screen.queryByText('AC')).toBeNull();
  view.rerender(<ChatAvatar name="Alex Chen" src="/api/photo/two" />);
  fireEvent.error(view.container.querySelector('img')!);
  expect(screen.getByText('AC')).toBeTruthy();
  expect(view.container.querySelector('img')).toBeNull();
});

it('waits for WhatsApp readiness, keeps the photo URL as given and retries after a reconnect', () => {
  // The URL is the cache key on the phone: it changes only when the photo changes (`v`), never
  // per connection, so an unchanged photo is not asked for again.
  const src = '/api/chats/customer%40s.whatsapp.net/avatar?v=ab12cd';
  // Earlier builds added the socket's connection revision to the URL: it must have no effect.
  const state = (ready: boolean) => ({ ready, revision: Date.now() });
  const photo = (ready: boolean) => (
    <ProfileImageContext.Provider value={state(ready)}>
      <ChatAvatar name="Alex Chen" src={src} />
    </ProfileImageContext.Provider>
  );
  const view = render(photo(false));
  expect(view.container.querySelector('img')).toBeNull();
  view.rerender(photo(true));
  expect(view.container.querySelector('img')!.getAttribute('src')).toBe(src);
  fireEvent.error(view.container.querySelector('img')!);
  expect(view.container.querySelector('img')).toBeNull();
  view.rerender(photo(false));
  view.rerender(photo(true));
  const retry = view.container.querySelector('img')!;
  expect(retry.getAttribute('src')).toBe(src);
  fireEvent.load(retry);
  expect(screen.queryByText('AC')).toBeNull();
});

it('does not repeat a private-photo lookup on ordinary re-renders', () => {
  const view = render(<ChatAvatar name="Alex Chen" src="/api/photo/private" />);
  fireEvent.error(view.container.querySelector('img')!);
  view.rerender(<ChatAvatar name="Alex Chen" src="/api/photo/private" />);
  expect(view.container.querySelector('img')).toBeNull();
  expect(screen.getByText('AC')).toBeTruthy();
});
