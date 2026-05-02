import type { LocalTransport } from '../transports/local.js';
import type { CloudTransport } from '../transports/cloud.js';
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
      daemon_id: {
        type: 'string',
        description: 'Daemon ID to check (cloud mode). Omit to check all daemons.',
      },
      ...FORMAT_PROP,
    },
    required: [],
  },
};

export async function checkPending(
  transport: LocalTransport | CloudTransport,
  args: { daemon_id?: string; format?: 'text' | 'json' },
): Promise<string> {
  if ('getStatus' in transport) {
    return checkPendingLocal(transport as LocalTransport, args.format);
  }
  return checkPendingCloud(transport as CloudTransport, args.daemon_id, args.format);
}

async function checkPendingLocal(
  transport: LocalTransport,
  format?: 'text' | 'json',
): Promise<string> {
  const status = await transport.getStatus();
  const sessions: any[] = status?.sessions ?? [];

  const pending = sessions.filter(
    (s) => s.status === 'waiting_approval' || s.agentStatus === 'waiting_approval',
  );

  if (format === 'json') {
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

async function checkPendingCloud(
  transport: CloudTransport,
  daemonId?: string,
  format?: 'text' | 'json',
): Promise<string> {
  const pending: Array<{ daemonId: string; session: any }> = [];

  if (daemonId) {
    const daemonStatus = await transport.getDaemonStatus(daemonId);
    const sessions: any[] = daemonStatus?.sessions ?? [];
    for (const s of sessions) {
      if (s.status === 'waiting_approval') pending.push({ daemonId, session: s });
    }
  } else {
    const data = await transport.listDaemons();
    const daemons: any[] = data?.daemons ?? [];
    await Promise.allSettled(
      daemons.map(async (d) => {
        try {
          const daemonStatus = await transport.getDaemonStatus(d.id);
          const sessions: any[] = daemonStatus?.sessions ?? [];
          for (const s of sessions) {
            if (s.status === 'waiting_approval') pending.push({ daemonId: d.id, session: s });
          }
        } catch {
          // skip unreachable daemons
        }
      }),
    );
  }

  if (format === 'json') {
    return JSON.stringify({
      pending: pending.map(({ daemonId: dId, session: s }) => ({
        daemon_id: dId,
        session_id: s.id,
        workspace: s.workspace ?? null,
        type: s.providerType ?? null,
        modal_message: null,
        buttons: [],
      })),
    }, null, 2);
  }

  if (pending.length === 0) return 'No sessions waiting for approval.';
  const lines = pending.map(({ daemonId: dId, session: s }) => {
    const parts = [`daemon_id: ${dId}`, `session_id: ${s.id}`];
    if (s.workspace) parts.push(`workspace: ${s.workspace}`);
    if (s.providerType) parts.push(`type: ${s.providerType}`);
    parts.push('(use read_chat to see the approval prompt)');
    return parts.join('\n  ');
  });
  return `Pending approvals (${pending.length}):\n\n${lines.join('\n\n')}`;
}
