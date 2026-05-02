import type { LocalTransport } from '../transports/local.js';
import type { CloudTransport } from '../transports/cloud.js';
import { FORMAT_PROP } from './list-sessions.js';

export const LIST_DAEMONS_TOOL = {
  name: 'list_daemons',
  description:
    'List all connected daemons (machines running the ADHDev agent). ' +
    'Use this to discover daemon IDs before calling launch_session, git_status, or other tools that require daemon_id. ' +
    'In local mode returns the single standalone daemon info.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      ...FORMAT_PROP,
    },
    required: [],
  },
};

export async function listDaemons(
  transport: LocalTransport | CloudTransport,
  args: { format?: 'text' | 'json' } = {},
): Promise<string> {
  const asJson = args.format === 'json';

  if ('getStatus' in transport) {
    // Local: single standalone daemon — extract identity from status
    const status = await (transport as LocalTransport).getStatus();
    const daemon = {
      id: status?.id ?? status?.instanceId ?? 'standalone',
      hostname: status?.hostname ?? status?.machine?.hostname ?? 'localhost',
      platform: status?.platform ?? status?.machine?.platform ?? 'unknown',
      version: status?.version ?? null,
      sessions: (status?.sessions ?? []).length,
    };
    if (asJson) return JSON.stringify({ daemons: [daemon] }, null, 2);
    return `Daemons (1):\n  id: ${daemon.id}, hostname: ${daemon.hostname}, platform: ${daemon.platform}${daemon.version ? `, version: ${daemon.version}` : ''}, sessions: ${daemon.sessions}`;
  }

  // Cloud: full daemon list from UserSessionDO
  const data = await (transport as CloudTransport).listDaemons();
  const daemons: any[] = data?.daemons ?? [];

  if (asJson) {
    return JSON.stringify({
      daemons: daemons.map((d) => ({
        id: d.id,
        hostname: d.hostname ?? null,
        platform: d.platform ?? null,
        nickname: d.nickname ?? null,
        version: d.version ?? null,
        p2p_available: d.p2p?.available ?? null,
        cdp_connected: d.cdpConnected ?? null,
      })),
    }, null, 2);
  }

  if (daemons.length === 0) return 'No connected daemons.';
  const lines = daemons.map((d) => {
    const parts = [`id: ${d.id}`];
    if (d.nickname) parts.push(`nickname: ${d.nickname}`);
    if (d.hostname) parts.push(`hostname: ${d.hostname}`);
    if (d.platform) parts.push(`platform: ${d.platform}`);
    if (d.version) parts.push(`version: ${d.version}`);
    if (d.p2p?.available != null) parts.push(`p2p: ${d.p2p.available ? 'yes' : 'no'}`);
    return parts.join(', ');
  });
  return `Daemons (${daemons.length}):\n${lines.join('\n')}`;
}
