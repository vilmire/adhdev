/**
 * Compact owner-decision shapes the assistant reads (structured-missions design
 * 2026-10-28 §6.3) and the allow-list sanitizer applied to a decision listing a
 * REMOTE host sent. A followed project's host is another daemon: its payload is
 * re-projected field by field here, never spread.
 */

export interface CompactDecision {
    itemId: string;
    question: string;
    /** Options as stored; the recommended one carries `recommended: true`. */
    options: Array<{ id: string; label: string; recommended?: true }>;
    recommended?: string;
    allowFreeText: boolean;
    urgency: 'normal' | 'blocking';
    dueAt?: string;
    onDue: 'remind' | 'apply_recommended';
    source: 'coordinator' | 'worker' | 'daemon';
    missionId: string;
    carryOver?: true;
    remindedAt?: string;
}

export interface CompactRecentAnswer {
    itemId: string;
    question: string;
    /** `b: Label` / free text, as a human reads it. */
    answer: string;
    by: 'owner' | 'auto_recommended';
    at: string;
}

export interface DecisionListing {
    openDecisions: { count: number; blocking: number };
    ownerDecisions: CompactDecision[];
    /** Answers recorded in the last 24h by the deadline pass (undoable). */
    autoApplied?: CompactRecentAnswer[];
}

const ROWS_MAX = 10;

function rec(v: unknown): Record<string, unknown> | null {
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

function text(v: unknown, max: number): string {
    return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function num(v: unknown): number {
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

function sanitizeRow(raw: unknown): CompactDecision | null {
    const r = rec(raw);
    if (!r) return null;
    const itemId = text(r.itemId, 100);
    const question = text(r.question, 300);
    if (!itemId || !question) return null;
    const options = (Array.isArray(r.options) ? r.options : []).slice(0, 5).flatMap((o) => {
        const x = rec(o);
        const id = text(x?.id, 8);
        const label = text(x?.label, 60);
        return id && label ? [{ id, label, ...(x?.recommended === true ? { recommended: true as const } : {}) }] : [];
    });
    const recommended = text(r.recommended, 8);
    const dueAt = text(r.dueAt, 40);
    const remindedAt = text(r.remindedAt, 40);
    const source = r.source === 'worker' || r.source === 'daemon' ? r.source : 'coordinator';
    return {
        itemId, question, options,
        ...(recommended ? { recommended } : {}),
        allowFreeText: r.allowFreeText !== false,
        urgency: r.urgency === 'blocking' ? 'blocking' : 'normal',
        ...(dueAt ? { dueAt } : {}),
        onDue: r.onDue === 'apply_recommended' ? 'apply_recommended' : 'remind',
        source,
        missionId: text(r.missionId, 100),
        ...(r.carryOver === true ? { carryOver: true as const } : {}),
        ...(remindedAt ? { remindedAt } : {}),
    };
}

function sanitizeRecent(raw: unknown): CompactRecentAnswer | null {
    const r = rec(raw);
    const itemId = text(r?.itemId, 100);
    if (!r || !itemId) return null;
    return {
        itemId, question: text(r.question, 300), answer: text(r.answer, 200),
        by: r.by === 'owner' ? 'owner' : 'auto_recommended', at: text(r.at, 40),
    };
}

/** A host's `openDecisions` / `ownerDecisions` (/ `autoApplied`) fields → the allow-listed shape; `{}` when there is nothing. */
export function sanitizeDecisionFields(raw: Record<string, unknown>): Partial<DecisionListing> {
    const counts = rec(raw.openDecisions);
    const rows = (Array.isArray(raw.ownerDecisions) ? raw.ownerDecisions : []).slice(0, ROWS_MAX)
        .map(sanitizeRow).filter((x): x is CompactDecision => x !== null);
    const auto = (Array.isArray(raw.autoApplied) ? raw.autoApplied : []).slice(0, ROWS_MAX)
        .map(sanitizeRecent).filter((x): x is CompactRecentAnswer => x !== null);
    if (!counts && rows.length === 0 && auto.length === 0) return {};
    const count = Math.max(num(counts?.count), rows.length);
    return {
        openDecisions: { count, blocking: Math.min(count, num(counts?.blocking)) },
        ownerDecisions: rows,
        ...(auto.length ? { autoApplied: auto } : {}),
    };
}
