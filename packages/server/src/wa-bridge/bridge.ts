import type { WaStatus } from '@ezychat/shared';
import type {
  WaAdapter,
  WaChatInfo,
  WaContactInfo,
  WaContactAlias,
  WaIncomingMessage,
  WaMessageEdit,
  WaMessageRevoke,
  WaMessageStatusUpdate,
  WaReaction,
} from '@ezychat/wa';
import type { AppContext } from '../context.js';
import { PRIMARY_INBOX_ID } from '../inboxes/keys.js';

/**
 * Wires the events of one inbox's WaAdapter into the domain services:
 * message → messages.ingest; reaction → messages.applyReaction; messageEdited / messageDeleted →
 * applyRemoteEdit / applyRemoteDelete; messageStatus → applyStatus; chats → upsertFromWa (all with the
 * inbox); contacts → contacts upsert; status → bus 'inbox:status' (every inbox) and, for inbox 1,
 * ctx.services.waStatus + bus 'wa:status'; when open → that inbox's send queue onConnected().
 * Returns a detach function.
 */
export function attachWaBridge(
  ctx: AppContext,
  inboxId: number = PRIMARY_INBOX_ID,
  wa: WaAdapter = ctx.inboxes.connections.adapter(inboxId),
): () => void {
  const messages = ctx.services.messages;
  const chats = ctx.services.chats;
  if (!messages || !chats)
    throw new Error('attachWaBridge: chats/messages services not initialized');
  const primary = inboxId === PRIMARY_INBOX_ID;
  const log = primary
    ? ctx.log.child({ mod: 'wa-bridge' })
    : ctx.log.child({ mod: 'wa-bridge', inboxId });
  let detached = false;
  let connectionGeneration = 0;

  const restoreContactAliases = () => {
    const generation = ++connectionGeneration;
    void (async () => {
      try {
        const jids = chats.contactJids();
        const aliases = await wa.getContactAliases(jids);
        if (detached || generation !== connectionGeneration || wa.status.state !== 'open') return;
        chats.upsertContactAliases(aliases);
        log.info(
          { contactCount: jids.length, aliasCount: aliases.length },
          'local contact alias recovery completed',
        );
      } catch (err) {
        if (!detached && generation === connectionGeneration)
          log.warn({ err }, 'local contact alias recovery failed');
      }
    })();
  };

  /** Remembers the inbox's own number, so alias learning ignores it after an unlink too. */
  const rememberOwnJid = (s: WaStatus) => {
    const jid = s.me?.jid;
    if (!jid) return;
    try {
      const row = ctx.inboxes.repo.get(inboxId);
      if (row && row.own_jid !== jid) ctx.inboxes.repo.setOwnJid(inboxId, jid);
    } catch (err) {
      log.warn({ err }, 'own number not saved');
    }
  };

  const onConnected = () => {
    rememberOwnJid(wa.status);
    messages.queueFor(inboxId).onConnected();
    restoreContactAliases();
  };

  const onMessage = (m: WaIncomingMessage, meta: { source: 'live' | 'history' }) => {
    messages
      .ingest(m, meta?.source ?? 'live', inboxId)
      .catch((err: unknown) => log.error({ err, id: m.id }, 'ingest failed'));
  };
  const onReaction = (r: WaReaction, meta: { source: 'live' | 'history' }) => {
    try {
      messages.applyReaction(r, meta?.source ?? 'live', inboxId);
    } catch (err) {
      log.error({ err, id: r.targetId }, 'reaction not stored');
    }
  };
  const onEdited = (e: WaMessageEdit, meta: { source: 'live' | 'history' }) => {
    try {
      messages.applyRemoteEdit(e, meta?.source ?? 'live', inboxId);
    } catch (err) {
      log.error({ err, id: e.targetId }, 'edit not stored');
    }
  };
  const onDeleted = (r: WaMessageRevoke, meta: { source: 'live' | 'history' }) => {
    try {
      messages.applyRemoteDelete(r, meta?.source ?? 'live', inboxId);
    } catch (err) {
      log.error({ err, id: r.targetId }, 'delete not stored');
    }
  };
  const onStatusUpdate = (u: WaMessageStatusUpdate) => {
    try {
      messages.applyStatus(u, inboxId);
    } catch (err) {
      log.error({ err, id: u.id }, 'applyStatus failed');
    }
  };
  const onChats = (list: WaChatInfo[]) => {
    try {
      ctx.db.transaction(() => {
        for (const c of list) chats.upsertFromWa(c, inboxId);
      })();
    } catch (err) {
      log.error({ err }, 'chats upsert failed');
    }
  };
  const onContacts = (list: WaContactInfo[]) => {
    try {
      chats.upsertContacts(list);
    } catch (err) {
      log.error({ err }, 'contacts upsert failed');
    }
  };
  const onContactAliases = (list: WaContactAlias[]) => {
    try {
      chats.upsertContactAliases(list);
    } catch (err) {
      log.error({ err }, 'contact aliases upsert failed');
    }
  };
  let prev: WaStatus = wa.status;
  const onStatus = (s: WaStatus) => {
    const before = prev;
    prev = s;
    if (primary) {
      ctx.services.waStatus = s;
      ctx.bus.emit('wa:status', s);
    }
    ctx.bus.emit('inbox:status', { inboxId, status: s });
    if (s.state === 'open' && before.state !== 'open') onConnected();
    else if (s.state !== 'open') connectionGeneration++;
  };

  if (primary) ctx.services.waStatus = wa.status;
  wa.on('message', onMessage);
  wa.on('reaction', onReaction);
  wa.on('messageEdited', onEdited);
  wa.on('messageDeleted', onDeleted);
  wa.on('messageStatus', onStatusUpdate);
  wa.on('chats', onChats);
  wa.on('contacts', onContacts);
  wa.on('contactAliases', onContactAliases);
  wa.on('status', onStatus);
  if (wa.status.state === 'open') onConnected();

  return () => {
    detached = true;
    connectionGeneration++;
    wa.off('message', onMessage);
    wa.off('reaction', onReaction);
    wa.off('messageEdited', onEdited);
    wa.off('messageDeleted', onDeleted);
    wa.off('messageStatus', onStatusUpdate);
    wa.off('chats', onChats);
    wa.off('contacts', onContacts);
    wa.off('contactAliases', onContactAliases);
    wa.off('status', onStatus);
  };
}
