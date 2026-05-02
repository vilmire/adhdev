import type { LocalTransport } from '../transports/local.js';
import type { CloudTransport } from '../transports/cloud.js';

export const READ_CHAT_TOOL = {
  name: 'read_chat',
  description: 'Read the current chat conversation from an IDE agent session. Returns recent messages.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      session_id: {
        type: 'string',
        description: 'Target session ID (from list_sessions). Omit to use the active session.',
      },
      limit: {
        type: 'number',
        description: 'Max messages to return (default: 50).',
      },
      daemon_id: {
        type: 'string',
        description: 'Daemon ID (cloud mode only). Omit for local mode.',
      },
    },
    required: [],
  },
};

export async function readChat(
  transport: LocalTransport | CloudTransport,
  args: { session_id?: string; limit?: number; daemon_id?: string },
): Promise<string> {
  const limit = args.limit ?? 50;

  if ('command' in transport) {
    // LocalTransport
    const result = await (transport as LocalTransport).command('read_chat', {
      ...(args.session_id ? { targetSessionId: args.session_id } : {}),
      limit,
    });
    return formatChatResult(result);
  }

  // CloudTransport
  if (!args.daemon_id) throw new Error('daemon_id is required in cloud mode');
  const targetId = args.session_id ? `${args.daemon_id}:session:${args.session_id}` : args.daemon_id;
  const result = await (transport as CloudTransport).readChat(targetId, { limit, sessionId: args.session_id });
  return formatChatResult(result);
}

function formatChatResult(result: any): string {
  if (!result?.success && result?.error) return `Error: ${result.error}`;

  const messages: any[] = result?.messages ?? result?.data?.messages ?? [];
  if (messages.length === 0) return 'No messages in chat.';

  const lines = messages.slice(-50).map((m: any) => {
    const role = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Agent' : m.role;
    const content = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map((p: any) => (typeof p === 'string' ? p : p?.text ?? '')).join('')
        : '';
    const truncated = content.length > 500 ? `${content.slice(0, 500)}…` : content;
    return `[${role}] ${truncated}`;
  });

  return lines.join('\n\n');
}
