import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Message } from '@ezychat/shared';
import { MessageBubble } from './MessageBubble';
import { MediaView, mediaFileName } from './MediaView';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const clip = vi.hoisted(() => ({
  copyText: vi.fn(),
  canCopyImage: vi.fn(() => true),
  copyImageFromUrl: vi.fn(),
}));
vi.mock('@/lib/clipboard', () => clip);

const text: Message = {
  id: '3EB0TEXT',
  chatJid: '60123456789@s.whatsapp.net',
  senderJid: null,
  senderName: null,
  fromMe: false,
  sentByUserId: null,
  type: 'text',
  body: '*Price* RM 25',
  mediaUrl: null,
  mediaMime: null,
  mediaName: null,
  mediaStatus: 'none',
  quotedId: null,
  status: 'delivered',
  error: null,
  timestamp: 1_700_000_000_000,
  clientId: null,
  reactions: [],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function withQuery(ui: React.ReactNode) {
  return render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}

describe('copying out of a message', () => {
  it('copies the text as written and says so', async () => {
    clip.copyText.mockResolvedValue(undefined);
    render(<MessageBubble message={text} showSender={false} outboundLabel={null} quoted={null} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Copy text' }));
    expect(clip.copyText).toHaveBeenCalledWith('*Price* RM 25');
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Copied'));
  });

  it('explains a failed copy', async () => {
    clip.copyText.mockRejectedValue(new Error('denied'));
    render(<MessageBubble message={text} showSender={false} outboundLabel={null} quoted={null} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Copy text' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Couldn’t copy. Select the text and press Ctrl+C instead.',
      ),
    );
  });

  it('offers Copy text in the press-and-hold menu, and no copy for a message without text', async () => {
    clip.copyText.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <MessageBubble
        message={text}
        showSender={false}
        outboundLabel={null}
        quoted={null}
        onReply={vi.fn()}
        onReact={vi.fn()}
      />,
    );
    await user.click(screen.getByTestId('reaction-picker-button'));
    const picker = screen.getByTestId('reaction-picker');
    const copy = Array.from(picker.querySelectorAll('button')).find(
      (b) => b.textContent === 'Copy text',
    )!;
    await user.click(copy);
    expect(clip.copyText).toHaveBeenCalledWith('*Price* RM 25');
    cleanup();
    withQuery(
      <MessageBubble
        message={{ ...text, type: 'audio', body: null, mediaStatus: 'failed' }}
        showSender={false}
        outboundLabel={null}
        quoted={null}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Copy text' })).toBeNull();
  });
});

describe('media out of the app', () => {
  const image: Message = {
    ...text,
    id: '3EB0IMAGE1234',
    type: 'image',
    body: null,
    mediaUrl: '/api/media/3EB0IMAGE1234',
    mediaMime: 'image/jpeg',
    mediaStatus: 'ok',
  };

  it('names media files for saving', () => {
    expect(mediaFileName(image)).toBe('whatsapp-image-MAGE1234.jpg');
    expect(mediaFileName({ ...image, mediaName: 'menu.pdf' })).toBe('menu.pdf');
    expect(mediaFileName({ ...image, mediaMime: 'video/quicktime', type: 'video' })).toBe(
      'whatsapp-video-MAGE1234.quicktime',
    );
    expect(mediaFileName({ ...image, mediaMime: null, id: '__' })).toBe('whatsapp-image-file');
  });

  it('drags an image or a document out as a file download', () => {
    const data = new Map<string, string>();
    const dataTransfer = { setData: (k: string, v: string) => data.set(k, v), effectAllowed: '' };
    const view = withQuery(<MediaView message={image} />);
    fireEvent.dragStart(view.container.querySelector('img')!, { dataTransfer });
    expect(data.get('DownloadURL')).toMatch(
      /^image\/jpeg:whatsapp-image-MAGE1234\.jpg:http.*\/api\/media\/3EB0IMAGE1234$/,
    );
    cleanup();
    data.clear();
    const doc = withQuery(
      <MediaView
        message={{ ...image, type: 'document', mediaMime: 'application/pdf', mediaName: 'Q4.pdf' }}
      />,
    );
    fireEvent.dragStart(doc.container.querySelector('a')!, { dataTransfer });
    expect(data.get('DownloadURL')).toMatch(/^application\/pdf:Q4\.pdf:/);
    data.clear();
    // The row that opens the PDF in the app drags out the same file.
    fireEvent.dragStart(screen.getByRole('button', { name: 'Open Q4.pdf' }), { dataTransfer });
    expect(data.get('DownloadURL')).toMatch(/^application\/pdf:Q4\.pdf:/);
  });

  it('copies an opened image to the clipboard', async () => {
    clip.copyImageFromUrl.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('no'));
    const user = userEvent.setup();
    withQuery(<MediaView message={image} />);
    await user.click(screen.getByRole('button', { name: 'Open image' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.querySelector('a[download]')!.getAttribute('download')).toBe(
      'whatsapp-image-MAGE1234.jpg',
    );
    await user.click(screen.getByRole('button', { name: 'Copy image' }));
    expect(clip.copyImageFromUrl).toHaveBeenCalledWith('/api/media/3EB0IMAGE1234');
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Image copied'));
    await user.click(screen.getByRole('button', { name: 'Copy image' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Couldn’t copy the image. Use Download instead.'),
    );
  });

  it('hides Copy image where the browser cannot copy images', async () => {
    clip.canCopyImage.mockReturnValue(false);
    withQuery(<MediaView message={image} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open image' }));
    await screen.findByRole('dialog');
    expect(screen.queryByRole('button', { name: 'Copy image' })).toBeNull();
    clip.canCopyImage.mockReturnValue(true);
  });
});
