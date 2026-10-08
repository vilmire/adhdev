/**
 * Assistant staged writes — the owner's "held for your approval" list
 * (design docs/design/2026-10-07-assistant-layer.md §4.10.2, §11 Q8; research
 * 2026-10-08 Q8: one card per review turn, approve all / one by one / reject all).
 *
 * The daemon owns the records; this module only reads the
 * `assistant_staged_resolve {action:'list'}` answer, shapes it for display and
 * reads the resolve answer back into per-item outcomes. The verb is owner-only
 * (p2p / ws / standalone sources, never the assistant's MCP IPC) and travels on
 * the dashboard's normal command transport — never the server status path.
 *
 * Everything here is defensive: the answer crosses a process boundary from a
 * daemon whose version we do not control, so unknown shapes are dropped rather
 * than rendered half-parsed.
 */
import { ASSISTANT_VERB } from '@adhdev/mesh-shared'

export const ASSISTANT_STAGED_COMMAND = ASSISTANT_VERB.stagedResolve

/** What the write changes: the assistant's own memory, the person's profile, a skill, a project note. */
export type AssistantStagedKind = 'memory' | 'user' | 'skill' | 'note'
export type AssistantStagedDecision = 'apply' | 'discard'

export interface AssistantStagedItem {
    id: string
    kind: AssistantStagedKind
    /** Store verb that was held: add / replace / remove / create / patch / archive / record / forget. */
    action: string
    /** Skill name or project slug; empty for memory (the kind names the file). */
    target: string
    /** relay / review / review_tainted / human / owner (raw daemon value). */
    origin: string
    createdAt: string
    reviewTurnId?: string
    /** Proposed text for an add / create / record (and the note category or skill file, when set). */
    text?: string
    /** Replace / patch: the text being changed and its replacement. */
    diff?: { before: string; after: string }
    /** Skill only — `protected_skill`: an agent patch on a skill the owner wrote or imported. */
    reason?: string
    /** Note category / skill file path, when the write names one. */
    detail?: string
}

export interface AssistantStagedGroup {
    /** Set for a review turn's writes (batch resolve key); absent for a single write. */
    reviewTurnId?: string
    /** Epoch ms parsed from `review:<ms>`, when the id carries one. */
    reviewAt?: number
    items: AssistantStagedItem[]
}

/** Per-item resolve outcome shown under the item until it leaves the list. */
export interface AssistantStagedOutcome {
    ok: boolean
    code?: string
}

function rec(v: unknown): Record<string, any> | null {
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : null
}

function s(v: unknown): string {
    return typeof v === 'string' ? v : ''
}

/** Cloud wraps the daemon answer once (`{success, result:{…}}`); standalone does not. */
export function unwrapStagedAnswer(raw: unknown): Record<string, any> | null {
    const r = rec(raw)
    if (!r) return null
    const inner = rec(r.result)
    return inner && (Array.isArray(inner.memory) || Array.isArray(inner.results) || 'success' in inner) ? inner : r
}

function base(r: Record<string, any>, kind: AssistantStagedKind, action: string, target: string): AssistantStagedItem | null {
    const id = s(r.id)
    if (!id) return null
    return {
        id,
        kind,
        action,
        target,
        origin: s(r.origin),
        createdAt: s(r.createdAt),
        ...(s(r.reviewTurnId) ? { reviewTurnId: s(r.reviewTurnId) } : {}),
    }
}

function memoryItem(r: Record<string, any>): AssistantStagedItem | null {
    const op = rec(r.op)
    if (!op) return null
    const action = s(op.action)
    const item = base(r, op.target === 'user' ? 'user' : 'memory', action, '')
    if (!item) return null
    if (action === 'add') item.text = s(op.content)
    else if (action === 'replace') item.diff = { before: s(op.match), after: s(op.content) }
    else if (action === 'remove') item.diff = { before: s(op.match), after: '' }
    return item
}

function skillItem(r: Record<string, any>): AssistantStagedItem | null {
    const op = rec(r.op)
    if (!op) return null
    const action = s(op.action)
    const item = base(r, 'skill', action, s(op.name))
    if (!item) return null
    if (s(r.reason)) item.reason = s(r.reason)
    if (action === 'create') {
        item.text = [s(op.description), s(op.body)].filter(Boolean).join('\n\n')
    } else if (action === 'patch') {
        if (s(op.file)) item.detail = s(op.file)
        if (typeof op.old === 'string') item.diff = { before: op.old, after: s(op.new) }
        else if (typeof op.new === 'string') item.text = op.new
        else if (typeof op.description === 'string') item.diff = { before: '', after: op.description }
    }
    return item
}

function noteItem(r: Record<string, any>): AssistantStagedItem | null {
    const op = rec(r.op)
    if (!op) return null
    const action = s(op.action)
    const item = base(r, 'note', action, s(r.project))
    if (!item) return null
    if (s(op.category)) item.detail = s(op.category)
    if (action === 'record') item.text = s(op.text)
    else if (action === 'forget') item.diff = { before: s(op.text) || s(op.noteId), after: '' }
    return item
}

/**
 * The list answer → items, oldest first. Returns null when the answer is not
 * a list at all (older daemon without the verb, refusal, transport error) so
 * the caller can hide the surface instead of claiming "0 pending".
 */
export function parseStagedList(raw: unknown): AssistantStagedItem[] | null {
    const r = unwrapStagedAnswer(raw)
    if (!r || r.success === false) return null
    if (!Array.isArray(r.memory) && !Array.isArray(r.skills) && !Array.isArray(r.notes)) return null
    const out: AssistantStagedItem[] = []
    const take = (list: unknown, fn: (x: Record<string, any>) => AssistantStagedItem | null) => {
        if (!Array.isArray(list)) return
        for (const x of list) {
            const row = rec(x)
            const item = row ? fn(row) : null
            if (item) out.push(item)
        }
    }
    take(r.memory, memoryItem)
    take(r.skills, skillItem)
    take(r.notes, noteItem)
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/** `review:<ms>` → ms. */
export function reviewTurnTime(reviewTurnId: string | undefined): number | undefined {
    const m = /^review:(\d+)$/.exec(reviewTurnId || '')
    const ms = m ? Number(m[1]) : NaN
    return Number.isFinite(ms) && ms > 0 ? ms : undefined
}

/**
 * One group per review turn (its writes resolve together), every other write on
 * its own. Groups keep the order of their oldest write.
 */
export function groupStagedItems(items: ReadonlyArray<AssistantStagedItem>): AssistantStagedGroup[] {
    const groups: AssistantStagedGroup[] = []
    const byReview = new Map<string, AssistantStagedGroup>()
    for (const item of items) {
        if (!item.reviewTurnId) {
            groups.push({ items: [item] })
            continue
        }
        let g = byReview.get(item.reviewTurnId)
        if (!g) {
            const at = reviewTurnTime(item.reviewTurnId)
            g = { reviewTurnId: item.reviewTurnId, ...(at ? { reviewAt: at } : {}), items: [] }
            byReview.set(item.reviewTurnId, g)
            groups.push(g)
        }
        g.items.push(item)
    }
    return groups
}

function codeOf(r: Record<string, any> | null, fallback: string): string {
    return s(r?.code) || s(r?.result) || s(r?.error) || fallback
}

/**
 * The resolve answer → outcome per item id. A single resolve maps to `ids[0]`;
 * a review batch reads its `results[]` (one per write — a write whose re-check
 * failed stays staged and carries its own code, `staged_batch_partial`).
 */
export function parseResolveOutcomes(raw: unknown, ids: ReadonlyArray<string>): Record<string, AssistantStagedOutcome> {
    const r = unwrapStagedAnswer(raw)
    const out: Record<string, AssistantStagedOutcome> = {}
    if (r && Array.isArray(r.results)) {
        for (const x of r.results) {
            const row = rec(x)
            const id = s(row?.id)
            if (!id) continue
            out[id] = row?.success === true ? { ok: true } : { ok: false, code: codeOf(row, 'failed') }
        }
        return out
    }
    const ok = !!r && r.success !== false
    for (const id of ids) out[id] = ok ? { ok: true } : { ok: false, code: codeOf(r, 'failed') }
    return out
}
