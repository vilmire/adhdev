import type { CommandTransport } from '../transports/mode.js';
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
      ...FORMAT_PROP,
    },
    required: ['session_id'],
  },
};

export async function specDebug(
  transport: CommandTransport,
  args: {
    session_id?: string;
    format?: 'text' | 'json';
  },
): Promise<string> {
  const sessionId = typeof args.session_id === 'string' ? args.session_id.trim() : '';
  if (!sessionId) throw new Error('session_id is required');

  const result = await transport.command('get_spec_debug', { targetSessionId: sessionId });

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

  // Sections — full raw text (this is a debugging surface; do NOT truncate or
  // collapse newlines, so the exact text the FSM regexes match against is
  // visible). Each section is fenced and prefixed with its line count.
  if (snap.sections && typeof snap.sections === 'object') {
    lines.push('');
    lines.push('## Sections');
    for (const [id, text] of Object.entries(snap.sections as Record<string, string>)) {
      const raw = String(text ?? '');
      const lineCount = raw.length === 0 ? 0 : raw.split('\n').length;
      lines.push('');
      lines.push(`### section: ${id} (${lineCount} lines, ${raw.length} chars)`);
      lines.push('```');
      lines.push(raw);
      lines.push('```');
    }
  }

  // State history (most recent first) — now includes the fired transition
  // (`via`) and the per-condition rule evaluation (`matchedRules`), so you can
  // see WHICH regex/time-gate fired and, for regex rules, the matched text.
  const history = Array.isArray(snap.stateHistory) ? snap.stateHistory : [];
  if (history.length > 0) {
    lines.push('');
    lines.push('## State History (newest first)');
    const now = Date.now();
    for (const entry of [...history].reverse().slice(0, 20)) {
      const agoMs = now - entry.at;
      const ago = agoMs < 2000 ? `${agoMs}ms ago` : `${(agoMs / 1000).toFixed(1)}s ago`;
      const dur = entry.durationMs > 0 ? `  held ${entry.durationMs}ms` : '';
      const via = entry.via ? `  via ${entry.via}` : '';
      lines.push(`  ${String(entry.stateId).padEnd(18)} ${ago}${dur}${via}`);
      const rules = Array.isArray(entry.matchedRules) ? entry.matchedRules : [];
      for (const rule of rules) {
        lines.push(`      ${String(rule)}`);
      }
    }
  }

  // PTY event timeline (input we injected / output the PTY printed / resize /
  // cursor moves) — correlate by timestamp with the State History above to see
  // what input/output preceded each status transition.
  const timeline = Array.isArray(snap.eventTimeline) ? snap.eventTimeline : [];
  if (timeline.length > 0) {
    lines.push('');
    lines.push('## Event Timeline (oldest first)');
    const now = Date.now();
    const arrow: Record<string, string> = {
      input: '→ in ', output: '← out', resize: '⇲ size', cursor: '⌖ cur', spawn: '⏻ spawn', exit: '⏹ exit',
    };
    for (const ev of timeline.slice(-120)) {
      const agoMs = now - (ev.ts ?? now);
      const ago = agoMs < 2000 ? `${agoMs}ms` : `${(agoMs / 1000).toFixed(1)}s`;
      const tag = arrow[String(ev.kind)] ?? String(ev.kind);
      const bytes = typeof ev.bytes === 'number' ? ` [${ev.bytes}b]` : '';
      lines.push(`  -${ago.padStart(6)}  ${tag}${bytes}  ${String(ev.content ?? '')}`);
    }
  }

  return lines.join('\n');
}
