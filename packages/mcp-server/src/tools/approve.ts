import type { CommandTransport } from '../transports/mode.js';

export const APPROVE_TOOL = {
  name: 'approve',
  description: 'Approve or reject a pending agent action (e.g. file write, command execution).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['approve', 'reject'],
        description: 'Whether to approve or reject the pending action.',
      },
      session_id: {
        type: 'string',
        description: 'Target session ID. Omit to use the active session.',
      },
    },
    required: ['action'],
  },
};

export async function approve(
  transport: CommandTransport,
  args: { action: 'approve' | 'reject'; session_id?: string },
): Promise<string> {
  const action = args.action === 'reject' ? 'reject' : 'approve';

  const result = await transport.command('resolve_action', {
    action,
    ...(args.session_id ? { targetSessionId: args.session_id } : {}),
  });
  if (result?.success === false) return `Error: ${result.error ?? 'resolve_action failed'}`;
  return `Action ${action}d.`;
}
