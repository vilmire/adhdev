import type { McpTransport } from '../transports/mode.js';
import type { CloudTransport } from '../transports/cloud.js';
import { isLocalTransport } from '../transports/mode.js';

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
      daemon_id: {
        type: 'string',
        description: 'Daemon ID (cloud mode only, required).',
      },
      type: {
        type: 'string',
        description:
          'Provider type (e.g. hermes-cli, claude-cli). Local mode auto-resolves from session_id if omitted; cloud mode forwards the session_id and omits type unless explicitly provided.',
      },
    },
    required: ['session_id'],
  },
};

export async function stopSession(
  transport: McpTransport,
  args: { session_id: string; daemon_id?: string; type?: string },
): Promise<string> {
  if (isLocalTransport(transport)) {
    const local = transport;
    let resolvedType = args.type;

    // Auto-resolve type from session status if not provided
    if (!resolvedType) {
      const status = await local.getStatus();
      const session = (status?.sessions ?? []).find((s: any) => s.id === args.session_id);
      resolvedType = session?.providerType ?? session?.type;
    }

    if (!resolvedType) {
      return `Error: could not resolve session type for ${args.session_id}. Pass type= explicitly.`;
    }

    const result = await local.command('stop_cli', {
      targetSessionId: args.session_id,
      cliType: resolvedType,
    });
    if (result?.success === false) return `Error: ${result.error ?? 'stop failed'}`;
    return `Session ${args.session_id} stopped.`;
  }

  // CloudTransport
  if (!args.daemon_id) throw new Error('daemon_id is required in cloud mode');
  const result = await transport.stop(args.daemon_id, {
    id: args.session_id,
    ...(args.type ? { type: args.type } : {}),
  });
  if (result?.success === false || result?.error) return `Error: ${result.error ?? 'stop failed'}`;
  return `Session ${args.session_id} stopped.`;
}
