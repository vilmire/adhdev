export const DEFAULT_ACTIVE_CHAT_POLL_STATUSES = new Set([
  'generating',
  'waiting_approval',
  'starting',
]);

export const DEFAULT_CHAT_TAIL_RECENT_MESSAGE_GRACE_MS = 8_000;

export interface HotChatSessionLike {
  id?: string | null;
  status?: unknown;
  lastMessageAt?: unknown;
}

function parseMessageTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export function classifyHotChatSessionsForSubscriptionFlush(
  sessions: HotChatSessionLike[],
  previousHotSessionIds: ReadonlySet<string>,
  options: {
    now?: number;
    recentMessageGraceMs?: number;
    activeStatuses?: ReadonlySet<string>;
  } = {},
): { active: Set<string>; finalizing: Set<string> } {
  const now = options.now ?? Date.now();
  const recentMessageGraceMs = Math.max(
    0,
    Number.isFinite(options.recentMessageGraceMs)
      ? Number(options.recentMessageGraceMs)
      : DEFAULT_CHAT_TAIL_RECENT_MESSAGE_GRACE_MS,
  );
  const activeStatuses = options.activeStatuses ?? DEFAULT_ACTIVE_CHAT_POLL_STATUSES;
  const active = new Set<string>();

  for (const session of sessions) {
    const sessionId = typeof session?.id === 'string' ? session.id : '';
    if (!sessionId) continue;

    const status = String(session?.status || '').toLowerCase();
    const lastMessageAt = parseMessageTimestamp(session?.lastMessageAt);
    const recentlyUpdated = lastMessageAt > 0 && (now - lastMessageAt) <= recentMessageGraceMs;

    if (activeStatuses.has(status) || recentlyUpdated) {
      active.add(sessionId);
    }
  }

  const finalizing = new Set(
    Array.from(previousHotSessionIds).filter((sessionId) => !active.has(sessionId)),
  );

  return { active, finalizing };
}