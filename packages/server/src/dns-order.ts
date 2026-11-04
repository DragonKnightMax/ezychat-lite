import { setDefaultResultOrder } from 'node:dns';

/**
 * Outgoing connections (licence server, Google, the AI provider, the connector list) try IPv4
 * addresses first. Node's default keeps the resolver's order, and on a network that hands out IPv6
 * addresses without an IPv6 route (common on home routers) a first IPv6 try can hang until fetch's
 * 10 s connect timeout: the server then looks unreachable at random while the browser and curl work.
 * IPv6-only networks still connect, because Node falls back to the next address family.
 */
export function preferIpv4(): void {
  setDefaultResultOrder('ipv4first');
}
