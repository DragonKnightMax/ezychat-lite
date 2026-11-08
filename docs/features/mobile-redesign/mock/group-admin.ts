import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { FakeWaAdapter, WaGroupInfo, WaGroupParticipant } from '@ezychat/wa';
import type { AppContext } from '../../../../packages/server/src/context.js';
import { requireAdmin, requireUser } from '../../../../packages/server/src/auth/guards.js';

/**
 * Proposed (group-management), mock only: an EzyChat admin manages a WhatsApp group from Group info
 * (rename, description, add / remove members, make / remove group admin, invite link, group settings,
 * join requests) instead of switching to the phone or Meta's tools. Stand-in routes
 * `/api/mock/group-admin*` change the fake phone's group (`FakeWaAdapter.setGroupInfo` + `groupChanged`),
 * so the real `GET /api/chats/:jid/members` shows each change. Production: `WaAdapter` group methods
 * gated by `WaCapabilities.groupAdmin`, routes `/api/chats/:jid/group/*` (design.md → API sketch).
 *
 * Mock-only switches (the dashed "Mock only" box): which connection the group's inbox uses (linked
 * phone or WhatsApp Business API) and whether WhatsApp is offline.
 */

type Connection = 'linked_phone' | 'business_api';

/** What the connection can do (production: `WaCapabilities.groupAdmin`, never a type name). */
export interface GroupAdminCaps {
  editInfo: boolean;
  addMembers: boolean;
  /** People join only through the invite link (Business API). */
  inviteOnly: boolean;
  removeMembers: boolean;
  admins: boolean;
  inviteLink: boolean;
  settings: Array<'announce' | 'locked' | 'memberAdd' | 'approval'>;
  joinRequests: boolean;
  /** Members besides the business number; null = WhatsApp's own limit. */
  maxMembers: number | null;
  nameMax: number;
}

const CAPS: Record<Connection, GroupAdminCaps> = {
  linked_phone: {
    editInfo: true,
    addMembers: true,
    inviteOnly: false,
    removeMembers: true,
    admins: true,
    inviteLink: true,
    settings: ['announce', 'locked', 'memberAdd', 'approval'],
    joinRequests: true,
    maxMembers: null,
    nameMax: 100,
  },
  business_api: {
    editInfo: true,
    addMembers: false,
    inviteOnly: true,
    removeMembers: true,
    admins: false,
    inviteLink: true,
    settings: [],
    joinRequests: true,
    maxMembers: 8,
    nameMax: 128,
  },
};

interface Settings {
  /** Only admins can send messages. */
  announce: boolean;
  /** Only admins can edit the group name, photo and description. */
  locked: boolean;
  memberAdd: 'admins' | 'all';
  /** New members need an admin's approval. */
  approval: boolean;
}

interface JoinRequest {
  id: string;
  phone: string;
  name: string;
  at: number;
}

interface Change {
  at: number;
  by: string;
  /** i18n key suffix of the change (mockGroupAdmin.log.*) */
  action: string;
  /** Who or what it was about: a member's name or number, never message text. */
  target: string | null;
}

interface GroupState {
  settings: Settings;
  inviteCode: string;
  requests: JoinRequest[];
  log: Change[];
  invited: string[];
}

const state = {
  connection: 'linked_phone' as Connection,
  offline: false,
  groups: new Map<string, GroupState>(),
  /** Adds in the last hour per inbox (production: 20 a day per inbox, one at a time). */
  adds: [] as number[],
};

const ADD_LIMIT_PER_HOUR = 6;
/** The demo group where the linked number is an ordinary member (not a WhatsApp group admin). */
const NOT_ADMIN_GROUP = '120363025550004@g.us';
const ME = '60000000000@s.whatsapp.net';
const code = () => randomBytes(8).toString('base64url').slice(0, 22);

function groupState(jid: string): GroupState {
  let s = state.groups.get(jid);
  if (!s) {
    s = {
      settings: { announce: false, locked: true, memberAdd: 'admins', approval: false },
      inviteCode: code(),
      requests:
        jid === '120363025550002@g.us'
          ? [
              { id: 'r1', phone: '60178812345', name: 'Hui Min', at: Date.now() - 50 * 60_000 },
              { id: 'r2', phone: '60195551234', name: 'Rajesh K', at: Date.now() - 3 * 3_600_000 },
            ]
          : [],
      log: [
        {
          at: Date.now() - 2 * 86_400_000,
          by: 'Aisyah',
          action: 'description',
          target: null,
        },
      ],
      invited: [],
    };
    state.groups.set(jid, s);
  }
  return s;
}

const Params = z.object({ jid: z.string().regex(/@g\.us$/) });
const MemberParams = Params.extend({ member: z.string().min(3).max(256) });

export function registerGroupAdmin(app: FastifyInstance, ctx: AppContext, wa: FakeWaAdapter): void {
  const admin = { preHandler: requireAdmin(ctx) };
  const user = { preHandler: requireUser(ctx) };
  const userName = (req: FastifyRequest) =>
    (
      ctx.db.prepare('SELECT display_name FROM users WHERE id = ?').get(req.user!.id) as
        { display_name: string } | undefined
    )?.display_name ?? 'Admin';

  /** The demo group where the business number is not an admin: demote it once. */
  let demoted = false;
  async function ensureDemo(): Promise<void> {
    if (demoted) return;
    demoted = true;
    try {
      const g = await wa.getGroupInfo(NOT_ADMIN_GROUP);
      wa.setGroupInfo({
        ...g,
        participants: g.participants.map((p) =>
          p.jid === ME ? { ...p, role: 'member' as const } : p,
        ),
      });
      wa.simulateGroupChanged(NOT_ADMIN_GROUP);
    } catch {
      /* the group is seeded later; the next view retries */
      demoted = false;
    }
  }

  const info = (jid: string) => wa.getGroupInfo(jid);
  const save = (g: WaGroupInfo) => {
    wa.setGroupInfo(g);
    wa.simulateGroupChanged(g.jid);
  };
  const myRole = (g: WaGroupInfo) =>
    state.connection === 'business_api'
      ? 'superadmin'
      : (g.participants.find((p) => p.jid === ME)?.role ?? 'member');
  const find = (g: WaGroupInfo, member: string) =>
    g.participants.find((p) => [p.jid, p.phoneJid, p.lidJid].includes(member));
  const label = (p: WaGroupParticipant) => {
    const row = ctx.db
      .prepare('SELECT COALESCE(saved_name, push_name) AS n FROM contacts WHERE jid = ?')
      .get(p.phoneJid ?? p.jid) as { n: string | null } | undefined;
    return row?.n ?? (p.phoneJid ? `+${p.phoneJid.split('@')[0]}` : p.jid);
  };

  /** Refusals every change shares: WhatsApp offline, the number not a group admin. */
  async function guard(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ g: WaGroupInfo; s: GroupState; jid: string } | null> {
    const { jid } = Params.parse(req.params);
    if (state.offline) {
      void reply
        .code(503)
        .send({ error: { code: 'wa_unavailable', message: 'WhatsApp is not connected' } });
      return null;
    }
    const g = await info(jid);
    if (myRole(g) === 'member') {
      void reply
        .code(409)
        .send({
          error: { code: 'not_group_admin', message: 'This number is not an admin of the group' },
        });
      return null;
    }
    return { g, s: groupState(jid), jid };
  }
  const log = (s: GroupState, req: FastifyRequest, action: string, target: string | null = null) =>
    s.log.unshift({ at: Date.now(), by: userName(req), action, target });

  app.get('/api/mock/group-admin/:jid', user, async (req) => {
    await ensureDemo();
    const { jid } = Params.parse(req.params);
    const g = await info(jid);
    const s = groupState(jid);
    const caps = CAPS[state.connection];
    return {
      connection: state.connection,
      offline: state.offline,
      caps,
      myRole: myRole(g),
      members: g.participants.filter((p) => p.jid !== ME).length,
      settings: s.settings,
      inviteLink: caps.inviteLink ? `https://chat.whatsapp.com/${s.inviteCode}` : null,
      requests: caps.joinRequests ? s.requests : [],
      log: s.log.slice(0, 8),
    };
  });

  app.put('/api/mock/group-admin/mock', admin, async (req) => {
    const body = z
      .object({
        connection: z.enum(['linked_phone', 'business_api']).optional(),
        offline: z.boolean().optional(),
      })
      .parse(req.body);
    if (body.connection) state.connection = body.connection;
    if (body.offline !== undefined) state.offline = body.offline;
    return { ok: true };
  });

  app.patch('/api/mock/group-admin/:jid', admin, async (req, reply) => {
    const ok = await guard(req, reply);
    if (!ok) return;
    const caps = CAPS[state.connection];
    const body = z
      .object({
        name: z.string().trim().min(1).max(caps.nameMax).optional(),
        description: z.string().max(2048).optional(),
      })
      .parse(req.body);
    if (body.name !== undefined) log(ok.s, req, 'name');
    if (body.description !== undefined) log(ok.s, req, 'description');
    save({
      ...ok.g,
      name: body.name ?? ok.g.name,
      description: body.description !== undefined ? body.description || null : ok.g.description,
    });
    return { ok: true };
  });

  app.post('/api/mock/group-admin/:jid/members', admin, async (req, reply) => {
    const ok = await guard(req, reply);
    if (!ok) return;
    const caps = CAPS[state.connection];
    if (!caps.addMembers)
      return reply
        .code(409)
        .send({ error: { code: 'not_supported', message: 'Invite link only' } });
    const { phone } = z.object({ phone: z.string().regex(/^\d{8,15}$/) }).parse(req.body);
    const jid = `${phone}@s.whatsapp.net`;
    if (find(ok.g, jid))
      return reply
        .code(409)
        .send({ error: { code: 'already_member', message: 'Already in the group' } });
    const now = Date.now();
    state.adds = state.adds.filter((t) => t > now - 3_600_000);
    if (state.adds.length >= ADD_LIMIT_PER_HOUR)
      return reply.code(429).send({ error: { code: 'too_many_adds', message: 'Too many adds' } });
    // Demo outcomes by the last digit: 0 = not on WhatsApp, 7 = privacy (an invite is needed).
    if (phone.endsWith('0'))
      return reply
        .code(422)
        .send({ error: { code: 'not_on_whatsapp', message: 'Not on WhatsApp' } });
    if (phone.endsWith('7')) return { result: 'invite_needed', phone };
    state.adds.push(now);
    save({
      ...ok.g,
      size: ok.g.size + 1,
      participants: [
        ...ok.g.participants,
        { jid, phoneJid: jid, lidJid: null, username: null, role: 'member' },
      ],
    });
    log(ok.s, req, 'added', `+${phone}`);
    return { result: 'added', phone };
  });

  app.post('/api/mock/group-admin/:jid/members/:member/invite', admin, async (req, reply) => {
    const ok = await guard(req, reply);
    if (!ok) return;
    const { member } = MemberParams.parse(req.params);
    ok.s.invited.push(member);
    state.adds.push(Date.now());
    log(ok.s, req, 'invited', `+${member}`);
    return { result: 'invite_sent' };
  });

  app.delete('/api/mock/group-admin/:jid/members/:member', admin, async (req, reply) => {
    const ok = await guard(req, reply);
    if (!ok) return;
    const { member } = MemberParams.parse(req.params);
    const p = find(ok.g, member);
    if (!p)
      return reply.code(404).send({ error: { code: 'not_found', message: 'Member not found' } });
    if (p.role === 'superadmin' || p.jid === ME)
      return reply
        .code(409)
        .send({ error: { code: 'cannot_remove_owner', message: 'Group creator' } });
    save({
      ...ok.g,
      size: ok.g.size - 1,
      participants: ok.g.participants.filter((x) => x !== p),
    });
    log(ok.s, req, 'removed', label(p));
    return { ok: true };
  });

  app.put('/api/mock/group-admin/:jid/members/:member/role', admin, async (req, reply) => {
    const ok = await guard(req, reply);
    if (!ok) return;
    if (!CAPS[state.connection].admins)
      return reply.code(409).send({ error: { code: 'not_supported', message: 'Not supported' } });
    const { member } = MemberParams.parse(req.params);
    const { admin: makeAdmin } = z.object({ admin: z.boolean() }).parse(req.body);
    const p = find(ok.g, member);
    if (!p)
      return reply.code(404).send({ error: { code: 'not_found', message: 'Member not found' } });
    if (p.role === 'superadmin')
      return reply
        .code(409)
        .send({ error: { code: 'cannot_remove_owner', message: 'Group creator' } });
    save({
      ...ok.g,
      participants: ok.g.participants.map((x) =>
        x === p ? { ...x, role: makeAdmin ? ('admin' as const) : ('member' as const) } : x,
      ),
    });
    log(ok.s, req, makeAdmin ? 'promoted' : 'demoted', label(p));
    return { ok: true };
  });

  app.post('/api/mock/group-admin/:jid/invite-link/reset', admin, async (req, reply) => {
    const ok = await guard(req, reply);
    if (!ok) return;
    ok.s.inviteCode = code();
    log(ok.s, req, 'linkReset');
    return { inviteLink: `https://chat.whatsapp.com/${ok.s.inviteCode}` };
  });

  app.put('/api/mock/group-admin/:jid/settings', admin, async (req, reply) => {
    const ok = await guard(req, reply);
    if (!ok) return;
    const body = z
      .object({
        announce: z.boolean().optional(),
        locked: z.boolean().optional(),
        memberAdd: z.enum(['admins', 'all']).optional(),
        approval: z.boolean().optional(),
      })
      .parse(req.body);
    const allowed = CAPS[state.connection].settings;
    for (const k of Object.keys(body) as Array<keyof Settings>) {
      if (!allowed.includes(k))
        return reply.code(409).send({ error: { code: 'not_supported', message: 'Not supported' } });
      log(ok.s, req, `setting.${k}`);
    }
    Object.assign(ok.s.settings, body);
    return { ok: true };
  });

  app.post('/api/mock/group-admin/:jid/requests/:id', admin, async (req, reply) => {
    const ok = await guard(req, reply);
    if (!ok) return;
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { approve } = z.object({ approve: z.boolean() }).parse(req.body);
    const r = ok.s.requests.find((x) => x.id === id);
    if (!r)
      return reply.code(404).send({ error: { code: 'not_found', message: 'Request not found' } });
    ok.s.requests = ok.s.requests.filter((x) => x !== r);
    if (approve) {
      const jid = `${r.phone}@s.whatsapp.net`;
      ctx.db
        .prepare('INSERT OR IGNORE INTO contacts (jid, push_name) VALUES (?, ?)')
        .run(jid, r.name);
      save({
        ...ok.g,
        size: ok.g.size + 1,
        participants: [
          ...ok.g.participants,
          { jid, phoneJid: jid, lidJid: null, username: null, role: 'member' },
        ],
      });
    }
    log(ok.s, req, approve ? 'approved' : 'rejected', r.name);
    return { ok: true };
  });
}
