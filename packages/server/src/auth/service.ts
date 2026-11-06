import { isLocale, type Locale, type PatchUserBody, type Role, type User } from '@ezychat/shared';
import type { AppContext } from '../context.js';
import { randomToken, sha256 } from '../crypto/secret.js';
import { errors } from '../http/errors.js';
import {
  dummyVerify,
  generatePassword,
  hashPassword,
  hashPasswordSync,
  verifyPassword,
} from './passwords.js';
import { LoginRateLimiter } from './rate-limit.js';

export const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
const LAST_SEEN_THROTTLE_MS = 60 * 1000;

export interface CreateUserInput {
  username: string;
  displayName: string;
  role: Role;
  password: string;
  mustChangePassword: boolean;
}

export interface AuthService {
  hasAnyUser(): boolean;
  /** conflict on duplicate username (case-insensitive) */
  createUser(i: CreateUserInput): User;
  /** Creates the first admin atomically; throws notFound if any user already exists. */
  createFirstAdmin(i: Omit<CreateUserInput, 'role' | 'mustChangePassword'>): Promise<User>;
  /** Verifies current credentials and creates the session atomically after asynchronous hashing. */
  login(
    username: string,
    password: string,
    meta: { ip: string; userAgent: string },
  ): Promise<{ user: User; token: string }>;
  /** returns raw token */
  createSession(userId: number, meta: { ip: string; userAgent: string }): string;
  /** updates last_seen_at (at most once/min); expires after 30 days idle; disabled user → null */
  resolveSession(rawToken: string): User | null;
  /** emits bus 'user:sessions-revoked' (so a live socket on that session is disconnected) */
  destroySession(rawToken: string): void;
  /** emits bus 'user:sessions-revoked' */
  revokeAll(userId: number): void;
  /** Deletes all of a user's sessions except `keepRawToken`; emits 'user:sessions-revoked'. */
  revokeOthers(userId: number, keepRawToken: string): void;
  changePassword(userId: number, current: string, next: string, rawToken: string): Promise<void>;
  /** random 12-char, must_change_password=1, revokeAll; rechecks the authorizing admin session */
  resetPassword(userId: number, actorToken: string): Promise<string>;
  /** Deleted AI agents are left out unless `includeDeleted` (names in message history). */
  listUsers(opts?: { includeDeleted?: boolean }): User[];
  /** cannot demote/disable last active admin → conflict; disabling emits 'user:disabled' + revokeAll; a role change emits 'user:role-changed' */
  updateUser(id: number, patch: PatchUserBody, actorId: number): User;
  getUser(id: number): User | null;
  /** self-service preference; returns the updated user, or null if it no longer exists */
  setLocale(id: number, locale: Locale | null): User | null;
}

interface UserRow {
  id: number;
  username: string;
  display_name: string;
  password_hash: string;
  role: Role;
  must_change_password: number;
  kind: 'human' | 'ai';
  disabled_at: number | null;
  created_at: number;
  locale: string | null;
  /** The AI agent of an AI member (`ai_agents.id`, joined); null for people and deleted agents. */
  ai_agent_id?: number | null;
  ai_deleted_at?: number | null;
  /** 'chosen': an agent limited to chosen chats (migration 037). */
  chat_scope?: string;
}

/** Users with their AI agent id. A deleted agent's user has no `ai_agents` row. */
const USER_SELECT =
  'SELECT u.*, a.id AS ai_agent_id FROM users u LEFT JOIN ai_agents a ON a.user_id = u.id';

export function rowToUser(r: UserRow): User {
  return {
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    role: r.role,
    kind: r.kind,
    ...(r.kind === 'ai'
      ? {
          aiRole: 'sales' as const,
          ...(r.ai_agent_id ? { aiAgentId: r.ai_agent_id } : {}),
          ...(r.ai_deleted_at ? { aiDeleted: true } : {}),
        }
      : {}),
    mustChangePassword: r.must_change_password === 1,
    disabled: r.disabled_at !== null,
    createdAt: r.created_at,
    locale: isLocale(r.locale) ? r.locale : null,
    ...(r.chat_scope === 'chosen' && r.role === 'agent' && r.kind === 'human'
      ? { chatScope: 'chosen' as const }
      : {}),
  };
}

export function createAuthService(
  ctx: Pick<AppContext, 'db' | 'bus'>,
  opts?: { limiter?: LoginRateLimiter; now?: () => number },
): AuthService {
  const { db, bus } = ctx;
  const now = opts?.now ?? Date.now;
  const limiter = opts?.limiter ?? new LoginRateLimiter(now);

  const q = {
    count: db.prepare('SELECT COUNT(*) AS n FROM users'),
    byId: db.prepare(`${USER_SELECT} WHERE u.id = ?`),
    byName: db.prepare(`${USER_SELECT} WHERE u.username = ? COLLATE NOCASE`),
    // A deleted AI agent's user stays for message history but is hidden from lists.
    list: db.prepare(`${USER_SELECT} WHERE u.ai_deleted_at IS NULL ORDER BY u.id`),
    listAll: db.prepare(`${USER_SELECT} ORDER BY u.id`),
    insert: db.prepare(
      `INSERT INTO users (username, display_name, password_hash, role, must_change_password, disabled_at, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    ),
    setPassword: db.prepare(
      'UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?',
    ),
    changePassword: db.prepare(
      'UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ? AND password_hash = ? AND disabled_at IS NULL',
    ),
    activeAdminsExcept: db.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL AND id != ?",
    ),
    setLocale: db.prepare('UPDATE users SET locale = ? WHERE id = ?'),
    sessionInsert: db.prepare(
      'INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    sessionGet: db.prepare('SELECT user_id, last_seen_at FROM sessions WHERE token_hash = ?'),
    sessionUser: db.prepare('SELECT user_id FROM sessions WHERE token_hash = ?'),
    sessionTouch: db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?'),
    sessionDelete: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    sessionDeleteUser: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    sessionDeleteOthers: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?'),
    sessionDeleteExpired: db.prepare('DELETE FROM sessions WHERE last_seen_at < ?'),
  };

  const getRow = (id: number) => q.byId.get(id) as UserRow | undefined;

  function insertUser(i: Omit<CreateUserInput, 'password'>, passwordHash: string): User {
    if (q.byName.get(i.username)) throw errors.conflict('Username already exists');
    try {
      const r = q.insert.run(
        i.username,
        i.displayName,
        passwordHash,
        i.role,
        i.mustChangePassword ? 1 : 0,
        now(),
      );
      return rowToUser(getRow(Number(r.lastInsertRowid))!);
    } catch (err) {
      if ((err as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT')) {
        throw errors.conflict('Username already exists');
      }
      throw err;
    }
  }

  function revokeAll(userId: number): void {
    q.sessionDeleteUser.run(userId);
    bus.emit('user:sessions-revoked', userId);
  }

  // drop long-idle sessions on startup
  q.sessionDeleteExpired.run(now() - SESSION_IDLE_MS);

  return {
    hasAnyUser() {
      return (q.count.get() as { n: number }).n > 0;
    },

    createUser(i) {
      return insertUser(i, hashPasswordSync(i.password));
    },

    async createFirstAdmin(i) {
      if (this.hasAnyUser()) throw errors.notFound();
      const passwordHash = await hashPassword(i.password);
      // synchronous check + insert: no other request can interleave
      return db.transaction(() => {
        if (this.hasAnyUser()) throw errors.notFound();
        return insertUser({ ...i, role: 'admin', mustChangePassword: false }, passwordHash);
      })();
    },

    async login(username, password, meta) {
      const { ip } = meta;
      const c = limiter.check(username, ip);
      if (!c.ok) throw errors.rateLimited(c.retryAfterSec);
      const row = q.byName.get(username) as UserRow | undefined;
      let ok = false;
      if (row && row.kind !== 'ai') ok = await verifyPassword(row.password_hash, password);
      else await dummyVerify(password);
      if (!row || !ok) {
        limiter.recordFailure(username, ip);
        throw errors.unauthorized('Invalid username or password');
      }
      // Argon2 yields: a reset, disable or role change may have happened during verification.
      const current = getRow(row.id);
      if (
        !current ||
        current.kind === 'ai' ||
        current.disabled_at !== null ||
        current.password_hash !== row.password_hash
      ) {
        throw errors.unauthorized('Invalid username or password');
      }
      limiter.recordSuccess(username);
      // Do not yield between this security-state check and inserting the authenticated session.
      return { user: rowToUser(current), token: this.createSession(current.id, meta) };
    },

    createSession(userId, meta) {
      const row = getRow(userId);
      if (!row || row.kind === 'ai' || row.disabled_at !== null) throw errors.unauthorized();
      const token = randomToken(32);
      const t = now();
      q.sessionInsert.run(sha256(token), userId, t, t, meta.userAgent.slice(0, 512), meta.ip);
      return token;
    },

    resolveSession(rawToken) {
      if (!rawToken) return null;
      const h = sha256(rawToken);
      const s = q.sessionGet.get(h) as { user_id: number; last_seen_at: number } | undefined;
      if (!s) return null;
      const t = now();
      if (t - s.last_seen_at > SESSION_IDLE_MS) {
        q.sessionDelete.run(h);
        return null;
      }
      const row = getRow(s.user_id);
      if (!row || row.kind === 'ai' || row.disabled_at !== null) return null;
      if (t - s.last_seen_at >= LAST_SEEN_THROTTLE_MS) q.sessionTouch.run(t, h);
      return rowToUser(row);
    },

    destroySession(rawToken) {
      if (!rawToken) return;
      const h = sha256(rawToken);
      const s = q.sessionUser.get(h) as { user_id: number } | undefined;
      q.sessionDelete.run(h);
      if (s) bus.emit('user:sessions-revoked', s.user_id);
    },

    revokeAll,

    revokeOthers(userId, keepRawToken) {
      q.sessionDeleteOthers.run(userId, sha256(keepRawToken));
      // realtime re-checks each socket's token and kicks those whose session is gone
      bus.emit('user:sessions-revoked', userId);
    },

    async changePassword(userId, current, next, rawToken) {
      const row = getRow(userId);
      if (!row) throw errors.notFound('User');
      if (!(await verifyPassword(row.password_hash, current))) {
        throw errors.validation('Current password is incorrect');
      }
      if (current === next)
        throw errors.validation('New password must differ from the current password');
      const passwordHash = await hashPassword(next);
      // Recovery must win over an already-running request authorized by a now-revoked session.
      if (this.resolveSession(rawToken)?.id !== userId) throw errors.unauthorized();
      const changed = q.changePassword.run(passwordHash, userId, row.password_hash);
      if (changed.changes !== 1) throw errors.unauthorized();
    },

    async resetPassword(userId, actorToken) {
      if (!getRow(userId)) throw errors.notFound('User');
      if (getRow(userId)!.kind === 'ai')
        throw errors.validation('AI members do not have passwords');
      const password = generatePassword(12);
      const passwordHash = await hashPassword(password);
      const actor = this.resolveSession(actorToken);
      if (!actor) throw errors.unauthorized();
      if (actor.role !== 'admin' || actor.mustChangePassword) throw errors.forbidden('Admin only');
      q.setPassword.run(passwordHash, 1, userId);
      revokeAll(userId);
      return password;
    },

    listUsers(opts) {
      return ((opts?.includeDeleted ? q.listAll : q.list).all() as UserRow[]).map(rowToUser);
    },

    updateUser(id, patch, actorId) {
      const row = getRow(id);
      if (!row) throw errors.notFound('User');
      if (row.kind === 'ai' && patch.role && patch.role !== 'agent')
        throw errors.validation('AI members cannot be admins');
      const isActiveAdmin = row.role === 'admin' && row.disabled_at === null;
      const demoting = patch.role === 'agent' && row.role === 'admin';
      const disabling = patch.disabled === true && row.disabled_at === null;
      if (disabling && id === actorId) throw errors.conflict('You cannot disable your own account');
      if (isActiveAdmin && (demoting || disabling)) {
        if ((q.activeAdminsExcept.get(id) as { n: number }).n === 0) {
          throw errors.conflict('Cannot demote or disable the last active admin');
        }
      }
      const sets: string[] = [];
      const vals: unknown[] = [];
      if (patch.displayName !== undefined) {
        sets.push('display_name = ?');
        vals.push(patch.displayName);
      }
      if (patch.role !== undefined) {
        sets.push('role = ?');
        vals.push(patch.role);
      }
      if (patch.disabled !== undefined) {
        sets.push('disabled_at = ?');
        vals.push(patch.disabled ? (row.disabled_at ?? now()) : null);
      }
      if (sets.length)
        db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
      const updated = rowToUser(getRow(id)!);
      if (disabling) {
        bus.emit('user:disabled', id);
        revokeAll(id);
      } else if (patch.role !== undefined && patch.role !== row.role) {
        bus.emit('user:role-changed', id, updated.role);
      }
      return updated;
    },

    getUser(id) {
      const row = getRow(id);
      return row ? rowToUser(row) : null;
    },

    setLocale(id, locale) {
      q.setLocale.run(locale, id);
      const row = getRow(id);
      return row ? rowToUser(row) : null;
    },
  };
}
