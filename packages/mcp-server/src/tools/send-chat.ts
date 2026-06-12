import type { CommandTransport } from '../transports/mode.js';

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
    },
    required: ['message'],
  },
};

export async function sendChat(
  transport: CommandTransport,
  args: { message: string; session_id?: string },
): Promise<string> {
  if (!args.message?.trim()) throw new Error('message is required');

  const result = await transport.command('send_chat', {
    message: args.message,
    ...(args.session_id ? { targetSessionId: args.session_id } : {}),
  });
  if (result?.success === false) return `Error: ${result.error ?? 'send_chat failed'}`;
  return 'Message sent.';
}
