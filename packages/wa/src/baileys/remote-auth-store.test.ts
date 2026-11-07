import { describe, expect, it } from 'vitest';
import { proto } from 'baileys';
import { createAuthStore } from './auth-store.js';
import type { WaAuthStorage } from '../types.js';

function memoryStorage() {
  const values = new Map<string, string>();
  const backups: Map<string, string>[] = [];
  const storage: WaAuthStorage = {
    async get(keys) {
      return Object.fromEntries(keys.map((key) => [key, values.get(key) ?? null]));
    },
    async set(changes) {
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) values.delete(key);
        else values.set(key, value);
      }
    },
    async clear() {
      values.clear();
    },
    async backup() {
      backups.push(new Map(values));
      return 'backup-' + backups.length;
    },
  };
  return { storage, values, backups };
}

describe('durable external authentication storage', () => {
  it('keeps two inbox stores isolated when one logs out', async () => {
    const first = memoryStorage(),
      second = memoryStorage();
    const a = createAuthStore('inbox-a', first.storage),
      b = createAuthStore('inbox-b', second.storage);
    const aa = await a.load(),
      bb = await b.load();
    expect(aa.state.creds.noiseKey).not.toEqual(bb.state.creds.noiseKey);
    await a.wipe();
    expect(first.values.size).toBe(0);
    expect(second.values.has('creds')).toBe(true);
    expect((await b.load()).state.creds.noiseKey).toEqual(bb.state.creds.noiseKey);
  });

  it('restores the same credentials and Signal keys without using a local auth directory', async () => {
    const { storage, values } = memoryStorage();
    const first = await createAuthStore('not-a-local-directory', storage).load();
    expect(values.has('creds')).toBe(true);
    first.state.creds.registered = true;
    await first.saveCreds();
    await first.state.keys.set({
      'pre-key': {
        '1': { private: Buffer.from('private-key'), public: Buffer.from('public-key') },
      },
    });
    const resumed = await createAuthStore('not-a-local-directory', storage).load();
    expect(resumed.state.creds.registered).toBe(true);
    expect(resumed.state.creds.noiseKey).toEqual(first.state.creds.noiseKey);
    expect((await resumed.state.keys.get('pre-key', ['1']))['1']?.private).toEqual(
      Buffer.from('private-key'),
    );
    expect((await resumed.state.keys.get('pre-key', ['missing']))['missing']).toBeNull();
  });

  it('preserves protobuf keys, deletes keys, backs up and wipes only the selected storage', async () => {
    const { storage, values, backups } = memoryStorage();
    const store = createAuthStore('remote-scope', storage);
    const auth = await store.load();
    const key = proto.Message.AppStateSyncKeyData.create({ keyData: Buffer.from('app-key') });
    await auth.state.keys.set({ 'app-state-sync-key': { 'app:1': key } });
    const restored = (await auth.state.keys.get('app-state-sync-key', ['app:1']))['app:1'];
    expect(restored).toBeInstanceOf(proto.Message.AppStateSyncKeyData);
    expect(Buffer.from(restored!.keyData!)).toEqual(Buffer.from('app-key'));
    expect(await store.backup()).toBe('backup-1');
    expect(backups[0]!.size).toBeGreaterThan(1);
    await auth.state.keys.set({ 'app-state-sync-key': { 'app:1': null } });
    expect((await auth.state.keys.get('app-state-sync-key', ['app:1']))['app:1']).toBeNull();
    await store.wipe();
    expect(values.size).toBe(0);
    expect(backups[0]!.size).toBeGreaterThan(1);
  });

  it('never replaces credentials when storage is unavailable or corrupt', async () => {
    const { storage, values } = memoryStorage();
    values.set('creds', 'not-json');
    await expect(createAuthStore('remote-scope', storage).load()).rejects.toThrow();
    expect(values.get('creds')).toBe('not-json');
    storage.get = async () => {
      throw new Error('storage_unavailable');
    };
    await expect(createAuthStore('remote-scope', storage).load()).rejects.toThrow(
      'storage_unavailable',
    );
  });

  it('propagates failed writes instead of reporting persistence success', async () => {
    const { storage } = memoryStorage();
    const auth = await createAuthStore('remote-scope', storage).load();
    storage.set = async () => {
      throw new Error('write_failed');
    };
    await expect(auth.saveCreds()).rejects.toThrow('write_failed');
    await expect(auth.state.keys.set({ 'pre-key': { '2': null } })).rejects.toThrow('write_failed');
  });
});
