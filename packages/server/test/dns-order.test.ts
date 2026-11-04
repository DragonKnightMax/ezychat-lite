// Outgoing connections try IPv4 first: on a network with IPv6 addresses but no IPv6 route, a first
// IPv6 try could hang until fetch's connect timeout ("Can't reach the licence server" at random).
import { getDefaultResultOrder, promises as dns, setDefaultResultOrder } from 'node:dns';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { preferIpv4 } from '../src/dns-order.js';
import { runCli } from '../src/run-cli.js';

const initial = getDefaultResultOrder();
afterEach(() => {
  setDefaultResultOrder(initial);
  vi.restoreAllMocks();
});

describe('IPv4 first', () => {
  it('resolves a dual-stack name with its IPv4 addresses first', async () => {
    setDefaultResultOrder('verbatim');
    preferIpv4();
    expect(getDefaultResultOrder()).toBe('ipv4first');
    const all = await dns.lookup('localhost', { all: true });
    expect(all[0]?.family).toBe(4);
  });

  it('is set by the server command line before anything else runs', async () => {
    setDefaultResultOrder('verbatim');
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const exit = (code: number): never => {
      throw new Error(`exit ${code}`);
    };
    await expect(runCli(['--no-such-option'], {}, { exit })).rejects.toThrow('exit 2');
    expect(getDefaultResultOrder()).toBe('ipv4first');
  });
});
