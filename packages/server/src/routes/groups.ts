import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AddGroupMemberBody,
  EditGroupBody,
  GroupJoinDecisionBody,
  GroupSettingsBody,
  SetGroupMemberRoleBody,
  type AddGroupMemberResponse,
  type GroupAdminResponse,
  type GroupChangeOkResponse,
  type GroupInviteLinkResponse,
  type SendGroupInviteResponse,
} from '@ezychat/shared';
import { requireAdmin, requireUser } from '../auth/guards.js';
import type { AppContext } from '../context.js';
import { createGroupAdminService, type GroupAdminService } from '../groups/admin.js';
import { createGroupService, type GroupService } from '../groups/service.js';
import { clientIp } from '../http/client-ip.js';
import { HttpError, parse } from '../http/errors.js';
import { profilePhotoLookup } from '../http/profile-images.js';
import { avatarStore, memberAvatarKey, sendAvatar } from '../avatars/http.js';
import { chosenChats } from '../inboxes/access.js';
import { chatWaState } from '../inboxes/service.js';
import { chatJidParam } from './chats.js';

declare module '../context.js' {
  interface Services {
    groups?: GroupService;
    groupAdmin?: GroupAdminService;
  }
}

const MemberParams = z.object({
  jid: z.string().min(3).max(256),
  member: z.string().min(3).max(256),
});

const OK: GroupChangeOkResponse = { ok: true };

/**
 * Group info: members of a WhatsApp group chat (any user with inbox access), and group management
 * (`/chats/:jid/group*`: EzyChat admins change it, everyone with access reads its state).
 */
export default async function groupRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', requireUser(ctx));
  const groups = (ctx.services.groups ??= createGroupService(ctx));
  const admin = (ctx.services.groupAdmin ??= createGroupAdminService(ctx, groups));
  const photos = avatarStore(ctx);

  app.get('/chats/:jid/members', async (req) => {
    const info = await groups.info(chatJidParam(ctx, req));
    // an agent limited to chosen chats gets a member's direct chat only when it is one of theirs
    const chosen = chosenChats(ctx, req.user!);
    if (!chosen) return info;
    return {
      ...info,
      members: info.members.map((m) =>
        m.chatJid && !chosen.has(m.chatJid) ? { ...m, chatJid: null } : m,
      ),
    };
  });

  app.get('/chats/:jid/members/:member/about', async (req) => {
    const { member } = parse(MemberParams, req.params);
    return { about: await groups.about(chatJidParam(ctx, req), member) };
  });

  app.get('/chats/:jid/members/:member/avatar', async (req, reply) => {
    const { member } = parse(MemberParams, req.params);
    const groupJid = chatJidParam(ctx, req);
    if (chatWaState(ctx, groupJid) !== 'open')
      return reply.header('cache-control', 'no-store').code(204).send();
    const target = await groups.photoTarget(groupJid, member);
    const result = await photos.get(
      memberAvatarKey(target.key),
      profilePhotoLookup(ctx, target.jid),
    );
    return sendAvatar(req, reply, result);
  });

  app.post('/chats/:jid/members/:member/chat', async (req) => {
    const { member } = parse(MemberParams, req.params);
    // starting or opening a chat from a group member would reach chats outside the chosen ones
    if (chosenChats(ctx, req.user!))
      throw new HttpError(403, 'chat_scope_limited', 'Only the chosen chats can be opened');
    const chatJid = await groups.startChat(chatJidParam(ctx, req), member, {
      userId: req.user!.id,
      ip: clientIp(req),
    });
    return { chatJid };
  });

  // ---- group management ----
  const actor = (req: FastifyRequest) => ({ userId: req.user!.id, ip: clientIp(req) });
  const adminOnly = { preHandler: requireAdmin(ctx) };

  app.get('/chats/:jid/group', async (req): Promise<GroupAdminResponse> =>
    admin.state(chatJidParam(ctx, req), { isAdmin: req.user!.role === 'admin' }),
  );

  app.patch('/chats/:jid/group', adminOnly, async (req): Promise<GroupChangeOkResponse> => {
    const jid = chatJidParam(ctx, req);
    await admin.edit(jid, parse(EditGroupBody, req.body), actor(req));
    return OK;
  });

  app.post('/chats/:jid/group/members', adminOnly, async (req): Promise<AddGroupMemberResponse> => {
    const jid = chatJidParam(ctx, req);
    const { phone } = parse(AddGroupMemberBody, req.body);
    return admin.addMember(jid, phone, actor(req));
  });

  app.post(
    '/chats/:jid/group/members/:member/invite',
    adminOnly,
    async (req): Promise<SendGroupInviteResponse> => {
      const { member } = parse(MemberParams, req.params);
      await admin.sendInvite(chatJidParam(ctx, req), member, actor(req));
      return { result: 'sent' };
    },
  );

  app.delete(
    '/chats/:jid/group/members/:member',
    adminOnly,
    async (req): Promise<GroupChangeOkResponse> => {
      const { member } = parse(MemberParams, req.params);
      await admin.removeMember(chatJidParam(ctx, req), member, actor(req));
      return OK;
    },
  );

  app.put(
    '/chats/:jid/group/members/:member/role',
    adminOnly,
    async (req): Promise<GroupChangeOkResponse> => {
      const { member } = parse(MemberParams, req.params);
      const jid = chatJidParam(ctx, req);
      const body = parse(SetGroupMemberRoleBody, req.body);
      await admin.setRole(jid, member, body.admin, actor(req));
      return OK;
    },
  );

  app.post(
    '/chats/:jid/group/invite-link/reset',
    adminOnly,
    async (req): Promise<GroupInviteLinkResponse> => ({
      inviteLink: await admin.resetInviteLink(chatJidParam(ctx, req), actor(req)),
    }),
  );

  app.put('/chats/:jid/group/settings', adminOnly, async (req): Promise<GroupChangeOkResponse> => {
    const jid = chatJidParam(ctx, req);
    await admin.setSettings(jid, parse(GroupSettingsBody, req.body), actor(req));
    return OK;
  });

  app.post(
    '/chats/:jid/group/requests/:member',
    adminOnly,
    async (req): Promise<GroupChangeOkResponse> => {
      const { member } = parse(MemberParams, req.params);
      const jid = chatJidParam(ctx, req);
      const { approve } = parse(GroupJoinDecisionBody, req.body);
      await admin.decideJoin(jid, member, approve, actor(req));
      return OK;
    },
  );
}
