import {
  CustomerProfileBody,
  EnrichmentExtraction,
  EnrichmentSettingBody,
  EnrichmentAudit,
  ENRICHMENT_ADD_THRESHOLD,
  ENRICHMENT_REPLACE_THRESHOLD,
  ENRICHMENT_POLICY,
  type Chat,
  type Message,
  type EnrichmentStatus,
} from '@ezychat/shared';
import type { AppContext } from '../context.js';
import { audit } from '../db/audit.js';
import { getChats, getMessages } from '../wa-bridge/index.js';
import { linkedChats } from './linked.js';
import { CustomerRepo, PROFILE_FIELDS, type ProfileFields } from './repo.js';
import { enrichmentPrompt } from './enrichment-prompt.js';

export const ENRICHMENT_SETTING = 'customer_enrichment_enabled';
export const ENRICHMENT_MAX_AGE_MS = 10 * 60_000;
const MAX_PENDING = 200;
const MAX_PARALLEL = 2;

export interface EnrichmentService {
  status(): EnrichmentStatus;
  setEnabled(enabled: boolean, actor: { userId: number; ip: string | null }): EnrichmentStatus;
  shutdown(): Promise<void>;
}
declare module '../context.js' {
  interface Services {
    enrichment?: EnrichmentService;
  }
}

/** Text equivalence only; never uses names/numbers to match people. */
const normalized = (text: string) => text.normalize('NFC').replace(/\s+/g, ' ').trim();

export function createEnrichmentService(ctx: AppContext): EnrichmentService {
  const repo = new CustomerRepo(ctx.db);
  const chats = getChats(ctx);
  const messages = getMessages(ctx);
  const log = ctx.log.child({ mod: 'enrichment' });
  const pending = new Map<string, Message[]>();
  const active = new Map<string, { cancel: AbortController; before: string; batch: Message[] }>();
  const running = new Set<Promise<void>>();
  let closed = false;
  const enabled = () => ctx.settings.get<boolean>(ENRICHMENT_SETTING, false) === true;
  // Paused while an edition has closed the access gate (nothing queued is replayed on reopen).
  const ready = () =>
    !closed && ctx.access.state().open && enabled() && !!ctx.services.ai?.connectionReady();
  const profileKey = (jid: string) => JSON.stringify(repo.get(jid));
  const stillRoutedHere = (jid: string) => (ctx.services.aliases?.route(jid) ?? jid) === jid;
  const fresh = (message: Message) => {
    const age = Date.now() - message.timestamp;
    return age >= -30_000 && age <= ENRICHMENT_MAX_AGE_MS;
  };
  const invalidate = () => {
    pending.clear();
    for (const item of active.values()) item.cancel.abort();
  };
  const canCommit = (message: Message, cancel: AbortController, before: string) =>
    !cancel.signal.aborted &&
    ready() &&
    fresh(message) &&
    profileKey(message.chatJid) === before &&
    stillRoutedHere(message.chatJid) &&
    chats.get(message.chatJid)?.type === 'dm';

  function proposalSource(proposal: EnrichmentExtraction['fields'][number], batch: Message[]) {
    if (
      proposal.ownership !== 'self' ||
      !proposal.current ||
      !['explicit', 'correction'].includes(proposal.statement)
    )
      return null;
    const value = proposal.value.trim();
    if (proposal.field === 'name' && /^[+\d\s()-]+$/.test(value)) return null;
    const evidence = normalized(proposal.evidence);
    const source = batch.findLast((m) => normalized(m.body ?? '').includes(evidence));
    if (!value || !source || !fresh(source) || !evidence.includes(normalized(value))) return null;
    return { source, value };
  }

  function acceptedProposal(
    proposal: EnrichmentExtraction['fields'][number],
    batch: Message[],
    profile: ReturnType<CustomerRepo['get']>,
  ) {
    const quoted = proposalSource(proposal, batch);
    if (!quoted) return null;
    const { value, source } = quoted;
    const parsed = CustomerProfileBody.shape[proposal.field].safeParse(value);
    if (!parsed.success || !parsed.data || profile?.[proposal.field] === parsed.data) return null;
    const operation = profile?.[proposal.field] ? 'replaced' : 'added';
    const threshold =
      operation === 'added' ? ENRICHMENT_ADD_THRESHOLD : ENRICHMENT_REPLACE_THRESHOLD;
    const points = proposal.points;
    const score = Object.values(points).reduce((sum, p) => sum + p, 0);
    if (score < threshold) return null;
    return {
      value: parsed.data,
      audit: {
        field: proposal.field,
        score,
        points,
        operation,
        threshold,
        messageId: source.id,
        reason: proposal.statement === 'correction' ? 'correction' : 'self_reported',
      } satisfies EnrichmentAudit['fields'][number],
    };
  }

  async function extract(batch: Message[], cancel: AbortController, before: string) {
    const message = batch.at(-1)!;
    const jid = message.chatJid;
    const started = Date.now();
    try {
      const profile = repo.get(jid);
      const history = messages.list(jid, { limit: 12 }).messages;
      const result = EnrichmentExtraction.parse(
        await ctx.services.ai!.extractCustomer(
          enrichmentPrompt(batch, history, profile),
          cancel.signal,
        ),
      );
      const fields: EnrichmentAudit['fields'] = [];
      const seen = new Set<string>();
      // Duplicate proposals fail closed for that field, rather than choosing one arbitrarily.
      const duplicates = new Set(
        result.fields
          .filter((f, i, all) => all.findIndex((x) => x.field === f.field) !== i)
          .map((f) => f.field),
      );
      const updates: Partial<ProfileFields> = {};
      for (const proposal of result.fields) {
        if (seen.has(proposal.field) || duplicates.has(proposal.field)) continue;
        seen.add(proposal.field);
        const accepted = acceptedProposal(proposal, batch, profile);
        if (!accepted) continue;
        updates[proposal.field] = accepted.value;
        fields.push(accepted.audit);
      }
      // All async work is over. Recheck and commit synchronously: staff edits and newer messages win.
      if (!canCommit(message, cancel, before)) return;
      if (fields.length) {
        const linked = linkedChats(ctx.db, jid);
        ctx.db.transaction(() => {
          const current = repo.get(jid);
          const next = Object.fromEntries(
            PROFILE_FIELDS.map((f) => [f, updates[f] ?? current?.[f] ?? null]),
          ) as ProfileFields;
          const now = Date.now();
          // The same person's chats in other inboxes share the contact fields, not the tags (linked.ts).
          repo.save(jid, next, current?.tags ?? [], null, now);
          for (const other of linked) repo.save(other, next, repo.tags(other), null, now);
          audit(ctx.db, {
            userId: null,
            action: 'customer.enrichment_update',
            ip: null,
            meta: {
              chatJid: jid,
              changed: fields.map((f) => f.field),
              enrichment: EnrichmentAudit.parse({
                fields,
                average: fields.reduce((sum, f) => sum + f.score, 0) / fields.length,
                messageId: message.id,
                policy: ENRICHMENT_POLICY,
              }),
            },
          });
        })();
        for (const target of [jid, ...linked]) {
          const chat = chats.get(target);
          if (chat) ctx.bus.emit('chat:updated', chat);
        }
      }
      log.info(
        { event: 'customer_enrichment', changed: fields.length, ms: Date.now() - started },
        'Customer enrichment completed',
      );
    } catch {
      if (!cancel.signal.aborted)
        log.warn(
          { event: 'customer_enrichment_failed', ms: Date.now() - started },
          'Customer enrichment failed',
        );
    }
  }
  function drain() {
    if (!ready()) return;
    for (const [jid, queued] of pending) {
      if (running.size >= MAX_PARALLEL) break;
      if (active.has(jid)) continue;
      pending.delete(jid);
      const batch = queued.filter(fresh);
      if (!batch.length || !stillRoutedHere(jid)) continue;
      const cancel = new AbortController();
      const before = profileKey(jid);
      active.set(jid, { cancel, before, batch });
      const task = extract(batch, cancel, before).finally(() => {
        active.delete(jid);
        running.delete(task);
        drain();
      });
      running.add(task);
    }
  }
  const onReceived = ({ chat, message }: { chat: Chat; message: Message }) => {
    // Every live arrival invalidates an older in-flight extraction, including non-text messages.
    const current = active.get(chat.jid);
    const prior =
      pending.get(chat.jid) ??
      (current && !current.cancel.signal.aborted && current.before === profileKey(chat.jid)
        ? current.batch
        : []);
    current?.cancel.abort();
    pending.delete(chat.jid);
    if (
      !ready() ||
      chat.type !== 'dm' ||
      message.fromMe ||
      !message.id ||
      message.id.length > 256 ||
      message.type !== 'text' ||
      !message.body?.trim() ||
      message.body.length > 16_000 ||
      !fresh(message)
    )
      return;
    if (pending.size >= MAX_PENDING) {
      log.warn(
        { event: 'customer_enrichment_queue_full', pending: pending.size },
        'Customer enrichment queue full',
      );
      return;
    }
    const batch = [...prior, message].slice(-12);
    // Bound prompt size during bursts; earlier completed work is never replayed from history.
    while (batch.length > 1 && batch.reduce((sum, m) => sum + (m.body?.length ?? 0), 0) > 16_000)
      batch.shift();
    pending.set(chat.jid, batch);
    drain();
  };
  const onChat = (chat: Chat) => {
    const current = active.get(chat.jid);
    if (current && current.before !== profileKey(chat.jid)) {
      current.cancel.abort();
      pending.delete(chat.jid);
    }
  };
  ctx.bus
    .on('message:received', onReceived)
    .on('chat:updated', onChat)
    .on('ai:connection-changed', invalidate)
    .on('access:closed', invalidate);
  return {
    status: () => ({ enabled: enabled(), connected: !!ctx.services.ai?.connectionReady() }),
    setEnabled(value, actor) {
      const { enabled: next } = EnrichmentSettingBody.parse({ enabled: value });
      if (next !== enabled()) {
        invalidate();
        ctx.db.transaction(() => {
          ctx.settings.set(ENRICHMENT_SETTING, next);
          audit(ctx.db, {
            ...actor,
            action: 'customer.enrichment_settings',
            meta: { enabled: next },
          });
        })();
      }
      return this.status();
    },
    async shutdown() {
      closed = true;
      invalidate();
      ctx.bus
        .off('message:received', onReceived)
        .off('chat:updated', onChat)
        .off('ai:connection-changed', invalidate)
        .off('access:closed', invalidate);
      await Promise.allSettled(running);
    },
  };
}
export function initEnrichment(ctx: AppContext) {
  ctx.services.enrichment = createEnrichmentService(ctx);
}
