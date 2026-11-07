import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationState,
  type SignalDataTypeMap,
} from 'baileys';
import type { WaAuthStorage } from '../types.js';
import type { AuthStore } from './auth-store.js';

const keyName = (type: string, id: string) => 'key:' + JSON.stringify([type, id]);

/** No filesystem fallback: a failed read must never replace an existing linked identity. */
export function createRemoteAuthStore(dir: string, storage: WaAuthStorage): AuthStore {
  let pending: Promise<void> = Promise.resolve();
  function write(changes: Readonly<Record<string, string | null>>): Promise<void> {
    const next = pending.then(() => storage.set(changes));
    pending = next.catch(() => {});
    return next;
  }
  return {
    dir,
    async load() {
      await pending;
      const raw = (await storage.get(['creds']))['creds'];
      const creds = raw === null ? initAuthCreds() : JSON.parse(raw!, BufferJSON.reviver);
      if (!creds || typeof creds !== 'object' || !creds.noiseKey)
        throw new Error('invalid_auth_storage');
      if (raw === null) await write({ creds: JSON.stringify(creds, BufferJSON.replacer) });
      const state: AuthenticationState = {
        creds,
        keys: {
          async get(type, ids) {
            await pending;
            const records = await storage.get(ids.map((id) => keyName(type, id)));
            const result: Record<string, SignalDataTypeMap[typeof type]> = {};
            for (const id of ids) {
              const value = records[keyName(type, id)];
              const parsed = value === null ? null : JSON.parse(value!, BufferJSON.reviver);
              result[id] =
                type === 'app-state-sync-key' && parsed
                  ? proto.Message.AppStateSyncKeyData.fromObject(parsed)
                  : parsed;
            }
            return result;
          },
          async set(data) {
            const changes: Record<string, string | null> = {};
            for (const [type, entries] of Object.entries(data)) {
              for (const [id, value] of Object.entries(entries)) {
                changes[keyName(type, id)] =
                  value === null ? null : JSON.stringify(value, BufferJSON.replacer);
              }
            }
            await write(changes);
          },
        },
      };
      return {
        state,
        saveCreds: () => write({ creds: JSON.stringify(creds, BufferJSON.replacer) }),
      };
    },
    async wipe() {
      await pending;
      await storage.clear();
    },
    async backup() {
      await pending;
      return storage.backup();
    },
  };
}
