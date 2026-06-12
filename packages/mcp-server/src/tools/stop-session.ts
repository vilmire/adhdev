import type { CommandTransport } from '../transports/mode.js';

export const STOP_SESSION_TOOL = {
  name: 'stop_session',
  description:
    'Stop a running agent session. For CLI agents (hermes-cli, claude-cli, etc.) this sends a graceful stop signal. ' +
    'Use list_sessions to find the session_id.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      session_id: {
        type: 'string',
        description: 'Session ID to stop (from list_sessions).',
      },
      type: {
        type: 'string',
        description:
          'Provider type (e.g. hermes-cli, claude-cli). Auto-resolved from session_id if omitted.',
      },
    },
    required: ['session_id'],
  },
};

export async function stopSession(
  transport: CommandTransport,
  args: { session_id: string; type?: string },
): Promise<string> {
  let resolvedType = args.type;

  // Auto-resolve type from session status if not provided
  if (!resolvedType) {
    const status = await transport.getStatus();
    const session = (status?.sessions ?? []).find((s: any) => s.id === args.session_id);
    resolvedType = session?.providerType ?? session?.type;
  }

  if (!resolvedType) {
    return `Error: could not resolve session type for ${args.session_id}. Pass type= explicitly.`;
  }

  const result = await transport.command('stop_cli', {
    targetSessionId: args.session_id,
    cliType: resolvedType,
  });
  if (result?.success === false) return `Error: ${result.error ?? 'stop failed'}`;
  return `Session ${args.session_id} stopped.`;
}
