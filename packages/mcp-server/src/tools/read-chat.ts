import type { McpTransport } from '../transports/mode.js';
import { isLocalTransport } from '../transports/mode.js';
import { compactChatPayload, messageContent } from './chat-compact.js';
import { annotateRapidReadChatAdvisory, type RapidReadChatAdvisory } from './read-chat-polling-advisory.js';
import { FORMAT_PROP } from './list-sessions.js';

export const READ_CHAT_TOOL = {
  name: 'read_chat',
  description: 'Read the current chat conversation from an IDE agent session. Returns recent messages.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      session_id: {
        type: 'string',
        description: 'Target session ID (from list_sessions). Pass explicitly in local mode when more than one session exists; omitting requires an active target and may fail.',
      },
      limit: {
        type: 'number',
        description: 'Max messages to return (default: 50).',
      },
      daemon_id: {
        type: 'string',
        description: 'Daemon ID (cloud mode only). Omit for local mode.',
      },
      compact: {
        type: 'boolean',
        description: 'Opt-in compact mode: filters tool/terminal/system/internal/control/debug/status chatter and returns user-visible messages plus lightweight summary metadata.',
      },
      ...FORMAT_PROP,
    },
    required: [],
  },
};

export async function readChat(
  transport: McpTransport,
  args: { session_id?: string; limit?: number; daemon_id?: string; format?: 'text' | 'json'; compact?: boolean },
): Promise<string> {
  const limit = args.limit ?? 50;

  if (isLocalTransport(transport)) {
    const result = await transport.command('read_chat', {
      ...(args.session_id ? { targetSessionId: args.session_id } : {}),
      tailLimit: limit,
    });
    const annotated = annotateRapidReadChatAdvisory(result as Record<string, any>, {
      key: `local:${args.session_id ?? '__active__'}`,
      toolName: 'read_chat',
      completionCallbackExpected: false,
    });
    return formatChatResult(annotated, args.session_id, args.format, limit, args.compact);
  }

  if (!args.daemon_id) throw new Error('daemon_id is required in cloud mode');
  const targetId = args.session_id ? `${args.daemon_id}:session:${args.session_id}` : args.daemon_id;
  const result = await transport.readChat(targetId, { limit, sessionId: args.session_id });
  const annotated = annotateRapidReadChatAdvisory(result as Record<string, any>, {
    key: `cloud:${args.daemon_id}:${args.session_id ?? '__active__'}`,
    toolName: 'read_chat',
    completionCallbackExpected: false,
  });
  return formatChatResult(annotated, args.session_id, args.format, limit, args.compact);
}

function formatChatResult(result: any, sessionId?: string, format?: 'text' | 'json', limit = 50, compact = false): string {
  if (!result?.success && result?.error) {
    if (format === 'json') return JSON.stringify({ error: result.error, messages: [] }, null, 2);
    return `Error: ${result.error}`;
  }

  const messages: any[] = result?.messages ?? result?.data?.messages ?? [];
  const source = { ...result, messages };
  const compactPayload = compact ? compactChatPayload(source, { sessionId: sessionId ?? null, limit }) : null;
  const outputMessages = compact ? compactPayload.messages : messages;

  if (format === 'json') {
    if (compact && compactPayload) {
      return JSON.stringify({
        session_id: sessionId ?? null,
        ...compactPayload,
        ...(result?.pollingAdvisory ? { pollingAdvisory: result.pollingAdvisory as RapidReadChatAdvisory } : {}),
        messages: compactPayload.messages.map((m: any) => ({
          role: m.role,
          kind: m.kind ?? null,
          content: messageContent(m),
          timestamp: m.timestamp ?? null,
        })),
      }, null, 2);
    }
    return JSON.stringify({
      session_id: sessionId ?? null,
      ...(result?.pollingAdvisory ? { pollingAdvisory: result.pollingAdvisory as RapidReadChatAdvisory } : {}),
      messages: outputMessages.slice(-limit).map((m: any) => ({
        role: m.role,
        kind: m.kind ?? null,
        content: messageContent(m),
        timestamp: m.timestamp ?? null,
      })),
    }, null, 2);
  }

  if (outputMessages.length === 0) {
    return result?.pollingAdvisory
      ? `No messages in chat.\n\nAdvisory: ${(result.pollingAdvisory as RapidReadChatAdvisory).message}`
      : 'No messages in chat.';
  }
  const lines = outputMessages.slice(-limit).map((m: any) => {
    const role = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Agent' : m.role;
    const content = messageContent(m);
    const truncated = content.length > 500 ? `${content.slice(0, 500)}…` : content;
    return `[${role}] ${truncated}`;
  });
  if (result?.pollingAdvisory) {
    lines.push(`Advisory: ${(result.pollingAdvisory as RapidReadChatAdvisory).message}`);
  }
  return lines.join('\n\n');
}
