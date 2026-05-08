export const RAPID_READ_CHAT_ADVISORY_WINDOW_MS = 5_000;

const ACTIVE_READ_STATUSES = new Set([
  'generating',
  'running',
  'streaming',
  'starting',
  'busy',
]);

type RecentRead = {
  at: number;
  status?: string;
};

export type RapidReadChatAdvisory = {
  type: 'rapid_read_chat_polling';
  toolName: string;
  windowMs: number;
  elapsedMs: number;
  nextSuggestedReadAt: number;
  completionCallbackExpected: boolean;
  message: string;
};

const recentReads = new Map<string, RecentRead>();

export function clearRapidReadChatAdvisoryStateForTests(): void {
  recentReads.clear();
}

export function isActiveReadChatStatus(status: unknown): boolean {
  return typeof status === 'string' && ACTIVE_READ_STATUSES.has(status.toLowerCase());
}

export function annotateRapidReadChatAdvisory<T extends Record<string, any>>(
  payload: T,
  options: {
    key: string;
    now?: number;
    status?: unknown;
    toolName: 'read_chat' | 'mesh_read_chat' | string;
    completionCallbackExpected?: boolean;
  },
): T & { pollingAdvisory?: RapidReadChatAdvisory } {
  const now = options.now ?? Date.now();
  const status = options.status ?? payload?.status ?? payload?.data?.status ?? payload?.result?.status;
  const active = isActiveReadChatStatus(status);
  const previous = recentReads.get(options.key);

  if (!active) {
    recentReads.set(options.key, { at: now, status: typeof status === 'string' ? status : undefined });
    return payload;
  }

  recentReads.set(options.key, { at: now, status: typeof status === 'string' ? status : undefined });

  if (!previous || !isActiveReadChatStatus(previous.status)) return payload;
  const elapsedMs = now - previous.at;
  if (elapsedMs < 0 || elapsedMs >= RAPID_READ_CHAT_ADVISORY_WINDOW_MS) return payload;

  return {
    ...payload,
    pollingAdvisory: {
      type: 'rapid_read_chat_polling',
      toolName: options.toolName,
      windowMs: RAPID_READ_CHAT_ADVISORY_WINDOW_MS,
      elapsedMs,
      nextSuggestedReadAt: previous.at + RAPID_READ_CHAT_ADVISORY_WINDOW_MS,
      completionCallbackExpected: Boolean(options.completionCallbackExpected),
      message: `This session is still ${String(status)}. Avoid repeated ${options.toolName} polling for the same generating session; wait for the completion callback/status event or retry after the suggested time if you are debugging a real stall.`,
    },
  };
}
