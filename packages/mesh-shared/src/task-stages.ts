/**
 * task-stages — vocabulary, shapes and validators for "review in task".
 *
 * A medium/difficult `code_change` can be enqueued as ONE stage task: the daemon runs
 * implement → self-check → independent review → (bounded) revise inside the task and the
 * coordinator is woken once, by the parent's terminal. Design:
 * docs/design/2026-11-01-review-in-task.md (§3 model, §5 data contract).
 *
 * Dependency-free leaf: every cap and enum the daemon validator, the MCP schemas and the
 * dashboard chips read lives here once.
 */

// ─── Vocabulary ─────────────────────────────────────────────────────────

export const REVIEW_VERDICTS = ['approve', 'approve_with_nits', 'changes_requested', 'reject_approach'] as const
export type MeshReviewVerdict = typeof REVIEW_VERDICTS[number]

export const FINDING_SEVERITIES = ['blocking', 'major', 'minor', 'nit'] as const
export type MeshFindingSeverity = typeof FINDING_SEVERITIES[number]

export const FINDING_CATEGORIES = ['correctness', 'regression', 'test_gap', 'scope', 'security', 'performance', 'maintainability'] as const
export type MeshFindingCategory = typeof FINDING_CATEGORIES[number]

export const PRIOR_FINDING_STATUSES = ['resolved', 'unresolved', 'dispute_accepted', 'dispute_rejected'] as const
export type MeshPriorFindingStatus = typeof PRIOR_FINDING_STATUSES[number]

export const FINDING_RESPONSE_KINDS = ['fixed', 'disputed'] as const
export type MeshFindingResponseKind = typeof FINDING_RESPONSE_KINDS[number]

export const STAGE_PHASES = ['implementing', 'self_checking', 'awaiting_review', 'reviewing', 'revising', 'done'] as const
export type MeshStagePhase = typeof STAGE_PHASES[number]

/** Phases in which the parent row holds NO open attempt but is waiting on the daemon (watchdogs must skip it). */
export const STAGE_PARKED_PHASES: readonly MeshStagePhase[] = ['self_checking', 'awaiting_review', 'reviewing']

export const STAGE_INDEPENDENCE_MODES = ['different_provider', 'fresh_session_ok'] as const
export type MeshStageIndependenceMode = typeof STAGE_INDEPENDENCE_MODES[number]

/** What actually reviewed (recorded on the verdict and in the final report). */
export type MeshStageIndependenceUsed = 'different_provider' | 'fresh_session_fallback'

export const STAGE_ROLES = ['implement', 'revise', 'review'] as const
export type MeshStageRole = typeof STAGE_ROLES[number]

/** Why a stage parent ended `blocked` (R4/R12, doc §3.2). */
export const STAGE_BLOCKED_REASONS = [
    'review_unresolved',
    'review_rejected_approach',
    'review_unavailable',
    'self_check_failed',
    'stage_pipeline_ceiling',
    'reviewer_mutated_source',
] as const
export type MeshStageBlockedReason = typeof STAGE_BLOCKED_REASONS[number]

export const STAGE_DECIDE_ACTIONS = ['accept', 'revise_once', 'rereview', 'abandon'] as const
export type MeshStageDecideAction = typeof STAGE_DECIDE_ACTIONS[number]

// ─── Limits ─────────────────────────────────────────────────────────────

export const STAGE_MAX_REVISIONS_LIMIT = 3
export const STAGE_DEFAULT_MAX_REVISIONS = 2
export const STAGE_SELF_CHECK_MAX_BOUNCES = 2
/** Minutes a review child may be refused only for `review_independence_required` before fresh_session fallback (R2). */
export const STAGE_INDEPENDENCE_FALLBACK_MS = 10 * 60 * 1000
/** Parent pipeline ceiling from first dispatch (R12). */
export const STAGE_PIPELINE_CEILING_DEFAULT_MS = 4 * 60 * 60 * 1000

export const REVIEW_FINDINGS_MAX = 30
export const REVIEW_CLAIM_MAX_CHARS = 500
export const REVIEW_EVIDENCE_MAX_CHARS = 1_000
export const REVIEW_FIX_MAX_CHARS = 500
export const REVIEW_FINDING_ID_MAX_CHARS = 40
export const REVIEW_CHECKED_MAX = 20
export const REVIEW_NOTE_MAX_CHARS = 500
export const REVIEW_TESTS_RUN_MAX = 20
export const FINDING_RESPONSES_MAX = 30

// ─── Shapes ─────────────────────────────────────────────────────────────

export interface MeshTaskStagePlan {
    review: true
    maxRevisions: 0 | 1 | 2 | 3
    independence: MeshStageIndependenceMode
}

export interface MeshStageHead {
    round: number
    rootSha: string
    submodules?: Record<string, string>
}

export interface MeshTaskStageState {
    phase: MeshStagePhase
    /** Review round in progress (0 before the first review child exists). */
    round: number
    selfCheckBounces: number
    startedAt: string
    phaseSince: string
    baseSha: string
    stageHeads: MeshStageHead[]
    reviewTaskIds: string[]
    lastVerdict?: MeshReviewVerdict
    openFindingIds: string[]
    artifacts: { diff: string[]; selfCheck: string[]; verdict: string[] }
    reviewerSessionId?: string
    independenceUsed?: MeshStageIndependenceUsed
    /** Attempts the reducer already consumed (idempotency against the two terminal paths). */
    handledAttemptIds?: string[]
    /** Consecutive reviewer-unavailable outcomes (2 → review_unavailable). */
    reviewerFailures?: number
    /** Coordinator-granted extra revision rounds (`mesh_task_stage_decide revise_once`). */
    extraRevisions?: number
    /** Why the parent is blocked, once it is. */
    blockedReason?: MeshStageBlockedReason
    /** Unresolved findings snapshot kept for the final report (id + severity + claim). */
    openFindings?: Array<{ id: string; severity: MeshFindingSeverity; claim: string }>
    /** Nits/minors from the approving verdict, delivered in the final report. */
    openNits?: Array<{ id: string; severity: MeshFindingSeverity; claim: string }>
    /** Self-check outcome summary for the final report. */
    selfCheck?: 'passed' | 'skipped_not_configured' | 'skipped_infra_error' | 'unavailable' | 'failed'
    /** Resolved/disputed counters for the verdict line. */
    findingsFixed?: number
    /** The original coordinator message, preserved while revise memos replace `message`. */
    originalMessage?: string
    /** True once the parent was released to a terminal by the pipeline (hold lifted). */
    released?: boolean
}

export interface MeshReviewFinding {
    id: string
    severity: MeshFindingSeverity
    category: MeshFindingCategory
    file?: string
    line?: number
    claim: string
    evidence: string
    suggestedFix?: string
}

export interface MeshPriorFindingStatusEntry { id: string; status: MeshPriorFindingStatus; note?: string }

export interface MeshTestRun { command: string; exit: number; passed?: number; failed?: number; note?: string }

export interface MeshReviewReport {
    verdict: MeshReviewVerdict
    findings: MeshReviewFinding[]
    priorFindings?: MeshPriorFindingStatusEntry[]
    checked: string[]
    notChecked: string[]
    testsRun?: MeshTestRun[]
}

export interface MeshFindingResponse { id: string; response: MeshFindingResponseKind; note: string }

export interface StageValidationError { field: string; message: string }

// ─── Guards ─────────────────────────────────────────────────────────────

function makeGuard<T extends readonly string[]>(values: T): (value: unknown) => value is T[number] {
    const set: ReadonlySet<string> = new Set(values)
    return (value: unknown): value is T[number] => typeof value === 'string' && set.has(value)
}

export const isReviewVerdict = makeGuard(REVIEW_VERDICTS)
export const isFindingSeverity = makeGuard(FINDING_SEVERITIES)
export const isFindingCategory = makeGuard(FINDING_CATEGORIES)
export const isPriorFindingStatus = makeGuard(PRIOR_FINDING_STATUSES)
export const isFindingResponseKind = makeGuard(FINDING_RESPONSE_KINDS)
export const isStageBlockedReason = makeGuard(STAGE_BLOCKED_REASONS)

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Blocking/major findings keep a review from passing. */
export function isBlockingSeverity(severity: MeshFindingSeverity): boolean {
    return severity === 'blocking' || severity === 'major'
}

// ─── Plan normalization (enqueue `review` option, R5) ───────────────────

export interface StagePlanDefaultsInput {
    taskMode?: string
    difficulty?: string
    readonly?: boolean
}

/**
 * Resolve the enqueue-time `review` option into a stage plan, or null when review is off.
 * `review` undefined → R5 default (medium/difficult non-readonly `code_change` → on; easy/freeform/readonly → off).
 * Throws `invalid_review_option: …` on malformed input (rejected, never coerced).
 */
export function resolveStagePlan(raw: unknown, task: StagePlanDefaultsInput): MeshTaskStagePlan | null {
    const eligible = isStageEligibleTask(task)
    if (raw === undefined || raw === null) return defaultsOnFor(task) ? defaultStagePlan() : null
    if (raw === false) return null
    if (raw === true) {
        if (!eligible) throw new Error(`invalid_review_option: review requires a non-readonly code_change task (got taskMode=${task.taskMode ?? 'unset'}${task.readonly ? ', readonly' : ''})`)
        return defaultStagePlan()
    }
    if (!isRecord(raw)) throw new Error('invalid_review_option: review must be true, false or {max_revisions?, independence?}')
    const allowed = new Set(['max_revisions', 'maxRevisions', 'independence'])
    for (const key of Object.keys(raw)) {
        if (!allowed.has(key)) throw new Error(`invalid_review_option: unknown review key '${key}' (expected max_revisions, independence)`)
    }
    if (!eligible) throw new Error(`invalid_review_option: review requires a non-readonly code_change task (got taskMode=${task.taskMode ?? 'unset'}${task.readonly ? ', readonly' : ''})`)
    const rawMax = raw.max_revisions ?? raw.maxRevisions
    let maxRevisions = STAGE_DEFAULT_MAX_REVISIONS as MeshTaskStagePlan['maxRevisions']
    if (rawMax !== undefined) {
        if (typeof rawMax !== 'number' || !Number.isInteger(rawMax) || rawMax < 0 || rawMax > STAGE_MAX_REVISIONS_LIMIT) {
            throw new Error(`invalid_review_option: max_revisions must be an integer 0..${STAGE_MAX_REVISIONS_LIMIT}`)
        }
        maxRevisions = rawMax as MeshTaskStagePlan['maxRevisions']
    }
    let independence: MeshStageIndependenceMode = 'fresh_session_ok'
    if (raw.independence !== undefined) {
        if (!(STAGE_INDEPENDENCE_MODES as readonly string[]).includes(raw.independence as string)) {
            throw new Error(`invalid_review_option: independence must be one of ${STAGE_INDEPENDENCE_MODES.join(' | ')}`)
        }
        independence = raw.independence as MeshStageIndependenceMode
    }
    return { review: true, maxRevisions, independence }
}

export function defaultStagePlan(): MeshTaskStagePlan {
    return { review: true, maxRevisions: STAGE_DEFAULT_MAX_REVISIONS as MeshTaskStagePlan['maxRevisions'], independence: 'fresh_session_ok' }
}

/** R5: only non-readonly code_change tasks run the pipeline by default (medium/difficult). */
export function isStageEligibleTask(task: StagePlanDefaultsInput): boolean {
    if (task.readonly) return false
    return (task.taskMode ?? 'code_change') === 'code_change'
}

function defaultsOnFor(task: StagePlanDefaultsInput): boolean {
    return isStageEligibleTask(task) && (task.difficulty === 'medium' || task.difficulty === 'difficult')
}

// ─── Review report validation (§5.2) ────────────────────────────────────

function str(value: unknown): string { return typeof value === 'string' ? value.trim() : '' }

function validateStringList(value: unknown, field: string, max: number, maxChars: number, errors: StageValidationError[], minItems = 0): string[] {
    if (!Array.isArray(value)) {
        errors.push({ field, message: `${field} must be an array of strings` })
        return []
    }
    if (value.length > max) errors.push({ field, message: `${field} has ${value.length} entries, over the ${max} limit` })
    const out: string[] = []
    for (const item of value) {
        const text = str(item)
        if (!text) continue
        if (text.length > maxChars) { errors.push({ field, message: `${field} contains an entry over ${maxChars} chars` }); continue }
        out.push(text)
    }
    if (out.length < minItems) errors.push({ field, message: `${field} needs at least ${minItems} entry — an empty ${field} list is a review with no recorded scope` })
    return out
}

export interface ReviewValidationContext {
    /** 1-based review round of the child this report is for. */
    round: number
    /** Blocking/major finding ids still open from the previous round (round ≥ 2 must answer each). */
    priorOpenBlockingIds?: readonly string[]
}

/**
 * Validate the `review` field of a reviewer's `report_completion`. Rejects, never coerces;
 * unknown keys are rejected (a misspelled `notChecked` must not silently vanish).
 */
export function validateReviewReport(raw: unknown, ctx: ReviewValidationContext): { report?: MeshReviewReport; errors: StageValidationError[] } {
    const errors: StageValidationError[] = []
    if (!isRecord(raw)) return { errors: [{ field: 'review', message: 'review must be an object {verdict, findings, checked, notChecked, ...}' }] }
    const KNOWN = new Set(['verdict', 'findings', 'priorFindings', 'checked', 'notChecked', 'testsRun'])
    for (const key of Object.keys(raw)) if (!KNOWN.has(key)) errors.push({ field: `review.${key}`, message: `unknown field '${key}' (expected one of: ${[...KNOWN].join(', ')})` })

    const verdict = raw.verdict
    if (!isReviewVerdict(verdict)) errors.push({ field: 'review.verdict', message: `verdict must be one of ${REVIEW_VERDICTS.join(' | ')}` })

    const findings: MeshReviewFinding[] = []
    if (!Array.isArray(raw.findings)) errors.push({ field: 'review.findings', message: 'findings must be an array (use [] when there are none)' })
    else {
        if (raw.findings.length > REVIEW_FINDINGS_MAX) errors.push({ field: 'review.findings', message: `findings has ${raw.findings.length} entries, over the ${REVIEW_FINDINGS_MAX} limit — keep the most important` })
        const seen = new Set<string>()
        raw.findings.forEach((f, i) => {
            const at = `review.findings[${i}]`
            if (!isRecord(f)) { errors.push({ field: at, message: 'each finding must be an object' }); return }
            const FK = new Set(['id', 'severity', 'category', 'file', 'line', 'claim', 'evidence', 'suggestedFix'])
            for (const key of Object.keys(f)) if (!FK.has(key)) errors.push({ field: `${at}.${key}`, message: `unknown field '${key}'` })
            const id = str(f.id)
            if (!id || id.length > REVIEW_FINDING_ID_MAX_CHARS) errors.push({ field: `${at}.id`, message: `id is required (≤ ${REVIEW_FINDING_ID_MAX_CHARS} chars)` })
            else if (seen.has(id)) errors.push({ field: `${at}.id`, message: `duplicate finding id '${id}'` })
            else seen.add(id)
            if (!isFindingSeverity(f.severity)) errors.push({ field: `${at}.severity`, message: `severity must be one of ${FINDING_SEVERITIES.join(' | ')}` })
            if (!isFindingCategory(f.category)) errors.push({ field: `${at}.category`, message: `category must be one of ${FINDING_CATEGORIES.join(' | ')}` })
            const claim = str(f.claim)
            if (!claim) errors.push({ field: `${at}.claim`, message: 'claim is required' })
            else if (claim.length > REVIEW_CLAIM_MAX_CHARS) errors.push({ field: `${at}.claim`, message: `claim is over ${REVIEW_CLAIM_MAX_CHARS} chars` })
            const evidence = str(f.evidence)
            if (!evidence) errors.push({ field: `${at}.evidence`, message: 'evidence is required — what did you read or run to know this' })
            else if (evidence.length > REVIEW_EVIDENCE_MAX_CHARS) errors.push({ field: `${at}.evidence`, message: `evidence is over ${REVIEW_EVIDENCE_MAX_CHARS} chars` })
            const fix = f.suggestedFix === undefined ? undefined : str(f.suggestedFix)
            if (fix !== undefined && fix.length > REVIEW_FIX_MAX_CHARS) errors.push({ field: `${at}.suggestedFix`, message: `suggestedFix is over ${REVIEW_FIX_MAX_CHARS} chars` })
            if (f.file !== undefined && typeof f.file !== 'string') errors.push({ field: `${at}.file`, message: 'file must be a string' })
            if (f.line !== undefined && (typeof f.line !== 'number' || !Number.isInteger(f.line) || f.line < 1)) errors.push({ field: `${at}.line`, message: 'line must be a positive integer' })
            if (id && isFindingSeverity(f.severity) && isFindingCategory(f.category) && claim && evidence) {
                findings.push({
                    id, severity: f.severity, category: f.category,
                    ...(typeof f.file === 'string' && f.file.trim() ? { file: f.file.trim() } : {}),
                    ...(typeof f.line === 'number' ? { line: f.line } : {}),
                    claim, evidence, ...(fix ? { suggestedFix: fix } : {}),
                })
            }
        })
    }

    const checked = validateStringList(raw.checked, 'review.checked', REVIEW_CHECKED_MAX, REVIEW_CLAIM_MAX_CHARS, errors, 1)
    const notChecked = validateStringList(raw.notChecked, 'review.notChecked', REVIEW_CHECKED_MAX, REVIEW_CLAIM_MAX_CHARS, errors, 1)

    let priorFindings: MeshPriorFindingStatusEntry[] | undefined
    if (raw.priorFindings !== undefined) {
        if (!Array.isArray(raw.priorFindings)) errors.push({ field: 'review.priorFindings', message: 'priorFindings must be an array' })
        else {
            priorFindings = []
            raw.priorFindings.forEach((p, i) => {
                const at = `review.priorFindings[${i}]`
                if (!isRecord(p)) { errors.push({ field: at, message: 'each entry must be an object {id, status, note?}' }); return }
                for (const key of Object.keys(p)) if (!['id', 'status', 'note'].includes(key)) errors.push({ field: `${at}.${key}`, message: `unknown field '${key}'` })
                const id = str(p.id)
                if (!id) errors.push({ field: `${at}.id`, message: 'id is required' })
                if (!isPriorFindingStatus(p.status)) errors.push({ field: `${at}.status`, message: `status must be one of ${PRIOR_FINDING_STATUSES.join(' | ')}` })
                const note = p.note === undefined ? undefined : str(p.note)
                if (note !== undefined && note.length > REVIEW_NOTE_MAX_CHARS) errors.push({ field: `${at}.note`, message: `note is over ${REVIEW_NOTE_MAX_CHARS} chars` })
                if (id && isPriorFindingStatus(p.status)) priorFindings!.push({ id, status: p.status, ...(note ? { note } : {}) })
            })
        }
    }

    const testsRun = raw.testsRun === undefined ? undefined : validateTestsRun(raw.testsRun, 'review.testsRun', errors)

    // Cross-field rules.
    if (isReviewVerdict(verdict)) {
        const blocking = findings.filter(f => isBlockingSeverity(f.severity))
        if (verdict === 'changes_requested' && blocking.length === 0 && Array.isArray(raw.findings) && errors.length === 0) {
            errors.push({ field: 'review.verdict', message: 'changes_requested needs at least one blocking or major finding — nits alone are approve_with_nits' })
        }
        if ((verdict === 'approve') && blocking.length > 0) {
            errors.push({ field: 'review.verdict', message: 'approve cannot carry blocking or major findings' })
        }
        if (verdict === 'approve_with_nits' && blocking.length > 0) {
            errors.push({ field: 'review.verdict', message: 'approve_with_nits cannot carry blocking or major findings — use changes_requested' })
        }
    }
    if (ctx.round >= 2 && ctx.priorOpenBlockingIds?.length) {
        const answered = new Set((priorFindings ?? []).map(p => p.id))
        const missing = ctx.priorOpenBlockingIds.filter(id => !answered.has(id))
        if (missing.length) errors.push({ field: 'review.priorFindings', message: `round ${ctx.round} must give a status for every prior blocking/major finding; missing: ${missing.join(', ')}` })
    }

    if (errors.length) return { errors }
    return {
        report: {
            verdict: verdict as MeshReviewVerdict,
            findings,
            ...(priorFindings?.length ? { priorFindings } : {}),
            checked,
            notChecked,
            ...(testsRun?.length ? { testsRun } : {}),
        },
        errors: [],
    }
}

/** Shared by the reviewer's `review.testsRun` and the top-level `testsRun` of any report. */
export function validateTestsRun(raw: unknown, field: string, errors: StageValidationError[]): MeshTestRun[] {
    if (!Array.isArray(raw)) { errors.push({ field, message: `${field} must be an array of {command, exit, passed?, failed?, note?}` }); return [] }
    if (raw.length > REVIEW_TESTS_RUN_MAX) errors.push({ field, message: `${field} has ${raw.length} entries, over the ${REVIEW_TESTS_RUN_MAX} limit` })
    const out: MeshTestRun[] = []
    raw.forEach((t, i) => {
        const at = `${field}[${i}]`
        if (!isRecord(t)) { errors.push({ field: at, message: 'each entry must be an object' }); return }
        for (const key of Object.keys(t)) if (!['command', 'exit', 'passed', 'failed', 'note'].includes(key)) errors.push({ field: `${at}.${key}`, message: `unknown field '${key}'` })
        const command = str(t.command)
        if (!command || command.length > REVIEW_CLAIM_MAX_CHARS) errors.push({ field: `${at}.command`, message: `command is required (≤ ${REVIEW_CLAIM_MAX_CHARS} chars)` })
        if (typeof t.exit !== 'number' || !Number.isInteger(t.exit)) errors.push({ field: `${at}.exit`, message: 'exit must be an integer' })
        for (const k of ['passed', 'failed'] as const) {
            if (t[k] !== undefined && (typeof t[k] !== 'number' || !Number.isInteger(t[k] as number) || (t[k] as number) < 0)) errors.push({ field: `${at}.${k}`, message: `${k} must be a non-negative integer` })
        }
        const note = t.note === undefined ? undefined : str(t.note)
        if (note !== undefined && note.length > REVIEW_NOTE_MAX_CHARS) errors.push({ field: `${at}.note`, message: `note is over ${REVIEW_NOTE_MAX_CHARS} chars` })
        if (command && typeof t.exit === 'number') {
            out.push({
                command, exit: t.exit,
                ...(typeof t.passed === 'number' ? { passed: t.passed } : {}),
                ...(typeof t.failed === 'number' ? { failed: t.failed } : {}),
                ...(note ? { note } : {}),
            })
        }
    })
    return out
}

/** Validate an implementer's `findingResponses` (§5.3). */
export function validateFindingResponses(raw: unknown, field = 'findingResponses'): { responses?: MeshFindingResponse[]; errors: StageValidationError[] } {
    const errors: StageValidationError[] = []
    if (!Array.isArray(raw)) return { errors: [{ field, message: `${field} must be an array of {id, response, note}` }] }
    if (raw.length > FINDING_RESPONSES_MAX) errors.push({ field, message: `${field} has ${raw.length} entries, over the ${FINDING_RESPONSES_MAX} limit` })
    const out: MeshFindingResponse[] = []
    raw.forEach((r, i) => {
        const at = `${field}[${i}]`
        if (!isRecord(r)) { errors.push({ field: at, message: 'each entry must be an object {id, response, note}' }); return }
        for (const key of Object.keys(r)) if (!['id', 'response', 'note'].includes(key)) errors.push({ field: `${at}.${key}`, message: `unknown field '${key}'` })
        const id = str(r.id)
        if (!id) errors.push({ field: `${at}.id`, message: 'id is required' })
        if (!isFindingResponseKind(r.response)) errors.push({ field: `${at}.response`, message: `response must be one of ${FINDING_RESPONSE_KINDS.join(' | ')}` })
        const note = str(r.note)
        if (!note) errors.push({ field: `${at}.note`, message: 'note is required — say what changed, or why you dispute it' })
        else if (note.length > REVIEW_NOTE_MAX_CHARS) errors.push({ field: `${at}.note`, message: `note is over ${REVIEW_NOTE_MAX_CHARS} chars` })
        if (id && isFindingResponseKind(r.response) && note && note.length <= REVIEW_NOTE_MAX_CHARS) out.push({ id, response: r.response, note })
    })
    return errors.length ? { errors } : { responses: out, errors: [] }
}

// ─── Verdict line (§5.4) ────────────────────────────────────────────────

export interface StageVerdictLineInput {
    verdict: MeshReviewVerdict | 'skipped_no_diff'
    rounds: number
    reviewerProvider?: string
    independenceUsed?: MeshStageIndependenceUsed
    fixed?: number
    openNits?: number
}

/** One human-readable line: `review: approve_with_nits · 2 rounds · reviewer codex-cli (different_provider) · 3 findings fixed, 1 nit open`. */
export function formatStageVerdictLine(input: StageVerdictLineInput): string {
    const parts: string[] = [`review: ${input.verdict}`]
    if (input.verdict === 'skipped_no_diff') return parts[0]
    parts.push(`${input.rounds} round${input.rounds === 1 ? '' : 's'}`)
    if (input.reviewerProvider) parts.push(`reviewer ${input.reviewerProvider} (${input.independenceUsed ?? 'different_provider'})`)
    const tail: string[] = []
    if (input.fixed) tail.push(`${input.fixed} finding${input.fixed === 1 ? '' : 's'} fixed`)
    if (input.openNits) tail.push(`${input.openNits} nit${input.openNits === 1 ? '' : 's'} open`)
    return tail.length ? `${parts.join(' · ')} · ${tail.join(', ')}` : parts.join(' · ')
}
