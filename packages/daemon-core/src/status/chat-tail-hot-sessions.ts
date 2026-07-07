import { getSessionHostSurfaceKind } from '../session-host/runtime-surface.js';

export const DEFAULT_ACTIVE_CHAT_POLL_STATUSES = new Set([
  'generating',
  'waiting_approval',
  'starting',
]);

export const DEFAULT_CHAT_TAIL_RECENT_MESSAGE_GRACE_MS = 8_000;

const LIVE_RUNTIME_LIFECYCLES = new Set(['starting', 'running', 'stopping', 'interrupted']);

export interface HotChatSessionLike {
  id?: string | null;
  status?: unknown;
  unread?: unknown;
  inboxBucket?: unknown;
  lastMessageAt?: unknown;
  runtimeLifecycle?: unknown;
  runtimeSurfaceKind?: unknown;
  runtimeRestoredFromStorage?: unknown;
  runtimeRecoveryState?: unknown;
}

function parseMessageTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function isDefinitelyNonLiveRuntimeSession(session: HotChatSessionLike): boolean {
  const surfaceKind = String(session?.runtimeSurfaceKind || '').trim();
  if (surfaceKind === 'live_runtime') return false;
  if (surfaceKind === 'recovery_snapshot') return true;
  if (surfaceKind === 'inactive_record') return false;

  const lifecycle = String(session?.runtimeLifecycle || '').trim();
  if (lifecycle && LIVE_RUNTIME_LIFECYCLES.has(lifecycle)) return false;

  const inferredSurfaceKind = getSessionHostSurfaceKind({
    lifecycle: lifecycle || null,
    meta: {
      restoredFromStorage: session?.runtimeRestoredFromStorage === true,
      ...(session?.runtimeRecoveryState ? { runtimeRecoveryState: session.runtimeRecoveryState } : {}),
    },
  });
  if (inferredSurfaceKind === 'recovery_snapshot') return true;

  return false;
}

export function classifyHotChatSessionsForSubscriptionFlush(
  sessions: HotChatSessionLike[],
  previousHotSessionIds: ReadonlySet<string>,
  options: {
    now?: number;
    recentMessageGraceMs?: number;
    activeStatuses?: ReadonlySet<string>;
    activeSessionIds?: ReadonlySet<string>;
    /**
     * Per-session `lastMessageAt` of the most recent completion tail that has
     * already been flushed to subscribers. A completed-but-unseen session is
     * kept hot for delivery REGARDLESS of the 8s recency timer, but only until
     * its current tail has been delivered once — bounding the guaranteed
     * delivery so a slow-finalizing turn is not re-pushed every tick forever.
     * A newer `lastMessageAt` (fresh turn) re-arms delivery.
     */
    deliveredCompletionTailAt?: ReadonlyMap<string, number>;
  } = {},
): { active: Set<string>; finalizing: Set<string>; guaranteedDelivery: Set<string> } {
  const now = options.now ?? Date.now();
  const recentMessageGraceMs = Math.max(
    0,
    Number.isFinite(options.recentMessageGraceMs)
      ? Number(options.recentMessageGraceMs)
      : DEFAULT_CHAT_TAIL_RECENT_MESSAGE_GRACE_MS,
  );
  const activeStatuses = options.activeStatuses ?? DEFAULT_ACTIVE_CHAT_POLL_STATUSES;
  const activeSessionIds = options.activeSessionIds ?? new Set<string>();
  // The guaranteed-delivery path is opt-in: only callers that provide a
  // delivered-watermark map (so they can BOUND re-pushes) participate. Callers
  // without it keep the original recency-window-only behavior and never enter
  // the completed-but-unseen keep-hot branch (which would otherwise thrash by
  // re-pushing every tick with no delivered record to stop it).
  const deliveredCompletionTailAt = options.deliveredCompletionTailAt ?? null;
  const active = new Set<string>();
  const excluded = new Set<string>();
  // Sessions kept hot purely because they finalized late (outside the 8s
  // window) and have not been delivered yet. The caller records these so the
  // next classification knows their tail is now delivered.
  const guaranteedDelivery = new Set<string>();

  for (const session of sessions) {
    const sessionId = typeof session?.id === 'string' ? session.id : '';
    if (!sessionId) continue;
    if (isDefinitelyNonLiveRuntimeSession(session)) {
      excluded.add(sessionId);
      continue;
    }
    if (activeSessionIds.has(sessionId)) {
      active.add(sessionId);
      continue;
    }

    const status = String(session?.status || '').toLowerCase();
    const unread = session?.unread === true;
    const inboxBucket = String(session?.inboxBucket || '').toLowerCase();
    const runtimeSurfaceKind = String(session?.runtimeSurfaceKind || '').toLowerCase();
    const runtimeLifecycle = String(session?.runtimeLifecycle || '').toLowerCase();
    const isLiveRuntime = runtimeSurfaceKind === 'live_runtime' || LIVE_RUNTIME_LIFECYCLES.has(runtimeLifecycle);
    const lastMessageAt = parseMessageTimestamp(session?.lastMessageAt);
    const recentlyUpdated = lastMessageAt > 0 && (now - lastMessageAt) <= recentMessageGraceMs;
    const shouldKeepRecentTailHot = recentlyUpdated && (
      unread
      || inboxBucket === 'task_complete'
      || inboxBucket === 'needs_attention'
      || isLiveRuntime
      || activeStatuses.has(status)
    );

    if (activeStatuses.has(status) || shouldKeepRecentTailHot) {
      active.add(sessionId);
      continue;
    }

    // Guaranteed-delivery path: a completed-but-unseen session whose native
    // tail finalized AFTER the 8s window (common for multi-turn MAGI
    // coordinators — the native-history tail lags the last PTY echo). Keep it
    // hot until its finalized [.,assistant] tail has been flushed once, so the
    // corrective snapshot always reaches the browser even minutes later.
    const completedUnseen = unread || inboxBucket === 'task_complete';
    if (deliveredCompletionTailAt && completedUnseen) {
      const delivered = deliveredCompletionTailAt.get(sessionId) ?? 0;
      // Not yet delivered for this turn (no record, or a newer tail arrived
      // since the last delivery). lastMessageAt===0 (unknown ts) still counts
      // as undelivered so the tail is not silently dropped.
      const alreadyDelivered = delivered > 0 && lastMessageAt > 0 && delivered >= lastMessageAt;
      if (!alreadyDelivered) {
        active.add(sessionId);
        guaranteedDelivery.add(sessionId);
      }
    }
  }

  const finalizing = new Set(
    Array.from(previousHotSessionIds).filter((sessionId) => !active.has(sessionId) && !excluded.has(sessionId)),
  );

  return { active, finalizing, guaranteedDelivery };
}

/**
 * Detect sessions that just transitioned from an active/generating state into
 * a settled/completed-but-unseen state, so their finalized completion tail can
 * be flushed exactly once regardless of the recency window. Pure: the caller
 * owns the `previousStatus` map and updates it from the returned `nextStatus`.
 */
export function detectNewlySettledCompletedSessions(
  sessions: HotChatSessionLike[],
  previousStatus: ReadonlyMap<string, string>,
  options: { activeStatuses?: ReadonlySet<string> } = {},
): { settled: Set<string>; nextStatus: Map<string, string> } {
  const activeStatuses = options.activeStatuses ?? DEFAULT_ACTIVE_CHAT_POLL_STATUSES;
  const settled = new Set<string>();
  const nextStatus = new Map<string, string>();

  for (const session of sessions) {
    const sessionId = typeof session?.id === 'string' ? session.id : '';
    if (!sessionId) continue;
    const status = String(session?.status || '').toLowerCase();
    const prevStatus = previousStatus.get(sessionId);
    nextStatus.set(sessionId, status);

    const wasActive = prevStatus !== undefined && activeStatuses.has(prevStatus);
    const isSettledNow = !activeStatuses.has(status);
    const inboxBucket = String(session?.inboxBucket || '').toLowerCase();
    const completedUnseen = session?.unread === true || inboxBucket === 'task_complete';
    if (wasActive && isSettledNow && completedUnseen) {
      settled.add(sessionId);
    }
  }

  return { settled, nextStatus };
}