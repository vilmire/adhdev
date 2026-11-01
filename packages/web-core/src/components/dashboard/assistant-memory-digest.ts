/**
 * Assistant memory digest — "what the assistant remembered recently", with undo
 * (docs/design/2026-11-01-assistant-memory.md §3.2).
 *
 * The daemon builds the digest from its write journal (`assistant_memory_digest`)
 * and reverses writes (`assistant_memory_undo`). Both are owner-only verbs on the
 * dashboard's normal command transport; memory text never travels the server
 * status path. This module only shapes the answers, defensively: the answer
 * crosses a process boundary from a daemon whose version we do not control.
 */
import { ASSISTANT_VERB } from '@adhdev/mesh-shared'

export const ASSISTANT_MEMORY_DIGEST_COMMAND = ASSISTANT_VERB.memoryDigest
export const ASSISTANT_MEMORY_UNDO_COMMAND = ASSISTANT_VERB.memoryUndo
/** Owner admin verb; its `merge` action applies a suggested pair. */
export const ASSISTANT_MEMORY_MERGE_COMMAND = ASSISTANT_VERB.storeAdmin

export type AssistantMemoryDigestState = 'applied' | 'staged' | 'reverted' | 'undone'

export interface AssistantMemoryDigestEntry {
    /** Undo handle (journal id). */
    id: string
    ts: string
    tier: 'core' | 'archive'
    target: 'memory' | 'user'
    scope?: string
    action: 'add' | 'replace' | 'remove' | 'archive'
    text: string
    origin: string
    batchId?: string
    state: AssistantMemoryDigestState
    undoable: boolean
    promoted: boolean
}

export interface AssistantMemoryDigestCounts {
    added: number
    replaced: number
    removed: number
    promoted: number
    staged: number
    reverted: number
}

/** Something only the owner should act on (the daemon never changes these by itself). */
export interface AssistantMemorySuggestion {
    kind: 'duplicate' | 'similar' | 'unused'
    target: 'memory' | 'user'
    tier: 'core' | 'archive'
    scope?: 'archive' | 'project'
    projectRef?: string
    items: string[]
    score?: number
}

export interface AssistantMemoryDigest {
    entries: AssistantMemoryDigestEntry[]
    counts: AssistantMemoryDigestCounts
    truncated: boolean
    suggestions: AssistantMemorySuggestion[]
}

export type AssistantMemoryUndoTarget = { id: string } | { batchId: string }

export interface AssistantMemoryUndoOutcome {
    ok: boolean
    code?: string
}

function rec(v: unknown): Record<string, any> | null {
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : null
}
function s(v: unknown): string {
    return typeof v === 'string' ? v : ''
}
function n(v: unknown): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** Cloud wraps the daemon answer once; standalone does not. */
function unwrap(raw: unknown): Record<string, any> | null {
    const r = rec(raw)
    if (!r) return null
    if (Array.isArray(r.entries)) return r
    const inner = rec(r.result)
    return inner && Array.isArray(inner.entries) ? inner : null
}

const STATES: ReadonlySet<string> = new Set(['applied', 'staged', 'reverted', 'undone'])
const ACTIONS: ReadonlySet<string> = new Set(['add', 'replace', 'remove', 'archive'])

/** Null when the daemon has no digest verb (older daemon): the surface stays hidden. */
export function parseMemoryDigest(raw: unknown): AssistantMemoryDigest | null {
    const a = unwrap(raw)
    if (!a) return null
    const entries: AssistantMemoryDigestEntry[] = []
    for (const e of a.entries as unknown[]) {
        const r = rec(e)
        if (!r || !s(r.id) || !STATES.has(s(r.state)) || !ACTIONS.has(s(r.action))) continue
        entries.push({
            id: s(r.id),
            ts: s(r.ts),
            tier: r.tier === 'archive' ? 'archive' : 'core',
            target: r.target === 'user' ? 'user' : 'memory',
            ...(s(r.scope) ? { scope: s(r.scope) } : {}),
            action: s(r.action) as AssistantMemoryDigestEntry['action'],
            text: s(r.text),
            origin: s(r.origin),
            ...(s(r.batchId) ? { batchId: s(r.batchId) } : {}),
            state: s(r.state) as AssistantMemoryDigestState,
            undoable: r.undoable === true,
            promoted: r.promoted === true,
        })
    }
    const c = rec(a.counts) ?? {}
    const suggestions: AssistantMemorySuggestion[] = []
    for (const sg of Array.isArray(a.suggestions) ? a.suggestions as unknown[] : []) {
        const r = rec(sg)
        const items = Array.isArray(r?.items) ? (r!.items as unknown[]).filter((x): x is string => typeof x === 'string') : []
        if (!r || !['duplicate', 'similar', 'unused'].includes(s(r.kind)) || !items.length) continue
        suggestions.push({
            kind: s(r.kind) as AssistantMemorySuggestion['kind'],
            target: r.target === 'user' ? 'user' : 'memory',
            tier: r.tier === 'archive' ? 'archive' : 'core',
            ...(r.scope === 'archive' || r.scope === 'project' ? { scope: r.scope as 'archive' | 'project' } : {}),
            ...(s(r.projectRef) ? { projectRef: s(r.projectRef) } : {}),
            items,
            ...(typeof r.score === 'number' ? { score: r.score } : {}),
        })
    }
    return {
        entries,
        counts: { added: n(c.added), replaced: n(c.replaced), removed: n(c.removed), promoted: n(c.promoted), staged: n(c.staged), reverted: n(c.reverted) },
        truncated: a.truncated === true,
        suggestions,
    }
}

/** Entries that still stand (applied, not undone): what the badge counts. */
export function standingMemoryChanges(d: AssistantMemoryDigest | null): number {
    if (!d) return 0
    return d.counts.added + d.counts.replaced + d.counts.removed + d.counts.promoted
}

export interface AssistantMemoryDigestRow {
    /** The entries one undo reverses (an archive move is two journal lines, one undo). */
    entries: AssistantMemoryDigestEntry[]
    batchId?: string
}

/** Entries sharing a `batchId` collapse into one row with one undo. */
export function groupDigestRows(entries: readonly AssistantMemoryDigestEntry[]): AssistantMemoryDigestRow[] {
    const rows: AssistantMemoryDigestRow[] = []
    const byBatch = new Map<string, AssistantMemoryDigestRow>()
    for (const e of entries) {
        if (!e.batchId) { rows.push({ entries: [e] }); continue }
        const row = byBatch.get(e.batchId)
        if (row) row.entries.push(e)
        else {
            const created: AssistantMemoryDigestRow = { entries: [e], batchId: e.batchId }
            byBatch.set(e.batchId, created)
            rows.push(created)
        }
    }
    return rows
}

export function parseMemoryUndoOutcome(raw: unknown): AssistantMemoryUndoOutcome {
    const r = rec(raw)
    if (!r) return { ok: false, code: 'no_answer' }
    const inner = rec(r.result) ?? r
    if (r.success === true && (s(inner.result) === 'applied' || s(r.result) === 'applied')) return { ok: true }
    return { ok: false, code: s(r.code) || s(inner.code) || s(inner.result) || s(r.result) || 'failed' }
}

/** The `assistant_store_admin` payload that applies a duplicate / similar suggestion (keep the first, drop the second). */
export function mergePayload(sg: AssistantMemorySuggestion): Record<string, unknown> | null {
    if (sg.kind === 'unused' || sg.items.length < 2) return null
    return {
        target: 'memory', action: 'merge', file: sg.target, keep: sg.items[0], drop: sg.items[1],
        ...(sg.tier === 'archive' ? { scope: sg.scope ?? 'archive' } : {}),
        ...(sg.projectRef ? { projectRef: sg.projectRef } : {}),
    }
}
