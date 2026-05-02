import type { LocalTransport } from '../transports/local.js';
import type { CloudTransport } from '../transports/cloud.js';

export const LIST_SESSIONS_TOOL = {
  name: 'list_sessions',
  description: 'List all currently connected IDE and CLI agent sessions on the local machine.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
    required: [],
  },
};

export async function listSessions(transport: LocalTransport | CloudTransport): Promise<string> {
  if ('getStatus' in transport) {
    // LocalTransport
    const status = await (transport as LocalTransport).getStatus();
    const sessions: any[] = status?.sessions ?? [];
    if (sessions.length === 0) return 'No active sessions.';

    const lines = sessions.map((s: any) => {
      const parts = [
        `id: ${s.id}`,
        `type: ${s.providerType ?? s.type ?? 'unknown'}`,
      ];
      if (s.label) parts.push(`label: ${s.label}`);
      if (s.agentStatus) parts.push(`status: ${s.agentStatus}`);
      if (s.workspace) parts.push(`workspace: ${s.workspace}`);
      return parts.join(', ');
    });
    return `Sessions (${sessions.length}):\n${lines.join('\n')}`;
  }

  // CloudTransport
  const data = await (transport as CloudTransport).listDaemons();
  const daemons: any[] = data?.daemons ?? data ?? [];
  if (daemons.length === 0) return 'No connected daemons.';

  const lines: string[] = [];
  for (const d of daemons) {
    const sessions: any[] = d.sessions ?? [];
    for (const s of sessions) {
      lines.push(
        `daemon: ${d.id}, session: ${s.id}, type: ${s.providerType ?? 'unknown'}${s.agentStatus ? `, status: ${s.agentStatus}` : ''}`,
      );
    }
    if (sessions.length === 0) {
      lines.push(`daemon: ${d.id} (no sessions)`);
    }
  }
  return lines.length > 0 ? `Sessions:\n${lines.join('\n')}` : 'No active sessions.';
}
