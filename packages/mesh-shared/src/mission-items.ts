/**
 * mission-items — structured mission records: the item kinds a mission carries
 * (remaining work, live checks, owner decisions, evidence), their normalization
 * and limits, dedupe-key derivation and the close outcome enum
 * (docs/design/2026-10-28-structured-missions-and-owner-decisions.md §4, §5).
 *
 * Philosophy (owner 2026-10-28, design §0): NEVER reject for size or shape —
 * over-long text is truncated, extra refs are dropped, unusable items are
 * reported per-item. The only hard rule lives elsewhere (the daemon): a
 * coordinator or worker can never ANSWER a decision, so `answer`/`delivery`
 * are stripped from every caller-supplied `decision` here.
 *
 * Dependency-free leaf: pure functions over plain data, no storage.
 */

export const MISSION_ITEM_KINDS = ['remaining', 'live_check', 'decision', 'evidence'] as const
export type MissionItemKind = typeof MISSION_ITEM_KINDS[number]

export const MISSION_ITEM_STATES = ['open', 'done', 'dropped', 'moved', 'answered', 'expired', 'withdrawn', 'superseded'] as const
export type MissionItemState = typeof MISSION_ITEM_STATES[number]

/** States a coordinator/worker may SET through items_update, per kind. `answered`/`expired` are daemon-owned. */
export const COORDINATOR_SETTABLE_ITEM_STATES: Readonly<Record<MissionItemKind, readonly MissionItemState[]>> = {
    remaining: ['open', 'done', 'dropped'],
    live_check: ['open', 'done', 'dropped'],
    evidence: ['open', 'done', 'dropped'],
    decision: ['open', 'withdrawn', 'superseded'],
}

export const MISSION_OUTCOMES = ['merged', 'verified_live', 'superseded', 'not_needed', 'owner_abandoned', 'unspecified'] as const
export type MissionOutcome = typeof MISSION_OUTCOMES[number]
export function isMissionOutcome(value: unknown): value is MissionOutcome {
    return typeof value === 'string' && (MISSION_OUTCOMES as readonly string[]).includes(value)
}

export const MISSION_REF_KINDS = ['commit', 'branch', 'pr', 'task', 'artifact', 'mission', 'url'] as const
export type MissionRefKind = typeof MISSION_REF_KINDS[number]

export const MISSION_LIMITS = {
    summary: 300,
    outcomeReason: 500,
    itemText: 300,
    machine: 80,
    refs: 8,
    refValue: 300,
    refRepo: 120,
    refNote: 200,
    dedupeKey: 400,
    question: 300,
    context: 600,
    options: 5,
    optionLabel: 60,
    optionDetail: 200,
    /** Open items per mission before the oldest `remaining` fold into a "N more" summary item. */
    openItemsPerMission: 200,
    /** One event payload (serialized). */
    eventPayloadBytes: 16 * 1024,
    /** items_add / items_update entries honoured per call (extra entries are reported, not applied). */
    itemsPerCall: 50,
} as const

export const MISSION_DECISION_OPTION_IDS = ['a', 'b', 'c', 'd', 'e'] as const
export const MISSION_DECISION_URGENCIES = ['normal', 'blocking'] as const
export type MissionDecisionUrgency = typeof MISSION_DECISION_URGENCIES[number]
export const MISSION_DECISION_ON_DUE = ['remind', 'apply_recommended'] as const
export type MissionDecisionOnDue = typeof MISSION_DECISION_ON_DUE[number]

export interface MissionItemRef {
    kind: MissionRefKind
    repo?: string
    value: string
    note?: string
}

export interface MissionDecisionOption {
    id: string
    label: string
    detail?: string
}

/** Who/where an answer came from. Written only by the daemon's (owner-side) answer path — never from tool input. */
export interface MissionDecisionAnswer {
    optionId?: string
    text?: string
    by: 'owner' | 'auto_recommended'
    via: 'dashboard' | 'assistant' | 'push' | 'cli' | 'auto'
    interpretedFrom?: string
    at: string
    ingress?: string
}

export interface MissionDecisionDelivery {
    messageId: string
    state: 'pending' | 'sent' | 'acked'
    lastAttemptAt?: string
}

export interface MissionDecision {
    question: string
    context?: string
    options: MissionDecisionOption[]
    recommended?: string
    allowFreeText: boolean
    dueAt?: string
    onDue: MissionDecisionOnDue
    urgency: MissionDecisionUrgency
    answer?: MissionDecisionAnswer
    delivery?: MissionDecisionDelivery
    /**
     * Coordinator-prompt watermark (bundle B): ISO time the coordinator last "saw" this item's
     * answer. An answered decision is shown in the coordinator prompt while this is absent or
     * older than `answer.at` (a changed answer re-surfaces). Written only by the daemon.
     */
    promptAckedAt?: string
}

export interface NormalizedMissionItem {
    kind: MissionItemKind
    text: string
    machine?: string
    refs: MissionItemRef[]
    decision?: MissionDecision
    dedupeKey: string
    /** Fields that were truncated/dropped — informational, never an error. */
    truncated: string[]
}

export function truncateMissionText(value: string, max: number): string {
    if (value.length <= max) return value
    return `${value.slice(0, max - 1).trimEnd()}…`
}

function str(value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
}

function collapse(value: string): string {
    return value.replace(/\s+/g, ' ').trim()
}

export function normalizeMissionSummary(value: unknown): { value: string; truncated: boolean } | null {
    if (typeof value !== 'string') return null
    const text = collapse(value)
    return { value: truncateMissionText(text, MISSION_LIMITS.summary), truncated: text.length > MISSION_LIMITS.summary }
}

export function normalizeOutcomeReason(value: unknown): { value: string; truncated: boolean } | null {
    if (typeof value !== 'string') return null
    const text = value.trim()
    return { value: truncateMissionText(text, MISSION_LIMITS.outcomeReason), truncated: text.length > MISSION_LIMITS.outcomeReason }
}

/** Refs: ≤8, `{kind, repo?, value, note?}`. Unusable entries are dropped; the 9th and later are dropped. */
export function normalizeMissionRefs(value: unknown): { refs: MissionItemRef[]; truncated: boolean } {
    if (!Array.isArray(value)) return { refs: [], truncated: false }
    const refs: MissionItemRef[] = []
    let truncated = false
    for (const raw of value) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
        const r = raw as Record<string, unknown>
        const kind = str(r.kind)
        const refValue = str(r.value)
        if (!(MISSION_REF_KINDS as readonly string[]).includes(kind) || !refValue) continue
        if (refs.length >= MISSION_LIMITS.refs) { truncated = true; break }
        const repo = str(r.repo)
        const note = str(r.note)
        refs.push({
            kind: kind as MissionRefKind,
            ...(repo ? { repo: truncateMissionText(repo, MISSION_LIMITS.refRepo) } : {}),
            value: truncateMissionText(refValue, MISSION_LIMITS.refValue),
            ...(note ? { note: truncateMissionText(note, MISSION_LIMITS.refNote) } : {}),
        })
    }
    return { refs, truncated }
}

function normalizeOptions(value: unknown, truncated: string[]): MissionDecisionOption[] {
    if (!Array.isArray(value)) return []
    const out: MissionDecisionOption[] = []
    for (const raw of value) {
        if (typeof raw === 'string' && raw.trim()) {
            if (out.length >= MISSION_LIMITS.options) { truncated.push('options'); break }
            out.push({ id: MISSION_DECISION_OPTION_IDS[out.length], label: truncateMissionText(raw.trim(), MISSION_LIMITS.optionLabel) })
            continue
        }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
        const o = raw as Record<string, unknown>
        const label = collapse(str(o.label))
        if (!label) continue
        if (out.length >= MISSION_LIMITS.options) { truncated.push('options'); break }
        const detail = str(o.detail)
        // Ids are positional ('a'..'e') so a caller cannot collide or invent ids.
        out.push({
            id: MISSION_DECISION_OPTION_IDS[out.length],
            label: truncateMissionText(label, MISSION_LIMITS.optionLabel),
            ...(detail ? { detail: truncateMissionText(detail, MISSION_LIMITS.optionDetail) } : {}),
        })
    }
    return out
}

function normalizeDueAt(value: unknown): string | undefined {
    if (typeof value !== 'string' || !value.trim()) return undefined
    const ms = Date.parse(value)
    return Number.isNaN(ms) ? undefined : new Date(ms).toISOString()
}

/**
 * Caller-supplied decision → stored shape. `answer`/`delivery` (and any other
 * unknown key) are DROPPED: a coordinator/worker cannot pre-answer its own
 * question. `recommended` must name one of the options, else it is dropped.
 */
export function normalizeDecisionInput(raw: Record<string, unknown>, truncated: string[]): MissionDecision | null {
    const questionSource = collapse(str(raw.question) || str(raw.text))
    if (!questionSource) return null
    if (questionSource.length > MISSION_LIMITS.question) truncated.push('question')
    const question = truncateMissionText(questionSource, MISSION_LIMITS.question)
    const contextSource = str(raw.context)
    if (contextSource.length > MISSION_LIMITS.context) truncated.push('context')
    const options = normalizeOptions(raw.options, truncated)
    const recommendedRaw = str(raw.recommended)
    const recommended = recommendedRaw && options.some(o => o.id === recommendedRaw)
        ? recommendedRaw
        // Also accept the option label (coordinators naturally write "recommended: Option A").
        : options.find(o => recommendedRaw && o.label.toLowerCase() === recommendedRaw.toLowerCase())?.id
    const dueAt = normalizeDueAt(raw.dueAt ?? raw.due_at)
    const onDueRaw = str(raw.onDue ?? raw.on_due)
    const urgencyRaw = str(raw.urgency)
    const allowFreeTextRaw = raw.allowFreeText ?? raw.allow_free_text
    return {
        question,
        ...(contextSource ? { context: truncateMissionText(contextSource, MISSION_LIMITS.context) } : {}),
        options,
        ...(recommended ? { recommended } : {}),
        allowFreeText: typeof allowFreeTextRaw === 'boolean' ? allowFreeTextRaw : true,
        ...(dueAt ? { dueAt } : {}),
        // apply_recommended without a recommended option has nothing to apply — fall back to remind.
        onDue: onDueRaw === 'apply_recommended' && recommended ? 'apply_recommended' : 'remind',
        urgency: urgencyRaw === 'blocking' ? 'blocking' : 'normal',
    }
}

/** Normalized text for dedupe: lower-case, whitespace-collapsed, trailing punctuation trimmed. */
export function normalizeForDedupe(text: string): string {
    return collapse(text).toLowerCase().replace(/[\s.!?。]+$/u, '')
}

export function deriveItemDedupeKey(kind: MissionItemKind, parts: { text?: string; machine?: string; refs?: readonly MissionItemRef[]; question?: string; explicit?: string }): string {
    const explicit = str(parts.explicit)
    if (explicit) return truncateMissionText(`k:${explicit}`, MISSION_LIMITS.dedupeKey)
    if (kind === 'decision') return truncateMissionText(`decision:${normalizeForDedupe(parts.question ?? parts.text ?? '')}`, MISSION_LIMITS.dedupeKey)
    if (kind === 'evidence') {
        const ref = parts.refs?.[0]
        if (ref) return truncateMissionText(`evidence:${ref.kind}:${ref.repo ?? ''}:${ref.value}`, MISSION_LIMITS.dedupeKey)
    }
    const machine = parts.machine ? `@${normalizeForDedupe(parts.machine)}` : ''
    return truncateMissionText(`${kind}${machine}:${normalizeForDedupe(parts.text ?? '')}`, MISSION_LIMITS.dedupeKey)
}

/**
 * Normalize one caller-supplied `items_add[]` entry. Returns `null` + `error`
 * only when nothing usable remains (no text/question) — everything else is
 * clamped, never rejected.
 */
export function normalizeMissionItemInput(raw: unknown): { item: NormalizedMissionItem } | { error: string } {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'item must be an object' }
    const r = raw as Record<string, unknown>
    const kind = str(r.kind) || 'remaining'
    if (!(MISSION_ITEM_KINDS as readonly string[]).includes(kind)) {
        return { error: `invalid kind '${kind}' (valid: ${MISSION_ITEM_KINDS.join(', ')})` }
    }
    const truncated: string[] = []
    const { refs, truncated: refsTruncated } = normalizeMissionRefs(r.refs)
    if (refsTruncated) truncated.push('refs')
    const machineRaw = collapse(str(r.machine))
    const machine = machineRaw ? truncateMissionText(machineRaw, MISSION_LIMITS.machine) : undefined
    const explicitKey = str(r.dedupe_key ?? r.dedupeKey)
    if (kind === 'decision') {
        const decisionRaw = (r.decision && typeof r.decision === 'object' && !Array.isArray(r.decision) ? r.decision : r) as Record<string, unknown>
        const decision = normalizeDecisionInput({ ...decisionRaw, question: decisionRaw.question ?? r.question ?? r.text }, truncated)
        if (!decision) return { error: 'decision item needs a question' }
        return {
            item: {
                kind,
                text: decision.question,
                ...(machine ? { machine } : {}),
                refs,
                decision,
                dedupeKey: deriveItemDedupeKey('decision', { question: decision.question, explicit: explicitKey }),
                truncated,
            },
        }
    }
    const textSource = collapse(str(r.text))
    if (!textSource && !(kind === 'evidence' && refs.length > 0)) return { error: `${kind} item needs text` }
    if (textSource.length > MISSION_LIMITS.itemText) truncated.push('text')
    const text = truncateMissionText(textSource || `${refs[0].kind}: ${refs[0].value}`, MISSION_LIMITS.itemText)
    return {
        item: {
            kind: kind as MissionItemKind,
            text,
            ...(machine ? { machine } : {}),
            refs,
            dedupeKey: deriveItemDedupeKey(kind as MissionItemKind, { text, machine, refs, explicit: explicitKey }),
            truncated,
        },
    }
}

export interface MissionItemUpdateInput {
    id: string
    state?: MissionItemState
    text?: string
    machine?: string | null
    refs?: MissionItemRef[]
}

/** Normalize one `items_update[]` entry (id required). The kind-specific state rule is applied by the daemon, which knows the stored kind. */
export function normalizeMissionItemUpdate(raw: unknown): { update: MissionItemUpdateInput; truncated: string[] } | { error: string } {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'update must be an object' }
    const r = raw as Record<string, unknown>
    const id = str(r.id ?? r.item_id ?? r.itemId)
    if (!id) return { error: 'update needs an item id' }
    const truncated: string[] = []
    const update: MissionItemUpdateInput = { id }
    if (r.state !== undefined) {
        const state = str(r.state)
        if (!(MISSION_ITEM_STATES as readonly string[]).includes(state)) return { error: `invalid state '${state}'` }
        update.state = state as MissionItemState
    }
    if (typeof r.text === 'string') {
        const text = collapse(r.text)
        if (text.length > MISSION_LIMITS.itemText) truncated.push('text')
        if (text) update.text = truncateMissionText(text, MISSION_LIMITS.itemText)
    }
    if (r.machine === null) update.machine = null
    else if (typeof r.machine === 'string') {
        const machine = collapse(r.machine)
        update.machine = machine ? truncateMissionText(machine, MISSION_LIMITS.machine) : null
    }
    if (r.refs !== undefined) {
        const { refs, truncated: t } = normalizeMissionRefs(r.refs)
        if (t) truncated.push('refs')
        update.refs = refs
    }
    return { update, truncated }
}

/** Cap a serialized event payload at {@link MISSION_LIMITS.eventPayloadBytes}; over-size payloads become a stub that says so. */
export function boundEventPayload(payload: Record<string, unknown>): string {
    let json = JSON.stringify(payload)
    if (json.length <= MISSION_LIMITS.eventPayloadBytes) return json
    // Shrink the largest string fields first (the previous goal text is the usual offender).
    const shrunk: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(payload)) {
        shrunk[k] = typeof v === 'string' && v.length > 4000 ? `${v.slice(0, 4000)}…` : v
    }
    shrunk.payloadTruncated = true
    json = JSON.stringify(shrunk)
    if (json.length <= MISSION_LIMITS.eventPayloadBytes) return json
    return JSON.stringify({ payloadTruncated: true, keys: Object.keys(payload).slice(0, 20) })
}

/** The carry-over mission's fixed title (design §5.1). */
export const CARRY_OVER_MISSION_TITLE = '이월 — 닫힌 미션에서 넘어온 항목'
/**
 * THE one predicate for "is this the auto carry-over mission". The daemon's `is_carry_over`
 * column (`isCarryOver`) is the source of truth; wire views that cannot carry the flag (older
 * strict decoders reject unknown keys) fall back to the fixed title. Use this everywhere.
 */
export function isCarryOverMissionRecord(m: { isCarryOver?: boolean; title?: unknown } | null | undefined): boolean {
    return !!m && (m.isCarryOver === true || isCarryOverMissionTitle(m.title))
}
/** The carry-over mission's title is fixed (the daemon ignores renames), so a title match identifies it on wire views that carry no flag. */
export function isCarryOverMissionTitle(title: unknown): boolean {
    return typeof title === 'string' && title.trim() === CARRY_OVER_MISSION_TITLE
}

/** Prefix of the owner-confirmation decision a coordinator's `owner_abandoned` close creates. */
export const OWNER_ABANDON_CONFIRM_KEY_PREFIX = 'owner-abandon-confirm:'

export const OWNER_ABANDON_CONFIRM_QUESTION = "코디가 '오너 결정으로 중단'이라고 닫음 — 맞나요?"
export const OWNER_ABANDON_CONFIRM_OPTIONS = ['맞음', '다시 열기'] as const

/** worker `report_completion.decisions_needed` cap. */
export const WORKER_DECISIONS_NEEDED_MAX = 3
/** worker `report_completion.commits` cap and shape. */
export const WORKER_COMMITS_MAX = 20
const SHA_RE = /^[0-9a-f]{7,64}$/i
export function normalizeReportCommits(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null
    const out: string[] = []
    for (const v of value) {
        if (typeof v !== 'string') return null
        const sha = v.trim()
        if (!SHA_RE.test(sha)) return null
        if (!out.includes(sha.toLowerCase())) out.push(sha.toLowerCase())
    }
    return out
}
