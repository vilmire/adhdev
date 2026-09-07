/**
 * Shared type vocabulary for the native-history subtree.
 *
 * Scope note — deliberately narrow. Only the two enums below are shared. The
 * per-provider `NativeHistoryMessage` / `NativeHistorySession` /
 * `NativeHistorySessionMeta` interfaces are NOT hoisted here, because despite
 * the identical names they are not the same type:
 *
 *   - `agent` is a distinct string-literal per reader ('claude-cli',
 *     'codex-cli', 'antigravity-cli'), and that literal is what makes a parsed
 *     message attributable to its source.
 *   - `nativeHistoryCoverage` is `'full'` for claude/codex/hermes but
 *     `'full' | 'partial' | 'best-effort'` for antigravity, which alone can
 *     fall back to history.jsonl prompts or raw .pb bytes.
 *   - Readers carry reader-specific fields (codex `turnTerminalMarkers`,
 *     antigravity `partialReason`, the `usage` totals only some emit).
 *   - hermes' message shape is structurally different again (`id`, no
 *     `agent`/`historySessionId`).
 *
 * Collapsing those into one interface would have to widen every literal to a
 * union and make every reader-specific field optional — which silently deletes
 * the compiler's ability to tell the readers apart at their call sites. That is
 * a semantic change wearing the costume of a type cleanup, so it is not done.
 *
 * OSS code (AGPL-3.0). Must not import from packages/ (proprietary).
 */

/** Speaker of a parsed native-history message. Identical across all readers. */
export type NativeHistoryRole = 'user' | 'assistant' | 'system';

/** Bubble class of a parsed native-history message. Identical across all readers. */
export type NativeHistoryKind = 'standard' | 'tool' | 'session_start';
