/**
 * mesh-graph-staleness — G3: periodic reminders for graphs and gates that have
 * gone quiet.
 *
 * The gate-open page (mesh-graph-transition-runner's gate-notify handler) fires
 * exactly once per gate while undrained. Once the coordinator consumes it and
 * moves on without acting — or a graph simply stops advancing — NOTHING
 * re-surfaces the item: measured live 2026-08-24, 49 graphs sat `active` with
 * zero updates for 3-5 days and 7 gates sat `awaiting_coordinator` for 3 days,
 * silently. This sweep pages the coordinator again, once per reminder window,
 * for every graph/gate that has been stale past a threshold.
 *
 * Reminders only: the sweep never mutates graph, gate, or queue state. Timeout
 * POLICY stays with the reconcile loop's gate deadline sweep (which may expire,
 * never release) — staleness here is purely a visibility mechanism.
 *
 * Dedup: pendingCoordinatorEvents collapses by fingerprint, whose generic key
 * includes `metadataEvent.taskId` (see buildPendingEventFingerprint). Anchoring
 * that on `<id>:stale:<floor(now / window)>` makes each item page at most once
 * per window while undrained, and page again in the next window if still stale.
 */
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { queuePendingMeshCoordinatorEvent } from './mesh-events-pending.js';
import type { MeshGraphGateRow, MeshTaskGraphRow, MeshTaskGraphNodeRow } from './mesh-graph-types.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Stale = no row update for this long. Env-tunable, clamped to [1h, 7d]. */
export const DEFAULT_GRAPH_STALE_THRESHOLD_MS = DAY_MS;
/** At most one reminder per item per window. Env-tunable, clamped to [1h, 7d]. */
export const DEFAULT_GRAPH_STALE_REMINDER_WINDOW_MS = DAY_MS;

const DURATION_MIN_MS = HOUR_MS;
const DURATION_MAX_MS = 7 * DAY_MS;

/**
 * Same contract as runtime-defaults' readMeshTimeoutEnvMs but with hour/day
 * scale clamps — that helper clamps to [1s, 120s], which cannot express a
 * staleness threshold. Out-of-range or unparsable values fall back, so a typo
 * can never disable the sweep or turn it into a spam loop.
 */
function readStaleDurationEnvMs(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
    const parsed = Number(String(raw).trim());
    if (!Number.isFinite(parsed)) return fallback;
    if (parsed < DURATION_MIN_MS || parsed > DURATION_MAX_MS) return fallback;
    return Math.floor(parsed);
}

export function getGraphStaleThresholdMs(): number {
    return readStaleDurationEnvMs('ADHDEV_MESH_GRAPH_STALE_MS', DEFAULT_GRAPH_STALE_THRESHOLD_MS);
}

export function getGraphStaleReminderWindowMs(): number {
    return readStaleDurationEnvMs('ADHDEV_MESH_GRAPH_STALE_REMINDER_MS', DEFAULT_GRAPH_STALE_REMINDER_WINDOW_MS);
}

export interface MeshGraphStalenessSweepResult {
    staleGraphs: number;
    staleGates: number;
    remindersQueued: number;
}

interface SweepOptions {
    nowMs?: number;
    staleThresholdMs?: number;
    reminderWindowMs?: number;
}

const LIVE_NODE_STATES = ['declared', 'blocked', 'materialized', 'awaiting_coordinator'] as const;
const STALE_GATE_STATES = ['awaiting_coordinator', 'expired'] as const;

function parseIsoMs(iso: string | undefined): number | null {
    if (!iso) return null;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : null;
}

function staleHoursLabel(nowMs: number, updatedAtMs: number): string {
    const hours = Math.max(1, Math.floor((nowMs - updatedAtMs) / HOUR_MS));
    return hours >= 48 ? `${Math.floor(hours / 24)}d` : `${hours}h`;
}

function frontierSummary(nodes: MeshTaskGraphNodeRow[]): string {
    const counts = new Map<string, number>();
    for (const node of nodes) {
        if ((LIVE_NODE_STATES as readonly string[]).includes(node.state)) {
            counts.set(node.state, (counts.get(node.state) ?? 0) + 1);
        }
    }
    if (counts.size === 0) return 'no live worker frontier';
    return [...counts.entries()].map(([state, n]) => `${n} ${state}`).join(', ');
}

function gateSummary(gate: MeshGraphGateRow): string {
    const label = gate.ref || gate.gateId;
    return `'${label}' (${gate.action}, ${gate.state})`;
}

/**
 * Page the coordinator for every stale graph/gate in one mesh. Read-only over
 * graph state; the only side effect is queuePendingMeshCoordinatorEvent.
 * Cheap by construction: active/waiting_gate graphs are a small set, and node
 * lists are only loaded for the graphs that are actually stale.
 */
export function sweepMeshGraphStaleness(meshId: string, opts?: SweepOptions): MeshGraphStalenessSweepResult {
    const nowMs = opts?.nowMs ?? Date.now();
    const staleThresholdMs = opts?.staleThresholdMs ?? getGraphStaleThresholdMs();
    const reminderWindowMs = opts?.reminderWindowMs ?? getGraphStaleReminderWindowMs();
    const bucket = Math.floor(nowMs / reminderWindowMs);

    const graphStore = MeshRuntimeStore.getInstance().graphStore();
    const result: MeshGraphStalenessSweepResult = { staleGraphs: 0, staleGates: 0, remindersQueued: 0 };

    const staleGraphIds = new Set<string>();
    const graphs = graphStore.listGraphsByMesh(meshId, { statuses: ['active', 'waiting_gate'] });
    for (const graph of graphs) {
        const updatedAtMs = parseIsoMs(graph.updatedAt) ?? parseIsoMs(graph.createdAt);
        if (updatedAtMs === null || nowMs - updatedAtMs < staleThresholdMs) continue;
        result.staleGraphs += 1;
        staleGraphIds.add(graph.graphId);
        if (queueGraphReminder(graphStore, graph, nowMs, updatedAtMs, bucket)) result.remindersQueued += 1;
    }

    // Gates whose GRAPH still looks fresh (edge case: something else bumped the
    // graph row) still deserve their own reminder; gates on stale graphs are
    // already named inside the graph reminder above — do not page them twice.
    for (const gate of graphStore.listGatesByMesh(meshId, STALE_GATE_STATES)) {
        const updatedAtMs = parseIsoMs(gate.updatedAt) ?? parseIsoMs(gate.createdAt);
        if (updatedAtMs === null || nowMs - updatedAtMs < staleThresholdMs) continue;
        result.staleGates += 1;
        if (staleGraphIds.has(gate.graphId)) continue;
        if (queueGateReminder(gate, nowMs, updatedAtMs, bucket)) result.remindersQueued += 1;
    }

    return result;
}

function queueGraphReminder(
    graphStore: ReturnType<ReturnType<typeof MeshRuntimeStore.getInstance>['graphStore']>,
    graph: MeshTaskGraphRow,
    nowMs: number,
    updatedAtMs: number,
    bucket: number,
): boolean {
    const nodes = graphStore.listNodes(graph.graphId);
    const gates = graphStore.listGatesByGraph(graph.graphId)
        .filter(g => (STALE_GATE_STATES as readonly string[]).includes(g.state));
    const age = staleHoursLabel(nowMs, updatedAtMs);
    const gatePart = gates.length > 0
        ? ` Awaiting gates: ${gates.map(gateSummary).join('; ')} — claim with mesh_graph_gate_claim, then release with evidence or abandon.`
        : '';
    const coordinatorMessage =
        `Graph ${graph.graphId} (${graph.status}) has not advanced for ${age}. `
        + `Frontier: ${frontierSummary(nodes)}.${gatePart} `
        + 'Inspect with mesh_graph_view; resume the work, release/abandon its gates, or cancel dead tasks so the graph can settle.';
    return queuePendingMeshCoordinatorEvent({
        event: 'mesh:graph_stale',
        meshId: graph.meshId,
        nodeLabel: graph.graphId.slice(0, 8),
        metadataEvent: {
            source: 'mesh_graph_staleness_sweep',
            // Windowed anchor: at most one page per graph per reminder window
            // while undrained; a new window re-pages if still stale.
            taskId: `${graph.graphId}:stale:${bucket}`,
            graphId: graph.graphId,
            graphStatus: graph.status,
            staleMs: nowMs - updatedAtMs,
            awaitingGateIds: gates.map(g => g.gateId),
            coordinatorMessage,
        },
        coordinatorMessage,
        queuedAt: nowMs,
    });
}

function queueGateReminder(gate: MeshGraphGateRow, nowMs: number, updatedAtMs: number, bucket: number): boolean {
    const age = staleHoursLabel(nowMs, updatedAtMs);
    const coordinatorMessage =
        `Coordinator gate ${gateSummary(gate)} on graph ${gate.graphId} has been waiting for ${age}. `
        + `${gate.instructions ? `Instructions: ${gate.instructions} ` : ''}`
        + `Claim it with mesh_graph_gate_claim (gateId: ${gate.gateId}) and release with evidence, or abandon it if the work is obsolete. Downstream tasks stay blocked until then.`;
    return queuePendingMeshCoordinatorEvent({
        event: 'mesh:graph_gate_stale',
        meshId: gate.meshId,
        nodeLabel: gate.ref || gate.gateId.slice(0, 8),
        metadataEvent: {
            source: 'mesh_graph_staleness_sweep',
            taskId: `${gate.gateId}:stale:${bucket}`,
            gateId: gate.gateId,
            graphId: gate.graphId,
            gateState: gate.state,
            action: gate.action,
            staleMs: nowMs - updatedAtMs,
            coordinatorMessage,
        },
        coordinatorMessage,
        queuedAt: nowMs,
    });
}
