/**
 * Native-transcript window for coordinator relay capture.
 *
 * The PTY screen scrape keeps one wrapped row. The relay reads assistant
 * `standard` bubbles from read_chat / chat_history instead, bounded to the
 * attempt. Paste-wrap provenance (a later change) can annotate `parts`
 * without changing this selection.
 */
import { isVisible, messageText } from './project-views.js';

export type ReportCompleteness = 'final_native' | 'envelope_unverified';

export interface NativeReplyPart {
    at: number;
    chars: number;
    text: string;
}

export interface AttemptReportSnapshot {
    body: string | null;
    completeness: ReportCompleteness;
    source?: string;
    parts?: Array<{ at: number; chars: number }>;
}

/** A native final the relay auditor hands to the missing-relay detector. */
export interface AuditedCoordinatorReply {
    sessionId: string;
    messageAt: number;
    chars: number;
    /** Containment check only. Never log this. */
    text: string;
    attemptId: string | null;
    /** Attempt still open: the commit-time capture has not run. Do not flag. */
    attemptOpen?: boolean;
    /** Closed by boot reconcile (`session_error` + `session_registry`). */
    restartClosed?: boolean;
}

const rec = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;

/**
 * A bubble's wall-clock time. Live `read_chat` / `chat_history` messages carry
 * it as \`receivedAt\` (provider-native-history.ts), not \`timestamp\`; reading
 * only \`timestamp\`/\`createdAt\` found no bubble at all, so every relay fell
 * back to the bare envelope (2026-10-18). Which providers' times count as
 * wall-clock evidence is decided upstream (TIMESTAMPED_PROVIDERS).
 */
export function bubbleTimestamp(m: unknown): number | null {
    const r = rec(m);
    if (!r) return null;
    for (const v of [r.timestamp, r.receivedAt]) {
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
    }
    const parsed = Date.parse(String(r.timestamp ?? r.createdAt ?? r.ts ?? ''));
    return Number.isFinite(parsed) ? parsed : null;
}

/** Visible assistant/agent text that is a standard bubble. Missing kind counts as standard; thinking and tool bubbles do not. */
export function standardAssistantBubble(m: unknown): { at: number; text: string } | null {
    if (!isVisible(m)) return null;
    const r = rec(m);
    if (!r) return null;
    const role = String(r.role ?? '').toLowerCase();
    if (role !== 'assistant' && role !== 'agent') return null;
    const kind = String(r.kind ?? r.messageKind ?? '').toLowerCase();
    if (kind && kind !== 'standard') return null;
    const text = messageText(r).trim();
    if (!text) return null;
    const at = bubbleTimestamp(r);
    if (at === null) return null;
    return { at, text };
}

/**
 * Bubbles in `[start, end]` (inclusive), oldest first.
 * Identical at+text duplicates collapse. Two different bubbles sharing a timestamp are ambiguous.
 */
export function selectNativeWindow(messages: readonly unknown[], start: number, end: number): { ambiguous: boolean; bubbles: NativeReplyPart[] } {
    const seen = new Set<string>();
    const bubbles: NativeReplyPart[] = [];
    for (const m of messages) {
        const b = standardAssistantBubble(m);
        if (!b || b.at < start || b.at > end) continue;
        const key = `${b.at}\n${b.text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        bubbles.push({ at: b.at, chars: Array.from(b.text).length, text: b.text });
    }
    bubbles.sort((a, b) => a.at - b.at || a.text.localeCompare(b.text));
    const atCount = new Map<number, number>();
    for (const b of bubbles) atCount.set(b.at, (atCount.get(b.at) ?? 0) + 1);
    if ([...atCount.values()].some((n) => n > 1)) return { ambiguous: true, bubbles: [] };
    return { ambiguous: false, bubbles };
}

export function formatReplyClock(ms: number): string {
    return new Date(ms).toISOString().slice(11, 19);
}

/** One reply is the raw text. Several are labelled oldest → newest. */
export function renderNativeReplies(bubbles: readonly NativeReplyPart[]): string {
    if (bubbles.length === 1) return bubbles[0]!.text;
    return bubbles.map((b, i) => `[reply ${i + 1}/${bubbles.length} · ${formatReplyClock(b.at)}]\n${b.text}`).join('\n\n');
}

/** Screen-scrape envelope agrees when it is a prefix of some native bubble (or of the joined text). */
export function envelopeIsNativePrefix(envelope: string, bubbles: readonly { text: string }[]): boolean {
    const needle = envelope.trim();
    if (!needle) return true;
    if (bubbles.some((b) => b.text.trim().startsWith(needle))) return true;
    return bubbles.map((b) => b.text.trim()).join('\n').startsWith(needle);
}

export function partsOf(bubbles: readonly NativeReplyPart[]): Array<{ at: number; chars: number }> {
    return bubbles.map((b) => ({ at: b.at, chars: b.chars }));
}
