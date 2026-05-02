import type { LocalTransport } from '../transports/local.js';
import type { CloudTransport } from '../transports/cloud.js';

export const FORMAT_PROP = {
  format: {
    type: 'string' as const,
    enum: ['text', 'json'],
    description: "Output format: 'text' (default, human-readable) or 'json' (structured, for programmatic use).",
  },
};

export const LIST_SESSIONS_TOOL = {
  name: 'list_sessions',
  description: 'List all currently connected IDE and CLI agent sessions on the local machine.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      ...FORMAT_PROP,
    },
    required: [],
  },
};

export async function listSessions(
  transport: LocalTransport | CloudTransport,
  args: { format?: 'text' | 'json' } = {},
): Promise<string> {
  const asJson = args.format === 'json';

  if ('getStatus' in transport) {
    const status = await (transport as LocalTransport).getStatus();
    const sessions: any[] = status?.sessions ?? [];

    if (asJson) {
      return JSON.stringify({
        sessions: sessions.map((s: any) => ({
          id: s.id,
          type: s.providerType ?? s.type ?? 'unknown',
          label: s.label ?? null,
          status: s.status ?? s.agentStatus ?? null,
          workspace: s.workspace ?? null,
        })),
      }, null, 2);
    }

    if (sessions.length === 0) return 'No active sessions.';
    const lines = sessions.map((s: any) => {
      const parts = [`id: ${s.id}`, `type: ${s.providerType ?? s.type ?? 'unknown'}`];
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

  if (asJson) {
    const sessions: any[] = [];
    for (const d of daemons) {
      for (const s of d.sessions ?? []) {
        sessions.push({
          daemon_id: d.id,
          id: s.id,
          type: s.providerType ?? 'unknown',
          status: s.status ?? s.agentStatus ?? null,
          workspace: s.workspace ?? null,
        });
      }
    }
    return JSON.stringify({ sessions }, null, 2);
  }

  if (daemons.length === 0) return 'No connected daemons.';
  const lines: string[] = [];
  for (const d of daemons) {
    const sessions: any[] = d.sessions ?? [];
    for (const s of sessions) {
      lines.push(
        `daemon: ${d.id}, session: ${s.id}, type: ${s.providerType ?? 'unknown'}${s.agentStatus ? `, status: ${s.agentStatus}` : ''}`,
      );
    }
    if (sessions.length === 0) lines.push(`daemon: ${d.id} (no sessions)`);
  }
  return lines.length > 0 ? `Sessions:\n${lines.join('\n')}` : 'No active sessions.';
}
