import type { McpTransport } from '../transports/mode.js';
import { isLocalTransport } from '../transports/mode.js';
import { FORMAT_PROP } from './list-sessions.js';

export const SPEC_DEBUG_TOOL = {
  name: 'spec_debug',
  description: 'Get current spec state, sections, and state transition history for a spec-driven CLI session (claude-cli, antigravity-cli, etc.). Use to diagnose idle/busy detection issues, inspect section parsing, or verify idle_hold and busy_hold behavior.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      session_id: {
        type: 'string',
        description: 'Target session ID (from list_sessions).',
      },
      daemon_id: {
        type: 'string',
        description: 'Daemon ID (cloud mode only). Omit for local mode.',
      },
      ...FORMAT_PROP,
    },
    required: ['session_id'],
  },
};

export async function specDebug(
  transport: McpTransport,
  args: {
    session_id?: string;
    daemon_id?: string;
    format?: 'text' | 'json';
  },
): Promise<string> {
  const sessionId = typeof args.session_id === 'string' ? args.session_id.trim() : '';
  if (!sessionId) throw new Error('session_id is required');

  let result: any;
  if (isLocalTransport(transport)) {
    result = await transport.command('get_spec_debug', { targetSessionId: sessionId });
  } else {
    if (!args.daemon_id) throw new Error('daemon_id is required in cloud mode');
    const targetId = `${args.daemon_id}:session:${sessionId}`;
    result = await transport.sendCommand(targetId, 'get_spec_debug', { targetSessionId: sessionId });
  }

  return formatSpecDebugResult(result, { sessionId, format: args.format });
}

export function formatSpecDebugResult(
  result: any,
  options: { sessionId: string; format?: 'text' | 'json' },
): string {
  if (!result?.success) {
    const err = result?.error || 'Unknown error';
    if (options.format === 'json') return JSON.stringify({ success: false, error: err }, null, 2);
    return `Error: ${err}`;
  }

  if (options.format === 'json') return JSON.stringify(result, null, 2);

  const snap = result.snapshot;
  if (!snap) {
    return [
      `session_id: ${options.sessionId}`,
      `provider_type: ${String(result.providerType || '')}`,
      'is_spec_provider: false',
      'No spec debug data available (not a spec-driven provider).',
    ].join('\n');
  }

  const lines: string[] = [];
  lines.push(`session_id: ${options.sessionId}`);
  lines.push(`provider_type: ${String(result.providerType || snap.cliType || '')}`);
  lines.push(`spec_id: ${String(snap.spec_id || '')}`);
  lines.push(`spec_path: ${String(snap.specPath || '')}`);
  lines.push(`current_state: ${snap.current_state ? `${snap.current_state.id} (${snap.current_state.label})` : 'none'}`);
  lines.push(`idle_hold_pending: ${String(snap.idleHoldPending ?? false)}`);
  lines.push(`last_busy_at: ${snap.lastBusyAt ? new Date(snap.lastBusyAt).toISOString() : 'never'}`);
  lines.push(`exited: ${String(snap.exited ?? false)}`);

  if (snap.current_modal) {
    lines.push(`current_modal: ${JSON.stringify(snap.current_modal)}`);
  }

  // Sections
  if (snap.sections && typeof snap.sections === 'object') {
    lines.push('');
    lines.push('── sections ──');
    for (const [id, text] of Object.entries(snap.sections as Record<string, string>)) {
      const preview = String(text || '').replace(/\n/g, '↵').slice(0, 120);
      lines.push(`  ${id}: ${preview}`);
    }
  }

  // State history (most recent first)
  const history = Array.isArray(snap.stateHistory) ? snap.stateHistory : [];
  if (history.length > 0) {
    lines.push('');
    lines.push('── state history (newest first) ──');
    const now = Date.now();
    for (const entry of [...history].reverse().slice(0, 20)) {
      const agoMs = now - entry.at;
      const ago = agoMs < 2000 ? `${agoMs}ms ago` : `${(agoMs / 1000).toFixed(1)}s ago`;
      const dur = entry.durationMs > 0 ? `  held ${entry.durationMs}ms` : '';
      lines.push(`  ${String(entry.stateId).padEnd(18)} ${ago}${dur}`);
    }
  }

  return lines.join('\n');
}
