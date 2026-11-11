/**
 * A random RFC 4122 version 4 UUID, for request and client ids the server checks with `z.uuid()`.
 *
 * `crypto.randomUUID` exists only in a secure context (https, localhost). The app is also opened over
 * plain http on the LAN (`http://192.168.x.x:7420`), where browsers leave it out; `getRandomValues`
 * is available there, so the UUID is built from it. Never `Math.random`.
 */
export function randomUuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40; // version 4
  b[8] = (b[8]! & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(b, (n) => n.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
