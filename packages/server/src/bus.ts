import { EventEmitter } from 'node:events';
import type {
  Chat,
  Role,
  ChatEvent,
  InboxStatusPayload,
  Message,
  MessageReactionsPayload,
  Note,
  ServerToClientEvents,
  TunnelStatus,
  VoiceStatus,
  WaStatus,
} from '@ezychat/shared';
import type { AiToolCallEvent } from './ai/agent/extension-tools.js';

export interface BusEvents {
  'message:new': [Message];
  'message:status': [Parameters<ServerToClientEvents['message:status']>[0]];
  /** An existing message changed after `message:new` (voice note transcript). */
  'message:updated': [Message];
  /** A stored message's reactions changed (never a notification). */
  'message:reactions': [MessageReactionsPayload];
  /** Voice model download/install state (admins only). */
  'voice:status': [VoiceStatus];
  /** Invalidate background work when the shared AI connection changes or becomes unavailable. */
  'ai:connection-changed': [];
  /** Committed Sales Agent handover, delivered through the existing notification channels. */
  'ai:handoff': [Chat];
  /**
   * The AI handed a question in a WhatsApp group to the team (the group keeps its assignee).
   * `member`: the asking member's display name; `question`: their message (notification text only,
   * never logged).
   */
  'ai:group_handoff': [{ chat: Chat; agentName: string; member: string | null; question: string }];
  /** One finished extension tool call of the AI (live or Try it); never its input or output. */
  'ai:tool_call': [AiToolCallEvent];
  'chat:updated': [Chat];
  /** A WhatsApp group changed (here or on WhatsApp): open Group info panels refetch. Chat key. */
  'group:changed': [{ chatJid: string }];
  'chat:event': [ChatEvent];
  'note:new': [Note];
  /** Connection status of inbox 1 (the number linked before multi-inbox). */
  'wa:status': [WaStatus];
  /** Connection status of every inbox, inbox 1 included. */
  'inbox:status': [InboxStatusPayload];
  /**
   * An inbox was added, renamed or removed, or who may open one changed: live sockets rebuild
   * their inbox rooms and clients reload the inbox list.
   */
  'inboxes:changed': [];
  'tunnel:status': [TunnelStatus];
  'user:disabled': [number];
  'user:sessions-revoked': [number];
  /** userId, new role (live sockets must join/leave the 'admins' room) */
  'user:role-changed': [number, Role];
  /** for push routing */
  'inbound:notify': [{ chat: Chat; message: Message }];
  /** Live WhatsApp receipt, before media downloads; automation must react to arrival order. */
  'message:received': [{ chat: Chat; message: Message }];
  /** The access gate closed (an edition turned the app off); paused services stop their work. */
  'access:closed': [{ code: string }];
  /** The access gate opened again; paused services resume. */
  'access:opened': [Record<string, never>];
}

type Listener<K extends keyof BusEvents> = (...args: BusEvents[K]) => void;

/** In-process typed domain event bus. Listener errors are isolated (logged via 'error' handler if set). */
export class Bus {
  private readonly ee = new EventEmitter();

  constructor(private readonly onListenerError?: (err: unknown, event: string) => void) {
    this.ee.setMaxListeners(100);
  }

  on<K extends keyof BusEvents>(ev: K, fn: Listener<K>): this {
    this.ee.on(ev, fn as (...a: unknown[]) => void);
    return this;
  }

  once<K extends keyof BusEvents>(ev: K, fn: Listener<K>): this {
    this.ee.once(ev, fn as (...a: unknown[]) => void);
    return this;
  }

  off<K extends keyof BusEvents>(ev: K, fn: Listener<K>): this {
    this.ee.off(ev, fn as (...a: unknown[]) => void);
    return this;
  }

  emit<K extends keyof BusEvents>(ev: K, ...args: BusEvents[K]): boolean {
    const listeners = this.ee.listeners(ev);
    for (const l of listeners) {
      try {
        (l as (...a: unknown[]) => void)(...args);
      } catch (err) {
        if (this.onListenerError) this.onListenerError(err, ev);
        else throw err;
      }
    }
    return listeners.length > 0;
  }

  removeAllListeners(): void {
    this.ee.removeAllListeners();
  }
}
