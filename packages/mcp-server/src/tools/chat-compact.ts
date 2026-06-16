export type CompactChatMessage = Record<string, any>;

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

/**
 * Build a one-line summary string for a tool/bash message that was filtered out.
 * Returns null when no useful summary can be extracted.
 */
export function summarizeToolMessage(message: any): string | null {
  if (!message || typeof message !== 'object') return null;
  const kind = String(message.kind ?? message.type ?? message.messageKind ?? '').toLowerCase();
  const role = String(message.role ?? '').toLowerCase();

  // Bash / terminal execution
  if (kind === 'terminal' || kind === 'bash') {
    const cmd = message.command ?? message.cmd ?? message.input ?? messageContent(message);
    const exit = message.exitCode ?? message.exit_code ?? message.code;
    const cmdShort = typeof cmd === 'string' ? cmd.split('\n')[0].slice(0, 120) : null;
    if (!cmdShort) return null;
    return exit !== undefined && exit !== null ? `[Bash] ${cmdShort} → exit ${exit}` : `[Bash] ${cmdShort}`;
  }

  // Tool call (Claude-style function call)
  if (kind === 'tool_call' || kind === 'tool' || role === 'tool') {
    const name = message.name ?? message.toolName ?? message.tool_name ?? message.function?.name;
    if (typeof name === 'string' && name.trim()) return `[Tool] ${name.trim()}`;
    return null;
  }

  // Tool result with explicit exit code
  if (kind === 'tool_result') {
    const exit = message.exitCode ?? message.exit_code ?? message.code;
    const name = message.name ?? message.toolName ?? message.tool_name;
    const label = typeof name === 'string' && name.trim() ? name.trim() : 'tool';
    return exit !== undefined && exit !== null ? `[Tool result: ${label}] exit ${exit}` : null;
  }

  return null;
}

export function buildCompactMessageTail(
  visibleMessages: CompactChatMessage[],
  opts: { summary?: string; finalAssistant?: CompactChatMessage | undefined; limit: number },
): CompactChatMessage[] {
  const tail = visibleMessages.slice(-opts.limit);
  // Always include the final assistant message even if it falls outside the tail window.
  if (opts.finalAssistant && !tail.includes(opts.finalAssistant)) {
    return [opts.finalAssistant, ...tail];
  }
  return tail;
}

/**
 * Normalize message text for an equality check between the compact `summary`
 * field and a message bubble's content. Trims and collapses interior whitespace
 * so trivially-different copies of the same report compare equal.
 */
function normalizeForSummaryEquality(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * When compact mode lifts the final assistant bubble into the `summary` field,
 * the same report text would otherwise be serialized a SECOND time inside the
 * returned `messages[]` tail — exactly doubling the payload for long reports.
 * This rewrites any tail bubble whose content is substantively identical to the
 * summary into a content-free stub carrying `_sameAsSummary: true`, so the body
 * lives exactly once (in `summary`). Bubble position/role/timestamp are preserved
 * for callers that walk the tail; the body is recoverable from `summary`.
 */
export function dedupeSummaryFromTail(
  messages: CompactChatMessage[],
  summary: string | undefined,
): CompactChatMessage[] {
  const normalizedSummary = summary ? normalizeForSummaryEquality(summary) : '';
  if (!normalizedSummary) return messages;
  return messages.map((message) => {
    const role = String(message?.role ?? '').toLowerCase();
    if (role !== 'assistant' && role !== 'agent') return message;
    const content = messageContent(message);
    if (!content.trim()) return message;
    if (normalizeForSummaryEquality(content) !== normalizedSummary) return message;
    const { content: _omitted, ...rest } = message;
    return { ...rest, content: '', _sameAsSummary: true };
  });
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
  // The final assistant bubble is now lifted into `summary`; strip its duplicate
  // body from the tail so a long report isn't serialized twice (leak #1).
  const messages = dedupeSummaryFromTail(
    buildCompactMessageTail(visible, { summary, finalAssistant, limit }),
    summary,
  );

  // Collect one-line summaries for filtered-out tool/bash messages so the coordinator
  // can see what actions were taken without reading the full transcript.
  const toolSummaries = rawMessages
    .filter((m: any) => !isCoordinatorVisibleMessage(m))
    .map(summarizeToolMessage)
    .filter((s: string | null): s is string => s !== null);

  // omittedMessages = total messages not included in the returned `messages` tail.
  // This includes both filtered (tool/system) messages AND visible messages cut off by the tail limit.
  const omittedMessages = Math.max(0, rawMessages.length - messages.length);
  // filteredMessages = only the non-user-visible messages (for backward compat).
  const filteredMessages = Math.max(0, rawMessages.length - visible.length);

  return {
    success: payload?.success !== false,
    compact: true,
    ...(opts.nodeId ? { nodeId: opts.nodeId } : {}),
    ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
    status: payload?.status ?? null,
    providerSessionId: payload?.providerSessionId ?? null,
    totalMessages: rawMessages.length,
    visibleMessages: visible.length,
    filteredMessages,
    omittedMessages,
    ...(toolSummaries.length > 0 ? { toolSummaries } : {}),
    summary,
    ...(payload?.changedFiles !== undefined ? { changedFiles: payload.changedFiles } : {}),
    ...(payload?.testsRun !== undefined ? { testsRun: payload.testsRun } : {}),
    messages,
  };
}
