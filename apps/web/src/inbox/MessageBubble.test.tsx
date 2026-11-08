import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { Message } from '@ezychat/shared';
import { MessageBubble } from './MessageBubble';
import { setUploadProgress } from '../lib/upload-progress';

const groupMessage: Message = {
  id: 'G-1',
  chatJid: '120363000000000000@g.us',
  senderJid: '123456789012345@lid',
  senderName: null,
  fromMe: false,
  sentByUserId: null,
  type: 'text',
  body: 'hello team',
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
  vi.unstubAllGlobals();
});

describe('MessageBubble group sender', () => {
  it('labels a WhatsApp ID sender without a name as "Unknown contact", never its digits', () => {
    const view = render(
      <MessageBubble message={groupMessage} showSender outboundLabel={null} quoted={null} />,
    );
    expect(screen.getByText('Unknown contact')).toBeTruthy();
    expect(view.container.textContent).not.toContain('123456789012345');
  });

  it('labels a phone-number sender without a name as +digits', () => {
    render(
      <MessageBubble
        message={{ ...groupMessage, senderJid: '60123456789@s.whatsapp.net' }}
        showSender
        outboundLabel={null}
        quoted={null}
      />,
    );
    expect(screen.getByText('+60123456789')).toBeTruthy();
  });
});

describe('MessageBubble voice note transcript', () => {
  const voice: Message = {
    ...groupMessage,
    id: 'V-1',
    chatJid: '60123456789@s.whatsapp.net',
    type: 'audio',
    body: null,
    mediaUrl: '/api/media/V-1',
    mediaMime: 'audio/ogg; codecs=opus',
    mediaStatus: 'ok',
  };
  const bubble = (message: Message) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MessageBubble message={message} showSender={false} outboundLabel={null} quoted={null} />
      </QueryClientProvider>,
    );

  it('shows the transcript under the audio player', () => {
    const view = bubble({
      ...voice,
      transcript: 'Do you deliver to Penang?',
      transcriptLang: 'en',
      transcriptStatus: 'ok',
    });
    const transcript = screen.getByTestId('voice-transcript');
    expect(transcript.textContent).toBe('Transcript: Do you deliver to Penang?');
    expect(transcript.className).toContain('italic');
    expect(transcript.className).toContain('text-muted-foreground');
    expect(view.container.querySelector('audio')).toBeTruthy();
  });

  it('shows a subtle status while transcribing or when it failed, and nothing otherwise', () => {
    bubble({ ...voice, transcriptStatus: 'pending' });
    expect(screen.getByText('Transcribing…')).toBeTruthy();
    cleanup();
    bubble({ ...voice, transcriptStatus: 'failed' });
    expect(screen.getByText('Couldn’t transcribe this voice note')).toBeTruthy();
    cleanup();
    const view = bubble({ ...voice, transcriptStatus: 'skipped' });
    expect(view.container.textContent).not.toMatch(/transcri/i);
    cleanup();
    const plain = bubble(voice);
    expect(plain.container.textContent).not.toMatch(/transcri/i);
  });
});

describe('MessageBubble sender profile', () => {
  const FARAH = '601@s.whatsapp.net';
  function renderBubble(message: Message) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === `/api/chats/${encodeURIComponent(FARAH)}/profile`
          ? new Response(
              JSON.stringify({
                profile: {
                  name: 'Farah Aziz',
                  company: 'Farah Catering Co',
                  email: null,
                  otherPhone: null,
                  address: null,
                  tags: ['VIP'],
                  updatedAt: null,
                  updatedBy: null,
                },
                whatsappName: 'Farah 🌸',
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            )
          : new Response('{}', { status: 404 }),
      ),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <MessageBubble message={message} showSender outboundLabel={null} quoted={null} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('shows the sender profile name in groups and opens their details', async () => {
    renderBubble({
      ...groupMessage,
      senderName: 'Farah 🌸',
      senderProfile: { chatJid: FARAH, name: 'Farah Aziz' },
    });
    expect(screen.queryByText('Farah 🌸')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Farah Aziz' }));
    expect(await screen.findByText('Farah Catering Co')).toBeTruthy();
    expect(screen.getByText('WhatsApp: Farah 🌸')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open chat' }).getAttribute('href')).toBe(
      '/chats/601%40s.whatsapp.net?customer=1',
    );
  });

  it('keeps the plain WhatsApp name without a profile', () => {
    renderBubble({ ...groupMessage, senderName: 'Farah 🌸', senderProfile: null });
    expect(screen.getByText('Farah 🌸')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Farah 🌸' })).toBeNull();
  });
});

describe('MessageBubble reply', () => {
  const sent: Message = { ...groupMessage, id: 'WA-1', chatJid: '6012@s.whatsapp.net' };

  it('offers Reply on a delivered message and passes the message back', async () => {
    const onReply = vi.fn();
    render(
      <MessageBubble
        message={sent}
        showSender={false}
        outboundLabel={null}
        quoted={null}
        onReply={onReply}
      />,
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reply' }));
    expect(onReply).toHaveBeenCalledWith(sent);
  });

  it('offers no Reply on a pending or failed message (WhatsApp cannot match its local id)', () => {
    render(
      <MessageBubble
        message={{ ...sent, id: 'local-abc', fromMe: true, status: 'failed' }}
        showSender={false}
        outboundLabel={null}
        quoted={null}
        onReply={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull();
  });
});

describe('MessageBubble quote author', () => {
  const original: Message = { ...groupMessage, id: 'WA-9', senderName: 'Farah Catering Co' };
  const reply: Message = {
    ...groupMessage,
    id: 'WA-10',
    fromMe: true,
    body: 'ok',
    quotedId: 'WA-9',
  };

  it('names the customer of a direct chat like the header, not by their WhatsApp name', () => {
    render(
      <MessageBubble
        message={reply}
        showSender={false}
        outboundLabel={null}
        quoted={original}
        contactName="Farah Aziz"
      />,
    );
    expect(screen.getByText('Farah Aziz')).toBeTruthy();
    expect(screen.queryByText('Farah Catering Co')).toBeNull();
  });

  it('keeps the sender name in group chats', () => {
    render(<MessageBubble message={reply} showSender outboundLabel={null} quoted={original} />);
    expect(screen.getByText('Farah Catering Co')).toBeTruthy();
  });
});

describe('MessageBubble quote jump', () => {
  const original: Message = { ...groupMessage, id: 'WA-9', senderName: 'Farah', body: 'Price?' };
  const reply: Message = {
    ...groupMessage,
    id: 'WA-10',
    fromMe: true,
    body: 'ok',
    quotedId: 'WA-9',
  };

  it('the quote is a named button that asks for its original, loaded or not', async () => {
    const onOpenQuote = vi.fn();
    const { rerender } = render(
      <MessageBubble
        message={reply}
        showSender
        outboundLabel={null}
        quoted={original}
        onOpenQuote={onOpenQuote}
      />,
    );
    const quote = screen.getByRole('button', { name: /Go to the quoted message.*Farah.*Price\?/ });
    await userEvent.click(quote);
    expect(onOpenQuote).toHaveBeenCalledWith('WA-9');
    // not loaded yet: still a button (the inbox loads older messages to find it)
    rerender(
      <MessageBubble
        message={reply}
        showSender
        outboundLabel={null}
        quoted={null}
        onOpenQuote={onOpenQuote}
      />,
    );
    quote.focus();
    await userEvent.keyboard('{Enter}');
    expect(onOpenQuote).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: /Quoted message/ })).toBeTruthy();
  });

  it('without a handler the quote stays plain text; highlighted marks the bubble', () => {
    const view = render(
      <MessageBubble
        message={reply}
        showSender
        outboundLabel={null}
        quoted={original}
        highlighted
      />,
    );
    expect(screen.queryByTestId('quote-jump')).toBeNull();
    expect(screen.getByText('Price?')).toBeTruthy();
    expect(
      view.container.querySelector('[data-highlighted="true"]')?.getAttribute('data-message-id'),
    ).toBe('WA-10');
  });

  it('a long press on the quote (touch) opens the press-and-hold bar, not the original', () => {
    vi.useFakeTimers();
    try {
      const onOpenQuote = vi.fn();
      render(
        <MessageBubble
          message={{ ...reply, fromMe: false }}
          showSender
          outboundLabel={null}
          quoted={original}
          onOpenQuote={onOpenQuote}
          onReply={vi.fn()}
        />,
      );
      const quote = screen.getByTestId('quote-jump');
      fireEvent.pointerDown(quote, { pointerType: 'touch', clientX: 5, clientY: 5, pointerId: 1 });
      act(() => vi.advanceTimersByTime(600));
      fireEvent.pointerUp(quote, { pointerType: 'touch', pointerId: 1 });
      fireEvent.click(quote);
      expect(onOpenQuote).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('MessageBubble via AI assistant', () => {
  const outbound: Message = {
    ...groupMessage,
    chatJid: '60123456789@s.whatsapp.net',
    senderJid: null,
    fromMe: true,
    sentByUserId: 1,
    clientId: 'mcp-0123456789abcdef',
  };

  it('marks a reply the AI assistant sent through MCP', () => {
    render(
      <MessageBubble
        message={{ ...outbound, viaAssistant: true }}
        showSender={false}
        outboundLabel="Aisyah"
        quoted={null}
      />,
    );
    expect(screen.getByTestId('via-assistant').textContent).toContain('via AI assistant');
  });

  it('trusts only the stored marker, never an mcp- clientId alone', () => {
    render(
      <MessageBubble message={outbound} showSender={false} outboundLabel="Aisyah" quoted={null} />,
    );
    expect(screen.queryByTestId('via-assistant')).toBeNull();
  });

  it('marks a message sent as an approved template with its name', () => {
    render(
      <MessageBubble
        message={{ ...outbound, template: { name: 'order_ready', language: 'en' } }}
        showSender={false}
        outboundLabel="Aisyah"
        quoted={null}
      />,
    );
    expect(screen.getByTestId('via-template').textContent).toBe('Template order_ready ·');
  });

  it('shows no template marker on an ordinary message', () => {
    render(
      <MessageBubble
        message={{ ...outbound, template: null }}
        showSender={false}
        outboundLabel="Aisyah"
        quoted={null}
      />,
    );
    expect(screen.queryByTestId('via-template')).toBeNull();
  });
});

describe('MessageBubble scheduled task mark', () => {
  const sent: Message = {
    ...groupMessage,
    id: 'S-1',
    fromMe: true,
    senderJid: null,
    body: "Good morning team. Today's bookings: 3.",
  };
  const bubble = (message: Message) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <MessageBubble message={message} showSender={false} outboundLabel="Aina" quoted={null} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

  it('marks a message a scheduled task sent with the task name', () => {
    bubble({ ...sent, scheduledTask: { id: 4, name: 'Morning bookings' } });
    expect(screen.getByTestId('scheduled-mark').textContent).toBe('Scheduled · Morning bookings');
  });

  it('says only "Scheduled" once the task is deleted', () => {
    bubble({ ...sent, scheduledTask: { id: 4, name: null } });
    expect(screen.getByTestId('scheduled-mark').textContent).toBe('Scheduled');
  });

  it('marks no other message', () => {
    bubble(sent);
    expect(screen.queryByTestId('scheduled-mark')).toBeNull();
    cleanup();
    // An incoming message never carries the mark, even with the field set.
    bubble({ ...groupMessage, scheduledTask: { id: 4, name: 'Morning bookings' } });
    expect(screen.queryByTestId('scheduled-mark')).toBeNull();
  });
});

describe('MessageBubble forwarded and large files', () => {
  const out: Message = {
    ...groupMessage,
    id: 'O-1',
    fromMe: true,
    senderJid: null,
    status: 'sent',
  };
  const bubble = (m: Message) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MessageBubble message={m} showSender={false} outboundLabel={null} quoted={null} />
      </QueryClientProvider>,
    );

  it('shows "Forwarded" or "Forwarded many times" at the top of the bubble', () => {
    bubble({ ...groupMessage, forwarded: { manyTimes: false } });
    expect(screen.getByTestId('forwarded-label').textContent).toBe('Forwarded');
    cleanup();
    bubble({ ...out, forwarded: { manyTimes: true } });
    expect(screen.getByTestId('forwarded-label').textContent).toBe('Forwarded many times');
    cleanup();
    bubble({ ...groupMessage, forwarded: null });
    expect(screen.queryByTestId('forwarded-label')).toBeNull();
    bubble({
      ...groupMessage,
      forwarded: { manyTimes: false },
      deletedAt: 1,
      deletedBy: 'sender',
    });
    expect(screen.queryByTestId('forwarded-label')).toBeNull();
  });

  it('a pending copy of 20 MB or more says it is still going up to WhatsApp', () => {
    const video: Message = {
      ...out,
      type: 'video',
      body: null,
      status: 'pending',
      mediaSize: 70 * 1024 * 1024,
    };
    bubble(video);
    expect(screen.getByTestId('sending-large').textContent).toBe('Sending 70 MB to WhatsApp…');
    cleanup();
    bubble({ ...video, status: 'sent' });
    bubble({ ...video, id: 'O-2', mediaSize: 19 * 1024 * 1024 });
    bubble({ ...video, id: 'O-3', fromMe: false });
    expect(screen.queryByTestId('sending-large')).toBeNull();
  });

  it('a failed upload reads plainly; other errors show as the server wrote them', () => {
    const failed: Message = { ...out, status: 'failed', error: 'too_large_as_video' };
    bubble(failed);
    expect(screen.getByText('Too large to send as a video on this WhatsApp number.')).toBeTruthy();
    cleanup();
    bubble({ ...failed, error: 'too_large_for_whatsapp' });
    expect(screen.getByText('Too large for this WhatsApp number.')).toBeTruthy();
    cleanup();
    bubble({ ...failed, error: 'too_large' });
    expect(screen.getByText('Too large to send.')).toBeTruthy();
    cleanup();
    bubble({ ...failed, error: 'Upload to WhatsApp failed' });
    expect(screen.getByText('Upload to WhatsApp failed')).toBeTruthy();
    cleanup();
    bubble({ ...failed, error: null });
    expect(screen.getByText('Not sent')).toBeTruthy();
  });
});

describe('MessageBubble upload progress', () => {
  const sending: Message = {
    ...groupMessage,
    id: 'local-up-1',
    chatJid: '60123@s.whatsapp.net',
    fromMe: true,
    type: 'document',
    body: null,
    mediaName: 'catalogue.pdf',
    mediaStatus: 'pending',
    status: 'pending',
    clientId: 'up-1',
  };

  it('shows the share of a file this browser is uploading, and nothing once it is done', () => {
    setUploadProgress('up-1', 0.42);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MessageBubble message={sending} showSender={false} outboundLabel={null} quoted={null} />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId('uploading-progress').textContent).toBe('42%');
    expect(screen.getByRole('progressbar', { name: 'Uploading 42%' })).toBeTruthy();
    act(() => setUploadProgress('up-1', null));
    expect(screen.queryByTestId('uploading-progress')).toBeNull();
  });

  it('words a file the tunnel refused', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MessageBubble
          message={{ ...sending, status: 'failed', error: 'tunnel_too_large', clientId: 'up-2' }}
          showSender={false}
          outboundLabel={null}
          quoted={null}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText(/Too large to send through the internet address/)).toBeTruthy();
  });
});
