import { createHash } from 'node:crypto';
import type {
  Message,
  ReplyPhrase,
  ReplyPhraseBody,
  ReplyPhraseListItem,
  ReplyPhraseStatus,
  ReplyPhraseTrigger,
} from '@ezychat/shared';
import type { AppContext } from '../../context.js';
import { audit } from '../../db/audit.js';
import { HttpError, errors } from '../../http/errors.js';
import { errorNameOf } from '../agent/models.js';
import { agentById, defaultAgent, listAgents, type AgentRow } from '../agents.js';
import { chatAgent } from '../groups.js';
import { replySuggestionsEnabled } from '../reply-suggestions-setting.js';
import { acceptPhrases, cleanTeamReply, planPhraseMerge } from './check.js';
import { PhraseRepo } from './repo.js';

/** Team replies since the last build that start the next one. */
export const PHRASE_REPLIES_PER_BUILD = 30;
/** AI calls a day for all phrase builds of the install. */
export const PHRASE_CALLS_PER_DAY = 24;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Team replies the build reads (newest), and their longest part. */
const TEAM_REPLIES = 200;
const TEAM_REPLY_CHARACTERS = 300;
/** Newest direct chats whose people's names no phrase may hold. */
const NAMED_CHATS = 2_000;

/** Per-agent build state (setting `ai_phrases_state:<agentId>`). */
interface BuildState {
  updatedAt: number | null;
  trigger: ReplyPhraseTrigger | null;
  /** The business context and instructions the last good build saw. */
  contextHash: string | null;
  newReplies: number;
  failedAt: number | null;
  prunedAt: number | null;
}
const EMPTY_STATE: BuildState = {
  updatedAt: null,
  trigger: null,
  contextHash: null,
  newReplies: 0,
  failedAt: null,
  prunedAt: null,
};

export interface PhraseService {
  /** Admin view: the status and every phrase of one agent (default: the agent of inbox 1). */
  admin(agentId?: number): {
    agentId: number | null;
    status: ReplyPhraseStatus;
    phrases: ReplyPhrase[];
  };
  /** What a composer matches: the chat's agent's phrases, nothing while suggestions are off. */
  forChat(jid: string): ReplyPhraseListItem[];
  feedback(jid: string, id: number, accepted: boolean): void;
  add(body: ReplyPhraseBody, actor: Actor): ReplyPhrase;
  update(id: number, body: ReplyPhraseBody, actor: Actor): ReplyPhrase;
  remove(id: number, actor: Actor): void;
  /** Rebuild now (admins): starts a build in the background and answers the status at once. */
  rebuild(agentId: number | undefined, actor: Actor): ReplyPhraseStatus;
  /** One worker round (the timer calls it; tests call it directly). */
  tick(): Promise<void>;
  shutdown(): Promise<void>;
}
type Actor = { userId: number | null; ip: string | null };

export interface PhraseDeps {
  now?: () => number;
  /** First round after start (default 2 min) and the round interval (default 1 min). */
  startDelayMs?: number;
  intervalMs?: number;
  /** false = no timers (tests drive `tick`). */
  timers?: boolean;
}

/**
 * The phrase list worker (design: docs/features/ai-phrase-dictionary/design.md). It builds an
 * agent's list at start (no list, older than 24 h), after a business context change (stable for one
 * round), after `PHRASE_REPLIES_PER_BUILD` team replies, weekly, and on Rebuild now; prunes AI
 * phrases unused for 30 days nightly. Nothing runs while reply suggestions are off, without a usable
 * AI connection or while the access gate is closed; at most `PHRASE_CALLS_PER_DAY` AI calls a day.
 */
export function createPhraseService(ctx: AppContext, deps: PhraseDeps = {}): PhraseService {
  const now = deps.now ?? Date.now;
  const log = ctx.log.child({ mod: 'ai', part: 'phrases' });
  const repo = new PhraseRepo(ctx.db);
  const building = new Map<number, AbortController>();
  const running = new Set<Promise<void>>();
  /** Context hash seen in the previous round, per agent (a change must be stable for a round). */
  const pendingHash = new Map<number, string>();
  let startRound = true;
  let closed = false;

  const stateKey = (agentId: number) => `ai_phrases_state:${agentId}`;
  const readState = (agentId: number): BuildState => ({
    ...EMPTY_STATE,
    ...(ctx.settings.get<Partial<BuildState> | null>(stateKey(agentId), null) ?? {}),
  });
  const writeState = (agentId: number, patch: Partial<BuildState>) =>
    ctx.settings.set(stateKey(agentId), { ...readState(agentId), ...patch });

  const day = () => new Date(now()).toISOString().slice(0, 10);
  const callsToday = () => {
    const stored = ctx.settings.get<{ day?: string; count?: number } | null>(
      'ai_phrases_calls',
      null,
    );
    return stored?.day === day() ? (stored.count ?? 0) : 0;
  };
  const countCall = () =>
    ctx.settings.set('ai_phrases_calls', { day: day(), count: callsToday() + 1 });

  const canBuild = () =>
    !closed &&
    replySuggestionsEnabled(ctx.settings) &&
    ctx.access.state().open &&
    ctx.services.ai?.draftConnection() === 'ready';

  /** Changes when a business context item, the instructions or the preset change. */
  const contextHash = (agent: AgentRow) => {
    const items = ctx.db
      .prepare('SELECT id, updated_at AS t FROM ai_documents WHERE agent_id = ? ORDER BY id')
      .all(agent.id) as { id: number; t: number }[];
    return createHash('sha256')
      .update(JSON.stringify([agent.instructions, agent.preset, items]))
      .digest('hex');
  };

  const agentOf = (agentId?: number): AgentRow => {
    const agent = agentId === undefined ? defaultAgent(ctx.db) : agentById(ctx.db, agentId);
    if (!agent) throw errors.notFound('AI agent');
    return agent;
  };

  const status = (agentId: number): ReplyPhraseStatus => {
    const state = readState(agentId);
    const languages = repo.counts(agentId);
    const count = languages.reduce((sum, l) => sum + l.count, 0);
    return {
      state: building.has(agentId)
        ? 'building'
        : count === 0 && state.failedAt !== null && (state.updatedAt ?? 0) < state.failedAt
          ? 'error'
          : count === 0 && state.updatedAt === null
            ? 'empty'
            : 'ready',
      count,
      languages,
      updatedAt: state.updatedAt,
      trigger: state.trigger,
      newReplies: Math.min(state.newReplies, PHRASE_REPLIES_PER_BUILD),
      nextAfterReplies: PHRASE_REPLIES_PER_BUILD,
      aiCallsToday: callsToday(),
      aiCallsLimit: PHRASE_CALLS_PER_DAY,
    };
  };

  /** The agent's team replies, cleaned of customer details, newest last; plus the names removed. */
  const teamReplies = (agent: AgentRow): { replies: string[]; names: string[] } => {
    if (agent.inboxId === null) return { replies: [], names: [] };
    const rows = ctx.db
      .prepare(
        `SELECT m.body AS body, c.name AS chatName, p.name AS profileName
           FROM messages m
           JOIN chats c ON c.jid = m.chat_jid
           LEFT JOIN customer_profiles p ON p.chat_jid = c.jid
          WHERE m.from_me = 1 AND m.type = 'text' AND m.body IS NOT NULL AND c.type = 'dm'
            AND c.inbox_id = ?
            AND m.sent_by_user_id IN (SELECT id FROM users WHERE kind = 'human')
          ORDER BY m.timestamp DESC LIMIT ?`,
      )
      .all(agent.inboxId, TEAM_REPLIES) as {
      body: string;
      chatName: string | null;
      profileName: string | null;
    }[];
    // Every customer name of the inbox, not only of the chats replied to: no phrase may hold one.
    const people = ctx.db
      .prepare(
        `SELECT c.name AS chatName, p.name AS profileName
           FROM chats c LEFT JOIN customer_profiles p ON p.chat_jid = c.jid
          WHERE c.inbox_id = ? AND c.type = 'dm'
          ORDER BY c.last_message_at DESC LIMIT ?`,
      )
      .all(agent.inboxId, NAMED_CHATS) as { chatName: string | null; profileName: string | null }[];
    const names = [
      ...new Set(
        [...rows, ...people]
          .flatMap((r) => [r.chatName, r.profileName])
          .flatMap((n) => (n ? [n, ...n.split(/\s+/)] : [])),
      ),
    ].filter((n) => n.trim().length >= 3 && !/^\+?\d/.test(n));
    const replies = rows
      .map((r) => cleanTeamReply(r.body, names).slice(0, TEAM_REPLY_CHARACTERS).trim())
      .filter(Boolean)
      .reverse();
    return { replies, names };
  };

  const build = async (agent: AgentRow, trigger: ReplyPhraseTrigger) => {
    if (building.has(agent.id)) return;
    const cancel = new AbortController();
    building.set(agent.id, cancel);
    countCall();
    const started = now();
    const hash = contextHash(agent);
    try {
      const { replies, names } = teamReplies(agent);
      const stored = repo.stored(agent.id);
      const result = await ctx.services.ai!.buildPhrases(
        agent.id,
        {
          teamReplies: replies,
          existing: stored.slice(0, 100).map(({ text, language }) => ({ text, language })),
        },
        cancel.signal,
      );
      const { accepted, dropped } = acceptPhrases(result.output.phrases, {
        business: result.business,
        internalTexts: result.internalTexts,
        names,
      });
      const plan = planPhraseMerge(repo.stored(agent.id), accepted, result.business);
      repo.replace(agent.id, plan.drop, plan.add, now());
      writeState(agent.id, {
        updatedAt: now(),
        trigger,
        contextHash: hash,
        newReplies: 0,
        failedAt: null,
      });
      // Counts only: never a phrase, a reply or a name.
      log.info(
        {
          event: 'phrase_build',
          agentId: agent.id,
          trigger,
          ok: true,
          ms: now() - started,
          model: result.model,
          candidates: result.output.phrases.length,
          added: plan.add.length,
          removed: plan.drop.length,
          dropped,
        },
        'Phrase list built',
      );
    } catch (error) {
      writeState(agent.id, { failedAt: now() });
      log.warn(
        {
          event: 'phrase_build',
          agentId: agent.id,
          trigger,
          ok: false,
          ms: now() - started,
          causeName: errorNameOf(error),
        },
        'Phrase list build failed',
      );
    } finally {
      building.delete(agent.id);
    }
  };
  const startBuild = (agent: AgentRow, trigger: ReplyPhraseTrigger) => {
    const job = build(agent, trigger);
    running.add(job);
    void job.finally(() => running.delete(job));
    return job;
  };

  /** What starts a build for this agent now, if anything. */
  const dueTrigger = (agent: AgentRow, state: BuildState): ReplyPhraseTrigger | null => {
    const t = now();
    // After a failure, wait an hour before an automatic try.
    if (state.failedAt !== null && t - state.failedAt < HOUR) return null;
    if (state.updatedAt === null) return 'start';
    if (startRound && t - state.updatedAt > DAY) return 'start';
    const hash = contextHash(agent);
    if (state.contextHash !== hash) {
      const stable = pendingHash.get(agent.id) === hash;
      pendingHash.set(agent.id, hash);
      if (stable) return 'context';
    } else pendingHash.delete(agent.id);
    if (state.newReplies >= PHRASE_REPLIES_PER_BUILD) return 'replies';
    if (t - state.updatedAt > 7 * DAY) return 'weekly';
    return null;
  };

  const tick = async () => {
    if (!canBuild()) return;
    for (const agent of listAgents(ctx.db)) {
      if (closed || !canBuild()) return;
      const state = readState(agent.id);
      if (state.prunedAt === null || now() - state.prunedAt > DAY) {
        const removed = repo.pruneUnused(agent.id, now() - 30 * DAY);
        writeState(agent.id, { prunedAt: now() });
        if (removed)
          log.info({ event: 'phrase_prune', agentId: agent.id, removed }, 'Unused phrases removed');
      }
      const trigger = dueTrigger(agent, state);
      if (!trigger || building.has(agent.id)) continue;
      if (callsToday() >= PHRASE_CALLS_PER_DAY) return;
      // One agent at a time: the builds share the install's AI connection.
      await startBuild(agent, trigger);
    }
    startRound = false;
  };

  // A teammate's text reply in a direct chat counts toward the next build of that chat's agent.
  const onMessage = (msg: Message) => {
    if (closed || !msg.fromMe || !msg.sentByUserId || msg.type !== 'text') return;
    const counted = ctx.db
      .prepare(
        "SELECT 1 FROM users u, chats c WHERE u.id = ? AND u.kind = 'human' AND c.jid = ? AND c.type = 'dm'",
      )
      .get(msg.sentByUserId, msg.chatJid);
    if (!counted) return;
    const agent = chatAgent(ctx, msg.chatJid);
    if (!agent) return;
    writeState(agent.id, { newReplies: readState(agent.id).newReplies + 1 });
  };
  ctx.bus.on('message:new', onMessage);

  let first: ReturnType<typeof setTimeout> | null = null;
  let every: ReturnType<typeof setInterval> | null = null;
  if (deps.timers !== false) {
    first = setTimeout(
      () => {
        void tick();
        every = setInterval(() => void tick(), deps.intervalMs ?? MINUTE);
        every.unref?.();
      },
      deps.startDelayMs ?? 2 * MINUTE,
    );
    first.unref?.();
  }

  const agentOfChat = (jid: string) => chatAgent(ctx, jid);
  const ownPhrase = (id: number) => {
    const agentId = repo.agentOf(id);
    if (agentId === null) throw errors.notFound('Phrase');
    return agentId;
  };

  return {
    admin(agentId) {
      const agent = agentId === undefined ? defaultAgent(ctx.db) : agentOf(agentId);
      if (!agent) return { agentId: null, status: status(0), phrases: [] };
      return { agentId: agent.id, status: status(agent.id), phrases: repo.list(agent.id) };
    },
    forChat(jid) {
      if (!replySuggestionsEnabled(ctx.settings)) return [];
      const agent = agentOfChat(jid);
      return agent
        ? repo.list(agent.id).map(({ id, text, language }) => ({ id, text, language }))
        : [];
    },
    feedback(jid, id, accepted) {
      const agent = agentOfChat(jid);
      if (!agent || !repo.feedback(agent.id, id, accepted)) throw errors.notFound('Phrase');
    },
    add(body, actor) {
      const agent = agentOf(body.agentId);
      const phrase = repo.add(
        agent.id,
        { text: body.text, language: body.language, source: 'admin', fact: /\d/.test(body.text) },
        now(),
      );
      audit(ctx.db, {
        ...actor,
        action: 'ai.phrase.create',
        meta: { agentId: agent.id, phraseId: phrase.id },
      });
      return phrase;
    },
    update(id, body, actor) {
      const agentId = ownPhrase(id);
      const phrase = repo.update(
        agentId,
        id,
        body.text,
        body.language,
        /\d/.test(body.text),
        now(),
      )!;
      audit(ctx.db, { ...actor, action: 'ai.phrase.update', meta: { agentId, phraseId: id } });
      return phrase;
    },
    remove(id, actor) {
      const agentId = ownPhrase(id);
      repo.remove(agentId, id);
      audit(ctx.db, { ...actor, action: 'ai.phrase.delete', meta: { agentId, phraseId: id } });
    },
    rebuild(agentId, actor) {
      const agent = agentOf(agentId);
      if (!replySuggestionsEnabled(ctx.settings))
        throw new HttpError(409, 'ai_suggestions_off', 'Reply suggestions are off');
      if (!canBuild())
        throw new HttpError(503, 'ai_unavailable', 'The AI connection is not available now');
      if (!building.has(agent.id)) {
        if (callsToday() >= PHRASE_CALLS_PER_DAY)
          throw new HttpError(
            429,
            'phrase_build_limit',
            'The phrase list was rebuilt often today. Try again tomorrow.',
          );
        audit(ctx.db, { ...actor, action: 'ai.phrase.rebuild', meta: { agentId: agent.id } });
        void startBuild(agent, 'manual');
      }
      return status(agent.id);
    },
    tick,
    async shutdown() {
      closed = true;
      if (first) clearTimeout(first);
      if (every) clearInterval(every);
      ctx.bus.off('message:new', onMessage);
      for (const cancel of building.values()) cancel.abort();
      await Promise.allSettled(running);
    },
  };
}

declare module '../../context.js' {
  interface Services {
    phrases?: PhraseService;
  }
}

export function initPhrases(ctx: AppContext) {
  if (ctx.services.ai) ctx.services.phrases = createPhraseService(ctx);
}
