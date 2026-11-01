import { describe, expect, it, vi } from 'vitest';
import { t } from '../i18n.js';
import { createMovedFlow, type MovedFlowOptions } from './moved-flow.js';
import { ENTERPRISE_PAGE_URL } from './moved.js';

function setup(responses: number[], over: Partial<MovedFlowOptions> = {}) {
  const boxes: Parameters<MovedFlowOptions['showMessageBox']>[0][] = [];
  const o: MovedFlowOptions = {
    dataDir: '/lite/data',
    platform: 'darwin',
    env: { HOME: '/Users/a' },
    productName: 'EzyChat Lite',
    t: (key, vars) => t('en', key, vars),
    readText: (p) =>
      p === '/lite/data/moved.json'
        ? JSON.stringify({ to: 'enterprise', product: 'EzyChat Enterprise', at: 'x', version: '1' })
        : null,
    exists: () => false,
    showMessageBox: vi.fn(async (options) => {
      boxes.push(options);
      return { response: responses.shift() ?? 2 };
    }),
    openPath: vi.fn(async () => ''),
    openExternal: vi.fn(async () => {}),
    showPage: vi.fn(),
    restore: vi.fn(async () => true),
    start: vi.fn(async () => true),
    runOperation: vi.fn(async (_label, _title, action) => action()),
    log: vi.fn(),
    ...over,
  };
  return { flow: createMovedFlow(o), o, boxes };
}

describe('moved screen', () => {
  it('shows the page and the choice with the product named in moved.json', async () => {
    const { flow, o, boxes } = setup([2]);
    expect(flow.active()).toBe(false);
    await flow.show();
    expect(o.showPage).toHaveBeenCalledWith(
      'This WhatsApp number now runs in EzyChat Enterprise.',
      'EzyChat Lite stays off so customers never get two replies.',
    );
    expect(boxes[0]!.buttons).toEqual([
      'Open EzyChat Enterprise',
      'Use EzyChat Lite again',
      'Close',
    ]);
    // Closing keeps the screen; the tray's Open asks again.
    expect(flow.active()).toBe(true);
    await flow.ask();
    expect(boxes).toHaveLength(2);
  });

  it('opens the installed Enterprise app, else its web page', async () => {
    const installed = setup([0], { exists: (p) => p === '/Applications/EzyChat Enterprise.app' });
    await installed.flow.show();
    expect(installed.o.openPath).toHaveBeenCalledWith('/Applications/EzyChat Enterprise.app');
    expect(installed.o.openExternal).not.toHaveBeenCalled();

    const broken = setup([0], {
      exists: () => true,
      openPath: vi.fn(async () => 'cannot open'),
    });
    await broken.flow.show();
    expect(broken.o.openExternal).toHaveBeenCalledWith(ENTERPRISE_PAGE_URL);

    const none = setup([0], { readText: () => null });
    await none.flow.show();
    expect(none.o.openPath).not.toHaveBeenCalled();
    expect(none.o.openExternal).toHaveBeenCalledWith(ENTERPRISE_PAGE_URL);
  });

  it('uses Lite again only after the warning, then restores and starts', async () => {
    const { flow, o, boxes } = setup([1, 0]);
    await flow.show();
    expect(boxes[1]).toMatchObject({
      type: 'warning',
      message: 'Use EzyChat Lite again?',
      buttons: ['Use EzyChat Lite again', 'Cancel'],
      cancelId: 1,
    });
    expect(boxes[1]!.detail).toContain('WhatsApp needs a new QR scan.');
    expect(o.restore).toHaveBeenCalledOnce();
    expect(o.start).toHaveBeenCalledOnce();
    expect(flow.active()).toBe(false);
    await flow.ask(); // nothing to ask any more
    expect(boxes).toHaveLength(2);
  });

  it('cancelling the warning changes nothing; a failed restore is an error', async () => {
    const cancelled = setup([1, 1]);
    await cancelled.flow.show();
    expect(cancelled.o.restore).not.toHaveBeenCalled();
    expect(cancelled.flow.active()).toBe(true);

    const failed = setup([1, 0], { restore: vi.fn(async () => false) });
    await expect(failed.flow.show()).rejects.toThrow('Could not turn EzyChat Lite back on');
    expect(failed.o.start).not.toHaveBeenCalled();
  });

  it('asks only once at a time', async () => {
    let answer!: (v: { response: number }) => void;
    const { flow, o } = setup([], {
      showMessageBox: vi.fn(() => new Promise<{ response: number }>((r) => (answer = r))),
    });
    const first = flow.show();
    await flow.ask();
    expect(o.showMessageBox).toHaveBeenCalledOnce();
    answer({ response: 2 });
    await first;
  });
});
