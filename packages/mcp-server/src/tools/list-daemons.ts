import type { CommandTransport } from '../transports/mode.js';
import { FORMAT_PROP } from './list-sessions.js';

export const LIST_DAEMONS_TOOL = {
  name: 'list_daemons',
  description:
    'List the connected daemon (machine running the ADHDev agent). ' +
    'Returns the daemon identity extracted from its status report.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      ...FORMAT_PROP,
    },
    required: [],
  },
};

export async function listDaemons(
  transport: CommandTransport,
  args: { format?: 'text' | 'json' } = {},
): Promise<string> {
  const asJson = args.format === 'json';

  // Single daemon — extract identity from status
  const status = await transport.getStatus();
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
