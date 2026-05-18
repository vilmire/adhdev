export type CompactChatMessage = Record<string, any>;

function isAssistantLike(message: any): boolean {
  const role = String(message?.role ?? '').toLowerCase();
  return role === 'assistant' || role === 'agent';
}

export function messageContent(message: any): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part: any) => (typeof part === 'string' ? part : part?.text ?? '')).join('');
  }
  return '';
}

export function isCoordinatorVisibleMessage(message: any): boolean {
  if (!message || typeof message !== 'object') return false;
  const role = String(message.role ?? '').toLowerCase();
  if (role === 'tool' || role === 'system' || role === 'debug') return false;
  const kind = String(message.kind ?? message.type ?? message.messageKind ?? '').toLowerCase();
  if (['tool', 'tool_call', 'tool_result', 'terminal', 'internal', 'control', 'debug', 'status'].includes(kind)) return false;
  const meta = message.meta ?? message.metadata;
  if (meta?.internal === true || meta?.debug === true || meta?.control === true || meta?.userVisible === false || meta?.user_visible === false) return false;
  return role === 'user' || role === 'assistant' || role === 'agent';
}

export function buildCompactMessageTail(
  visibleMessages: CompactChatMessage[],
  opts: { summary?: string; finalAssistant?: CompactChatMessage | undefined; limit: number },
): CompactChatMessage[] {
  const summary = typeof opts.summary === 'string' ? opts.summary.trim() : '';
  const shouldOmitSummaryMessage = !!summary
    && !!opts.finalAssistant
    && isAssistantLike(opts.finalAssistant)
    && messageContent(opts.finalAssistant).trim() === summary;
  const sourceMessages = shouldOmitSummaryMessage
    ? visibleMessages.filter((message) => message !== opts.finalAssistant)
    : visibleMessages;
  return sourceMessages.slice(-opts.limit);
}

export function compactChatPayload(
  payload: any,
  opts: { sessionId?: string | null; nodeId?: string; limit?: number } = {},
): any {
  const rawMessages = Array.isArray(payload?.messages) ? payload.messages : [];
  const visible = rawMessages.filter(isCoordinatorVisibleMessage);
  const limit = Math.max(1, Math.min(opts.limit ?? 10, 10));
  const finalAssistant = [...visible].reverse().find((message: any) => {
    const role = String(message?.role ?? '').toLowerCase();
    return (role === 'assistant' || role === 'agent') && messageContent(message).trim();
  });
  const summary = typeof payload?.summary === 'string' && payload.summary.trim()
    ? payload.summary.trim()
    : messageContent(finalAssistant).trim();
  const messages = buildCompactMessageTail(visible, { summary, finalAssistant, limit });

  return {
    success: payload?.success !== false,
    compact: true,
    ...(opts.nodeId ? { nodeId: opts.nodeId } : {}),
    ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
    status: payload?.status ?? null,
    providerSessionId: payload?.providerSessionId ?? null,
    totalMessages: rawMessages.length,
    visibleMessages: visible.length,
    filteredMessages: visible.length,
    omittedMessages: Math.max(0, rawMessages.length - visible.length),
    summary,
    ...(payload?.changedFiles !== undefined ? { changedFiles: payload.changedFiles } : {}),
    ...(payload?.testsRun !== undefined ? { testsRun: payload.testsRun } : {}),
    messages,
  };
}
