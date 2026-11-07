import { createRef } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MEDIA_UPLOAD_LIMIT_BYTES } from '@ezychat/shared';
import { Composer, type ComposerHandle } from './Composer';

const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn() } }));

afterEach(() => {
  cleanup();
  toastError.mockReset();
});
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= function () {};
});

const pdf = () => new File(['%PDF'], 'price-list.pdf', { type: 'application/pdf' });
const png = () => new File(['png'], 'image.png', { type: 'image/png' });

function paste(box: HTMLElement, data: { files?: File[]; types?: string[]; text?: string }) {
  return fireEvent.paste(box, {
    clipboardData: {
      files: data.files ?? [],
      types: data.types ?? ['Files'],
      getData: (type: string) => (type === 'text/plain' ? (data.text ?? '') : ''),
    },
  });
}

describe('Composer attachments', () => {
  it('puts a pasted screenshot in the tray and sends it with the typed caption', async () => {
    const onAttach = vi.fn();
    const onSend = vi.fn();
    render(
      <Composer quickReplies={[]} onSend={onSend} onAttach={onAttach} onVoiceNote={vi.fn()} />,
    );
    const user = userEvent.setup();
    const box = screen.getByRole('textbox', { name: 'Message' });
    paste(box, { files: [png()] });
    const tray = screen.getByTestId('attachment-tray');
    expect(tray.textContent).toContain('1 file to send');
    expect(tray.textContent).toMatch(/pasted-\d{8}-\d{6}\.png/);
    expect(screen.getByPlaceholderText('Add a caption (optional)')).toBe(box);
    // A file waiting means Send, not the mic.
    expect(screen.queryByRole('button', { name: 'Record a voice note' })).toBeNull();
    await user.type(box, 'Here is the receipt{Enter}');
    await waitFor(() => expect(onAttach).toHaveBeenCalledTimes(1));
    expect(onAttach.mock.calls[0]![1]).toBe('Here is the receipt');
    expect(onAttach.mock.calls[0]![2]).toBe(0);
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.queryByTestId('attachment-tray')).toBeNull();
    expect((box as HTMLTextAreaElement).value).toBe('');
  });

  it('lets text from Office or a web page paste as text', () => {
    const onAttach = vi.fn();
    render(<Composer quickReplies={[]} onSend={vi.fn()} onAttach={onAttach} />);
    const box = screen.getByRole('textbox', { name: 'Message' });
    const event = paste(box, {
      files: [png()],
      types: ['text/html', 'text/plain', 'Files'],
      text: 'Price list for October',
    });
    expect(event).toBe(true);
    paste(box, { files: [], types: ['text/plain'], text: 'hello' });
    expect(screen.queryByTestId('attachment-tray')).toBeNull();
  });

  it('attaches an image copied from a web page (HTML but no text)', () => {
    render(<Composer quickReplies={[]} onSend={vi.fn()} onAttach={vi.fn()} />);
    const box = screen.getByRole('textbox', { name: 'Message' });
    const event = paste(box, { files: [png()], types: ['text/html', 'Files'], text: '  ' });
    expect(event).toBe(false);
    expect(screen.getByTestId('attachment-tray').textContent).toContain('1 file to send');
  });

  it('sends several files one after another, in order, with the caption on the first', async () => {
    const order: string[] = [];
    let release!: () => void;
    const onAttach = vi.fn(
      (file: File) =>
        new Promise<void>((resolve) => {
          order.push(file.name);
          release = resolve;
        }),
    );
    const ref = createRef<ComposerHandle>();
    render(<Composer ref={ref} quickReplies={[]} onSend={vi.fn()} onAttach={onAttach} />);
    const user = userEvent.setup();
    const a = new File(['a'], 'a.pdf', { type: 'application/pdf' });
    const b = new File(['b'], 'b.pdf', { type: 'application/pdf' });
    act(() => ref.current!.addFiles([a, b]));
    expect(screen.getByTestId('attachment-tray').textContent).toContain('2 files to send');
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Docs');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(onAttach).toHaveBeenCalledTimes(1));
    expect(onAttach).toHaveBeenLastCalledWith(a, 'Docs', 0);
    release();
    await waitFor(() => expect(onAttach).toHaveBeenCalledTimes(2));
    expect(onAttach).toHaveBeenLastCalledWith(b, undefined, 1);
    expect(order).toEqual(['a.pdf', 'b.pdf']);
  });

  it('keeps sending the rest when one file fails', async () => {
    const onAttach = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined);
    const ref = createRef<ComposerHandle>();
    render(<Composer ref={ref} quickReplies={[]} onSend={vi.fn()} onAttach={onAttach} />);
    act(() => ref.current!.addFiles([pdf(), png()]));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(onAttach).toHaveBeenCalledTimes(2));
  });

  it('picks several files, removes one and clears the rest', async () => {
    const onAttach = vi.fn();
    const { container } = render(
      <Composer quickReplies={[]} onSend={vi.fn()} onAttach={onAttach} />,
    );
    const user = userEvent.setup();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.multiple).toBe(true);
    await user.upload(input, [pdf(), new File(['n'], 'notes.txt', { type: 'text/plain' })]);
    expect(screen.getByTestId('attachment-tray').textContent).toContain('2 files to send');
    await user.click(screen.getByRole('button', { name: 'Remove price-list.pdf' }));
    expect(screen.getByTestId('attachment-tray').textContent).toContain('notes.txt');
    expect(screen.getByTestId('attachment-tray').textContent).not.toContain('price-list.pdf');
    await user.click(screen.getByRole('button', { name: 'Remove all' }));
    expect(screen.queryByTestId('attachment-tray')).toBeNull();
    expect(onAttach).not.toHaveBeenCalled();
  });

  it('refuses a file over the upload limit and an eleventh file with a message', () => {
    const ref = createRef<ComposerHandle>();
    render(<Composer ref={ref} quickReplies={[]} onSend={vi.fn()} onAttach={vi.fn()} />);
    const big = new File(['x'], 'video.mov', { type: 'video/quicktime' });
    Object.defineProperty(big, 'size', { value: MEDIA_UPLOAD_LIMIT_BYTES + 1 });
    act(() => ref.current!.addFiles([big]));
    expect(toastError).toHaveBeenCalledWith('video.mov is larger than 100 MB and can’t be sent.');
    expect(screen.queryByTestId('attachment-tray')).toBeNull();
    const many = Array.from({ length: 11 }, (_, i) => new File(['f'], `f${i}.txt`));
    act(() => ref.current!.addFiles(many));
    expect(screen.getByTestId('attachment-tray').textContent).toContain('10 files to send');
    expect(toastError).toHaveBeenLastCalledWith('Up to 10 files at a time: f10.txt was not added.');
  });

  it("refuses a file above what the chat's WhatsApp number takes, naming that limit", () => {
    const ref = createRef<ComposerHandle>();
    render(
      <Composer
        ref={ref}
        quickReplies={[]}
        onSend={vi.fn()}
        onAttach={vi.fn()}
        mediaLimits={{ image: 5 * 1024 * 1024, document: 100 * 1024 * 1024 }}
      />,
    );
    const photo = new File(['x'], 'photo.jpg', { type: 'image/jpeg' });
    Object.defineProperty(photo, 'size', { value: 6 * 1024 * 1024 });
    act(() => ref.current!.addFiles([photo]));
    expect(toastError).toHaveBeenCalledWith('photo.jpg is larger than 5.0 MB and can’t be sent.');
    expect(screen.queryByTestId('attachment-tray')).toBeNull();
  });

  it('takes no files while sending is blocked, and asks before sending them', async () => {
    const ref = createRef<ComposerHandle>();
    const { rerender } = render(
      <Composer ref={ref} disabled quickReplies={[]} onSend={vi.fn()} onAttach={vi.fn()} />,
    );
    act(() => ref.current!.addFiles([pdf()]));
    expect(screen.queryByTestId('attachment-tray')).toBeNull();
    const onAttach = vi.fn();
    const confirmSend = vi.fn().mockResolvedValue(false);
    rerender(
      <Composer
        ref={ref}
        quickReplies={[]}
        onSend={vi.fn()}
        onAttach={onAttach}
        confirmSend={confirmSend}
      />,
    );
    act(() => ref.current!.addFiles([pdf()]));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Send' }));
    expect(confirmSend).toHaveBeenCalled();
    expect(onAttach).not.toHaveBeenCalled();
    // Cancelled: the file stays for another try.
    expect(screen.getByTestId('attachment-tray').textContent).toContain('price-list.pdf');
  });

  it('shows an image thumbnail and frees it when the file is removed', async () => {
    const createObjectURL = vi.fn(() => 'blob:thumb');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const ref = createRef<ComposerHandle>();
    const { container } = render(
      <Composer ref={ref} quickReplies={[]} onSend={vi.fn()} onAttach={vi.fn()} />,
    );
    act(() => ref.current!.addFiles([new File(['p'], 'shop.png', { type: 'image/png' })]));
    expect(container.querySelector('img[src="blob:thumb"]')).toBeTruthy();
    fireEvent.error(container.querySelector('img[src="blob:thumb"]')!);
    expect(container.querySelector('img')).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Remove shop.png' }));
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:thumb');
  });
});
