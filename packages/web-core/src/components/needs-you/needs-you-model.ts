/**
 * "Needs you" model (structured-missions design 2026-10-28 §6.2): the pure part of the
 * owner-decision inbox — wire parsing of `mission_decisions_list`, the unified entry
 * list (decisions, approvals, live checks, coordinator close confirmations), urgency
 * sorting, kind/project filtering, "answer all with recommended" planning, deep-link
 * query parsing and the small label rules. No React, no transport.
 */
import { OWNER_ABANDON_CONFIRM_OPTIONS, OWNER_ABANDON_CONFIRM_QUESTION, isCarryOverMissionTitle } from '@adhdev/mesh-shared'
import type { PendingApprovalItem } from '../MeshGraph/PendingApprovalsInbox'
import type { AssistantStagedItem } from '../dashboard/assistant-staged'

// ─── wire types (mirror daemon-core OwnerDecisionEntry & friends; additive/optional) ───

export interface NeedsYouOption { id: string; label: string; detail?: string }

export interface NeedsYouDecision {
    daemonId: string
    meshId: string
    missionId: string
    missionTitle: string
    itemId: string
    question: string
    context?: string
    options: NeedsYouOption[]
    recommended?: string
    allowFreeText: boolean
    urgency: 'normal' | 'blocking'
    dueAt?: string
    onDue: 'remind' | 'apply_recommended'
    source: 'coordinator' | 'worker' | 'daemon'
    createdAt: string
    carryOver?: boolean
}

export interface NeedsYouLiveCheck {
    daemonId: string
    meshId: string
    missionId: string
    missionTitle: string
    itemId: string
    text: string
    machine?: string
    createdAt: string
    carryOver?: boolean
}

export interface NeedsYouAnswered {
    daemonId: string
    meshId: string
    missionId: string
    itemId: string
    question: string
    answer: { optionId?: string; text?: string; by: string; via: string; at: string }
    revision: number
    deliveryState?: 'pending' | 'queued' | 'sent' | 'acked'
    autoApplied: boolean
    options: NeedsYouOption[]
    recommended?: string
    allowFreeText: boolean
}

export interface NeedsYouMissionStructure {
    daemonId: string
    meshId: string
    missionId: string
    summary?: string
    openItems: { remaining: number; live_check: number; decision: number; evidence: number }
    carryOver?: boolean
}

export interface NeedsYouSnapshot {
    decisions: NeedsYouDecision[]
    liveChecks: NeedsYouLiveCheck[]
    answered: NeedsYouAnswered[]
    missions: NeedsYouMissionStructure[]
    hostedMeshIds: string[]
    /** meshId → project name, as the hosting daemon knows it. */
    meshNames: Record<string, string>
}

export const EMPTY_NEEDS_YOU_SNAPSHOT: NeedsYouSnapshot = { decisions: [], liveChecks: [], answered: [], missions: [], hostedMeshIds: [], meshNames: {} }

export const NEEDS_YOU_LIST_COMMAND = 'mission_decisions_list'
export const NEEDS_YOU_ANSWER_COMMAND = 'mission_decision_answer'

// ─── parsing ──────────────────────────────────────────────────────────────

function rec(v: unknown): Record<string, any> | null {
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : null
}
function s(v: unknown): string { return typeof v === 'string' ? v : '' }

function parseOptions(v: unknown): NeedsYouOption[] {
    if (!Array.isArray(v)) return []
    const out: NeedsYouOption[] = []
    for (const raw of v) {
        const o = rec(raw)
        if (!o || !s(o.id) || !s(o.label)) continue
        out.push({ id: s(o.id), label: s(o.label), ...(s(o.detail) ? { detail: s(o.detail) } : {}) })
    }
    return out
}

/** The transports wrap differently (cloud: `{ result: body }`, standalone: body) — read the inner body. */
export function unwrapCommandBody(raw: unknown): Record<string, any> | null {
    const outer = rec(raw)
    if (!outer) return null
    return rec(outer.result) ?? outer
}

/** Parse one daemon's `mission_decisions_list` answer. Unusable rows are dropped, never thrown on. */
export function parseNeedsYouList(raw: unknown, daemonId: string): NeedsYouSnapshot {
    const body = unwrapCommandBody(raw)
    if (!body || body.success === false) return EMPTY_NEEDS_YOU_SNAPSHOT
    const decisions: NeedsYouDecision[] = []
    for (const r of Array.isArray(body.ownerDecisions) ? body.ownerDecisions : []) {
        const d = rec(r)
        if (!d || !s(d.meshId) || !s(d.itemId) || !s(d.question)) continue
        decisions.push({
            daemonId, meshId: s(d.meshId), missionId: s(d.missionId), missionTitle: s(d.missionTitle),
            itemId: s(d.itemId), question: s(d.question),
            ...(s(d.context) ? { context: s(d.context) } : {}),
            options: parseOptions(d.options),
            ...(s(d.recommended) ? { recommended: s(d.recommended) } : {}),
            allowFreeText: d.allowFreeText !== false,
            urgency: d.urgency === 'blocking' ? 'blocking' : 'normal',
            ...(s(d.dueAt) ? { dueAt: s(d.dueAt) } : {}),
            onDue: d.onDue === 'apply_recommended' ? 'apply_recommended' : 'remind',
            source: d.source === 'worker' ? 'worker' : d.source === 'daemon' ? 'daemon' : 'coordinator',
            createdAt: s(d.createdAt),
            ...(d.carryOver === true ? { carryOver: true } : {}),
        })
    }
    const liveChecks: NeedsYouLiveCheck[] = []
    for (const r of Array.isArray(body.liveChecks) ? body.liveChecks : []) {
        const c = rec(r)
        if (!c || !s(c.meshId) || !s(c.itemId)) continue
        liveChecks.push({
            daemonId, meshId: s(c.meshId), missionId: s(c.missionId), missionTitle: s(c.missionTitle),
            itemId: s(c.itemId), text: s(c.text),
            ...(s(c.machine) ? { machine: s(c.machine) } : {}),
            createdAt: s(c.createdAt),
            ...(c.carryOver === true ? { carryOver: true } : {}),
        })
    }
    const answered: NeedsYouAnswered[] = []
    for (const r of Array.isArray(body.recentlyAnswered) ? body.recentlyAnswered : []) {
        const a = rec(r)
        const ans = rec(a?.answer)
        if (!a || !ans || !s(a.meshId) || !s(a.itemId) || !s(ans.at)) continue
        answered.push({
            daemonId, meshId: s(a.meshId), missionId: s(a.missionId), itemId: s(a.itemId), question: s(a.question),
            answer: {
                ...(s(ans.optionId) ? { optionId: s(ans.optionId) } : {}),
                ...(s(ans.text) ? { text: s(ans.text) } : {}),
                by: s(ans.by), via: s(ans.via), at: s(ans.at),
            },
            revision: typeof a.revision === 'number' ? a.revision : 1,
            ...(['pending', 'queued', 'sent', 'acked'].includes(a.deliveryState) ? { deliveryState: a.deliveryState } : {}),
            autoApplied: a.autoApplied === true,
            options: parseOptions(a.options),
            ...(s(a.recommended) ? { recommended: s(a.recommended) } : {}),
            allowFreeText: a.allowFreeText !== false,
        })
    }
    const missions: NeedsYouMissionStructure[] = []
    for (const r of Array.isArray(body.missions) ? body.missions : []) {
        const m = rec(r)
        const oi = rec(m?.openItems)
        if (!m || !s(m.meshId) || !s(m.missionId) || !oi) continue
        const n = (k: string) => (typeof oi[k] === 'number' ? oi[k] : 0)
        missions.push({
            daemonId, meshId: s(m.meshId), missionId: s(m.missionId),
            ...(s(m.summary) ? { summary: s(m.summary) } : {}),
            openItems: { remaining: n('remaining'), live_check: n('live_check'), decision: n('decision'), evidence: n('evidence') },
            ...(m.carryOver === true ? { carryOver: true } : {}),
        })
    }
    const hostedMeshIds = Array.isArray(body.hostedMeshIds) ? body.hostedMeshIds.filter((x: unknown): x is string => typeof x === 'string') : []
    const meshNames: Record<string, string> = {}
    for (const [id, name] of Object.entries(rec(body.meshNames) ?? {})) if (typeof name === 'string' && name) meshNames[id] = name
    return { decisions, liveChecks, answered, missions, hostedMeshIds, meshNames }
}

export function mergeNeedsYouSnapshots(parts: NeedsYouSnapshot[]): NeedsYouSnapshot {
    return {
        decisions: parts.flatMap(p => p.decisions),
        liveChecks: parts.flatMap(p => p.liveChecks),
        answered: parts.flatMap(p => p.answered).sort((a, b) => (a.answer.at < b.answer.at ? 1 : -1)),
        missions: parts.flatMap(p => p.missions),
        hostedMeshIds: [...new Set(parts.flatMap(p => p.hostedMeshIds))],
        meshNames: Object.assign({}, ...parts.map(p => p.meshNames)),
    }
}

// ─── unified entries ──────────────────────────────────────────────────────

export type NeedsYouKind = 'decision' | 'approval' | 'live_check' | 'confirmation'
export const NEEDS_YOU_KINDS: readonly NeedsYouKind[] = ['decision', 'approval', 'live_check', 'confirmation']

export type NeedsYouEntry =
    | { kind: 'decision'; key: string; decision: NeedsYouDecision }
    | { kind: 'confirmation'; key: string; decision: NeedsYouDecision }
    | { kind: 'live_check'; key: string; check: NeedsYouLiveCheck }
    | { kind: 'approval'; key: string; approval: PendingApprovalItem }
    /** An owner-held write waiting for approval (assistant held write, driver activation, destructive driver action). Filters as an `approval`. */
    | { kind: 'staged'; key: string; item: AssistantStagedItem }

/** The filter bucket of an entry: held owner approvals sit under the 승인/approval filter. */
export function entryFilterKind(e: NeedsYouEntry): NeedsYouKind {
    return e.kind === 'staged' ? 'approval' : e.kind
}

/** The coordinator's `owner_abandoned` close confirmation (Correct / Reopen). */
export function isCloseConfirmation(d: Pick<NeedsYouDecision, 'question' | 'source' | 'options'>): boolean {
    if (d.question !== OWNER_ABANDON_CONFIRM_QUESTION) return false
    const labels = d.options.map(o => o.label)
    return OWNER_ABANDON_CONFIRM_OPTIONS.every(l => labels.includes(l))
}

/** i18n key suffix of a close-confirmation option label ("Correct" → `optionCorrect`), or undefined for any other label. */
export function confirmationOptionKey(label: string): 'optionCorrect' | 'optionReopen' | undefined {
    if (label === OWNER_ABANDON_CONFIRM_OPTIONS[0]) return 'optionCorrect'
    if (label === OWNER_ABANDON_CONFIRM_OPTIONS[1]) return 'optionReopen'
    return undefined
}

/**
 * The stored canonical context of a close confirmation is `Mission "<title>" (<uuid>) — reason: <reason>`
 * (daemon-core `createOwnerConfirmation`). Returns the title and reason without the id, or null when the
 * text does not have that shape (shown raw then).
 */
export function parseCloseConfirmationContext(context: string | undefined): { title: string; reason?: string } | null {
    if (!context) return null
    const m = /^Mission "([\s\S]*?)" \(([0-9A-Za-z_-]{8,})\)(?: — reason: ([\s\S]*))?$/.exec(context.trim())
    if (!m) return null
    const reason = m[3]?.trim()
    return { title: m[1], ...(reason ? { reason } : {}) }
}

/** `?decision=…&choose=…` removed (a handled deep link must not re-target an answered card); `mesh` and any other param stay. */
export function clearDecisionFromQuery(search: string): string {
    const p = new URLSearchParams(search)
    p.delete('decision')
    p.delete('choose')
    const out = p.toString()
    return out ? `?${out}` : ''
}

export function decisionKey(d: { meshId: string; itemId: string }): string { return `d:${d.meshId}:${d.itemId}` }

export function buildNeedsYouEntries(
    snapshot: Pick<NeedsYouSnapshot, 'decisions' | 'liveChecks'>,
    approvals: readonly PendingApprovalItem[],
    staged: readonly AssistantStagedItem[] = [],
): NeedsYouEntry[] {
    const out: NeedsYouEntry[] = []
    for (const approval of approvals) out.push({ kind: 'approval', key: `a:${approval.nodeId}:${approval.sessionId}`, approval })
    for (const item of staged) out.push({ kind: 'staged', key: `s:${item.id}`, item })
    for (const decision of snapshot.decisions) {
        out.push({ kind: isCloseConfirmation(decision) ? 'confirmation' : 'decision', key: decisionKey(decision), decision })
    }
    for (const check of snapshot.liveChecks) out.push({ kind: 'live_check', key: `l:${check.meshId}:${check.itemId}`, check })
    return out
}

function dueMs(iso: string | undefined): number {
    if (!iso) return Number.POSITIVE_INFINITY
    const t = Date.parse(iso)
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY
}

/** Lower = more urgent. Approvals (an agent is stuck right now) → blocking decisions → other decisions → close confirmations → live checks. */
function rank(e: NeedsYouEntry): number {
    switch (e.kind) {
        case 'approval': return 0
        case 'staged': return 0
        case 'decision': return e.decision.urgency === 'blocking' ? 1 : 2
        case 'confirmation': return 3
        case 'live_check': return 4
    }
}

function createdOf(e: NeedsYouEntry): string {
    return e.kind === 'live_check' ? e.check.createdAt : e.kind === 'approval' ? '' : e.kind === 'staged' ? e.item.createdAt ?? '' : e.decision.createdAt
}

/** Most urgent first; stable. Approvals by longest wait, decisions by nearest due then oldest. */
export function sortNeedsYou(entries: readonly NeedsYouEntry[]): NeedsYouEntry[] {
    return [...entries].sort((a, b) => {
        const ra = rank(a)
        const rb = rank(b)
        if (ra !== rb) return ra - rb
        if (a.kind === 'approval' && b.kind === 'approval') return (a.approval.waitingSince ?? Infinity) - (b.approval.waitingSince ?? Infinity)
        if ((a.kind === 'decision' || a.kind === 'confirmation') && (b.kind === 'decision' || b.kind === 'confirmation')) {
            const da = dueMs(a.decision.dueAt)
            const db = dueMs(b.decision.dueAt)
            if (da !== db) return da < db ? -1 : 1
        }
        const ca = createdOf(a)
        const cb = createdOf(b)
        return ca < cb ? -1 : ca > cb ? 1 : 0
    })
}

export interface NeedsYouFilter {
    kind: NeedsYouKind | 'all'
    /** Project (mesh) id, or 'all'. Approvals carry no project and are hidden while one is chosen. */
    meshId: string | 'all'
}

export function entryMeshId(e: NeedsYouEntry): string | null {
    return e.kind === 'live_check' ? e.check.meshId : e.kind === 'approval' || e.kind === 'staged' ? null : e.decision.meshId
}

export function filterNeedsYou(entries: readonly NeedsYouEntry[], f: NeedsYouFilter): NeedsYouEntry[] {
    return entries.filter(e => (f.kind === 'all' || entryFilterKind(e) === f.kind) && (f.meshId === 'all' || entryMeshId(e) === f.meshId))
}

/** What the nav badge counts: open decisions (incl. close confirmations) + approvals. */
export function needsYouCount(entries: readonly NeedsYouEntry[]): number {
    return entries.filter(e => e.kind !== 'live_check').length
}

// ─── answer all with recommended (acceptance 5) ─────────────────────────────

export interface RecommendedPlanLine {
    decision: NeedsYouDecision
    optionId: string
    optionLabel: string
}

/** Only decisions whose `recommended` names an existing option are answered; the rest are skipped. */
export function planRecommendedAnswers(entries: readonly NeedsYouEntry[]): RecommendedPlanLine[] {
    const out: RecommendedPlanLine[] = []
    for (const e of entries) {
        if (e.kind !== 'decision') continue
        const opt = e.decision.recommended ? e.decision.options.find(o => o.id === e.decision.recommended) : undefined
        if (opt) out.push({ decision: e.decision, optionId: opt.id, optionLabel: opt.label })
    }
    return out
}

// ─── deep link ──────────────────────────────────────────────────────────────

export interface NeedsYouDeepLink { meshId?: string; decisionId?: string; choose?: string }

/** `/needs-you?mesh=<meshId>&decision=<itemId>&choose=<optionId>` (bundle F's push links land here). */
export function parseNeedsYouQuery(search: string): NeedsYouDeepLink {
    const p = new URLSearchParams(search)
    const get = (k: string) => p.get(k)?.trim() || undefined
    const meshId = get('mesh')
    const decisionId = get('decision')
    const choose = get('choose')
    return { ...(meshId ? { meshId } : {}), ...(decisionId ? { decisionId } : {}), ...(choose && decisionId ? { choose } : {}) }
}

// ─── labels ─────────────────────────────────────────────────────────────────

/** Answered more than this long ago → "may already be in progress" (design §6.4). */
export const ANSWER_IN_PROGRESS_AFTER_MS = 10 * 60 * 1000

export function mayAlreadyBeInProgress(answeredAtIso: string, nowMs: number): boolean {
    const t = Date.parse(answeredAtIso)
    return Number.isFinite(t) && nowMs - t > ANSWER_IN_PROGRESS_AFTER_MS
}

export interface DueInfo { state: 'overdue' | 'upcoming'; ms: number; autoApply: boolean }

export function dueInfo(d: Pick<NeedsYouDecision, 'dueAt' | 'onDue' | 'recommended'>, nowMs: number): DueInfo | null {
    const due = dueMs(d.dueAt)
    if (!Number.isFinite(due)) return null
    const delta = due - nowMs
    return { state: delta < 0 ? 'overdue' : 'upcoming', ms: Math.abs(delta), autoApply: d.onDue === 'apply_recommended' && !!d.recommended }
}

/** "5m", "3h 04m", "2d" — a rough span for due/overdue labels. */
export function formatSpan(ms: number): string {
    const m = Math.floor(ms / 60_000)
    if (m < 1) return '<1m'
    if (m < 60) return `${m}m`
    const h = Math.floor(m / 60)
    if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m`
    return `${Math.floor(h / 24)}d`
}

/**
 * Display title of a mission: the auto carry-over mission stores an English title, so it is
 * shown through the locale string instead (the `carryOver` flag decides; the stored title is the
 * fallback for wire views that cannot carry the flag).
 */
export function missionDisplayTitle(
    mission: { title?: string; carryOver?: boolean },
    carryOverLabel: string,
): string {
    const title = mission.title ?? ''
    return mission.carryOver === true || isCarryOverMissionTitle(title) ? carryOverLabel : title
}

/** How an answer reads: `Label`, free text, or both. */
export function describeAnswer(a: { optionId?: string; text?: string }, options: readonly NeedsYouOption[]): string {
    const opt = a.optionId ? options.find(o => o.id === a.optionId) : undefined
    return [a.optionId ? (opt?.label ?? a.optionId) : '', a.text ?? ''].filter(Boolean).join(' — ')
}
