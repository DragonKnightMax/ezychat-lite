import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Message } from '@ezychat/shared';
import { imageBox, MediaView } from './MediaView';

const base: Message = {
  id: '3EB0ABC',
  chatJid: '60123456789@s.whatsapp.net',
  senderJid: null,
  senderName: null,
  fromMe: false,
  sentByUserId: null,
  type: 'audio',
  body: null,
  mediaUrl: null,
  mediaMime: 'audio/ogg',
  mediaName: null,
  mediaStatus: 'pending',
  quotedId: null,
  status: 'delivered',
  error: null,
  timestamp: 1,
  clientId: null,
  reactions: [],
};

function show(m: Message) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MediaView message={m} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MediaView pending media', () => {
  it('history audio sent from the phone is loaded on demand, not shown as uploading', () => {
    show({ ...base, fromMe: true, status: 'read' });
    expect(screen.queryByText(/uploading/i)).toBeNull();
    expect(screen.getByRole('button', { name: /tap to load/i })).toBeTruthy();
  });

  it('a message still uploading from the app shows the upload spinner', () => {
    show({ ...base, id: 'local-abc', fromMe: true, status: 'pending' });
    expect(screen.getByText(/uploading/i)).toBeTruthy();
  });

  it('pending history images load automatically', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ...base, type: 'image', mediaStatus: 'ok', mediaUrl: '/api/media/3EB0ABC' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    show({ ...base, type: 'image', mediaMime: 'image/jpeg' });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String((fetchMock.mock.calls[0] as unknown as [string])[0])).toBe('/api/media/3EB0ABC/redownload');
  });

  it('a pending image downloads only when the reader comes near it', async () => {
    let notify: IntersectionObserverCallback | undefined;
    let options: IntersectionObserverInit | undefined;
    const disconnect = vi.fn();
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback, init?: IntersectionObserverInit) {
          notify = callback;
          options = init;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ...base, type: 'image', mediaStatus: 'ok', mediaUrl: '/api/media/3EB0ABC' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    show({ ...base, type: 'image', mediaMime: 'image/jpeg' });
    expect(options?.rootMargin).toBe('300px 0px');

    const entry = (isIntersecting: boolean) => [{ isIntersecting }] as IntersectionObserverEntry[];
    notify!(entry(false), {} as IntersectionObserver);
    expect(fetchMock).not.toHaveBeenCalled();

    notify!(entry(true), {} as IntersectionObserver);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(disconnect).toHaveBeenCalled();
  });

  it('keeps the image size for the waiting box', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    show({ ...base, type: 'image', mediaMime: 'image/jpeg', mediaWidth: 1600, mediaHeight: 900 });
    const box = screen.getByText(/downloading/i).parentElement!;
    expect(box.style.width).toBe('320px');
    expect(box.style.aspectRatio).toBe('320 / 180');
  });
});

describe('MediaView stored image', () => {
  const stored: Message = { ...base, type: 'image', mediaStatus: 'ok', mediaUrl: '/api/media/3EB0ABC', mediaMime: 'image/jpeg' };

  it('uses the known size', () => {
    show({ ...stored, mediaWidth: 400, mediaHeight: 800 });
    const img = screen.getByRole('img');
    expect(img.style.width).toBe('320px');
    expect(img.style.aspectRatio).toBe('320 / 288');
  });

  it('keeps the old fit when the size is not known', () => {
    show(stored);
    const img = screen.getByRole('img');
    expect(img.style.width).toBe('');
    expect(img.className).toContain('max-h-72');
  });

  it('gives a sticker its fixed size even with a known size', () => {
    show({ ...stored, type: 'sticker', mediaWidth: 512, mediaHeight: 512 });
    const img = screen.getByRole('img');
    expect(img.style.width).toBe('');
    expect(img.className).toContain('size-32');
  });
});

describe('MediaView with WhatsApp thumbnail', () => {
  const thumb = '/api/media/3EB0ABC/thumb';
  const real = '/api/media/3EB0ABC';
  const image: Message = { ...base, type: 'image', mediaMime: 'image/jpeg', mediaThumbUrl: thumb, mediaWidth: 768, mediaHeight: 1024 };

  it('the chat shows only the thumbnail, and opening shows only the real photo', async () => {
    show({ ...image, mediaStatus: 'ok', mediaUrl: real });
    const inChat = screen.getByRole('img') as HTMLImageElement;
    expect(inChat.getAttribute('src')).toBe(thumb);
    expect(document.querySelector(`img[src="${real}"]`)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /open image/i }));
    const dialog = await screen.findByRole('dialog');
    const photo = dialog.querySelector('img')!;
    expect(photo.getAttribute('src')).toBe(real);
    expect(dialog.querySelector(`img[src="${thumb}"]`)).toBeNull();
  });

  it('a pending image with a thumbnail downloads nothing until it is opened', async () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    show(image);
    expect((screen.getByRole('img') as HTMLImageElement).getAttribute('src')).toBe(thumb);
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /open image/i }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.querySelector('img')!.getAttribute('src')).toBe(real);
  });

  it('shows a spinner until the real photo has loaded', async () => {
    show({ ...image, mediaStatus: 'ok', mediaUrl: real });
    fireEvent.click(screen.getByRole('button', { name: /open image/i }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.querySelector('.animate-spin')).toBeTruthy();
    fireEvent.load(dialog.querySelector('img')!);
    expect(dialog.querySelector('.animate-spin')).toBeNull();
  });

  it('a click on the photo keeps it open; a click beside it or Esc closes it', async () => {
    show({ ...image, mediaStatus: 'ok', mediaUrl: real });
    fireEvent.click(screen.getByRole('button', { name: /open image/i }));
    let dialog = await screen.findByRole('dialog');
    const photo = dialog.querySelector('img')!;
    fireEvent.load(photo);
    fireEvent.click(photo);
    expect(screen.getByRole('dialog')).toBe(dialog);

    fireEvent.click(photo.parentElement!);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: /open image/i }));
    dialog = await screen.findByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('falls back to the real photo when the thumbnail cannot load', () => {
    show({ ...image, mediaStatus: 'ok', mediaUrl: real });
    fireEvent.error(screen.getByRole('img'));
    expect((screen.getByRole('img') as HTMLImageElement).getAttribute('src')).toBe(real);
  });

  it('a failed image shows the failed state, not its thumbnail', () => {
    show({ ...image, mediaStatus: 'failed' });
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });
});

describe('imageBox', () => {
  it.each([
    ['a small image keeps its size', 200, 100, 200, '200 / 100'],
    ['a wide image fits the width', 1600, 900, 320, '320 / 180'],
    ['a tall image stops at the height limit', 720, 1280, 320, '320 / 288'],
  ])('%s', (_name, w, h, width, ratio) => {
    expect(imageBox(w, h)).toEqual({ width, maxWidth: '100%', aspectRatio: ratio });
  });

  it.each([
    [null, 100],
    [100, null],
    [undefined, undefined],
    [0, 100],
  ])('has no box without a size (%s x %s)', (w, h) => {
    expect(imageBox(w, h)).toBeUndefined();
  });
});
