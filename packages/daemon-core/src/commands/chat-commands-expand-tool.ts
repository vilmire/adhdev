/**
 * `expand_tool_block` — fetch one truncated tool bubble at full length.
 *
 * Tool call args and results are summarised by the native-history parser (240 /
 * 600 chars) and the untruncated text is deliberately carried on NO transcript
 * payload: results are routinely multi-kilobyte and almost never read, so
 * shipping them with every read_chat would bloat the transcript — and, on the
 * cloud path, would push agent-authored content toward the server for no user
 * benefit. Instead the parser stamps a content-free `toolBlockRef` on bubbles it
 * truncated, and this command trades that ref back for the full text.
 *
 * Transport: this is a normal daemon command, so on the cloud path it travels
 * the P2P DataChannel like every other dashboard command, and on standalone it
 * travels the localhost HTTP/WS surface. The expanded body therefore never
 * reaches the Worker — consistent with the P2P-first rule that the server WS /
 * status path carries signalling and metadata, not chat content.
 */

import type { CommandResult, CommandHelpers } from './handler.js';
import { getTargetedCliAdapter } from './chat-commands-shared.js';
import type { ToolBlockExpandResult } from '../providers/spec/tool-block-expand.js';

/** A CLI adapter that knows how to re-read its own tool blocks. */
interface ToolBlockExpandCapableAdapter {
    expandToolBlock(ref: unknown): ToolBlockExpandResult;
}

function canExpand(adapter: unknown): adapter is ToolBlockExpandCapableAdapter {
    return !!adapter && typeof (adapter as ToolBlockExpandCapableAdapter).expandToolBlock === 'function';
}

export function handleExpandToolBlock(h: CommandHelpers, args: any): CommandResult {
    const ref = args?.toolBlockRef;
    if (!ref || typeof ref !== 'object') {
        return { success: false, error: 'toolBlockRef is required' };
    }

    const adapter = getTargetedCliAdapter(h, args);
    // Only spec-driven CLI adapters carry a declarative native-history source to
    // re-read. Anything else has no untruncated text to offer, and saying so is
    // better than returning an empty body the UI would render as "expanded".
    if (!canExpand(adapter)) {
        return { success: false, error: 'expand_unsupported', reason: 'unsupported_source' };
    }

    let result: ToolBlockExpandResult;
    try {
        result = adapter.expandToolBlock(ref);
    } catch {
        return { success: false, error: 'expand_failed', reason: 'source_unavailable' };
    }

    if (!result.ok) {
        // Typed refusal, not a silent empty body. `source_changed` in particular
        // means the transcript moved under the ref, and the ONLY correct answer
        // is to refuse and let the caller re-read — returning whatever now sits
        // at those indices would show the wrong tool's output.
        return { success: false, error: 'expand_failed', reason: result.reason };
    }

    return {
        success: true,
        ...(result.toolName ? { toolName: result.toolName } : {}),
        ...(result.callArgs !== undefined ? { callArgs: result.callArgs } : {}),
        ...(result.result !== undefined ? { result: result.result } : {}),
        truncated: result.truncated,
    };
}
