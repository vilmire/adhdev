/**
 * Archive-tier memory writes (docs/design/2026-11-01-assistant-memory.md §3.3–3.5).
 *
 * `AssistantMemoryStore.applyInner` hands every op that is not a plain core-file
 * add/replace/remove here: project-scoped and global-archive entries, and the
 * `archive` action that moves a core entry down. The check order is the core
 * tier's, on purpose: USER origin → origin scope → format → match → duplicate →
 * credential → content → origin staging → apply. Nothing here writes a row
 * without passing them, and every attempt is journaled (`tier: 'archive'`).
 */

import { randomBytes } from 'crypto';
import {
    detectCredential, mustStage, scanWriteContent, userTargetAllowed, type StoreWriteOrigin,
} from '../store-guards.js';
import { firstChars, validateContent } from './memory-content.js';
import { ARCHIVE_KINDS, type ArchiveEntry, type ArchiveKind, type ArchiveScope, type MemoryArchive } from './memory-archive.js';
import type {
    MemoryApplyExtra, MemoryChangeEvent, MemoryFileState, MemoryJournalRecord, MemoryJournalResult,
    MemoryOperation, MemoryTarget, MemoryWriteOutcome,
} from './memory-store.js';
import { originScopeDenied } from './memory-store.js';

const CANDIDATE_PREVIEW_CHARS = 60;

export interface ArchiveOpHost {
    archive: MemoryArchive | null;
    readCore(target: MemoryTarget): MemoryFileState;
    journal(rec: Omit<MemoryJournalRecord, 'ts' | 'redacted' | 'jid'>): void;
    stage(op: MemoryOperation, origin: StoreWriteOrigin, reviewTurnId: string | undefined): string;
    applyCore(op: MemoryOperation, origin: StoreWriteOrigin, extra: MemoryApplyExtra): MemoryWriteOutcome;
    emit(e: MemoryChangeEvent): void;
}

type Resolving = { stagedId: string; resolvedBy: 'owner' } | undefined;

export function archiveScopeOf(op: { scope?: string }): ArchiveScope {
    return op.scope === 'project' ? 'project' : 'global';
}

/** `preference` ⇔ USER target; everything else is `rule` unless the caller picked env/lesson. */
export function archiveKindFor(target: MemoryTarget, kind: ArchiveKind | undefined): ArchiveKind | 'bad' {
    if (target === 'user') return kind && kind !== 'preference' ? 'bad' : 'preference';
    if (kind === undefined) return 'rule';
    return kind === 'preference' || !ARCHIVE_KINDS.includes(kind) ? 'bad' : kind;
}

export function applyArchiveTier(
    host: ArchiveOpHost,
    op: MemoryOperation,
    origin: StoreWriteOrigin,
    resolving: Resolving,
    reviewTurnId: string | undefined,
    extra: MemoryApplyExtra,
): MemoryWriteOutcome {
    if (op.action === 'archive') return applyMove(host, op, origin, resolving, reviewTurnId, extra);

    const scope = archiveScopeOf(op);
    const projectRef = scope === 'project' ? (op.projectRef ?? '') : null;
    const content = op.action === 'remove' ? null : typeof op.content === 'string' ? op.content.trim() : '';
    const kindOrBad = archiveKindFor(op.target, op.kind);
    let before: string | null = null;
    let target: ArchiveEntry | null = null;

    const journal = (result: MemoryJournalResult, jx?: { stagedId?: string }) =>
        host.journal({
            action: op.action,
            target: op.target,
            before,
            after: content,
            origin,
            result: extra.restoredFrom && result === 'applied' ? 'reverted' : result,
            stagedId: jx?.stagedId ?? resolving?.stagedId,
            resolvedBy: resolving?.resolvedBy,
            reviewTurnId,
            tier: 'archive',
            ...(target ? { entryId: target.id } : {}),
            scope: op.scope ?? 'archive',
            ...(projectRef ? { projectRef } : {}),
            ...(kindOrBad !== 'bad' ? { kind: kindOrBad } : {}),
            ...(extra.batchId ? { batchId: extra.batchId } : {}),
            ...(extra.restoredFrom ? { restoredFrom: extra.restoredFrom } : {}),
            ...(op.sourceRef ? { sourceRef: op.sourceRef } : {}),
        });
    const fail = (outcome: Exclude<MemoryWriteOutcome, { result: 'applied' | 'staged' }>) => (journal(outcome.result), outcome);

    const archive = host.archive;
    if (!archive) return fail({ result: 'memory_archive_unavailable' });
    if (!resolving && op.target === 'user' && !userTargetAllowed(origin)) return fail({ result: 'memory_user_requires_human' });
    if (originScopeDenied(op, origin)) return fail({ result: 'memory_origin_scope_denied' });
    if (kindOrBad === 'bad') return fail({ result: 'memory_invalid_format', reason: 'bad_kind' });
    if (scope === 'project' && !projectRef) return fail({ result: 'memory_invalid_format', reason: 'bad_scope' });
    const kind: ArchiveKind = kindOrBad;

    if (content !== null) {
        const reason = validateContent(content);
        if (reason) return fail({ result: 'memory_invalid_format', reason });
    }
    if (op.action !== 'add') {
        const match = typeof op.match === 'string' ? op.match : '';
        if (!match.trim()) return fail({ result: 'memory_invalid_format', reason: 'empty_match' });
        // A USER-target op only sees preferences and a MEMORY-target op never does.
        const pool = archive.active(scope, projectRef).filter((e) => (e.kind === 'preference') === (op.target === 'user'));
        const hits = pool.filter((e) => (extra.exactMatch ? e.text === match : e.text.includes(match)));
        if (hits.length === 0) return fail({ result: 'memory_no_match' });
        if (hits.length > 1) return fail({ result: 'memory_ambiguous', candidates: hits.map((e) => firstChars(e.text, CANDIDATE_PREVIEW_CHARS)) });
        target = hits[0]!;
        before = target.text;
        if (op.action === 'replace' && before === content) return fail({ result: 'memory_duplicate' });
    }
    if (content !== null && !(op.action === 'replace' && target && archive.findActiveByText(scope, projectRef, content)?.id === target.id)) {
        if (archive.findActiveByText(scope, projectRef, content)) return fail({ result: 'memory_duplicate' });
    }
    if (content !== null && detectCredential(content)) return fail({ result: 'memory_secret_rejected' });
    const finding = content !== null ? scanWriteContent(content) : null;
    if (finding) {
        return fail(finding.kind === 'hidden_chars'
            ? { result: 'memory_hidden_chars_rejected', pattern: finding.pattern }
            : { result: 'memory_injection_rejected', pattern: finding.pattern });
    }
    if (!resolving && mustStage(origin)) {
        const stagedId = host.stage(op, origin, reviewTurnId);
        journal('staged', { stagedId });
        return { result: 'staged', stagedId };
    }

    if (op.action === 'add') {
        const added = archive.add({ scope, projectRef, kind, text: content!, origin, sourceRef: op.sourceRef ?? null });
        if (added.result !== 'applied') {
            if (added.result === 'memory_duplicate') return fail({ result: 'memory_duplicate' });
            return fail({ result: 'memory_budget_exceeded', used: added.used, budget: added.budget });
        }
        target = added.entry;
    } else if (op.action === 'replace') {
        archive.replaceText(target!.id, content!, op.kind);
    } else {
        archive.archive(target!.id);
    }
    journal('applied');
    host.emit({
        tier: 'archive', target: op.target, action: op.action, origin, text: content ?? before ?? '',
        reverted: !!extra.restoredFrom, scope: op.scope ?? 'archive', kind,
    });
    return { result: 'applied' };
}

/**
 * `archive` action: move a core entry down to the archive tier so it stops
 * costing prompt budget but stays searchable. Two journaled steps share one
 * `batchId`, so one undo restores both. The row is added first and purged again
 * if the file removal fails, so an entry is never lost half-way.
 */
function applyMove(
    host: ArchiveOpHost,
    op: Extract<MemoryOperation, { action: 'archive' }>,
    origin: StoreWriteOrigin,
    resolving: Resolving,
    reviewTurnId: string | undefined,
    extra: MemoryApplyExtra,
): MemoryWriteOutcome {
    const journalFail = (result: MemoryJournalResult, before: string | null, stagedId?: string) =>
        host.journal({
            action: 'archive', target: op.target, before, after: null, origin, result,
            stagedId: stagedId ?? resolving?.stagedId, resolvedBy: resolving?.resolvedBy, reviewTurnId,
            tier: 'core', ...(extra.batchId ? { batchId: extra.batchId } : {}),
        });
    const fail = (outcome: Exclude<MemoryWriteOutcome, { result: 'applied' | 'staged' }>, before: string | null = null) => (journalFail(outcome.result, before), outcome);

    const archive = host.archive;
    if (!archive) return fail({ result: 'memory_archive_unavailable' });
    if (!resolving && op.target === 'user' && !userTargetAllowed(origin)) return fail({ result: 'memory_user_requires_human' });
    if (originScopeDenied(op, origin)) return fail({ result: 'memory_origin_scope_denied' });
    const kind = archiveKindFor(op.target, op.kind);
    if (kind === 'bad') return fail({ result: 'memory_invalid_format', reason: 'bad_kind' });
    const state = host.readCore(op.target);
    if (state.unreadable) return fail({ result: 'memory_store_unreadable' });
    const match = typeof op.match === 'string' ? op.match : '';
    if (!match.trim()) return fail({ result: 'memory_invalid_format', reason: 'empty_match' });
    const hits = state.entries.filter((e) => e.includes(match));
    if (hits.length === 0) return fail({ result: 'memory_no_match' });
    if (hits.length > 1) return fail({ result: 'memory_ambiguous', candidates: hits.map((e) => firstChars(e, CANDIDATE_PREVIEW_CHARS)) });
    const text = hits[0]!;
    if (archive.findActiveByText('global', null, text)) return fail({ result: 'memory_duplicate' }, text);
    if (!resolving && mustStage(origin)) {
        const stagedId = host.stage(op, origin, reviewTurnId);
        journalFail('staged', text, stagedId);
        return { result: 'staged', stagedId };
    }

    const batchId = extra.batchId ?? `b${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
    // The row is added first. The origin is the writer's own: archiving does not launder provenance.
    const added = archive.add({ scope: 'global', kind, text, origin });
    if (added.result !== 'applied') {
        return added.result === 'memory_duplicate'
            ? fail({ result: 'memory_duplicate' }, text)
            : fail({ result: 'memory_budget_exceeded', used: added.used, budget: added.budget }, text);
    }
    const removed = host.applyCore({ action: 'remove', target: op.target, match: text }, resolving ? 'owner' : origin, { batchId, exactMatch: true });
    if (removed.result !== 'applied') {
        archive.purge(added.entry.id);
        return removed;
    }
    host.journal({
        action: 'add', target: op.target, before: null, after: text, origin, result: 'applied',
        reviewTurnId, tier: 'archive', entryId: added.entry.id, scope: 'archive', kind, batchId,
    });
    host.emit({ tier: 'archive', target: op.target, action: 'add', origin, text, reverted: false, scope: 'archive', kind });
    return { result: 'applied' };
}
