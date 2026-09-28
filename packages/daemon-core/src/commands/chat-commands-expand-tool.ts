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
 *
 * ── Addressing by `messageId` (keyed storage, design 2026-09-28 §5.9) ──────
 * The keyed replica wire carries only `expandable: boolean` — a ref sealed by
 * the file mtime would change on every append and force every past tool
 * bubble to be rewritten. A replica reader therefore asks with
 * `{ messageId }`, and the ref is resolved HERE from the session's message
 * identity ledger, which keeps the ref the latest read observed for that id.
 * The mtime seal still applies to that ref, so a moved transcript still fails
 * closed (`source_changed`) instead of naming another block.
 */

import type { CommandResult, CommandHelpers } from './handler.js';
import { getTargetedCliAdapter } from './chat-commands-shared.js';
import type { ToolBlockExpandResult } from '../providers/spec/tool-block-expand.js';
import { LOG } from '../logging/logger.js';
import { peekMessageIdentityLedger } from '../chat/message-identity-ledger.js';

/**
 * (G11) Describe the ref in a refusal log line.
 *
 * ★ The three ref components ONLY — an mtime and two array positions. No
 * `sourcePath`, no tool name, no block body: this line exists to say which
 * address was refused and why, and a refusal reason needs no content to be
 * actionable. Keeping it to integers is also what makes it safe to log
 * unconditionally.
 */
function describeRef(ref: unknown): string {
    const r = (ref ?? {}) as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '?');
    return `mtime=${num(r.sourceMtimeMs)} record=${num(r.recordIndex)} block=${num(r.blockIndex)}`;
}

/** A CLI adapter that knows how to re-read its own tool blocks. */
interface ToolBlockExpandCapableAdapter {
    expandToolBlock(ref: unknown): ToolBlockExpandResult;
}

function canExpand(adapter: unknown): adapter is ToolBlockExpandCapableAdapter {
    return !!adapter && typeof (adapter as ToolBlockExpandCapableAdapter).expandToolBlock === 'function';
}

/** The session key the read_chat choke point files this session's ledger under. */
function ledgerKeyOf(h: CommandHelpers, args: any): string {
    const raw = typeof args?.targetSessionId === 'string' && args.targetSessionId.trim() ? args.targetSessionId
        : typeof args?.sessionId === 'string' && args.sessionId.trim() ? args.sessionId
        : h.currentSession?.sessionId;
    return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * The tool-block ref the session's identity ledger holds for `args.messageId`
 * (§5.9), or undefined when the id is unknown or not a truncated tool bubble.
 */
export function resolveToolBlockRefByMessageId(h: CommandHelpers, args: any): unknown {
    const messageId = typeof args?.messageId === 'string' ? args.messageId.trim() : '';
    if (!messageId) return undefined;
    const key = ledgerKeyOf(h, args);
    if (!key) return undefined;
    const locator = peekMessageIdentityLedger(key)?.locatorOf(messageId);
    return locator && typeof locator === 'object' ? locator : undefined;
}

export function handleExpandToolBlock(h: CommandHelpers, args: any): CommandResult {
    const ref = args?.toolBlockRef ?? resolveToolBlockRefByMessageId(h, args);
    // (G11) Which session asked. Falls back rather than bailing: a refusal with
    // an unknown session is still worth logging, and an empty string here would
    // read as a bug in the log rather than as a missing target.
    const sessionId = String(args?.targetSessionId || h.currentSession?.sessionId || 'unknown-session');
    if (!ref || typeof ref !== 'object') {
        LOG.warn('Command', `[expand_tool_block] refused session=${sessionId} reason=missing_ref`);
        return { success: false, error: 'toolBlockRef or a known messageId is required' };
    }

    const adapter = getTargetedCliAdapter(h, args);
    // Only spec-driven CLI adapters carry a declarative native-history source to
    // re-read. Anything else has no untruncated text to offer, and saying so is
    // better than returning an empty body the UI would render as "expanded".
    if (!canExpand(adapter)) {
        LOG.warn('Command', `[expand_tool_block] refused session=${sessionId} ${describeRef(ref)} reason=unsupported_source (adapter cannot expand)`);
        return { success: false, error: 'expand_unsupported', reason: 'unsupported_source' };
    }

    let result: ToolBlockExpandResult;
    try {
        result = adapter.expandToolBlock(ref);
    } catch (err) {
        LOG.warn('Command', `[expand_tool_block] refused session=${sessionId} ${describeRef(ref)} reason=source_unavailable (threw: ${(err as Error)?.message || 'unknown'})`);
        return { success: false, error: 'expand_failed', reason: 'source_unavailable' };
    }

    if (!result.ok) {
        // ★ (G11) Why this is logged at all. Every refusal path above and here
        // returned a typed reason to the CALLER and left no trace anywhere else,
        // so "I clicked expand and nothing opened" produced zero daemon-side
        // evidence — there was no way to tell a broken seal from an adapter that
        // never supported expand, short of reproducing it live.
        //
        // `source_changed` is the one worth naming: it is not a malfunction but
        // the seal working — the transcript moved under the ref, so the indices
        // can no longer be trusted and the only correct answer is to refuse and
        // let the caller re-read. Without this line, that correct refusal and a
        // genuine defect look identical from the outside.
        LOG.warn('Command', `[expand_tool_block] refused session=${sessionId} ${describeRef(ref)} reason=${result.reason}`);
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
