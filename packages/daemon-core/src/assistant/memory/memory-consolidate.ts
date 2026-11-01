/**
 * Periodic memory housekeeping (docs/design/2026-11-01-assistant-memory.md §3.9, §3.10).
 *
 * Runs inside the existing 24 h curator pass (no new timer) and is DETERMINISTIC:
 * no model call, no semantic merging.
 *
 *  1. Exact duplicates (equal after lower-casing and dropping whitespace and
 *     punctuation): keep the newest, remove the rest — for the MEMORY file and
 *     the archive tier, as origin `curator` through the normal journaled write
 *     path, one `batchId` per pass so a single undo restores them all. USER
 *     entries are a person's own words: never touched, only SUGGESTED.
 *  2. Similar entries (token Jaccard >= 0.8) and long-unused human entries: only
 *     ever SUGGESTED, in the owner's digest. Merging them is an owner action.
 *  3. Expiry: review-written `lesson` rows past their TTL are soft-deleted
 *     (undoable for 30 days, then purged). Nothing a person wrote ever expires.
 *  4. Project memory of projects that no longer exist is soft-deleted.
 */

import { randomBytes } from 'crypto';
import type { AssistantMemoryStore, MemoryTarget } from './memory-store.js';
import { normalizeMemoryText, tokenJaccard } from './memory-content.js';
import type { ArchiveEntry } from './memory-archive.js';

export const SIMILAR_THRESHOLD = 0.8;
const SUGGESTIONS_MAX = 30;

export type MemorySuggestion =
    | { kind: 'duplicate'; target: MemoryTarget; tier: 'core' | 'archive'; scope?: 'archive' | 'project'; projectRef?: string; items: [string, string] }
    | { kind: 'similar'; target: MemoryTarget; tier: 'core' | 'archive'; scope?: 'archive' | 'project'; projectRef?: string; items: [string, string]; score: number }
    | { kind: 'unused'; target: MemoryTarget; tier: 'archive'; scope: 'archive' | 'project'; projectRef?: string; items: [string]; id: string };

export interface ConsolidationReport {
    duplicatesRemoved: { core: number; archive: number };
    lessonsExpired: number;
    purged: number;
    projectEntriesArchived: number;
    suggestions: number;
    skipped: string[];
}

function newBatch(prefix: string, now: number): string {
    return `${prefix}${now.toString(36)}${randomBytes(3).toString('hex')}`;
}

function groupBy<T>(items: readonly T[], key: (t: T) => string): T[][] {
    const m = new Map<string, T[]>();
    for (const i of items) {
        const k = key(i);
        m.set(k, [...(m.get(k) ?? []), i]);
    }
    return [...m.values()].filter((g) => g.length > 1);
}

const archiveScopeField = (e: ArchiveEntry): { scope: 'archive' | 'project'; projectRef?: string } =>
    e.scope === 'project' ? { scope: 'project', ...(e.projectRef ? { projectRef: e.projectRef } : {}) } : { scope: 'archive' };

/** Everything the owner might want to look at; computed on demand, never stored. */
export function consolidationSuggestions(store: AssistantMemoryStore, now: number): MemorySuggestion[] {
    const out: MemorySuggestion[] = [];
    for (const target of ['memory', 'user'] as const) {
        const st = store.readFile(target);
        if (st.unreadable) continue;
        const bad = new Set(st.invalid.map((i) => i.index));
        const entries = st.entries.filter((_, i) => !bad.has(i));
        const seenDup = new Set<string>();
        // USER duplicates are suggestions only; MEMORY ones are fixed by the pass, so only USER is listed here.
        if (target === 'user') {
            for (const g of groupBy(entries, normalizeMemoryText)) {
                out.push({ kind: 'duplicate', target, tier: 'core', items: [g[0]!, g[1]!] });
                for (const e of g) seenDup.add(e);
            }
        }
        for (let i = 0; i < entries.length; i++) {
            for (let j = i + 1; j < entries.length; j++) {
                const a = entries[i]!;
                const b = entries[j]!;
                if (normalizeMemoryText(a) === normalizeMemoryText(b)) continue;
                const score = tokenJaccard(a, b);
                if (score >= SIMILAR_THRESHOLD) out.push({ kind: 'similar', target, tier: 'core', items: [a, b], score: Math.round(score * 100) / 100 });
            }
        }
    }
    const archive = store.archive;
    if (archive) {
        const active = archive.active();
        const byBucket = new Map<string, ArchiveEntry[]>();
        for (const e of active) {
            const k = `${e.scope}|${e.projectRef ?? ''}|${e.kind === 'preference' ? 'user' : 'memory'}`;
            byBucket.set(k, [...(byBucket.get(k) ?? []), e]);
        }
        for (const list of byBucket.values()) {
            for (let i = 0; i < list.length; i++) {
                for (let j = i + 1; j < list.length; j++) {
                    const a = list[i]!;
                    const b = list[j]!;
                    const target: MemoryTarget = a.kind === 'preference' ? 'user' : 'memory';
                    const base = { target, tier: 'archive' as const, ...archiveScopeField(a), items: [a.text, b.text] as [string, string] };
                    if (normalizeMemoryText(a.text) === normalizeMemoryText(b.text)) {
                        // memory-target duplicates are removed by the pass; only preference ones wait for the owner
                        if (target === 'user') out.push({ kind: 'duplicate', ...base });
                        continue;
                    }
                    const score = tokenJaccard(a.text, b.text);
                    if (score >= SIMILAR_THRESHOLD) out.push({ kind: 'similar', ...base, score: Math.round(score * 100) / 100 });
                }
            }
        }
        for (const e of archive.unusedSuggestions(now)) {
            out.push({ kind: 'unused', target: e.kind === 'preference' ? 'user' : 'memory', tier: 'archive', ...archiveScopeField(e), items: [e.text], id: e.id });
        }
    }
    return out.slice(0, SUGGESTIONS_MAX);
}

/** One maintenance pass. `now` is the store's clock (ms). */
export function consolidateMemory(
    store: AssistantMemoryStore,
    now: number,
    opts: { liveProjectRefs?: () => ReadonlySet<string> | null } = {},
): ConsolidationReport {
    const report: ConsolidationReport = {
        duplicatesRemoved: { core: 0, archive: 0 }, lessonsExpired: 0, purged: 0, projectEntriesArchived: 0, suggestions: 0, skipped: [],
    };
    const dupBatch = newBatch('cd', now);

    // 1a. MEMORY file duplicates: keep the last (newest) occurrence.
    const mem = store.readFile('memory');
    if (mem.unreadable) {
        report.skipped.push('memory_file_unreadable');
    } else {
        const bad = new Set(mem.invalid.map((i) => i.index));
        const valid = mem.entries.filter((_, i) => !bad.has(i));
        for (const group of groupBy(valid, normalizeMemoryText)) {
            for (const older of group.slice(0, -1)) {
                const out = store.apply({ action: 'remove', target: 'memory', match: older }, 'curator', {}, { batchId: dupBatch, exactMatch: true });
                if (out.result === 'applied') report.duplicatesRemoved.core += 1;
                else report.skipped.push(`core_dup:${out.result}`);
            }
        }
    }

    // 1b. Archive-tier duplicates (memory-target rows): keep the most recently updated.
    const archive = store.archive;
    if (archive) {
        const rows = archive.active().filter((e) => e.kind !== 'preference');
        for (const group of groupBy(rows, (e) => `${e.scope}|${e.projectRef ?? ''}|${normalizeMemoryText(e.text)}`)) {
            const keep = [...group].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)[0]!;
            for (const e of group) {
                if (e.id === keep.id) continue;
                const out = store.apply({ action: 'remove', target: 'memory', match: e.text, ...archiveScopeField(e) }, 'curator', {}, { batchId: dupBatch, exactMatch: true });
                if (out.result === 'applied') report.duplicatesRemoved.archive += 1;
                else report.skipped.push(`archive_dup:${out.result}`);
            }
        }

        // 3. Expiry: review-written lessons past their TTL (undoable), then rows past the undo window.
        const expBatch = newBatch('ce', now);
        for (const e of archive.staleLessons(now)) {
            const out = store.apply({ action: 'remove', target: 'memory', match: e.text, ...archiveScopeField(e) }, 'curator', {}, { batchId: expBatch, exactMatch: true });
            if (out.result === 'applied') report.lessonsExpired += 1;
            else report.skipped.push(`lesson:${out.result}`);
        }
        report.purged = archive.purgeGrace(now);

        // 4. Project memory of projects that are gone (never on an empty/unknown inventory).
        const live = opts.liveProjectRefs?.() ?? null;
        if (live && live.size > 0) report.projectEntriesArchived = archive.archiveOrphanProjects(live).length;
    }

    report.suggestions = consolidationSuggestions(store, now).length;
    try {
        archive?.bump('memory_consolidation_removed', report.duplicatesRemoved.core + report.duplicatesRemoved.archive);
        archive?.bump('memory_consolidation_suggested', report.suggestions);
        archive?.bump('memory_lessons_expired', report.lessonsExpired);
    } catch { /* metrics never fail the pass */ }
    return report;
}

/** Owner-approved merge of a suggested pair: drop one entry, optionally rewrite the other, as one undoable batch. */
export function mergeMemoryEntries(
    store: AssistantMemoryStore,
    req: { target: MemoryTarget; keep: string; drop: string; content?: string; scope?: 'core' | 'archive' | 'project'; projectRef?: string },
): { result: string } & Record<string, unknown> {
    const batchId = newBatch('cm', Date.now());
    const scope = req.scope && req.scope !== 'core' ? { scope: req.scope, ...(req.projectRef ? { projectRef: req.projectRef } : {}) } : {};
    const drop = store.apply({ action: 'remove', target: req.target, match: req.drop, ...scope }, 'owner', {}, { batchId, exactMatch: true });
    if (drop.result !== 'applied') return { result: drop.result, step: 'drop' };
    if (typeof req.content === 'string' && req.content.trim() && req.content.trim() !== req.keep) {
        const rep = store.apply({ action: 'replace', target: req.target, match: req.keep, content: req.content, ...scope }, 'owner', {}, { batchId, exactMatch: true });
        if (rep.result !== 'applied') {
            store.undo({ batchId }); // do not leave the pair half merged
            return { result: rep.result, step: 'keep' };
        }
    }
    return { result: 'applied', batchId };
}
