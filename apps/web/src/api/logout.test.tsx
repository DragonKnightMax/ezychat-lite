import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type React from 'react';
import { qk, useLogout } from './queries';

function stubPush() {
  const unsubscribe = vi.fn(async () => true);
  const sub = { endpoint: 'https://push.example/abc', unsubscribe, toJSON: () => ({}) };
  vi.stubGlobal('Notification', function Notification() {});
  vi.stubGlobal('PushManager', function PushManager() {});
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistration: async () => ({ pushManager: { getSubscription: async () => sub } }) },
  });
  return { unsubscribe };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (navigator as unknown as Record<string, unknown>).serviceWorker;
});

describe('useLogout', () => {
  it('removes this device push subscription (server + browser) before logging out', async () => {
    const { unsubscribe } = stubPush();
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        return new Response('{"ok":true}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const qc = new QueryClient();
    qc.setQueryData(qk.me, { id: 1 });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useLogout(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync();
    });
    expect(calls).toEqual(['DELETE /api/push/subscribe', 'POST /api/auth/logout']);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(qc.getQueryData(qk.me)).toBeNull();
  });

  it('removes the photos, files and saved chat lists of the user who signs out', async () => {
    stubPush();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: true })),
    );
    const kept = new Set(['ezy-avatars-v1', 'ezy-media-v1', 'workbox-precache-v2-x']);
    vi.stubGlobal('caches', {
      keys: () => Promise.resolve([...kept]),
      delete: (name: string) => Promise.resolve(kept.delete(name)),
    });
    localStorage.setItem('ezy.queries.1', '{}');
    const qc = new QueryClient();
    qc.setQueryData(qk.me, { id: 1 });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useLogout(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync();
    });
    expect([...kept]).toEqual(['workbox-precache-v2-x']);
    expect(localStorage.getItem('ezy.queries.1')).toBeNull();
  });

  it('still logs out when removing the push subscription fails', async () => {
    const { unsubscribe } = stubPush();
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        const status = url.endsWith('/push/subscribe') ? 500 : 200;
        return new Response('{"ok":true}', {
          status,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const qc = new QueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useLogout(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync();
    });
    expect(calls).toContain('POST /api/auth/logout');
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
