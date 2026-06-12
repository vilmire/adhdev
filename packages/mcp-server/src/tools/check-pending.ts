import type { CommandTransport } from '../transports/mode.js';
import { FORMAT_PROP } from './list-sessions.js';

export const CHECK_PENDING_TOOL = {
  name: 'check_pending',
  description:
    'List all agent sessions currently waiting for user approval (tool-use confirmation). ' +
    'Returns session ID, daemon ID, workspace, and the approval prompt message when available. ' +
    'Use approve() with the session_id to approve or reject.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      ...FORMAT_PROP,
    },
    required: [],
  },
};

export async function checkPending(
  transport: CommandTransport,
  args: { format?: 'text' | 'json' },
): Promise<string> {
  const status = await transport.getStatus();
  const sessions: any[] = status?.sessions ?? [];

  const pending = sessions.filter(
    (s) => s.status === 'waiting_approval' || s.agentStatus === 'waiting_approval',
  );

  if (args.format === 'json') {
    return JSON.stringify({
      pending: pending.map((s) => ({
        session_id: s.id,
        workspace: s.workspace ?? null,
        type: s.providerType ?? null,
        modal_message: s.activeChat?.activeModal?.message ?? null,
        buttons: s.activeChat?.activeModal?.buttons ?? [],
      })),
    }, null, 2);
  }

  if (pending.length === 0) return 'No sessions waiting for approval.';
  const lines = pending.map((s) => {
    const modal = s.activeChat?.activeModal;
    const parts = [`session_id: ${s.id}`];
    if (s.workspace) parts.push(`workspace: ${s.workspace}`);
    if (s.providerType) parts.push(`type: ${s.providerType}`);
    if (modal?.message) parts.push(`prompt: ${modal.message}`);
    if (modal?.buttons?.length) parts.push(`buttons: ${modal.buttons.join(', ')}`);
    return parts.join('\n  ');
  });
  return `Pending approvals (${pending.length}):\n\n${lines.join('\n\n')}`;
}
