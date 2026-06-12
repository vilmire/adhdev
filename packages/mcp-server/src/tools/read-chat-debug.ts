import type { CommandTransport } from '../transports/mode.js';
import { FORMAT_PROP } from './list-sessions.js';

export const READ_CHAT_DEBUG_TOOL = {
  name: 'read_chat_debug',
  description: 'Collect a daemon-side chat/parser debug bundle for an agent session without opening the browser UI. Prefer this when terminal/chat diverge or long CLI transcripts parse incorrectly. Defaults to daemon_file delivery and returns a saved bundle locator.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      session_id: {
        type: 'string',
        description: 'Target session ID (from list_sessions). Required for reliable routing.',
      },
      agent_type: {
        type: 'string',
        description: 'Optional provider/agent type hint, e.g. hermes-cli, claude-cli, codex-cli.',
      },
      limit: {
        type: 'number',
        description: 'Max read_chat tail messages embedded in the bundle (default: 40).',
      },
      delivery: {
        type: 'string',
        enum: ['daemon_file', 'inline'],
        description: 'daemon_file saves the full sanitized bundle on the daemon and returns a locator; inline returns the sanitized bundle in the MCP response. Default: daemon_file.',
      },
      ...FORMAT_PROP,
    },
    required: ['session_id'],
  },
};

export async function readChatDebug(
  transport: CommandTransport,
  args: {
    session_id?: string;
    agent_type?: string;
    limit?: number;
    delivery?: 'daemon_file' | 'inline';
    format?: 'text' | 'json';
  },
): Promise<string> {
  const sessionId = typeof args.session_id === 'string' ? args.session_id.trim() : '';
  if (!sessionId) throw new Error('session_id is required');

  const tailLimit = args.limit ?? 40;
  const delivery = args.delivery === 'inline' ? 'inline' : 'daemon_file';
  const commandArgs = {
    targetSessionId: sessionId,
    tailLimit,
    ...(args.agent_type ? { agentType: args.agent_type, providerType: args.agent_type } : {}),
    ...(delivery === 'daemon_file' ? { delivery: 'daemon_file' } : {}),
  };

  const result = await transport.command('get_chat_debug_bundle', commandArgs);

  return formatChatDebugResult(result, { sessionId, delivery, format: args.format });
}

export function formatChatDebugResult(
  result: any,
  options: { sessionId: string; delivery: 'daemon_file' | 'inline'; format?: 'text' | 'json' },
): string {
  if (!result?.success && result?.error) {
    if (options.format === 'json') return JSON.stringify({ success: false, error: result.error }, null, 2);
    return `Error: ${result.error}`;
  }

  if (options.format === 'json') {
    return JSON.stringify(result, null, 2);
  }

  if (result?.delivery === 'daemon_file') {
    const summary = result.summary && typeof result.summary === 'object' ? result.summary : {};
    return [
      'ADHDev chat debug bundle saved on daemon.',
      `session_id: ${options.sessionId}`,
      `bundle_id: ${String(result.bundleId || '')}`,
      `saved_path: ${String(result.savedPath || '')}`,
      `size_bytes: ${String(result.sizeBytes || '')}`,
      `created_at: ${String(result.createdAt || '')}`,
      `read_chat_status: ${String((summary as any).readChatStatus || '')}`,
      `read_chat_total_messages: ${String((summary as any).readChatTotalMessages ?? '')}`,
      `cli_status: ${String((summary as any).cliStatus || '')}`,
      `cli_message_count: ${String((summary as any).cliMessageCount ?? '')}`,
    ].join('\n');
  }

  if (typeof result?.text === 'string') return result.text;
  if (result?.bundle) return JSON.stringify(result.bundle, null, 2);
  return JSON.stringify(result, null, 2);
}
