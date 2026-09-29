/**
 * blueprintViewModel — pure derivations shared by the blueprint list and its
 * scheduling panel: route-preview requests/labels and the summary splitters,
 * unit-tested without rendering React Flow (same convention as
 * taskDagViewModel).
 */
import type { RepoMeshQueueTask } from '@adhdev/daemon-core'

/* ── Route-preview requests: the forecast must respect the pin ─────────────
 * The scheduling forecast used to ask mesh_route_preview only the four bare
 * difficulties, so a task PINNED to a node (targetNodeId) was annotated with
 * the UNPINNED prediction — the owner watched the blueprint predict a
 * machine the pinned task could never land on. The engine has the pin axis
 * (targetNodeId, verified against both conditions); the fix is on the
 * display axis: request a pinned preview per pending pinned task and keep
 * the generic forecast as a separate, explicitly-unpinned reading. */

export const ROUTE_PREVIEW_DIFFICULTIES = ['easy', 'medium', 'difficult', 'freeform'] as const

export interface RoutePreviewRequest {
    difficulty: string
    /** Present only for pinned previews — the generic forecast omits it. */
    targetNodeId?: string
}

/** Matrix key: bare difficulty for the generic forecast, `difficulty::nodeId` for a pinned one. */
export function routePreviewKey(difficulty: string, targetNodeId?: string): string {
    return targetNodeId ? `${difficulty}::${targetNodeId}` : difficulty
}

/**
 * The full request sweep: the four generic difficulties PLUS one pinned
 * preview per distinct (difficulty, targetNodeId) among PENDING pinned tasks
 * (settled tasks no longer need a prediction; assigned ones already landed).
 */
export function buildRoutePreviewRequests(
    tasks: ReadonlyArray<Pick<RepoMeshQueueTask, 'status' | 'difficulty' | 'targetNodeId'>>,
): RoutePreviewRequest[] {
    const requests: RoutePreviewRequest[] = ROUTE_PREVIEW_DIFFICULTIES.map(difficulty => ({ difficulty }))
    const seen = new Set<string>()
    for (const task of tasks) {
        const targetNodeId = typeof task.targetNodeId === 'string' ? task.targetNodeId.trim() : ''
        if (task.status !== 'pending' || !targetNodeId) continue
        const difficulty = task.difficulty ?? 'medium'
        const key = routePreviewKey(difficulty, targetNodeId)
        if (seen.has(key)) continue
        seen.add(key)
        requests.push({ difficulty, targetNodeId })
    }
    return requests
}

/** Minimal shape of one node entry in a mesh_route_preview response. */
export interface RoutePreviewNodeLike {
    nodeId: string
    predictedWinner?: { providerType: string; model?: string; fitnessScore?: number }
    stages?: { fitness?: Array<{ providerType: string; model?: string }> }
}

/** Label for one slot: `provider·model` or bare provider. */
export function routePreviewSlotLabel(slot: { providerType: string; model?: string }): string {
    return slot.model ? `${slot.providerType}·${slot.model}` : slot.providerType
}

/**
 * The next-match reading of one preview response: the first node's top-ranked
 * fitness slot (falling back to its predictedWinner), labelled with the
 * node suffix the caller supplies for that node ('' when none applies).
 */
export function routePreviewNextSlotLabel(
    nodes: ReadonlyArray<RoutePreviewNodeLike> | undefined,
    nodeSuffix?: (nodeId: string) => string,
): string | undefined {
    const first = nodes?.[0]
    if (!first) return undefined
    const slot = first.stages?.fitness?.[0] ?? first.predictedWinner
    if (!slot) return undefined
    return `${routePreviewSlotLabel(slot)}${nodeSuffix?.(first.nodeId) ?? ''}`
}

/**
 * taskId → predicted slot label for PENDING pinned tasks, read from the
 * pinned entries of the preview matrix. Tasks whose pinned preview has no
 * eligible slot are omitted (the card then shows no forecast rather than a
 * wrong one).
 */
export function buildPinnedSlotLabels(
    tasks: ReadonlyArray<Pick<RepoMeshQueueTask, 'id' | 'status' | 'difficulty' | 'targetNodeId'>>,
    matrix: Readonly<Record<string, ReadonlyArray<RoutePreviewNodeLike>>>,
    nodeSuffix?: (nodeId: string) => string,
): Record<string, string> {
    const out: Record<string, string> = {}
    for (const task of tasks) {
        const targetNodeId = typeof task.targetNodeId === 'string' ? task.targetNodeId.trim() : ''
        if (task.status !== 'pending' || !targetNodeId) continue
        const label = routePreviewNextSlotLabel(matrix[routePreviewKey(task.difficulty ?? 'medium', targetNodeId)], nodeSuffix)
        if (label) out[task.id] = label
    }
    return out
}

/**
 * The one-line reading of the whole forecast: which slot a MEDIUM unpinned
 * dispatch would take right now.
 *
 * WHY MEDIUM
 * The full forecast is four rows (easy/medium/difficult/freeform). One line
 * is all the header chip carries, and medium is the honest default: it is
 * the difficulty the coordinator assigns when a task is not classified, so
 * "where would my next task go" reads medium unless stated otherwise. The
 * other three stay one tap away in the detail popover the chip opens —
 * nothing is removed, only folded. (Rows never show the generic forecast at
 * all — a pinned task shows its own 📌 preview, buildPinnedSlotLabels.)
 *
 * Returns undefined when the sweep produced no eligible slot, so the caller
 * renders the explicit "no eligible slot" copy rather than a bare dash that
 * could be misread as "not loaded yet".
 */
export const ROUTE_PREVIEW_COMPACT_DIFFICULTY = 'medium'

export function resolveCompactRoutePreviewLabel(
    predictedSlots: Readonly<Record<string, string>> | undefined,
): string | undefined {
    return predictedSlots?.[ROUTE_PREVIEW_COMPACT_DIFFICULTY]
}

/**
 * How long a task's detail panel shows before it folds the rest away.
 *
 * Chosen to cover a genuine one-or-two-line task ("rerun the flaky suite on
 * win32") without folding, while a dispatched briefing — measured at several
 * thousand characters on the live mesh — folds after its opening lines.
 */
export const TASK_MESSAGE_LEAD_CHARS = 280

/**
 * Split a task message into the part shown immediately and the part folded
 * behind a disclosure.
 *
 * A queue task's `message` is the entire instruction it was dispatched with.
 * Rendering it whole at the top of the detail panel buried the fields the
 * panel exists to answer — status, provider, difficulty, elapsed time, failure
 * reason — under a wall of text with its own scrollbar, which is what the
 * owner hit when clicking a card.
 *
 * Splitting on a paragraph or line boundary when one is available keeps the
 * visible part readable; a hard character cut mid-sentence reads worse than
 * slightly more text. Returns `rest: ''` when the whole message already fits,
 * so a short task shows exactly as before with no disclosure at all.
 */
export function splitTaskMessage(
    message: string | null | undefined,
    leadChars: number = TASK_MESSAGE_LEAD_CHARS,
): { lead: string; rest: string } | null {
    const text = typeof message === 'string' ? message.trim() : ''
    if (!text) return null
    if (text.length <= leadChars) return { lead: text, rest: '' }

    /* Cut on a structural boundary when there is one, so the visible part ends
     * as a whole thought rather than mid-word.
     *
     * A task briefing almost always opens with a title line or short summary
     * paragraph, so the FIRST paragraph break is the natural lead — not the
     * last one inside the budget, which would drag unrelated body text along
     * with it. Line breaks and sentence ends are the weaker fallbacks, and for
     * those the last one inside the budget is right because it fills the lead.
     *
     * A break in the opening few characters is ignored: it would leave a lead
     * too short to tell the reader anything. */
    const window = text.slice(0, leadChars)
    // Low enough to accept a real title line ("Fix the canvas zoom." is 20),
    // high enough to reject a stray leading newline.
    const minLead = 12

    const paragraph = window.indexOf('\n\n')
    if (paragraph >= minLead) {
        return { lead: text.slice(0, paragraph).trim(), rest: text.slice(paragraph).trim() }
    }

    const floor = Math.floor(leadChars / 2)
    for (const cut of [window.lastIndexOf('\n'), window.lastIndexOf('. ')]) {
        if (cut >= floor) {
            return { lead: text.slice(0, cut).trim(), rest: text.slice(cut).trim() }
        }
    }
    return { lead: window.trim(), rest: text.slice(leadChars).trim() }
}

/**
 * Keys a worker report is worth leading with, most informative first.
 *
 * A report is free-form JSON, so this cannot be a schema — it is a preference
 * order over what agents in this repo actually emit (the task briefings ask for
 * `status`, and for a one-line account of the work under various names).
 */
const FINAL_SUMMARY_LEAD_KEYS = ['summary', 'result', 'outcome', 'conclusion', 'status'] as const

/**
 * Split a task's FINAL SUMMARY into a lead and a folded remainder.
 *
 * `babbc4ad` gave the task's own `message` this treatment but left the final
 * summary rendering whole, so a completed task's panel still opened with the
 * entire worker report — measured on the live preview mesh as the full JSON
 * body of queue task `85adc645`, in a scrollbox above everything the panel
 * exists to answer. This closes that half.
 *
 * Why it is not simply `splitTaskMessage`: a worker report is usually a JSON
 * object, and `splitTaskMessage`'s boundaries (paragraph, line, sentence) are
 * prose boundaries that JSON does not have. Pretty-printed, it has no blank
 * line, so the cut lands on whichever `",\n` fell inside the budget — a lead of
 * `{` plus two arbitrary truncated fields. Minified, it has no break at all and
 * the cut is mid-token. Either way the "summary" is noise.
 *
 * So JSON is summarised STRUCTURALLY: pick the most informative scalar field
 * present (`FINAL_SUMMARY_LEAD_KEYS`) and lead with that, keeping the whole
 * original — pretty-printed, since that is the readable form — behind the fold.
 * Anything that does not parse as a JSON object is prose, and falls through to
 * the same `splitTaskMessage` the instruction block uses, so the two blocks
 * behave identically on prose.
 */
export function splitFinalSummary(
    summary: string | null | undefined,
    leadChars: number = TASK_MESSAGE_LEAD_CHARS,
): { lead: string; rest: string } | null {
    const text = typeof summary === 'string' ? summary.trim() : ''
    if (!text) return null

    const parsed = parseJsonObject(text)
    if (!parsed) return splitTaskMessage(text, leadChars)

    /* Lead with the best scalar the report offers. A nested object or array is
     * skipped: flattening one back into the lead just rebuilds the wall of text
     * this function exists to fold away. */
    let lead = ''
    for (const key of FINAL_SUMMARY_LEAD_KEYS) {
        const value = parsed[key]
        if (typeof value === 'string' && value.trim()) { lead = value.trim(); break }
        if (typeof value === 'number' || typeof value === 'boolean') { lead = String(value); break }
    }
    /* No recognised key — say how big the thing is rather than inventing a
     * summary from a field whose meaning is unknown. The reader still gets the
     * report, one click away. */
    if (!lead) {
        const keys = Object.keys(parsed)
        lead = keys.length ? `{ ${keys.slice(0, 6).join(', ')}${keys.length > 6 ? ', …' : ''} }` : '{ }'
    }
    if (lead.length > leadChars) lead = `${lead.slice(0, leadChars).trimEnd()}…`

    // Pretty-print so the folded body is readable even when the report arrived
    // minified; fall back to the original text if re-serialising ever fails.
    let rest = text
    try {
        rest = JSON.stringify(parsed, null, 2)
    } catch {
        rest = text
    }
    return { lead, rest }
}

/** `JSON.parse` narrowed to plain objects — arrays and scalars are not reports. */
function parseJsonObject(text: string): Record<string, unknown> | null {
    if (!text.startsWith('{')) return null
    try {
        const parsed: unknown = JSON.parse(text)
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null
    } catch {
        return null
    }
}

/**
 * Milliseconds elapsed since an ISO timestamp, clamped to >= 0 so a clock
 * skew between daemon and browser never renders a negative age.
 */
export function elapsedMsSince(isoTimestamp: string | undefined, nowMs: number): number | undefined {
    if (!isoTimestamp) return undefined
    const then = Date.parse(isoTimestamp)
    if (Number.isNaN(then)) return undefined
    return Math.max(0, nowMs - then)
}

/**
 * Compact "age" label for a badge/one-liner — "3m", "2h", "5d". Mirrors
 * the coarse-bucket convention `formatTaskCardTime` uses elsewhere in the
 * blueprint (taskDagViewModel.ts) rather than inventing a new one.
 */
export function formatBlueprintAge(elapsedMs: number): string {
    const seconds = Math.floor(elapsedMs / 1000)
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h`
    const days = Math.floor(hours / 24)
    return `${days}d`
}
