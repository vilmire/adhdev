import { SEND_POLICY_MODES, isSendPolicyMode, mintMessageId, type SendPolicy } from '@adhdev/mesh-shared';
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
      message_id: {
        type: 'string',
        description: 'Stable id for this message. Re-sending with the same id is delivered once (the daemon deduplicates by it). Omit to have one minted.',
      },
      delivery_mode: {
        type: 'string',
        enum: [...SEND_POLICY_MODES],
        description: "How to deliver to a busy session: 'queue' (default — after the running turn), 'send_now' (into the agent's own input queue now, where the provider supports it) or 'interrupt' (stop the running turn, then deliver).",
      },
    },
    required: ['message'],
  },
};

export async function sendChat(
  transport: CommandTransport,
  args: { message: string; session_id?: string; message_id?: string; delivery_mode?: string },
): Promise<string> {
  if (!args.message?.trim()) throw new Error('message is required');
  if (args.delivery_mode !== undefined && !isSendPolicyMode(args.delivery_mode)) {
    return `Error: unknown delivery_mode '${args.delivery_mode}' (expected one of ${SEND_POLICY_MODES.join(', ')})`;
  }
  const policy: SendPolicy = { mode: isSendPolicyMode(args.delivery_mode) ? args.delivery_mode : 'queue' };
  // D2 (applied in C-W8): the daemon's one send funnel dedupes on messageId and
  // admits per policy; `origin: 'mcp'` labels this caller.
  const messageId = typeof args.message_id === 'string' && args.message_id.trim() ? args.message_id.trim() : mintMessageId();
  const result = await transport.command('send_chat', {
    message: args.message,
    ...(args.session_id ? { targetSessionId: args.session_id } : {}),
    messageId,
    policy,
    origin: 'mcp',
  });
  if (result?.success === false) return `Error: ${result.error ?? 'send_chat failed'}`;
  return 'Message sent.';
}
