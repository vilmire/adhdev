/**
 * Tool-block projection for the native-history executor.
 *
 * Extracted from `native-history-executor.ts` as a pure move (that file crossed
 * the 2,400-line gate when the expand ref landed). This is the one place that
 * decides how a raw transcript content block becomes a `kind:'tool'` bubble —
 * including the summary caps, which the on-demand expand path
 * (`tool-block-expand.ts`) reads from here so the two can never disagree about
 * what "truncated" means.
 */

import type { NativeHistoryMessage, NativeHistoryToolBlockRef } from './native-history-types.js';
import type { NativeHistoryToolMap } from './types.js';

export const DEFAULT_TOOL_CALL_TYPES = ['tool_use', 'function_call', 'custom_tool_call'];
export const DEFAULT_TOOL_RESULT_TYPES = ['tool_result', 'function_call_output', 'custom_tool_call_output'];

/**
 * Summary caps for tool bubbles. Exported so the on-demand expand path
 * (`tool-block-expand.ts`) and its regression tests assert against the SAME
 * numbers the parser truncates at, instead of re-hardcoding 240/600 and
 * silently drifting apart.
 */
export const TOOL_CALL_SUMMARY_MAX = 240;
export const TOOL_RESULT_SUMMARY_MAX = 600;

/**
 * Turn a single content block into a `kind:'tool'` message, or null if the
 * block is not a tool call/result. Field locations come from the spec's
 * `tools` map with Anthropic-block defaults.
 *
 * Both tool calls and tool results render on the assistant side: a tool call
 * is the agent's action, and a tool result is part of the agent's work, not a
 * user turn (claude/codex persist results under the user / no role, which would
 * otherwise misattribute them). Calls render as `↗ {name}: {one-line args}`,
 * results as `↘ {one-line result}`. The `role` param is accepted for symmetry
 * but tool bubbles are always assistant.
 */
export function projectToolBlock(
    block: any,
    role: 'user' | 'assistant' | 'system',
    tmap: NativeHistoryToolMap,
    deps: {
        jsonPathGet: (record: any, expr: string) => unknown;
        stringifyContent: (v: unknown) => string;
    },
    ref?: NativeHistoryToolBlockRef,
): NativeHistoryMessage | null {
    void role;
    if (block == null || typeof block !== 'object') return null;
    const { jsonPathGet, stringifyContent } = deps;
    const typeVal = String(jsonPathGet(block, tmap.block_type || '$.type') ?? '');
    if (!typeVal) return null;
    const callTypes = tmap.call_types ?? DEFAULT_TOOL_CALL_TYPES;
    const resultTypes = tmap.result_types ?? DEFAULT_TOOL_RESULT_TYPES;

    // The ref rides along only when the summary actually lost text. An
    // un-truncated bubble is already complete, so advertising an expand
    // affordance for it would promise the reader something new and deliver the
    // same string back.
    if (callTypes.includes(typeVal)) {
        const name = String(jsonPathGet(block, tmap.call_name || '$.name') ?? 'tool').trim() || 'tool';
        const { text: args, truncated } = oneLine(stringifyContent(jsonPathGet(block, tmap.call_args || '$.input')), TOOL_CALL_SUMMARY_MAX);
        const content = args ? `↗ ${name}: ${args}` : `↗ ${name}`;
        const msg: NativeHistoryMessage = { role: 'assistant', content, receivedAt: 0, kind: 'tool' };
        if (truncated && ref) msg.toolBlockRef = ref;
        return msg;
    }
    if (resultTypes.includes(typeVal)) {
        const { text: result, truncated } = oneLine(stringifyContent(jsonPathGet(block, tmap.result_content || '$.content')), TOOL_RESULT_SUMMARY_MAX);
        if (!result) return null;
        const msg: NativeHistoryMessage = { role: 'assistant', content: `↘ ${result}`, receivedAt: 0, kind: 'tool' };
        if (truncated && ref) msg.toolBlockRef = ref;
        return msg;
    }
    return null;
}

/**
 * Collapse whitespace to single spaces and cap length for a tool summary.
 *
 * Reports whether the cap actually bit, so the caller can decide to attach an
 * expand ref. Note the truncation test is on the WHITESPACE-FLATTENED text: a
 * multi-line body that collapses to under the cap loses newlines but no words,
 * and offering "expand" for it would be noise.
 *
 * Exported so the built-in readers (`providers/native-history/*`) cap and
 * decide "did this lose text?" with the SAME function the spec parser uses.
 * Re-implementing it there is the failure mode the caps were exported to
 * prevent: a reader that truncates at a different length, or judges truncation
 * on the un-flattened string, would stamp refs on complete bubbles (expand
 * returns the identical text) or omit them from lossy ones.
 */
export function oneLine(s: string, max: number): { text: string; truncated: boolean } {
    const flat = s.replace(/\s+/g, ' ').trim();
    if (flat.length <= max) return { text: flat, truncated: false };
    return { text: flat.slice(0, max - 1) + '…', truncated: true };
}
