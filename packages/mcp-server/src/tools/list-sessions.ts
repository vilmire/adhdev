import type { CommandTransport } from '../transports/mode.js';

export const FORMAT_PROP = {
  format: {
    type: 'string' as const,
    enum: ['text', 'json'],
    description: "Output format: 'text' (default, human-readable) or 'json' (structured, for programmatic use).",
  },
};

export const LIST_SESSIONS_TOOL = {
  name: 'list_sessions',
  description: 'List all connected agent sessions.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      ...FORMAT_PROP,
    },
    required: [],
  },
};

export async function listSessions(
  transport: CommandTransport,
  args: { format?: 'text' | 'json' } = {},
): Promise<string> {
  const asJson = args.format === 'json';

  // Single daemon, status endpoint has full SessionEntry[]
  const status = await transport.getStatus();
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
