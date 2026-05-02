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
  description:
    'List all connected agent sessions. In cloud mode, fetches session state from each daemon ' +
    '(data is sourced from daemon WS status reports, up to 30s stale). ' +
    'Pass daemon_id to scope to a single daemon.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      daemon_id: {
        type: 'string',
        description: 'Daemon ID (cloud mode only). Omit to list sessions across all daemons.',
      },
      ...FORMAT_PROP,
    },
    required: [],
  },
};

export async function listSessions(
  transport: LocalTransport | CloudTransport,
  args: { daemon_id?: string; format?: 'text' | 'json' } = {},
): Promise<string> {
  const asJson = args.format === 'json';

  if ('getStatus' in transport) {
    // Local: single daemon, status endpoint has full SessionEntry[]
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
      if (s.status ?? s.agentStatus) parts.push(`status: ${s.status ?? s.agentStatus}`);
      if (s.workspace) parts.push(`workspace: ${s.workspace}`);
      return parts.join(', ');
    });
    return `Sessions (${sessions.length}):\n${lines.join('\n')}`;
  }

  // Cloud: UserSessionDO /list-daemons intentionally strips sessions[] (P2P architecture —
  // session data flows to dashboard via P2P DataChannel, not server WS).
  // MCP must fetch sessions directly from each DaemonConnectionDO's WS status cache.
  return listSessionsCloud(transport as CloudTransport, args.daemon_id, asJson);
}

async function listSessionsCloud(
  transport: CloudTransport,
  daemonId: string | undefined,
  asJson: boolean,
): Promise<string> {
  const collected: Array<{ daemonId: string; session: any }> = [];

  if (daemonId) {
    const daemonStatus = await transport.getDaemonStatus(daemonId);
    for (const s of daemonStatus?.sessions ?? []) {
      collected.push({ daemonId, session: s });
    }
  } else {
    const data = await transport.listDaemons();
    const daemons: any[] = data?.daemons ?? [];

    // Batch 5 at a time to avoid flooding the API
    for (let i = 0; i < daemons.length; i += 5) {
      await Promise.allSettled(
        daemons.slice(i, i + 5).map(async (d) => {
          try {
            const daemonStatus = await transport.getDaemonStatus(d.id);
            for (const s of daemonStatus?.sessions ?? []) {
              collected.push({ daemonId: d.id, session: s });
            }
          } catch {
            // skip unreachable daemons
          }
        }),
      );
    }
  }

  if (asJson) {
    return JSON.stringify({
      sessions: collected.map(({ daemonId: dId, session: s }) => ({
        daemon_id: dId,
        id: s.id,
        type: s.providerType ?? 'unknown',
        status: s.status ?? null,
        workspace: s.workspace ?? null,
      })),
    }, null, 2);
  }

  if (collected.length === 0) return 'No active sessions.';
  const lines = collected.map(({ daemonId: dId, session: s }) => {
    const parts = [
      `daemon: ${dId}`,
      `session: ${s.id}`,
      `type: ${s.providerType ?? 'unknown'}`,
    ];
    if (s.status) parts.push(`status: ${s.status}`);
    if (s.workspace) parts.push(`workspace: ${s.workspace}`);
    return parts.join(', ');
  });
  return `Sessions (${collected.length}):\n${lines.join('\n')}`;
}
