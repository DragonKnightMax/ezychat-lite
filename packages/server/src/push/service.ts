import webpush from 'web-push';
import {
  isLocale,
  type Chat,
  type InboxStatusPayload,
  type Locale,
  type Message,
  type NotificationPayload,
  type PushSubscribeBody,
  type WaStatus,
} from '@ezychat/shared';
import type { AppContext } from '../context.js';
import { t } from '../i18n/messages.js';
import { usersWhoCanOpenChat } from '../inboxes/access.js';
import { PRIMARY_INBOX_ID } from '../inboxes/keys.js';
import { chatWaitingAfterHandoff } from '../reports/report.js';
import { loadOrCreateVapid, type VapidDetails } from './vapid.js';

export interface PushService {
  publicKey(): string;
  subscribe(userId: number, sub: PushSubscribeBody): void;
  unsubscribe(userId: number, endpoint: string): void;
  notifyInbound(chat: Chat, message: Message): Promise<void>;
  notifyHandoff(chat: Chat): Promise<void>;
  /**
   * The AI handed a WhatsApp group question to the team: the group's assignee, else everyone who may
   * open its inbox. The text names the agent, the group and the member.
   */
  notifyGroupHandoff(handoff: GroupHandoff): Promise<void>;
  /**
   * `text` is rendered in each admin's preferred language. `link` overrides the URL and tag
   * (default Admin → WhatsApp, `wa-status`).
   */
  notifyAdmins(text: LocalizedText, link?: { url: string; tag: string }): Promise<void>;
  /** detaches bus listeners */
  shutdown(): void;
}

/** Delivers one encrypted notification. Throws an error with `statusCode` on HTTP failure (web-push WebPushError). */
export type PushSender = (
  sub: PushSubscribeBody,
  payload: string,
  vapid: VapidDetails,
) => Promise<unknown>;

export interface PushDeps {
  sender?: PushSender;
}

export type LocalizedText = (locale: Locale | null) => { title: string; body: string };

/** The `ai:group_handoff` bus event. */
export interface GroupHandoff {
  chat: Chat;
  agentName: string;
  member: string | null;
  question: string;
}

interface SubRow {
  id: number;
  user_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

const ALERT_STATES = new Set<WaStatus['state']>(['logged_out', 'replaced', 'blocked']);

/** Hostnames of the browser push services (FCM/Chrome+Edge, Mozilla, Windows WNS, Apple). */
const PUSH_HOST_SUFFIXES = ['.push.services.mozilla.com', '.notify.windows.com', '.push.apple.com'];
const PUSH_HOSTS = new Set([
  'fcm.googleapis.com',
  'android.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
]);

/**
 * SSRF guard: a push endpoint must be https on the default port and belong to a known push service.
 * Rejects IP literals, internal/LAN hosts and arbitrary URLs.
 */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.port !== '' || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  return PUSH_HOSTS.has(host) || PUSH_HOST_SUFFIXES.some((s) => host.endsWith(s));
}

const defaultSender: PushSender = async (sub, payload, vapid) => {
  if (!isAllowedPushEndpoint(sub.endpoint)) throw new Error('push endpoint not allowed');
  return webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload, {
    vapidDetails: {
      subject: vapid.subject,
      publicKey: vapid.publicKey,
      privateKey: vapid.privateKey,
    },
    TTL: 60 * 60 * 24,
  });
};

function statusCodeOf(err: unknown): number | null {
  if (err && typeof err === 'object' && 'statusCode' in err) {
    const c = Number((err as { statusCode: unknown }).statusCode);
    return Number.isFinite(c) ? c : null;
  }
  return null;
}

/**
 * The alert for a WhatsApp number that went offline. With several active inboxes `inbox` names
 * it in the title, and the text points to Admin → Inboxes instead of Admin → WhatsApp.
 */
function waAlertText(s: WaStatus, inbox: string | null = null): LocalizedText {
  const titled = (locale: Locale | null, title: string) =>
    inbox === null ? title : t(locale, 'push.inboxAlertTitle', { inbox, title });
  return (locale) => {
    switch (s.state) {
      case 'logged_out':
        return {
          title: titled(locale, t(locale, 'push.waLoggedOut.title')),
          body: t(locale, inbox === null ? 'push.waLoggedOut.body' : 'push.waLoggedOut.inboxBody'),
        };
      case 'replaced':
        return {
          title: titled(locale, t(locale, 'push.waReplaced.title')),
          body: t(locale, inbox === null ? 'push.waReplaced.body' : 'push.waReplaced.inboxBody'),
        };
      default:
        return {
          title: titled(locale, t(locale, 'push.waUnavailable.title')),
          // lastError is a technical detail from the socket and stays as reported.
          body: s.lastError ?? t(locale, 'push.waUnavailable.body', { state: s.state }),
        };
    }
  };
}

export function createPushService(ctx: AppContext, deps: PushDeps = {}): PushService {
  const { db } = ctx;
  const log = ctx.log.child({ mod: 'push' });
  const vapid = loadOrCreateVapid(ctx.settings);
  const sender = deps.sender ?? defaultSender;

  const q = {
    upsert: db.prepare(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
    ),
    delOwn: db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?'),
    delById: db.prepare('DELETE FROM push_subscriptions WHERE id = ?'),
    activeAdmins: db.prepare("SELECT id FROM users WHERE disabled_at IS NULL AND role = 'admin'"),
    activeUser: db.prepare(
      "SELECT id FROM users WHERE id = ? AND disabled_at IS NULL AND kind = 'human'",
    ),
    subsFor: db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?'),
    localeOf: db.prepare('SELECT locale FROM users WHERE id = ?'),
  };

  const localeOf = (id: number): Locale | null => {
    const v = (q.localeOf.get(id) as { locale: string | null } | undefined)?.locale;
    return isLocale(v) ? v : null;
  };

  /** Groups recipients by preferred language so each group gets one rendered payload. */
  function byLocale(userIds: number[]): Map<Locale | null, number[]> {
    const groups = new Map<Locale | null, number[]>();
    for (const id of userIds) {
      const l = localeOf(id);
      groups.set(l, [...(groups.get(l) ?? []), id]);
    }
    return groups;
  }

  /** Push is paused while an edition has closed the access gate (nothing is queued for later). */
  const paused = () => !ctx.access.state().open;

  interface SendCounts {
    devices: number;
    sent: number;
    failed: number;
    removed: number;
  }

  /**
   * Pushes to every subscribed device of each user, also while the user is online elsewhere: an
   * open desktop window or a phone app still connected in the background must not swallow the
   * phone notification. The desktop app has no push subscription, so it never gets a second copy.
   */
  async function sendTo(userIds: number[], payload: NotificationPayload): Promise<SendCounts> {
    const counts: SendCounts = { devices: 0, sent: 0, failed: 0, removed: 0 };
    if (paused()) return counts;
    const json = JSON.stringify(payload);
    const jobs: Array<Promise<void>> = [];
    for (const uid of userIds) {
      for (const row of q.subsFor.all(uid) as SubRow[]) {
        const sub: PushSubscribeBody = {
          endpoint: row.endpoint,
          keys: { p256dh: row.p256dh, auth: row.auth },
        };
        counts.devices++;
        jobs.push(
          sender(sub, json, vapid).then(
            () => {
              counts.sent++;
            },
            (err: unknown) => {
              const code = statusCodeOf(err);
              if (code === 404 || code === 410) {
                q.delById.run(row.id);
                counts.removed++;
                log.info({ userId: uid, code }, 'push subscription expired; removed');
              } else {
                counts.failed++;
                log.warn({ err, userId: uid, code }, 'push send failed');
              }
            },
          ),
        );
      }
    }
    await Promise.all(jobs);
    return counts;
  }

  /** Live notification for open desktop windows plus web push to every device, then one count line. */
  async function deliver(
    kind: 'inbound' | 'handoff' | 'admin',
    groups: Map<Locale | null, number[]>,
    payloadFor: (locale: Locale | null) => NotificationPayload,
  ): Promise<void> {
    const total: SendCounts = { devices: 0, sent: 0, failed: 0, removed: 0 };
    let recipients = 0;
    await Promise.all(
      [...groups].map(async ([locale, group]) => {
        const payload = payloadFor(locale);
        recipients += group.length;
        notifyConnected(group, payload);
        const c = await sendTo(group, payload);
        total.devices += c.devices;
        total.sent += c.sent;
        total.failed += c.failed;
        total.removed += c.removed;
      }),
    );
    // counts only: never the chat, the contact or the push endpoints
    log.info({ event: 'push_result', kind, recipients, ...total }, 'Push notification delivered');
  }

  const ids = (rows: unknown[]) => (rows as Array<{ id: number }>).map((r) => r.id);

  function notifyConnected(userIds: number[], payload: NotificationPayload): void {
    // Hidden desktop windows remain connected; browser push skips online users.
    // Send only to the same eligible recipients, never the public "all" room.
    const rt = ctx.services.realtime;
    if (paused()) return;
    if (rt && userIds.length)
      rt.io.to(userIds.map((id) => `user:${id}`)).emit('notification:new', payload);
  }

  /**
   * Who hears about a chat: everyone who may open it while it is unassigned (its inbox's people, plus
   * the agents limited to chosen chats who chose it), else the assignee only while they still may
   * open it (an agent who lost the inbox or the chat hears nothing).
   */
  const recipients = (chat: Chat): number[] => {
    // the key is the source of truth for the inbox (and a malformed one reaches nobody)
    const allowed = usersWhoCanOpenChat(ctx, chat.jid);
    if (chat.assignedTo == null) return allowed;
    return q.activeUser.get(chat.assignedTo) && allowed.includes(chat.assignedTo)
      ? [chat.assignedTo]
      : [];
  };

  const service: PushService = {
    publicKey: () => vapid.publicKey,

    subscribe(userId, sub) {
      q.upsert.run(userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, Date.now());
    },

    unsubscribe(userId, endpoint) {
      q.delOwn.run(userId, endpoint);
    },

    async notifyInbound(chat, message) {
      const targets = recipients(chat);
      if (!targets.length) return;
      // The AI handed this chat over and nobody has answered yet: the customer's new message (it
      // replaces the hand-off notice, same tag) says so, so the chat does not read as routine.
      const waiting = chat.type === 'dm' && chatWaitingAfterHandoff(ctx.db, chat.jid);
      await deliver('inbound', byLocale(targets), (locale) => {
        const preview = chat.lastMessagePreview ?? message.body ?? t(locale, 'push.newMessage');
        const name = chat.name || t(locale, 'push.unknownContact');
        return {
          title: (waiting ? t(locale, 'push.aiHandoffWaiting', { name }) : name).slice(0, 200),
          body: preview.slice(0, 1000),
          url: `/chats/${encodeURIComponent(chat.jid)}`,
          tag: chat.jid,
        };
      });
    },

    async notifyHandoff(chat) {
      const targets = recipients(chat);
      log.info(
        {
          event: 'ai_handoff_notification',
          assigned: chat.assignedTo != null,
          recipients: targets.length,
        },
        'Dispatching AI handover notification',
      );
      await deliver('handoff', byLocale(targets), (locale) => ({
        title: t(locale, 'push.aiHandoff.title'),
        body: t(locale, 'push.aiHandoff.body', {
          name: chat.name || t(locale, 'push.unknownContact'),
        }).slice(0, 1000),
        url: `/chats/${encodeURIComponent(chat.jid)}`,
        tag: chat.jid,
      }));
    },

    async notifyGroupHandoff({ chat, agentName, member, question }) {
      const targets = recipients(chat);
      // counts only: never the group, the member or the question
      log.info(
        {
          event: 'ai_group_handoff_notification',
          assigned: chat.assignedTo != null,
          recipients: targets.length,
        },
        'Dispatching AI group handover notification',
      );
      await deliver('handoff', byLocale(targets), (locale) => ({
        title: t(locale, 'push.aiGroupHandoff.title', {
          agent: agentName,
          group: chat.name || t(locale, 'push.unknownContact'),
        }).slice(0, 200),
        body: t(locale, 'push.aiGroupHandoff.body', {
          member: member ?? t(locale, 'push.aiGroupHandoff.member'),
          question,
        }).slice(0, 1000),
        url: `/chats/${encodeURIComponent(chat.jid)}`,
        tag: chat.jid,
      }));
    },

    async notifyAdmins(text, link = { url: '/admin/whatsapp', tag: 'wa-status' }) {
      const targets = ids(q.activeAdmins.all());
      if (!targets.length) return;
      await deliver('admin', byLocale(targets), (locale) => {
        const { title, body } = text(locale);
        return {
          title: title.slice(0, 200),
          body: body.slice(0, 1000),
          url: link.url,
          tag: link.tag,
        };
      });
    },

    shutdown() {
      ctx.bus.off('inbound:notify', onInbound);
      ctx.bus.off('ai:handoff', onHandoff);
      ctx.bus.off('ai:group_handoff', onGroupHandoff);
      ctx.bus.off('wa:status', onWaStatus);
      ctx.bus.off('inbox:status', onInboxStatus);
    },
  };

  const onInbound = ({ chat, message }: { chat: Chat; message: Message }) => {
    service
      .notifyInbound(chat, message)
      .catch((err: unknown) => log.warn({ err }, 'notifyInbound failed'));
  };
  const onHandoff = (chat: Chat) => {
    service.notifyHandoff(chat).catch((err: unknown) => log.warn({ err }, 'notifyHandoff failed'));
  };
  const onGroupHandoff = (handoff: GroupHandoff) => {
    service
      .notifyGroupHandoff(handoff)
      .catch((err: unknown) => log.warn({ err }, 'notifyGroupHandoff failed'));
  };
  // the last alert state of each inbox: one alert per outage, per number
  const lastAlertState = new Map<number, WaStatus['state']>();
  const alertInbox = (inboxId: number, s: WaStatus) => {
    if (!ALERT_STATES.has(s.state)) {
      lastAlertState.delete(inboxId);
      return;
    }
    if (lastAlertState.get(inboxId) === s.state) return; // don't spam admins on repeated status events
    lastAlertState.set(inboxId, s.state);
    const active = ctx.inboxes.repo.active();
    const several = active.length > 1;
    const name = several ? (active.find((r) => r.id === inboxId)?.name ?? null) : null;
    const tag = inboxId === PRIMARY_INBOX_ID ? 'wa-status' : `wa-status-${inboxId}`;
    service
      .notifyAdmins(
        waAlertText(s, name),
        several ? { url: '/admin/inboxes', tag } : { url: '/admin/whatsapp', tag },
      )
      .catch((err: unknown) => log.warn({ err }, 'notifyAdmins failed'));
  };
  // inbox 1 reports through wa:status as before; the others through inbox:status
  const onWaStatus = (s: WaStatus) => alertInbox(PRIMARY_INBOX_ID, s);
  const onInboxStatus = (p: InboxStatusPayload) => {
    if (p.inboxId !== PRIMARY_INBOX_ID) alertInbox(p.inboxId, p.status);
  };
  ctx.bus.on('inbound:notify', onInbound);
  ctx.bus.on('ai:handoff', onHandoff);
  ctx.bus.on('ai:group_handoff', onGroupHandoff);
  ctx.bus.on('wa:status', onWaStatus);
  ctx.bus.on('inbox:status', onInboxStatus);

  return service;
}
