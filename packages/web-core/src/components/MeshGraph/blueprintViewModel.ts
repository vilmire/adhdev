/**
 * blueprintViewModel — pure derivations for the blueprint DAG
 * (the fused blueprint canvas (MeshTaskDagView)). Extracted from the component so the edge-state
 * vocabulary — the "what unlocks what" reading of the graph — is unit-tested
 * without rendering React Flow (same convention as taskDagViewModel).
 */
import type { MeshGraphView, MeshGraphEdgeView, MeshGraphGateView, RepoMeshQueueTask } from '@adhdev/daemon-core'

/** The daemon defaults to 20 and clamps mesh_graph_overview requests at 100. */
export const BLUEPRINT_GRAPH_INITIAL_LIMIT = 20
export const BLUEPRINT_GRAPH_LOAD_MORE_STEP = 20
export const BLUEPRINT_GRAPH_MAX_LIMIT = 100

export function buildBlueprintGraphOverviewArgs(meshId: string, includeTerminal: boolean, limit: number): Record<string, unknown> {
    return includeTerminal ? { meshId, includeTerminal, limit } : { meshId, includeTerminal }
}

export function nextBlueprintGraphLimit(limit: number): number {
    return Math.min(BLUEPRINT_GRAPH_MAX_LIMIT, limit + BLUEPRINT_GRAPH_LOAD_MORE_STEP)
}

export function getBlueprintGraphPagination(graphCount: number, totalGraphCount: number, requestedLimit: number): {
    hiddenCount: number
    canLoadMore: boolean
    atServerLimit: boolean
} {
    const hiddenCount = Math.max(0, totalGraphCount - graphCount)
    return {
        hiddenCount,
        canLoadMore: hiddenCount > 0 && requestedLimit < BLUEPRINT_GRAPH_MAX_LIMIT,
        atServerLimit: hiddenCount > 0 && requestedLimit >= BLUEPRINT_GRAPH_MAX_LIMIT,
    }
}

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
 * Which forecast a task card shows: the PINNED prediction when the task pins
 * a target node and that preview exists, else the generic per-difficulty
 * one. The `pinned` flag lets the card render the two readings distinctly —
 * the generic forecast is a hypothetical unpinned dispatch, the pinned one
 * is where THIS task would actually go. A pinned task WITHOUT its pinned
 * preview shows nothing: falling back to the unpinned forecast there is
 * exactly the misprediction this fixes.
 */
export function resolveTaskPredictedSlot(
    task: Pick<RepoMeshQueueTask, 'id' | 'difficulty' | 'targetNodeId'>,
    predictedSlots: Readonly<Record<string, string>> | undefined,
    pinnedSlots: Readonly<Record<string, string>> | undefined,
): { label: string; pinned: boolean } | undefined {
    if (task.targetNodeId) {
        const pinnedLabel = pinnedSlots?.[task.id]
        return pinnedLabel ? { label: pinnedLabel, pinned: true } : undefined
    }
    const generic = predictedSlots?.[task.difficulty ?? 'medium']
    return generic ? { label: generic, pinned: false } : undefined
}

/**
 * The one-line reading of the whole forecast: which slot a MEDIUM unpinned
 * dispatch would take right now.
 *
 * WHY MEDIUM
 * The full forecast is four rows (easy/medium/difficult/freeform), which is
 * what made the overlay as tall as the canvas on a phone and got it hidden
 * outright (`hidden sm:flex`, 2026-09-02). Narrow viewports need ONE line, and
 * medium is the honest default: it is the difficulty the coordinator assigns
 * when a task is not classified, so "where would my next task go" reads medium
 * unless stated otherwise. The other three stay one tap away in the same
 * detail popover the wide overlay opens — nothing is removed, only folded.
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

/** One graph's placement on the blueprint's vertical time axis. */
export interface BlueprintGraphTimelineEntry {
    graphId: string
    /** Epoch ms — terminalAt when the graph settled, else createdAt; 0 when neither parses. */
    timestamp: number
    /** Day bucket (yyyy-mm-dd) — graphs sharing one collapse under a single date header. */
    dateKey: string
    /** True for the first entry of a day — the axis renders the date label there only. */
    showDate: boolean
}

/**
 * The moment a graph belongs to on the timeline: when it SETTLED (terminalAt)
 * for finished graphs, when it was CREATED otherwise. Read the structured
 * fields — never parse the date out of a graph title.
 */
export function blueprintGraphTimelineTime(graph: Pick<MeshGraphView, 'createdAt' | 'terminalAt'>): number {
    const terminal = graph.terminalAt ? Date.parse(graph.terminalAt) : Number.NaN
    if (Number.isFinite(terminal)) return terminal
    const created = graph.createdAt ? Date.parse(graph.createdAt) : Number.NaN
    return Number.isFinite(created) ? created : 0
}

/** Local-day bucket key — the axis groups by the viewer's own calendar day. */
export function blueprintTimelineDateKey(ms: number): string {
    const date = new Date(ms)
    const pad = (value: number) => String(value).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Graphs ordered for the vertical timeline: newest first (matching the
 * daemon's mesh_graph_overview order), each stamped with its day bucket and a
 * showDate flag that fires only on the day's first graph. The dateKey source
 * is injectable so tests stay timezone-deterministic.
 */
export function buildBlueprintGraphTimeline(
    graphs: Array<Pick<MeshGraphView, 'graphId' | 'createdAt' | 'terminalAt'>>,
    toDateKey: (ms: number) => string = blueprintTimelineDateKey,
): BlueprintGraphTimelineEntry[] {
    const ordered = graphs
        .map(graph => ({ graphId: graph.graphId, timestamp: blueprintGraphTimelineTime(graph) }))
        .sort((a, b) => b.timestamp - a.timestamp)
    let lastDateKey = ''
    return ordered.map(entry => {
        const dateKey = toDateKey(entry.timestamp)
        const showDate = dateKey !== lastDateKey
        lastDateKey = dateKey
        return { ...entry, dateKey, showDate }
    })
}

/** Source states that mean "this dependency is satisfied — the edge is green". */
const TERMINAL_OK_STATES = new Set(['completed', 'released'])
/** All terminal states (success or not) — a terminal target no longer waits. */
const TERMINAL_STATES = new Set(['completed', 'failed', 'skipped', 'cancelled', 'released'])

export type BlueprintEdgeState = 'inactive' | 'satisfied' | 'failed' | 'waiting' | 'idle'

/** Gate lookups keyed by the gate's graph nodeId. */
export function buildGateByNodeId(graph: Pick<MeshGraphView, 'gates'>): Map<string, MeshGraphGateView> {
    const map = new Map<string, MeshGraphGateView>()
    for (const gate of graph.gates ?? []) map.set(gate.nodeId, gate)
    return map
}

/**
 * Effective display state per node: a coordinator_gate node shows its GATE
 * state (awaiting/claimed/released…), a worker node its graph node state.
 */
export function buildStateByNodeId(graph: Pick<MeshGraphView, 'nodes' | 'gates'>): Map<string, string> {
    const gates = buildGateByNodeId(graph)
    const map = new Map<string, string>()
    for (const node of graph.nodes) {
        map.set(node.nodeId, node.kind === 'coordinator_gate' ? (gates.get(node.nodeId)?.state ?? node.state) : node.state)
    }
    return map
}

/**
 * Edge endpoints in MeshGraphEdgeView are `ref ?? nodeId` (the view projects
 * the human-readable ref when the node has one). React Flow and ELK are keyed
 * by nodeId, so every edge endpoint must be resolved back through this map.
 */
export function buildNodeIdByEndpoint(graph: Pick<MeshGraphView, 'nodes'>): Map<string, string> {
    const map = new Map<string, string>()
    for (const node of graph.nodes) {
        map.set(node.nodeId, node.nodeId)
        if (node.ref) map.set(node.ref, node.nodeId)
    }
    return map
}

/**
 * Edge display state:
 *  - inactive: the projection deactivated the edge (source skipped)
 *  - satisfied: source reached a successful terminal state — dependency met
 *  - failed: source terminal but NOT successful — the dependency can never be met
 *  - waiting: source still in flight and the target still waits on it (animated)
 *  - idle: source in flight but the target itself is already terminal
 */
export function deriveBlueprintEdgeState(
    edge: Pick<MeshGraphEdgeView, 'active' | 'from' | 'to'>,
    stateByNodeId: Map<string, string>,
    nodeIdByEndpoint?: Map<string, string>,
): BlueprintEdgeState {
    if (edge.active === false) return 'inactive'
    const sourceId = nodeIdByEndpoint?.get(edge.from) ?? edge.from
    const targetId = nodeIdByEndpoint?.get(edge.to) ?? edge.to
    const sourceState = stateByNodeId.get(sourceId) ?? 'declared'
    const targetState = stateByNodeId.get(targetId) ?? 'declared'
    if (TERMINAL_OK_STATES.has(sourceState)) return 'satisfied'
    if (TERMINAL_STATES.has(sourceState)) return 'failed'
    return TERMINAL_STATES.has(targetState) ? 'idle' : 'waiting'
}

/* ── B-plan collapse (owner call 2026-09-02) ───────────────────────────────
 * The blueprint used to run THREE placement systems side by side: a hand-built
 * time lane for detached graph clusters, ELK for the fused chains, and a
 * hand-built stack for loose tasks — joined by arithmetic (`shift = laneMaxX +
 * gap`), not by meaning. Reading the canvas as one picture failed because the
 * Y axis meant time on the left and crossing-minimization in the middle.
 *
 * B-plan collapses that to ONE axis: dependency depth, laid out by ELK for
 * everything. A settled graph no longer gets its own zone — it renders as a
 * single collapsed chip in the same flow, expandable on click. Time moves onto
 * the cards (formatTaskCardTime), except for ROOT tasks, whose relative order
 * ELK does not otherwise constrain — those stay newest-first so the entry
 * points into the graph still read chronologically. */

/** A graph that has settled: nothing in it will advance again on its own. */
export function isSettledGraph(graph: Pick<MeshGraphView, 'status' | 'terminalAt'>): boolean {
    if (graph.terminalAt) return true
    return graph.status === 'completed' || graph.status === 'failed' || graph.status === 'cancelled'
}

/**
 * Which graphs render collapsed: every settled graph the viewer has not
 * explicitly expanded. An in-flight graph is never collapsed — the blueprint
 * exists to show live work, and hiding it behind a click would defeat the tab.
 */
export function resolveCollapsedGraphIds(
    graphs: ReadonlyArray<Pick<MeshGraphView, 'graphId' | 'status' | 'terminalAt'>>,
    expanded: ReadonlySet<string>,
): Set<string> {
    const collapsed = new Set<string>()
    for (const graph of graphs) {
        if (!isSettledGraph(graph)) continue
        if (expanded.has(graph.graphId)) continue
        collapsed.add(graph.graphId)
    }
    return collapsed
}

/** Counts summarised on a collapsed graph's chip. */
export interface CollapsedGraphSummary {
    graphId: string
    batchId?: string
    status: string
    nodeCount: number
    gateCount: number
    /** Settled-at (or created-at) epoch ms, so the chip can carry a time too. */
    timestamp: number
    /** Lets the chip title itself with the mission name instead of a raw
     *  UUID fragment — a collapsed graph is the FIRST thing a reader sees. */
    missionId?: string
}

export function summarizeCollapsedGraph(graph: MeshGraphView): CollapsedGraphSummary {
    return {
        graphId: graph.graphId,
        ...(graph.batchId ? { batchId: graph.batchId } : {}),
        status: graph.status,
        nodeCount: graph.nodes.length,
        gateCount: graph.gates.length,
        timestamp: blueprintGraphTimelineTime(graph),
        ...(graph.missionId ? { missionId: graph.missionId } : {}),
    }
}

/**
 * How many archive entries to place per row, given the width available.
 *
 * The archive used to be ONE column at a single x (`layoutArchive`), which is
 * what made the blueprint unreadable rather than merely tall. Measured on the
 * live mesh (20 graphs, 19 of them `gates:0`, so every one collapses to a
 * chip): the drawing's bounding box came out 236 × 1230 — a strip narrower
 * than a phone inside a ~1200px dialog. `fitView` frames by the LIMITING axis,
 * so that height forced zoom to 0.474, at which a 236px card renders 112px
 * wide (the "grey smudge" the owner reported) while 91% of the viewport width
 * sat empty. It also made the zoom buttons feel broken: React Flow's
 * `scaleBy(1.2)` per press means two presses only reach 0.68 — still below the
 * card's design width — so pressing + twice visibly changed nothing.
 *
 * Packing the same entries into rows trades height for the width that was
 * already there, which is the one move that fixes both readings at once: a
 * wider, shorter box fits at a HIGHER zoom, so cards get bigger without
 * touching the zoom limits, the card count stops driving legibility, and the
 * empty 70% is actually used.
 *
 * Column count is derived from the measured canvas width rather than fixed, so
 * a narrow dialog (or a phone) still degrades to the single column that shape
 * genuinely wants — the old behaviour is the narrow-viewport special case, not
 * the general one.
 */
export function archiveColumnCount(availableWidth: number, entryWidth: number, gap: number): number {
    if (!Number.isFinite(availableWidth) || availableWidth <= 0) return 1
    if (!Number.isFinite(entryWidth) || entryWidth <= 0) return 1
    // n columns occupy n*entryWidth + (n-1)*gap. Solve for the largest n that
    // fits, then clamp: at least one column always, and never so many that the
    // archive becomes a wide thin band the eye cannot scan.
    const n = Math.floor((availableWidth + gap) / (entryWidth + gap))
    return Math.max(1, Math.min(ARCHIVE_MAX_COLUMNS, n))
}

/** Upper bound on archive columns — past this a row scans worse than it packs. */
export const ARCHIVE_MAX_COLUMNS = 4

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
 * Root-first ordering for the ELK input array. ELK's `considerModelOrder`
 * strategy is NODES_AND_EDGES, so the order nodes are handed in decides their
 * relative placement within a layer — which is exactly the knob the owner call
 * needs: roots (no incoming dependency) newest-first, everything else left to
 * ELK's crossing minimization. No coordinate math, no second placement system.
 */
export function orderTasksForElk<T extends { id: string; dependsOn: string[] }>(
    nodes: ReadonlyArray<T>,
    timeKey: (node: T) => string,
): T[] {
    const present = new Set(nodes.map(node => node.id))
    const isRoot = (node: T) => node.dependsOn.filter(id => present.has(id)).length === 0
    const roots = nodes.filter(isRoot).sort((a, b) => timeKey(b).localeCompare(timeKey(a)))
    const rest = nodes.filter(node => !isRoot(node))
    return [...roots, ...rest]
}

/**
 * The hop list for one mission's hover thread — the dotted line chaining a
 * mission's cards on the blueprint canvas.
 *
 * Two properties this function exists to pin, both of which produced the
 * screen-wide stray dotted line the owner reported on mobile:
 *
 *  1. **Direction must match the ELK placement axis.** `orderTasksForElk` above
 *     stacks roots NEWEST-FIRST (`timeKey(b).localeCompare(timeKey(a))`), so a
 *     thread sorted oldest-first ran bottom-to-top against the stack. Cards
 *     expose handles left=target / right=source only, so every backwards hop
 *     forced `smoothstep` into a full detour around the card column — a dotted
 *     line spanning the viewport. The chain is therefore sorted with the SAME
 *     comparator direction as the ELK input, which keeps each hop forward
 *     along the layout axis. Chronological reading is preserved (owner ask
 *     2026-08-25); only the drawing direction changed.
 *  2. **Unplaced nodes are excluded.** A node missing from the position map is
 *     not on the canvas, and @xyflow/react renders an edge to it from (0,0) —
 *     another stray line. Every other canvas consumer filters on `positions`;
 *     the thread now does too.
 */
export function buildMissionThreadChain<T extends { id: string }>(
    nodes: ReadonlyArray<T>,
    timeKey: (node: T) => string,
    isPlaced: (id: string) => boolean,
): T[] {
    const placed = nodes.filter(node => isPlaced(node.id))
    if (placed.length < 2) return []
    return [...placed].sort((a, b) => timeKey(b).localeCompare(timeKey(a)))
}

/** Where a thread hop attaches to a card. Mirrors @xyflow/react's `Position`. */
export type MissionThreadSide = 'left' | 'right' | 'top' | 'bottom'

/** One hop of the mission thread, with the sides it should leave and enter by. */
export interface MissionThreadHop {
    sourceId: string
    targetId: string
    sourceSide: MissionThreadSide
    targetSide: MissionThreadSide
}

/** A placed card's box, in canvas coordinates. */
export interface MissionThreadBox {
    x: number
    y: number
    width: number
    height: number
}

/**
 * Turn an ordered mission chain into hops that route AROUND cards instead of
 * through them.
 *
 * ## Why the previous fix was not enough
 *
 * `3e4a4631` aligned the chain's sort direction with `orderTasksForElk`, on the
 * reasoning that a hop running backwards along the placement axis forces
 * `smoothstep` into a detour. That is true, but it fixed the ORDER while
 * leaving the real precondition unaddressed: every card exposes exactly two
 * handles, `target=Left` and `source=Right`, so a hop is always drawn
 * right-edge → left-edge.
 *
 * That is only a sane route when the target actually sits to the RIGHT of the
 * source. ELK lays the canvas out with `elk.direction: RIGHT`, which advances x
 * by dependency LAYER — not by time. Two tasks of one mission with no
 * dependency between them land in the SAME layer at the same x, stacked
 * vertically. Sorting them by time therefore says nothing about their x, and a
 * hop between two same-x cards leaves the right edge, has to come back to a
 * left edge at the same x, and `smoothstep` closes that loop by running back
 * across the column — straight through the card sitting between them. That is
 * the line the owner saw crossing `M-BLUEPRINT-CANVAS-UX`.
 *
 * The archive row-packing (`archiveColumnCount`, same day) made this far more
 * visible rather than causing it: chips that used to sit in one column at one x
 * now spread across up to four columns, so same-row hops became common and
 * every one of them is a backwards hop at some point in the row.
 *
 * ## The rule
 *
 * Pick the sides from the two boxes' actual geometry:
 *
 *  - Target clearly to the right → `right → left`, the natural reading, which
 *    is also what `smoothstep` draws most cleanly.
 *  - Target clearly to the left → `left → right`. Leaving by the left edge is
 *    what keeps the line outside the column instead of doubling back through
 *    it.
 *  - Neither (the same column, which is the archive-row and same-layer case) →
 *    go vertically, `bottom → top` or `top → bottom` by which card is lower,
 *    PROVIDED the column between them is empty. See below.
 *
 * "Clearly" is the point of `slack`: two cards whose x differ by a few pixels
 * are visually one column, and treating that as a horizontal hop reintroduces
 * the near-zero-width detour this exists to remove.
 *
 * ## Why the vertical case needed a second pass (2026-09-15)
 *
 * The rule above shipped with an unstated premise of its own — the mirror image
 * of the one the previous fix died on. It claimed "a vertical hop between two
 * vertically-stacked cards is the one route that cannot cross either of them",
 * which is true of the two ENDPOINTS and says nothing about anybody else. This
 * function only ever saw the two boxes it was hopping between; every other card
 * on the canvas was invisible to it.
 *
 * So when two same-mission cards share a column with a THIRD card stacked
 * between them — a card of some other mission, which is the normal state of an
 * ELK layer — the `bottom → top` route drew a straight line down the column
 * centre, straight through that third card's body. Observed on rc.30: the
 * thread's upper vertical segment crossing `M-GRAPH-FEATURE-UNRELIAB…`. The
 * hop BELOW it in the same thread was horizontal, exited sideways and cleared
 * the column cleanly, which is exactly why one half of the thread looked
 * correct and the other did not.
 *
 * The fix is to pass the obstacles in (`obstacles`) and check the corridor. A
 * vertical hop is only taken when the span between the two cards is clear; when
 * something blocks it, the hop leaves sideways instead — by whichever flank has
 * room — so the line runs beside the column rather than down it. The vertical
 * route stays the default because it is the cleanest one when it is available,
 * and it usually is.
 *
 * `obstacles` is optional and defaults to empty, which reproduces the old
 * behaviour exactly. That is deliberate: a caller that has not measured the
 * canvas yet should still get a drawable thread rather than no thread.
 */
export function buildMissionThreadHops(
    chain: ReadonlyArray<{ id: string }>,
    boxOf: (id: string) => MissionThreadBox | undefined,
    slack = 24,
    obstacles: ReadonlyArray<{ id: string; box: MissionThreadBox }> = [],
): MissionThreadHop[] {
    const hops: MissionThreadHop[] = []
    for (let i = 0; i < chain.length - 1; i += 1) {
        const sourceId = chain[i].id
        const targetId = chain[i + 1].id
        const source = boxOf(sourceId)
        const target = boxOf(targetId)
        /* No geometry (not yet measured) — fall back to the plain left/right
         * reading rather than dropping the hop, so the thread still draws. */
        if (!source || !target) {
            hops.push({ sourceId, targetId, sourceSide: 'right', targetSide: 'left' })
            continue
        }
        const sourceRight = source.x + source.width
        const targetRight = target.x + target.width
        if (target.x >= sourceRight - slack) {
            hops.push({ sourceId, targetId, sourceSide: 'right', targetSide: 'left' })
        } else if (targetRight <= source.x + slack) {
            hops.push({ sourceId, targetId, sourceSide: 'left', targetSide: 'right' })
        } else {
            // Overlapping x ranges: one column.
            const sourceIsAbove = source.y + source.height / 2 <= target.y + target.height / 2
            const upper = sourceIsAbove ? source : target
            const lower = sourceIsAbove ? target : source
            /* Is the column between them actually empty? Only then is straight
             * down the clean route; otherwise it is the route THROUGH the card
             * sitting in the gap. */
            const blocked = obstacles.some(obstacle => {
                if (obstacle.id === sourceId || obstacle.id === targetId) return false
                return verticalCorridorHits(upper, lower, obstacle.box, slack)
            })
            if (!blocked) {
                hops.push({
                    sourceId,
                    targetId,
                    sourceSide: sourceIsAbove ? 'bottom' : 'top',
                    targetSide: sourceIsAbove ? 'top' : 'bottom',
                })
                continue
            }
            /* Blocked: go around the column instead of down it. Pick the flank
             * with more clearance so the detour is the shorter of the two, and
             * so a column pinned against one edge of the canvas does not send
             * the line back across everything. */
            const side = clearerFlank(source, target, obstacles, sourceId, targetId, slack)
            hops.push({ sourceId, targetId, sourceSide: side, targetSide: side })
        }
    }
    return hops
}

/**
 * Does `candidate` sit inside the vertical corridor between two stacked cards?
 *
 * The corridor is the x-span the two cards share (that is where a vertical hop
 * is drawn) and the y-gap strictly between them. `slack` is subtracted from
 * every edge so that a card merely touching the corridor — the 1px abutments
 * that ELK's own spacing produces — does not count as blocking it and push
 * every hop onto the sideways route.
 */
function verticalCorridorHits(
    upper: MissionThreadBox,
    lower: MissionThreadBox,
    candidate: MissionThreadBox,
    slack: number,
): boolean {
    const corridorTop = upper.y + upper.height
    const corridorBottom = lower.y
    if (corridorBottom - corridorTop <= 0) return false
    const corridorLeft = Math.max(upper.x, lower.x)
    const corridorRight = Math.min(upper.x + upper.width, lower.x + lower.width)
    if (corridorRight - corridorLeft <= 0) return false
    const candidateRight = candidate.x + candidate.width
    const candidateBottom = candidate.y + candidate.height
    const overlapsX = candidate.x < corridorRight - slack && candidateRight > corridorLeft + slack
    const overlapsY = candidate.y < corridorBottom - slack && candidateBottom > corridorTop + slack
    return overlapsX && overlapsY
}

/**
 * Which flank a blocked vertical hop should leave by.
 *
 * Both ends use the SAME side, which is what makes this a detour rather than a
 * crossing: leaving left and entering right would run the line back through the
 * column it is trying to avoid. Exiting and re-entering on one side draws a
 * bracket around the column, clear of everything in it.
 *
 * The choice is by clearance — how much empty canvas lies beyond that side of
 * the two cards. Ties go left only as a tiebreak; there is no meaning to the
 * preference beyond determinism.
 */
function clearerFlank(
    source: MissionThreadBox,
    target: MissionThreadBox,
    obstacles: ReadonlyArray<{ id: string; box: MissionThreadBox }>,
    sourceId: string,
    targetId: string,
    slack: number,
): 'left' | 'right' {
    const top = Math.min(source.y, target.y)
    const bottom = Math.max(source.y + source.height, target.y + target.height)
    const left = Math.min(source.x, target.x)
    const right = Math.max(source.x + source.width, target.x + target.width)
    let leftClearance = left
    let rightClearance = Number.POSITIVE_INFINITY
    for (const obstacle of obstacles) {
        if (obstacle.id === sourceId || obstacle.id === targetId) continue
        const box = obstacle.box
        /* Only cards level with the hop can crowd its flanks. */
        if (box.y + box.height <= top + slack || box.y >= bottom - slack) continue
        const boxRight = box.x + box.width
        if (boxRight <= left) leftClearance = Math.min(leftClearance, left - boxRight)
        else if (box.x >= right) rightClearance = Math.min(rightClearance, box.x - right)
    }
    return rightClearance >= leftClearance ? 'right' : 'left'
}

/**
 * What a card ACTIVATION does to the lit mission, for both input devices.
 *
 * The thread carries real information — which tasks belong to one mission, in
 * time order — so it must stay reachable on touch. It was briefly suppressed
 * there (2026-08-25) because a tap fires a synthetic `mouseenter` with no
 * matching `mouseleave`, which stuck the thread on permanently; the fix is a
 * dismiss gesture, not suppression (owner call 2026-09-15).
 *
 * Why the toggle-off half is hover-less-ONLY: on a pointer device
 * `onNodeMouseEnter` has already stored this exact mission by the time the
 * click lands, so an unconditional toggle would read the very first click as
 * "second tap" and snuff a thread the pointer is still resting on. Desktop
 * therefore only re-asserts what hover set, leaving the delayed mouseleave
 * clear in charge. Touch has no such predecessor event, so there the second
 * tap is genuinely a second tap.
 *
 * Extracted from the component because @xyflow/react renders zero edges under
 * jsdom (nodes have no measured geometry), so a render-level assertion on the
 * thread passes vacuously whatever the state — it cannot tell this rule from
 * its inverse. This function is where the rule is actually pinned.
 */
export function nextHoveredMissionOnCardActivate(
    current: string | null,
    activatedMissionId: string | null | undefined,
    pointerHasHover: boolean,
): string | null {
    const next = typeof activatedMissionId === 'string' && activatedMissionId ? activatedMissionId : null
    if (pointerHasHover) return next
    return current === next ? null : next
}
