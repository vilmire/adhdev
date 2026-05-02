import type { LocalTransport } from '../transports/local.js';
import type { CloudTransport } from '../transports/cloud.js';

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
      daemon_id: {
        type: 'string',
        description: 'Daemon ID (cloud mode only).',
      },
    },
    required: ['action'],
  },
};

export async function approve(
  transport: LocalTransport | CloudTransport,
  args: { action: 'approve' | 'reject'; session_id?: string; daemon_id?: string },
): Promise<string> {
  const action = args.action === 'reject' ? 'reject' : 'approve';

  if ('command' in transport) {
    // LocalTransport
    const result = await (transport as LocalTransport).command('resolve_action', {
      action,
      ...(args.session_id ? { targetSessionId: args.session_id } : {}),
    });
    if (result?.success === false) return `Error: ${result.error ?? 'resolve_action failed'}`;
    return `Action ${action}d.`;
  }

  // CloudTransport
  if (!args.daemon_id) throw new Error('daemon_id is required in cloud mode');
  const targetId = args.session_id ? `${args.daemon_id}:session:${args.session_id}` : args.daemon_id;
  const result = await (transport as CloudTransport).approve(targetId, action);
  if (result?.success === false) return `Error: ${result.error ?? 'approve failed'}`;
  return `Action ${action}d.`;
}
