/**
 * Memory digest and undo (docs/design/2026-11-01-assistant-memory.md §3.2).
 *
 * Both read the write journal (`.journal.jsonl`), the one record of every
 * attempt, core and archive tier alike. Nothing here has its own storage:
 *
 *  - `buildMemoryDigest` = "what was remembered since X", with an undo handle.
 *  - `undoMemoryWrite` reverses one APPLIED record (or one batch) by running
 *    the inverse operation through the store's normal write path as `owner`, so
 *    the budget, duplicate, credential and content checks all run again. A
 *    record whose text was blanked (credential/refused) is not undoable, and an
 *    entry that changed since is a conflict, never overwritten. The undo itself
 *    is journaled as `reverted` with `restoredFrom`.
 *
 * Undo is an owner verb only: the assistant must not be able to quietly undo a
 * person's addition.
 */

import { detectCredential, scanWriteContent } from '../store-guards.js';
import type { MemoryJournalRecord, MemoryOperation, MemoryWriteOutcome } from './memory-store.js';
import type { ArchiveEntry } from './memory-archive.js';

export const DIGEST_DEFAULT_SINCE_MS = 24 * 60 * 60 * 1000;
export const DIGEST_DEFAULT_LIMIT = 50;
export const DIGEST_MAX_LIMIT = 200;

export type DigestState = 'applied' | 'staged' | 'reverted' | 'undone';

export interface DigestEntry {
    ts: string;
    /** Undo handle (unique per journal line); legacy lines without one fall back to `ts`. */
    id: string;
    tier: 'core' | 'archive';
    target: 'memory' | 'user';
    scope?: string;
    action: MemoryJournalRecord['action'];
    /** Entry text after the write (before it, for a remove). */
    text: string | null;
    before: string | null;
    origin: string;
    entryId?: string;
    batchId?: string;
    state: DigestState;
    undoable: boolean;
    /** Promoted decision preference (also counted under `promoted`). */
    promoted: boolean;
}

export interface MemoryDigest {
    entries: DigestEntry[];
    counts: { added: number; replaced: number; removed: number; promoted: number; staged: number; reverted: number };
    sinceMs: number;
    truncated: boolean;
}

/** The handle a record is addressed by. */
export function journalHandle(r: MemoryJournalRecord): string {
    return r.jid ?? r.ts;
}

function isUndone(r: MemoryJournalRecord, all: readonly MemoryJournalRecord[]): boolean {
    const h = journalHandle(r);
    return all.some((x) => x.result === 'reverted' && x.restoredFrom === h);
}

/** Whether a record carries enough (un-redacted) text to be reversed. */
function reversible(r: MemoryJournalRecord): boolean {
    if (r.result !== 'applied') return false;
    if (r.redacted?.length) return false;
    if (r.action === 'add') return typeof r.after === 'string' && r.after.length > 0;
    if (r.action === 'remove') return typeof r.before === 'string' && r.before.length > 0;
    if (r.action === 'replace') return typeof r.before === 'string' && r.before.length > 0 && typeof r.after === 'string' && r.after.length > 0;
    return false;
}

export function buildMemoryDigest(
    journal: readonly MemoryJournalRecord[],
    opts: { sinceMs?: number; limit?: number; now: number },
): MemoryDigest {
    const sinceMs = Math.max(0, Math.floor(opts.sinceMs ?? DIGEST_DEFAULT_SINCE_MS));
    const limit = Math.min(DIGEST_MAX_LIMIT, Math.max(1, Math.floor(opts.limit ?? DIGEST_DEFAULT_LIMIT)));
    const cutoff = opts.now - sinceMs;
    const counts = { added: 0, replaced: 0, removed: 0, promoted: 0, staged: 0, reverted: 0 };
    const rows: DigestEntry[] = [];
    for (const r of journal) {
        const t = Date.parse(r.ts);
        if (!Number.isFinite(t) || t < cutoff) continue;
        if (r.result !== 'applied' && r.result !== 'staged' && r.result !== 'reverted') continue;
        const undone = r.result === 'applied' && isUndone(r, journal);
        const state: DigestState = r.result === 'reverted' ? 'reverted' : r.result === 'staged' ? 'staged' : undone ? 'undone' : 'applied';
        const promoted = r.origin === 'decision_promotion' && r.result === 'applied';
        if (r.result === 'staged') counts.staged += 1;
        else if (r.result === 'reverted') counts.reverted += 1;
        else if (!undone) {
            if (promoted) counts.promoted += 1;
            else if (r.action === 'add') counts.added += 1;
            else if (r.action === 'replace') counts.replaced += 1;
            else if (r.action === 'remove') counts.removed += 1;
        }
        rows.push({
            ts: r.ts, id: journalHandle(r), tier: r.tier ?? 'core', target: r.target,
            ...(r.scope ? { scope: r.scope } : {}), action: r.action,
            text: r.action === 'remove' ? r.before : r.after, before: r.before, origin: r.origin,
            ...(r.entryId ? { entryId: r.entryId } : {}), ...(r.batchId ? { batchId: r.batchId } : {}),
            state, undoable: state === 'applied' && reversible(r), promoted,
        });
    }
    const newestFirst = rows.reverse();
    return { entries: newestFirst.slice(0, limit), counts, sinceMs, truncated: newestFirst.length > limit };
}

// ── undo ────────────────────────────────────────────────────────────────────

export interface MemoryUndoHost {
    readJournal(): MemoryJournalRecord[];
    apply(op: MemoryOperation, origin: 'owner', meta: object, extra: { restoredFrom?: string; exactMatch?: boolean }): { result: string } & Record<string, unknown>;
    /** Current core entries of a file. */
    coreEntries(target: 'memory' | 'user'): string[] | null;
    archiveRow(id: string): ArchiveEntry | null;
    restoreArchiveRow(id: string): boolean;
    recordJournal(rec: Omit<MemoryJournalRecord, 'ts' | 'redacted' | 'jid'>): void;
}

export type MemoryUndoRequest = { id: string } | { ts: string } | { batchId: string };

export type MemoryUndoOutcome =
    | { result: 'applied'; reverted: string[] }
    | { result: 'memory_undo_not_found' }
    | { result: 'memory_undo_not_undoable'; reason: string }
    | { result: 'memory_undo_already' }
    | { result: 'memory_undo_conflict'; current: string | null }
    | { result: 'memory_undo_partial'; reverted: string[]; failed: Array<{ id: string; result: string; current?: string | null }> }
    | { result: Exclude<MemoryWriteOutcome['result'], 'applied'> };

/** Which journal line(s) a request names. `ts` must be unambiguous. */
function resolveTargets(journal: readonly MemoryJournalRecord[], req: MemoryUndoRequest): MemoryJournalRecord[] | 'ambiguous' {
    if ('batchId' in req) return journal.filter((r) => r.batchId === req.batchId && r.result === 'applied');
    if ('id' in req) return journal.filter((r) => journalHandle(r) === req.id && r.result !== 'reverted');
    const same = journal.filter((r) => r.ts === req.ts && r.result === 'applied');
    return same.length > 1 ? 'ambiguous' : same;
}

export function undoMemoryWrite(host: MemoryUndoHost, req: MemoryUndoRequest): MemoryUndoOutcome {
    const journal = host.readJournal();
    const targets = resolveTargets(journal, req);
    if (targets === 'ambiguous') return { result: 'memory_undo_not_undoable', reason: 'ambiguous_ts_use_id' };
    if (!targets.length) return { result: 'memory_undo_not_found' };

    if (!('batchId' in req)) return undoOne(host, journal, targets[0]!);

    // Batch: put things back before taking things away, so a failure half-way never loses an entry.
    const live = targets.filter((r) => !isUndone(r, journal));
    if (!live.length) return { result: 'memory_undo_already' };
    const rank = (r: MemoryJournalRecord) => (r.action === 'remove' ? 0 : r.action === 'replace' ? 1 : 2);
    const ordered = [...live].sort((a, b) => rank(a) - rank(b));
    const reverted: string[] = [];
    const failed: Array<{ id: string; result: string; current?: string | null }> = [];
    for (const r of ordered) {
        const out = undoOne(host, host.readJournal(), r);
        if (out.result === 'applied') { reverted.push(journalHandle(r)); continue; }
        failed.push({ id: journalHandle(r), result: out.result, ...('current' in out ? { current: out.current } : {}) });
        // Stop at the first failure: the steps after it may be the ones that take the
        // entry's other copy away (an archive move's file side must be back first).
        break;
    }
    return failed.length ? { result: 'memory_undo_partial', reverted, failed } : { result: 'applied', reverted };
}

function undoOne(host: MemoryUndoHost, journal: readonly MemoryJournalRecord[], rec: MemoryJournalRecord): MemoryUndoOutcome {
    const handle = journalHandle(rec);
    if (rec.result !== 'applied') return { result: 'memory_undo_not_undoable', reason: `record_${rec.result}` };
    if (isUndone(rec, journal)) return { result: 'memory_undo_already' };
    if (!reversible(rec)) return { result: 'memory_undo_not_undoable', reason: rec.redacted?.length ? 'redacted' : 'no_text' };
    const tier = rec.tier ?? 'core';
    const extra = { restoredFrom: handle, exactMatch: true };
    const archiveFields = tier === 'archive'
        ? { scope: (rec.scope === 'project' ? 'project' : 'archive') as 'archive' | 'project', ...(rec.projectRef ? { projectRef: rec.projectRef } : {}), ...(rec.kind ? { kind: rec.kind } : {}) }
        : {};
    const done = (out: { result: string } & Record<string, unknown>): MemoryUndoOutcome =>
        out.result === 'applied' ? { result: 'applied', reverted: [handle] } : { result: out.result as MemoryUndoOutcome['result'] } as MemoryUndoOutcome;

    if (rec.action === 'add') {
        const after = rec.after!;
        if (tier === 'core') {
            const cur = host.coreEntries(rec.target);
            if (cur === null) return { result: 'memory_store_unreadable' };
            if (!cur.includes(after)) return { result: 'memory_undo_conflict', current: cur.find((e) => e.startsWith(after.slice(0, 30))) ?? null };
        } else {
            const row = rec.entryId ? host.archiveRow(rec.entryId) : null;
            if (!row || row.archivedAt !== null || row.text !== after) return { result: 'memory_undo_conflict', current: row && row.archivedAt === null ? row.text : null };
        }
        return done(host.apply({ action: 'remove', target: rec.target, match: after, ...archiveFields }, 'owner', {}, extra));
    }
    if (rec.action === 'replace') {
        const after = rec.after!;
        if (tier === 'core') {
            const cur = host.coreEntries(rec.target);
            if (cur === null) return { result: 'memory_store_unreadable' };
            if (!cur.includes(after)) return { result: 'memory_undo_conflict', current: cur.find((e) => e.startsWith(after.slice(0, 30))) ?? null };
        } else {
            const row = rec.entryId ? host.archiveRow(rec.entryId) : null;
            if (!row || row.archivedAt !== null || row.text !== after) return { result: 'memory_undo_conflict', current: row && row.archivedAt === null ? row.text : null };
        }
        return done(host.apply({ action: 'replace', target: rec.target, match: after, content: rec.before!, ...archiveFields }, 'owner', {}, extra));
    }
    // remove → put it back
    const before = rec.before!;
    if (tier === 'core') {
        const out = host.apply({ action: 'add', target: rec.target, content: before }, 'owner', {}, extra);
        if (out.result === 'memory_duplicate') return { result: 'memory_undo_conflict', current: before };
        return done(out);
    }
    const row = rec.entryId ? host.archiveRow(rec.entryId) : null;
    if (!row || row.archivedAt === null) return { result: 'memory_undo_conflict', current: row?.text ?? null };
    // The row was checked on the way in; check it again on the way back out.
    if (detectCredential(row.text) || scanWriteContent(row.text)) return { result: 'memory_undo_not_undoable', reason: 'content_rejected' };
    if (!host.restoreArchiveRow(row.id)) return { result: 'memory_undo_conflict', current: row.text };
    host.recordJournal({
        action: 'add', target: rec.target, before: null, after: row.text, origin: 'owner', result: 'reverted',
        tier: 'archive', entryId: row.id, ...(rec.scope ? { scope: rec.scope } : {}), ...(rec.projectRef ? { projectRef: rec.projectRef } : {}),
        ...(rec.kind ? { kind: rec.kind } : {}), restoredFrom: handle,
    });
    return { result: 'applied', reverted: [handle] };
}

/**
 * M-mem-2 from the local daily counters: how often the owner reverses what was
 * applied without asking (human tool call, clean review, promotion, curator).
 * A rate above 10 % means the automatic-write scope (§3.1) deserves another look.
 */
export function undoRate(rows: ReadonlyArray<{ metric: string; n: number }>): { autoApplied: number; undone: number; rate: number } {
    let autoApplied = 0;
    let undone = 0;
    for (const r of rows) {
        if (/^memory_write_(?:human|review|decision_promotion|curator)_applied$/.test(r.metric)) autoApplied += r.n;
        else if (r.metric === 'memory_write_owner_reverted') undone += r.n;
    }
    return { autoApplied, undone, rate: autoApplied > 0 ? Math.round((undone / autoApplied) * 1000) / 1000 : 0 };
}
