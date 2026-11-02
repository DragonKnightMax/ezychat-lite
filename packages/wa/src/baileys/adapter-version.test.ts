import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type * as Baileys from 'baileys';
import { BaileysAdapter } from './adapter.js';

const socketFactory = vi.hoisted(() => vi.fn());
const fetchLatest = vi.hoisted(() => vi.fn());
vi.mock('baileys', async (importOriginal) => ({
  ...(await importOriginal<typeof Baileys>()),
  fetchLatestBaileysVersion: fetchLatest,
  makeWASocket: socketFactory,
}));

function adapter() {
  const a = new BaileysAdapter({ authDir: 'unused-auth-dir', historyDays: 0 });
  Object.assign(a as unknown as Record<string, unknown>, {
    auth: {
      load: async () => ({
        state: { creds: {}, keys: { get: async () => ({}), set: async () => {} } },
        saveCreds: async () => {},
      }),
      wipe: async () => {},
    },
  });
  socketFactory.mockReturnValueOnce({ ev: new EventEmitter(), end: vi.fn(), logout: vi.fn() });
  return a;
}

describe('BaileysAdapter WhatsApp Web version', () => {
  it('opens the socket at once while the version lookup hangs, then uses the looked-up version', async () => {
    let answer!: (v: { version: [number, number, number] }) => void;
    fetchLatest.mockReturnValueOnce(new Promise((r) => (answer = r)));

    const first = adapter();
    await first.connect();
    expect(socketFactory).toHaveBeenCalledTimes(1);
    expect(socketFactory.mock.calls[0]![0]).not.toHaveProperty('version');
    expect(first.status.state).toBe('connecting');

    answer({ version: [2, 3000, 7] });
    await vi.waitFor(() => expect(fetchLatest).toHaveBeenCalledTimes(1));
    await new Promise((r) => setImmediate(r));

    const second = adapter();
    await second.connect();
    expect(socketFactory.mock.calls[1]![0]).toMatchObject({ version: [2, 3000, 7] });
    expect(fetchLatest).toHaveBeenCalledTimes(1); // cached, not asked again
    await first.disconnect();
    await second.disconnect();
  });
});
