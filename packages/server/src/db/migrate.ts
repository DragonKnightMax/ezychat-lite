import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from './index.js';

/**
 * Locate the migrations directory. In source (tsx/vitest) it sits next to this file; the
 * published package build (scripts/build-package.mjs) copies it to dist/db/migrations and the
 * desktop bundle next to server.cjs. A bare tsc output falls back to ../../src/db/migrations.
 * WATI_MIGRATIONS_DIR overrides all of them.
 */
export function migrationsDir(): string {
  const env = process.env.WATI_MIGRATIONS_DIR;
  if (env && existsSync(env)) return env;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, 'migrations'), join(here, '..', '..', 'src', 'db', 'migrations')];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(`migrations directory not found (tried ${candidates.join(', ')})`);
}

/** The numbered migration files (`NNN_*.sql`) in ascending numeric order. */
function migrationFiles(dir: string): Array<{ version: number; file: string }> {
  return readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .map((file) => ({ version: parseInt(file, 10), file }))
    .sort((a, b) => a.version - b.version);
}

/** The highest migration number, i.e. the `user_version` of a fully migrated database. */
export function latestMigration(): number {
  const files = migrationFiles(migrationsDir());
  return files.length === 0 ? 0 : files[files.length - 1]!.version;
}

/**
 * Applies db/migrations/NNN_*.sql in order; PRAGMA user_version tracks the last applied number.
 * `upTo` stops after that migration (tests build a database "as release N left it" with it).
 */
export function migrate(db: DB, upTo: number = Number.POSITIVE_INFINITY): void {
  const dir = migrationsDir();
  const current = db.pragma('user_version', { simple: true }) as number;
  for (const { version, file } of migrationFiles(dir)) {
    if (version <= current) continue;
    if (version > upTo) break;
    const sql = readFileSync(join(dir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${version}`);
    })();
  }
}
