/**
 * Standalone `session.chat_tail` WS fan-out — per-connection subscription
 * storage plus the hot / guaranteed-delivery flush (hybrid cohort: the build
 * engine is the core TopicSubscriptionRegistry's `buildChatTailUpdate`).
 *
 * Moved out of index.ts (wiring-unification B5). What changed on the way:
 *  - the completion-tail guarantee is driven by the host runtime's bus
 *    `status` subscriber (working|blocked → ready) calling `flush({forceSessionIds})`,
 *    instead of a `lastObservedSessionStatus` snapshot diff that ran inside
 *    `onStatusChange` lambdas which never fired on a turn transition (C17 —
 *    only the 2 s timer delivered it);
 *  - `deliveredCompletionTailAt` / `lastFlushedTailSignatureBySession` are
 *    subscriber caches purged on `terminated` (`forgetSession`), not pruned by
 *    diffing every snapshot.
 */

import { WebSocket } from 'ws';
import {
  LOG,
  classifyHotChatSessionsForSubscriptionFlush,
  decideMissingSessionAttempt,
  runAsyncBatch,
  type ChatTailMissingSessionState,
  type DaemonHostRuntime,
  type SessionChatTailSubscriptionParams,
  type SessionChatTailUpdate,
  type SubscribeRequest,
} from '@adhdev/daemon-core';

export interface ChatTailSubscriptionState {
  request: SubscribeRequest & { topic: 'session.chat_tail'; params: SessionChatTailSubscriptionParams };
  seq: number;
  cursor: {
    tailLimit: number;
  };
  lastDeliveredSignature: string;
  /**
   * Set once the target session stops resolving in the live registry, cleared as
   * soon as a read succeeds. Drives the retry backoff / give-up that keeps an
   * orphaned subscription from re-reading `read_chat` on every flush.
   */
  missingSession?: ChatTailMissingSessionState;
}

export interface ChatTailFlushOptions {
  onlyActive?: boolean;
  forceSessionIds?: ReadonlySet<string>;
}

/**
 * (D8) True when the tail the daemon just built carries at least one message —
 * on the emitted update or (a no-op update) on the underlying read_chat result.
 */
export function chatTailUpdateHasMessages(update: SessionChatTailUpdate | null, result: unknown): boolean {
  if (update && Array.isArray(update.messages) && update.messages.length > 0) return true;
  const r = result as { messages?: unknown; messagesTail?: unknown } | null | undefined;
  if (r && Array.isArray(r.messages) && r.messages.length > 0) return true;
  if (r && Array.isArray(r.messagesTail) && r.messagesTail.length > 0) return true;
  return false;
}

export class StandaloneChatTailFanout {
  private readonly subscriptions = new Map<WebSocket, Map<string, ChatTailSubscriptionState>>();
  private flushInFlight = false;
  private pending: { targetWs?: WebSocket; onlyActive: boolean; forceSessionIds?: ReadonlySet<string> } | null = null;
  private hotSessionIds = new Set<string>();
  // Per-session `lastMessageAt` of the completion tail last flushed — bounds the
  // guaranteed-delivery path to one push per completion tail.
  private readonly deliveredCompletionTailAt = new Map<string, number>();
  // (D8) Per-session signature of the most recent NON-EMPTY tail actually built,
  // paired with each subscription's lastDeliveredSignature: the per-subscription
  // ACK gate that keeps a completed session hot until every subscriber has it.
  private readonly lastFlushedTailSignatureBySession = new Map<string, string>();

  constructor(private readonly deps: {
    clients(): Iterable<WebSocket>;
    host(): DaemonHostRuntime | null;
  }) {}

  addClient(ws: WebSocket): void {
    this.subscriptions.set(ws, new Map());
  }

  removeClient(ws: WebSocket): void {
    this.subscriptions.delete(ws);
  }

  clear(): void {
    this.subscriptions.clear();
  }

  /** `terminated` purge of the per-session delivery caches. */
  forgetSession(sessionId: string): void {
    this.deliveredCompletionTailAt.delete(sessionId);
    this.lastFlushedTailSignatureBySession.delete(sessionId);
    this.hotSessionIds.delete(sessionId);
  }

  /** The registry's `onPrepared` hook (record a real, non-empty tail signature). */
  onPrepared = ({ sessionId, lastDeliveredSignature, update, result }: {
    sessionId: string;
    lastDeliveredSignature: string;
    update: SessionChatTailUpdate | null;
    result: unknown;
  }): void => {
    if (lastDeliveredSignature && chatTailUpdateHasMessages(update, result)) {
      this.lastFlushedTailSignatureBySession.set(sessionId, lastDeliveredSignature);
    }
  };

  async subscribe(ws: WebSocket, msg: SubscribeRequest): Promise<void> {
    const params = msg.params as SessionChatTailSubscriptionParams;
    if (!params?.targetSessionId) return;
    const subs = this.subscriptions.get(ws) || new Map<string, ChatTailSubscriptionState>();
    this.subscriptions.set(ws, subs);
    subs.set(msg.key, {
      request: { ...msg, topic: 'session.chat_tail', params },
      seq: 0,
      cursor: { tailLimit: Math.max(0, Number(params.tailLimit || 0)) },
      lastDeliveredSignature: '',
    });
    // Codex can create its native rollout file shortly after the dashboard
    // subscribes. Keep a fresh subscription hot briefly so an initial empty
    // read is retried by the normal chat-tail flush path.
    this.deps.host()?.topics.markChatOutputActivity(params.targetSessionId);
    await this.flush(ws);
  }

  unsubscribe(ws: WebSocket, key: string): void {
    this.subscriptions.get(ws)?.delete(key);
  }

  /**
   * (D8) Sessions with an OPEN subscriber whose per-ws lastDeliveredSignature
   * does not match the session's current authoritative tail signature.
   */
  private getUnderDeliveredSessionIds(): Set<string> {
    const underDelivered = new Set<string>();
    for (const ws of this.deps.clients()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const subs = this.subscriptions.get(ws);
      if (!subs || subs.size === 0) continue;
      for (const sub of subs.values()) {
        const sessionId = sub.request.params.targetSessionId;
        if (!sessionId) continue;
        const target = this.lastFlushedTailSignatureBySession.get(sessionId);
        if (!target) continue;
        if (sub.lastDeliveredSignature !== target) underDelivered.add(sessionId);
      }
    }
    return underDelivered;
  }

  private getHotSessionIds(host: DaemonHostRuntime): { active: Set<string>; finalizing: Set<string> } {
    const now = Date.now();
    const snapshot = host.buildSnapshot('live');
    const hotSessions = classifyHotChatSessionsForSubscriptionFlush(
      snapshot.sessions,
      this.hotSessionIds,
      {
        now,
        activeSessionIds: host.topics.getRecentlyOutputActiveChatSessionIds(now),
        deliveredCompletionTailAt: this.deliveredCompletionTailAt,
        underDeliveredSessionIds: this.getUnderDeliveredSessionIds(),
      },
    );
    this.hotSessionIds = hotSessions.active;
    // Record the finalized tail about to be flushed for each guaranteed-delivery
    // session, so the next classification treats it as delivered.
    if (hotSessions.guaranteedDelivery.size > 0) {
      const lastMessageAtBySession = new Map<string, number>();
      for (const session of snapshot.sessions as Array<{ id?: unknown; lastMessageAt?: unknown }>) {
        const id = typeof session?.id === 'string' ? session.id : '';
        if (!id) continue;
        const ts = typeof session.lastMessageAt === 'number' && Number.isFinite(session.lastMessageAt)
          ? session.lastMessageAt
          : (typeof session.lastMessageAt === 'string' ? Date.parse(session.lastMessageAt) : 0);
        lastMessageAtBySession.set(id, Number.isFinite(ts) ? ts : 0);
      }
      for (const sessionId of hotSessions.guaranteedDelivery) {
        const ts = lastMessageAtBySession.get(sessionId) ?? 0;
        this.deliveredCompletionTailAt.set(sessionId, ts > 0 ? ts : now);
      }
    }
    return hotSessions;
  }

  async flush(targetWs?: WebSocket, options: ChatTailFlushOptions = {}): Promise<void> {
    const host = this.deps.host();
    if (!host) return;
    if (this.flushInFlight) {
      const nextOnlyActive = options.onlyActive === true;
      const pending = this.pending;
      // Preserve forced session ids across coalesced flushes — a targeted
      // completion delivery must not be swallowed by an in-flight periodic flush.
      const mergedForce = new Set<string>([
        ...(pending?.forceSessionIds ?? []),
        ...(options.forceSessionIds ?? []),
      ]);
      this.pending = {
        targetWs: pending?.targetWs === undefined || targetWs === undefined ? undefined : targetWs,
        onlyActive: pending ? (pending.onlyActive && nextOnlyActive) : nextOnlyActive,
        forceSessionIds: mergedForce.size > 0 ? mergedForce : undefined,
      };
      return;
    }

    this.flushInFlight = true;
    try {
      const targets = targetWs ? [targetWs] : Array.from(this.deps.clients());
      const hotSessionIds = options.onlyActive ? this.getHotSessionIds(host) : null;
      const forceSessionIds = options.forceSessionIds ?? null;
      const now = Date.now();
      const tasks: Array<{ ws: WebSocket; key: string; sub: ChatTailSubscriptionState }> = [];
      for (const ws of targets) {
        if (ws.readyState !== WebSocket.OPEN) continue;
        const subs = this.subscriptions.get(ws);
        if (!subs || subs.size === 0) continue;
        for (const [key, sub] of subs.entries()) {
          const targetSessionId = sub.request.params.targetSessionId;
          // Pace a subscription whose session has left the live registry. This
          // guard precedes the forced/hot checks on purpose: a just-stopped
          // session passes through "newly settled" too.
          const decision = decideMissingSessionAttempt(sub.missingSession, now);
          if (decision.action === 'skip') continue;
          if (decision.action === 'drop') {
            subs.delete(key);
            LOG.info('Standalone', `[chat_tail] subscription dropped: session=${targetSessionId} key=${key} — live session absent for ${Math.round((now - (sub.missingSession?.firstMissingAt ?? now)) / 1000)}s`);
            continue;
          }
          const isForced = forceSessionIds?.has(targetSessionId) === true;
          if (
            !isForced
            && hotSessionIds
            && !hotSessionIds.active.has(targetSessionId)
            && !hotSessionIds.finalizing.has(targetSessionId)
          ) {
            continue;
          }
          tasks.push({ ws, key, sub });
        }
      }

      await runAsyncBatch(tasks, async ({ ws, key, sub }) => {
        try {
          const update = await host.topics.buildChatTailUpdate({ key, params: sub.request.params, state: sub });
          if (!update || ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({ type: 'topic_update', update }));
        } catch (error: any) {
          LOG.warn('Standalone', `[chat_tail] skipped session=${sub.request.params.targetSessionId} key=${key} error=${error?.message || error}`);
        }
      }, { concurrency: 4 });
    } finally {
      this.flushInFlight = false;
      if (this.pending) {
        const pending = this.pending;
        this.pending = null;
        void this.flush(pending.targetWs, {
          onlyActive: pending.onlyActive,
          ...(pending.forceSessionIds ? { forceSessionIds: pending.forceSessionIds } : {}),
        });
      }
    }
  }
}
