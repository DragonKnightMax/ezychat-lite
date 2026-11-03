import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Message } from '@ezychat/shared';
import type * as PdfModule from '@/lib/pdf';

const { loadPdf } = vi.hoisted(() => ({ loadPdf: vi.fn() }));
vi.mock('@/lib/pdf', async (orig) => ({ ...(await orig<typeof PdfModule>()), loadPdf }));

import { PdfLoadError } from '@/lib/pdf';
import { MediaView } from './MediaView';

const doc: Message = {
  id: '3EB0PDF',
  chatJid: '60123456789@s.whatsapp.net',
  senderJid: null,
  senderName: null,
  fromMe: false,
  sentByUserId: null,
  type: 'document',
  body: null,
  mediaUrl: '/api/media/3EB0PDF',
  mediaMime: 'application/pdf',
  mediaName: 'Quotation.pdf',
  mediaStatus: 'ok',
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

function fakeDoc(numPages: number) {
  const render = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
  const destroy = vi.fn();
  return {
    render,
    destroy,
    doc: { numPages, getPage: vi.fn(async () => ({ width: 600, height: 800, render })), destroy },
  };
}

afterEach(() => {
  cleanup();
  loadPdf.mockReset();
});

describe('PDF attachments', () => {
  it('open inside the app instead of downloading, with every page drawn', async () => {
    const f = fakeDoc(3);
    loadPdf.mockResolvedValue(f.doc);
    show(doc);
    expect(
      screen.getByRole('link', { name: /download quotation\.pdf/i }).getAttribute('download'),
    ).toBe('Quotation.pdf');
    fireEvent.click(screen.getByRole('button', { name: /open quotation\.pdf/i }));
    expect(await screen.findByRole('dialog', { name: /pdf preview/i })).toBeTruthy();
    expect(loadPdf).toHaveBeenCalledWith('/api/media/3EB0PDF', expect.any(AbortSignal));
    expect(await screen.findByRole('img', { name: 'Page 3 of 3' })).toBeTruthy();
    await waitFor(() => expect(f.render).toHaveBeenCalledTimes(3));
  });

  it('zooms in and out within the limits and redraws', async () => {
    const f = fakeDoc(1);
    loadPdf.mockResolvedValue(f.doc);
    show(doc);
    fireEvent.click(screen.getByRole('button', { name: /open quotation\.pdf/i }));
    await screen.findByRole('img', { name: 'Page 1 of 1' });
    expect(screen.getByText('100%')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByText('125%')).toBeTruthy();
    await waitFor(() => expect(f.render).toHaveBeenCalledTimes(2));
    for (let i = 0; i < 6; i++) fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(screen.getByText('50%')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Zoom out' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('closing the viewer releases the document', async () => {
    const f = fakeDoc(1);
    loadPdf.mockResolvedValue(f.doc);
    show(doc);
    fireEvent.click(screen.getByRole('button', { name: /open quotation\.pdf/i }));
    await screen.findByRole('img', { name: 'Page 1 of 1' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(f.destroy).toHaveBeenCalled());
  });

  it('offers Download when the PDF cannot be shown', async () => {
    loadPdf.mockRejectedValue(new PdfLoadError('too_large'));
    show(doc);
    fireEvent.click(screen.getByRole('button', { name: /open quotation\.pdf/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/too large/i);
    const links = screen.getAllByRole('link', { name: /download/i });
    expect(links.every((a) => a.getAttribute('href') === '/api/media/3EB0PDF')).toBe(true);
  });

  it('an image sent as a file opens in the image preview', async () => {
    show({ ...doc, mediaMime: 'image/png', mediaName: 'receipt.png' });
    fireEvent.click(screen.getByRole('button', { name: /open receipt\.png/i }));
    const dialog = await screen.findByRole('dialog', { name: /image preview/i });
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe('/api/media/3EB0PDF');
    expect(loadPdf).not.toHaveBeenCalled();
  });

  it('other files still download as before', () => {
    show({ ...doc, mediaMime: 'application/zip', mediaName: 'files.zip' });
    expect(screen.queryByRole('button', { name: /open files\.zip/i })).toBeNull();
    expect(screen.getByRole('link', { name: /files\.zip/i }).getAttribute('download')).toBe(
      'files.zip',
    );
  });
});
