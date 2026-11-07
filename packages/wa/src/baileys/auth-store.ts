import { cp, mkdir, rm } from 'node:fs/promises';
import { useMultiFileAuthState, type AuthenticationState } from 'baileys';
import type { WaAuthStorage } from '../types.js';
import { createRemoteAuthStore } from './remote-auth-store.js';

export interface AuthStore {
  readonly dir: string;
  /** Load (or create) the multi-file auth state. */
  load(): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }>;
  /** Remove all auth/session files. */
  wipe(): Promise<void>;
  /** Copy the auth dir to `${dir}.bak-<ts>`; returns the backup path. */
  backup(): Promise<string>;
}

export function createAuthStore(dir: string, storage?: WaAuthStorage): AuthStore {
  if (storage) return createRemoteAuthStore(dir, storage);
  return {
    dir,
    async load() {
      await mkdir(dir, { recursive: true });
      return useMultiFileAuthState(dir);
    },
    async wipe() {
      await rm(dir, { recursive: true, force: true });
    },
    async backup() {
      const target = `${dir}.bak-${Date.now()}`;
      await cp(dir, target, { recursive: true, force: true }).catch(
        (err: NodeJS.ErrnoException) => {
          if (err.code !== 'ENOENT') throw err;
        },
      );
      return target;
    },
  };
}
