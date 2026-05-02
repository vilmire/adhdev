import type { LocalTransport } from '../transports/local.js';
import type { CloudTransport } from '../transports/cloud.js';

export const LAUNCH_SESSION_TOOL = {
  name: 'launch_session',
  description:
    'Launch a new agent session on the daemon. Supports CLI agents (e.g. hermes-cli, claude-cli, gemini-cli), ACP agents (e.g. claude-acp), and IDEs (e.g. cursor, vscode).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      type: {
        type: 'string',
        description:
          'Provider type to launch. CLI examples: hermes-cli, claude-cli, gemini-cli. ACP examples: claude-acp. IDE examples: cursor, vscode.',
      },
      workspace: {
        type: 'string',
        description: 'Working directory for the session. Defaults to the daemon default workspace.',
      },
      model: {
        type: 'string',
        description: 'Model override for ACP agents (e.g. claude-opus-4-7).',
      },
      daemon_id: {
        type: 'string',
        description: 'Daemon ID (cloud mode only). Required in cloud mode.',
      },
    },
    required: ['type'],
  },
};

export async function launchSession(
  transport: LocalTransport | CloudTransport,
  args: { type: string; workspace?: string; model?: string; daemon_id?: string },
): Promise<string> {
  if ('command' in transport) {
    // LocalTransport
    const isCliOrAcp =
      args.type.includes('-cli') || args.type.includes('-acp') || args.type === 'codex';
    const commandType = isCliOrAcp ? 'launch_cli' : 'launch_ide';
    const payload: Record<string, unknown> = isCliOrAcp
      ? { cliType: args.type, dir: args.workspace ?? '~', ...(args.model ? { model: args.model } : {}) }
      : { ideType: args.type, enableCdp: true };
    const result = await (transport as LocalTransport).command(commandType, payload);
    if (result?.success === false) return `Error: ${result.error ?? 'launch failed'}`;
    const id = result?.id ?? result?.sessionId;
    return id ? `Session launched. id: ${id}, type: ${args.type}` : `Launched: ${JSON.stringify(result)}`;
  }

  // CloudTransport
  if (!args.daemon_id) throw new Error('daemon_id is required in cloud mode');
  const result = await (transport as CloudTransport).launch(args.daemon_id, {
    type: args.type,
    dir: args.workspace,
    model: args.model,
  });
  if (result?.success === false || result?.error) return `Error: ${result.error ?? 'launch failed'}`;
  const id = result?.id ?? result?.sessionId;
  return id ? `Session launched. id: ${id}, type: ${args.type}` : `Launched: ${JSON.stringify(result)}`;
}
