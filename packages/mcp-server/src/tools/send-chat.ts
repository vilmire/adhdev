import type { LocalTransport } from '../transports/local.js';
import type { CloudTransport } from '../transports/cloud.js';
import { isLocalTransport } from '../transports/mode.js';

export const SEND_CHAT_TOOL = {
  name: 'send_chat',
  description: 'Send a message to an IDE agent session.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      message: {
        type: 'string',
        description: 'The message to send to the agent.',
      },
      session_id: {
        type: 'string',
        description: 'Target session ID (from list_sessions). Omit to use the active session.',
      },
      daemon_id: {
        type: 'string',
        description: 'Daemon ID (cloud mode only). Omit for local mode.',
      },
    },
    required: ['message'],
  },
};

export async function sendChat(
  transport: LocalTransport | CloudTransport,
  args: { message: string; session_id?: string; daemon_id?: string },
): Promise<string> {
  if (!args.message?.trim()) throw new Error('message is required');

  if (isLocalTransport(transport)) {
    // LocalTransport
    const result = await transport.command('send_chat', {
      message: args.message,
      ...(args.session_id ? { targetSessionId: args.session_id } : {}),
    });
    if (result?.success === false) return `Error: ${result.error ?? 'send_chat failed'}`;
    return 'Message sent.';
  }

  // CloudTransport
  if (!args.daemon_id) throw new Error('daemon_id is required in cloud mode');
  const targetId = args.session_id ? `${args.daemon_id}:session:${args.session_id}` : args.daemon_id;
  const result = await transport.sendChat(targetId, args.message, {
    ...(args.session_id ? { sessionId: args.session_id } : {}),
  });
  if (result?.success === false) return `Error: ${result.error ?? 'send_chat failed'}`;
  return 'Message sent.';
}
