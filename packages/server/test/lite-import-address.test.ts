// Lite's own address in a merge: it moves when the target has none, the hand-over releases it in
// Lite (any Lite version then starts without it), and the undo puts everything back.
import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SecretBox } from '../src/crypto/secret.js';
import { openDb } from '../src/db/index.js';
import { SettingsStore } from '../src/db/settings.js';
import { handOver } from '../src/lite-import/handover.js';
import { releaseLiteAddress } from '../src/lite-import/merge-address.js';
import { mergeLiteInbox } from '../src/lite-import/merge.js';
import { silentLogger } from '../src/logger.js';
import { readMovedMarker } from '../src/moved.js';
import { cleanupDirs, seedLite, seedTarget, tempDir } from './lite-import-merge-helpers.js';

afterEach(cleanupDirs);

const HOST = 'inbox.example.com';
const TUNNEL_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_ID = '66666666-7777-4888-8999-000000000000';
const ACCOUNT = 'a'.repeat(32);
const TOKEN = 'runtime-token-123';
const ZONE = 'b'.repeat(32);
const AUTH = JSON.stringify({ accountID: ACCOUNT, zoneID: ZONE, apiToken: 'cf-api-token' });
const MANAGED = {
  id: TUNNEL_ID,
  accountID: ACCOUNT,
  name: 'wa-team-inbox',
  hostname: HOST,
  zoneID: 'b'.repeat(32),
  port: 7420,
  tokenHash: 'hash',
};

const settingsOf = (dir: string) => {
  const db = openDb(join(dir, 'app.db'));
  return { db, s: new SettingsStore(db, SecretBox.loadOrCreate(join(dir, 'secret.key'))) };
};

/** Lite's app-managed own address, as Cloudflare setup saves it. */
function giveAddress(dir: string, opts: { managed?: boolean } = {}): void {
  const { db, s } = settingsOf(dir);
  s.set('tunnel_mode', 'named');
  s.setSecret('tunnel_token', TOKEN);
  s.set('named_tunnel_hostname', HOST);
  if (opts.managed !== false) s.set('cloudflare_managed_tunnel', MANAGED);
  s.setSecret('cloudflare_auth', AUTH);
  s.set('cloudflare_domains', [{ zoneID: 'b'.repeat(32), name: 'example.com' }]);
  s.set('cloudflare_owned_tunnels', [
    { id: TUNNEL_ID, accountID: ACCOUNT, name: 'wa-team-inbox' },
    { id: OTHER_ID, accountID: ACCOUNT, name: 'old' },
  ]);
  db.close();
}

const merge = (target: string, lite: string) =>
  mergeLiteInbox({
    targetDataDir: target,
    liteDataDir: lite,
    plan: { team: [] },
    maxInboxes: 3,
    log: silentLogger(),
    progress: () => {},
  });

const auditMeta = (dir: string) => {
  const db = new Database(join(dir, 'app.db'), { readonly: true });
  try {
    const row = db
      .prepare("SELECT meta FROM audit_log WHERE action = 'lite.import' ORDER BY id DESC")
      .get() as { meta: string };
    return JSON.parse(row.meta) as { addressMoved: boolean };
  } finally {
    db.close();
  }
};

describe('merge: own address', () => {
  it("moves Lite's managed address into a target without one, sealed with the target's key", async () => {
    const t = seedTarget();
    const lite = seedLite();
    giveAddress(lite.dir);
    {
      // A half-done Cloudflare sign-in of the target to the same account (no address): its tunnels
      // stay listed beside Lite's.
      const { db, s } = settingsOf(t.dir);
      s.setSecret(
        'cloudflare_auth',
        JSON.stringify({ accountID: ACCOUNT, zoneID: ZONE, apiToken: 'target-api-token' }),
      );
      s.set('cloudflare_owned_tunnels', [
        { id: OTHER_ID, accountID: ACCOUNT, name: 'old' },
        { id: '99999999-2222-4333-8444-555555555555', accountID: 'c'.repeat(32), name: 'x' },
      ]);
      s.set('tunnel_mode', 'quick');
      db.close();
    }
    const result = await merge(t.dir, lite.dir);
    expect(result.address).toBe(HOST);

    const { db, s } = settingsOf(t.dir);
    expect(s.get('tunnel_mode', null)).toBe('named');
    expect(s.get('named_tunnel_hostname', null)).toBe(HOST);
    expect(s.getSecret('tunnel_token')).toBe(TOKEN);
    expect(s.getSecret('cloudflare_auth')).toBe(AUTH);
    expect(s.get('cloudflare_managed_tunnel', null)).toEqual(MANAGED);
    expect(s.get('cloudflare_domains', null)).toEqual([
      { zoneID: 'b'.repeat(32), name: 'example.com' },
    ]);
    expect(s.get<Array<{ id: string }>>('cloudflare_owned_tunnels', []).map((x) => x.id)).toEqual([
      OTHER_ID,
      '99999999-2222-4333-8444-555555555555',
      TUNNEL_ID,
    ]);
    // the stored values are the target's ciphertext, not Lite's
    const raw = db.prepare("SELECT value FROM settings WHERE key = 'tunnel_token'").get() as {
      value: string;
    };
    const liteBox = SecretBox.fromKey(readFileSync(join(lite.dir, 'secret.key')));
    expect(() => liteBox.decrypt(raw.value)).toThrow();
    db.close();
    expect(auditMeta(t.dir).addressMoved).toBe(true);
  });

  it('never replaces a Cloudflare sign-in of the target to another account', async () => {
    const t = seedTarget();
    const lite = seedLite();
    giveAddress(lite.dir);
    const other = JSON.stringify({
      accountID: 'c'.repeat(32),
      zoneID: ZONE,
      apiToken: 'other-token',
    });
    {
      const { db, s } = settingsOf(t.dir);
      s.setSecret('cloudflare_auth', other);
      db.close();
    }
    expect((await merge(t.dir, lite.dir)).address).toBeNull();
    const { db, s } = settingsOf(t.dir);
    expect(s.getSecret('cloudflare_auth')).toBe(other);
    expect(s.getSecret('tunnel_token')).toBeNull();
    db.close();
  });

  it('keeps the target’s own address and leaves Lite’s behind', async () => {
    const t = seedTarget();
    const lite = seedLite();
    giveAddress(lite.dir);
    {
      const { db, s } = settingsOf(t.dir);
      s.setSecret('tunnel_token', 'target-token');
      db.close();
    }
    expect((await merge(t.dir, lite.dir)).address).toBeNull();
    const { db, s } = settingsOf(t.dir);
    expect(s.getSecret('tunnel_token')).toBe('target-token');
    expect(s.get('named_tunnel_hostname', null)).toBeNull();
    expect(s.get('cloudflare_managed_tunnel', null)).toBeNull();
    db.close();
    expect(auditMeta(t.dir).addressMoved).toBe(false);
  });

  it.each([
    ['set up in the Cloudflare dashboard (no managed tunnel)', { managed: false }, false],
    ['without a readable secret.key', {}, true],
  ])('does not move an address %s', async (_name, opts, dropKey) => {
    const t = seedTarget();
    const lite = seedLite();
    giveAddress(lite.dir, opts);
    if (dropKey) writeFileSync(join(lite.dir, 'secret.key'), 'not a key');
    expect((await merge(t.dir, lite.dir)).address).toBeNull();
    const { db, s } = settingsOf(t.dir);
    expect(s.get('tunnel_mode', 'off')).toBe('off');
    expect(s.getSecret('tunnel_token')).toBeNull();
    db.close();
  });

  it.each([
    ['a sign-in that cannot be decrypted', 'cloudflare_auth', 'garbage'],
    [
      'a managed record Cloudflare setup would refuse',
      'cloudflare_managed_tunnel',
      JSON.stringify({ ...MANAGED, hostname: 'not a host!' }),
    ],
  ])('does not move a Lite address with %s', async (_n, key, value) => {
    const t = seedTarget();
    const lite = seedLite();
    giveAddress(lite.dir);
    {
      const db = openDb(join(lite.dir, 'app.db'));
      db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(value, key);
      db.close();
    }
    expect((await merge(t.dir, lite.dir)).address).toBeNull();
  });
});

describe('releaseLiteAddress', () => {
  it('turns Lite’s address off, forgets the moved tunnel, keeps the sign-in; undo restores it', () => {
    const dir = tempDir('lite-release-');
    giveAddress(dir);
    const before = (() => {
      const db = openDb(join(dir, 'app.db'));
      const rows = db.prepare('SELECT key, value FROM settings ORDER BY key').all();
      db.close();
      return rows;
    })();
    const db = new Database(join(dir, 'app.db'));
    const undo = releaseLiteAddress(db);
    db.close();

    const { db: check, s } = settingsOf(dir);
    expect(s.get('tunnel_mode', null)).toBe('off');
    expect(s.getSecret('tunnel_token')).toBeNull();
    expect(s.get('named_tunnel_hostname', null)).toBeNull();
    expect(s.get('cloudflare_managed_tunnel', null)).toBeNull();
    expect(s.getSecret('cloudflare_auth')).toBe(AUTH);
    expect(s.get<Array<{ id: string }>>('cloudflare_owned_tunnels', []).map((x) => x.id)).toEqual([
      OTHER_ID,
    ]);
    check.close();

    const again = new Database(join(dir, 'app.db'));
    undo(again);
    expect(again.prepare('SELECT key, value FROM settings ORDER BY key').all()).toEqual(before);
    again.close();
  });
});

describe('hand-over with a moved address', () => {
  const liteFolder = () => {
    const dir = tempDir('lite-handover-');
    giveAddress(dir);
    mkdirSync(join(dir, 'wa-auth'), { recursive: true });
    writeFileSync(join(dir, 'wa-auth', 'creds.json'), '{}');
    return dir;
  };

  it('releases the address after the marker', () => {
    const dir = liteFolder();
    const parts: string[] = [];
    handOver({
      liteDataDir: dir,
      product: 'enterprise',
      version: '9.9.9',
      log: silentLogger(),
      releaseAddress: true,
      afterPart: (p) => parts.push(p),
    });
    expect(parts).toEqual(['marker', 'address', 'wa-auth']);
    const { db, s } = settingsOf(dir);
    expect(s.get('tunnel_mode', null)).toBe('off');
    db.close();
  });

  it('a failure after the release puts Lite’s address back and removes the marker', () => {
    const dir = liteFolder();
    expect(() =>
      handOver({
        liteDataDir: dir,
        product: 'enterprise',
        version: '9.9.9',
        log: silentLogger(),
        releaseAddress: true,
        afterPart: (p) => {
          if (p === 'wa-auth') throw new Error('rename failed');
        },
      }),
    ).toThrow('rename failed');
    expect(readMovedMarker(dir)).toBeNull();
    const { db, s } = settingsOf(dir);
    expect(s.get('tunnel_mode', null)).toBe('named');
    expect(s.getSecret('tunnel_token')).toBe(TOKEN);
    expect(s.get('cloudflare_managed_tunnel', null)).toEqual(MANAGED);
    db.close();
  });

  it('without a moved address, Lite’s settings are not touched', () => {
    const dir = liteFolder();
    handOver({ liteDataDir: dir, product: 'enterprise', version: '9.9.9', log: silentLogger() });
    const { db, s } = settingsOf(dir);
    expect(s.get('tunnel_mode', null)).toBe('named');
    db.close();
  });
});
