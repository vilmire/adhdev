/**
 * Mesh tool implementations — GRAPH ORCHESTRATION domain (phase E).
 *
 * Source of truth: docs/design/2026-08-18-graph-orchestration-full.md
 *
 * ★ THIS IS THE POINT OF PHASE E. Phase C2 (`mesh-graph-gates.ts`) implemented the
 * whole coordinator gate contract — claim, fenced release, leases, the deadline
 * sweep — but deliberately exposed NONE of it over MCP ("NOT HERE (by design):
 * MCP/JSON-RPC tool exposure (phase E)"). Until these tools existed, a gate could
 * be declared and opened but a coordinator had no way to pass it, so a graph with
 * a gate was un-advanceable. These three tools are that missing surface.
 *
 * ── What is exposed, and what is deliberately NOT ────────────────────────────
 *  - `mesh_graph_gate_claim`   → claimMeshGraphGate   (design :407-408)
 *  - `mesh_graph_gate_release` → releaseMeshGraphGate (design :409-421)
 *  - `mesh_graph_view`         → buildMeshGraphViews  (design :759-775)
 *
 * There is NO tool that expires, force-releases, or auto-passes a gate. The
 * deadline sweep runs on the daemon reconcile tick and can only EXPIRE a gate
 * (design :431-432: no `auto_release`; elapsed time is never completion
 * evidence). Adding a coordinator-callable "force release" would reintroduce the
 * exact M-TERMINAL-ADMISSION-GATE defect class the gate contract exists to
 * prevent — do not add one.
 *
 * ── Error shape ──────────────────────────────────────────────────────────────
 * The C2 core signals rejection two ways, and both are preserved verbatim:
 *   - claim returns `{ claimed: false, reason }` for an expected refusal
 *     (gate_lease_held, gate_not_awaiting, …) — a normal, retryable answer;
 *   - release THROWS for every rejection, because its whole transaction must roll
 *     back (stale_fence, gate_lease_expired, gate_release_conflict, …).
 * The thrown message is prefixed with its machine-readable code, so it is parsed
 * back out into `code` rather than being flattened into prose.
 */

import {
    claimMeshGraphGate,
    releaseMeshGraphGate,
    buildMeshGraphViews,
    requestUsesGraphV2,
    recordGraphGateClaimed,
    recordGraphGateReleased,
    readString,
    recordMeshCoordinatorToolCall,
    refreshMeshFromDaemon,
    triggerMeshQueueAndReport,
} from './mesh-tools-internal.js';
import type { MeshContext, MeshGraphGatePlanSpec, MeshTaskGraphEntrySpec } from './mesh-tools-internal.js';

// ── batch v2 request normalization (design :566-592) ─────────────────────────
//
// ★ WHY THIS LIVES HERE AND NOT IN mesh-tools-queue.ts:
// `mesh-tools-queue.ts` is one of the three pinned SCHEDULING SURFACES (design
// :984-986, enforced by daemon-core's mesh-scheduler-dependency-gate-invariant
// suite): a scheduling surface must never grow graph-layer vocabulary of its own,
// because the whole safety argument is that the scheduler learns NOTHING about
// graphs — a not-ready task simply carries a system block and the UNCHANGED
// `taskDependenciesSatisfied` predicate refuses it. Parsing `run_if` /
// `inputs_from` / `workspace_ref` inside that file would put graph tokens in the
// one place the design says they may never appear, even though this code only
// FORWARDS them. Keeping the vocabulary in the graph module preserves both the
// invariant and its structural test.

/** design :568-570 — the per-task v2 fields. Every one is optional and additive. */
export interface GraphTaskFieldsShape {
    inputs_from?: unknown;
    inputsFrom?: unknown;
    run_if?: unknown;
    runIf?: unknown;
    on_false?: unknown;
    onFalse?: unknown;
    on_upstream_skip?: string;
    onUpstreamSkip?: string;
    workspace_ref?: string;
    workspaceRef?: string;
    gated_by?: string[];
    gatedBy?: string[];
}

/** design :570 — a delayed worktree declaration; preparation is a compensated saga. */
export interface GraphWorkspaceDeclarationShape {
    ref: string;
    source_node_id?: string;
    sourceNodeId?: string;
    purpose?: string;
    base_revision?: string;
    baseRevision?: string;
    desired_path?: string;
    desiredPath?: string;
    cleanup_on_graph_failure?: boolean;
    cleanupOnGraphFailure?: boolean;
}

export interface GraphPlanShape {
    tasks: Array<MeshTaskGraphEntrySpec & Record<string, unknown>>;
    gates: MeshGraphGatePlanSpec[];
    workspaces: ReturnType<typeof normalizeWorkspaceDeclarations>;
    /** True when the caller used any v2 surface — i.e. this is NOT an old-path batch. */
    useGraphPath: boolean;
}

/**
 * Read the graph-only fields off one raw task entry, tolerating both spellings.
 *
 * Returns UNDEFINED for every field the caller omitted, so daemon-core's
 * `isAdvancedGraphTask` sees exactly the caller's intent — an absent field must
 * never become a present-but-empty one, which would drag a static task onto the
 * graph path and block a row that should have run immediately.
 */
export function readGraphTaskFields(entry: GraphTaskFieldsShape): Record<string, unknown> {
    const inputsFrom = entry.inputs_from ?? entry.inputsFrom;
    const runIf = entry.run_if ?? entry.runIf;
    const onFalse = entry.on_false ?? entry.onFalse;
    const onUpstreamSkip = readString(entry.on_upstream_skip) || readString(entry.onUpstreamSkip) || undefined;
    const workspaceRef = readString(entry.workspace_ref) || readString(entry.workspaceRef) || undefined;
    const rawGatedBy = entry.gated_by ?? entry.gatedBy;
    const gatedBy = Array.isArray(rawGatedBy)
        ? rawGatedBy.map(g => readString(g)).filter((g): g is string => !!g)
        : undefined;
    return {
        ...(inputsFrom !== undefined ? { inputs_from: inputsFrom } : {}),
        ...(runIf !== undefined ? { run_if: runIf } : {}),
        ...(onFalse !== undefined ? { on_false: onFalse } : {}),
        ...(onUpstreamSkip ? { on_upstream_skip: onUpstreamSkip } : {}),
        ...(workspaceRef ? { workspace_ref: workspaceRef } : {}),
        ...(gatedBy && gatedBy.length > 0 ? { gated_by: gatedBy } : {}),
    };
}

/** Normalize the v2 `workspaces` array to daemon-core's snake_case declaration shape. */
export function normalizeWorkspaceDeclarations(raw: GraphWorkspaceDeclarationShape[] | undefined) {
    if (!Array.isArray(raw)) return [];
    return raw.map(w => ({
        ref: readString(w?.ref) || '',
        ...(readString(w?.source_node_id ?? w?.sourceNodeId) ? { source_node_id: readString(w.source_node_id ?? w.sourceNodeId) } : {}),
        ...(readString(w?.purpose) ? { purpose: readString(w.purpose) } : {}),
        ...(readString(w?.base_revision ?? w?.baseRevision) ? { base_revision: readString(w.base_revision ?? w.baseRevision) } : {}),
        ...(readString(w?.desired_path ?? w?.desiredPath) ? { desired_path: readString(w.desired_path ?? w.desiredPath) } : {}),
        ...((w?.cleanup_on_graph_failure ?? w?.cleanupOnGraphFailure) === true ? { cleanup_on_graph_failure: true } : {}),
    }));
}

/**
 * Fold the already-normalized queue specs together with the raw entries' graph
 * fields, and decide which path the request takes.
 *
 * `hasExplicitBatchId` also selects the graph path: the whole point of `batch_id`
 * is the UNIQUE(mesh_id, batch_id) idempotency contract (design :108, :118-120),
 * and that contract lives on the graph row — a static plan carrying a batch_id but
 * taking the old path would silently double-insert on the very retry the key was
 * supplied to make safe.
 */
export function buildGraphPlanShape(
    specs: MeshTaskGraphEntrySpec[],
    rawEntries: Array<GraphTaskFieldsShape | undefined>,
    gates: MeshGraphGatePlanSpec[] | undefined,
    workspaces: GraphWorkspaceDeclarationShape[] | undefined,
    hasExplicitBatchId: boolean,
): GraphPlanShape {
    const gateSpecs = Array.isArray(gates) ? gates : [];
    const workspaceSpecs = normalizeWorkspaceDeclarations(workspaces);
    const tasks = specs.map((spec, i) => ({ ...spec, ...readGraphTaskFields(rawEntries[i] ?? {}) }));
    return {
        tasks,
        gates: gateSpecs,
        workspaces: workspaceSpecs,
        useGraphPath: hasExplicitBatchId
            || requestUsesGraphV2({ tasks, gates: gateSpecs, workspaces: workspaceSpecs }),
    };
}

/**
 * Rejection codes `releaseMeshGraphGate` throws (design :417-421). Matched by
 * prefix so the LLM caller gets a stable `code` instead of parsing prose.
 */
const GATE_RELEASE_ERROR_CODES = [
    'gate_not_found',
    'gate_release_conflict',
    'gate_already_released',
    'gate_not_claimed',
    'stale_fence',
    'gate_lease_expired',
    'gate_upstream_unsettled',
    'gate_patch_not_downstream',
    'gate_patch_forbidden',
    'task_already_claimed',
    'graph_node_not_found',
] as const;

function classifyGateError(message: string): string | undefined {
    return GATE_RELEASE_ERROR_CODES.find(code => message.startsWith(`${code}:`) || message.includes(`${code}:`));
}

/**
 * The coordinator session identity a gate lease is bound to.
 *
 * A gate's whole safety model is "one live coordinator owns this decision", so an
 * unidentified caller must not be able to take a lease: two anonymous claimants
 * would share the same owner string and each would look like a same-owner refresh
 * of the other's lease, quietly defeating the fencing generation. An explicit
 * argument is allowed (an operator driving a gate by hand), but there is no
 * implicit fallback.
 */
function resolveGateSession(ctx: MeshContext, explicit?: unknown): string | undefined {
    return readString(explicit) || ctx.coordinatorSessionId || undefined;
}

/**
 * `mesh_graph_gate_claim` (design :407-408, :425-439).
 *
 * Takes the lease on a gate that is awaiting a coordinator, returning the
 * monotonically increasing `leaseGeneration` and the opaque `fencingToken` that
 * the matching release MUST present. Both are required at release: a stale
 * generation or a wrong token can never release the gate.
 */
export async function meshGraphGateClaim(
    ctx: MeshContext,
    args: {
        gate_id?: string; gateId?: string;
        lease_seconds?: number; leaseSeconds?: number;
        extend_deadline_seconds?: number; extendDeadlineSeconds?: number;
        coordinator_session_id?: string; coordinatorSessionId?: string;
    },
): Promise<string> {
    recordMeshCoordinatorToolCall(ctx, 'mesh_graph_gate_claim');
    const gateId = readString(args.gate_id) || readString(args.gateId);
    if (!gateId) {
        return JSON.stringify({
            success: false,
            code: 'missing_gate_id',
            error: 'mesh_graph_gate_claim requires gate_id. Use mesh_graph_view to list gates awaiting a coordinator.',
        });
    }
    const coordinatorSessionId = resolveGateSession(ctx, args.coordinator_session_id ?? args.coordinatorSessionId);
    if (!coordinatorSessionId) {
        return JSON.stringify({
            success: false,
            code: 'missing_coordinator_session',
            error: 'No coordinator session id is available for this call, so a gate lease cannot be attributed to an owner. '
                + 'Pass coordinator_session_id explicitly.',
        });
    }
    const leaseSeconds = readNumber(args.lease_seconds ?? args.leaseSeconds);
    const extendDeadlineSeconds = readNumber(args.extend_deadline_seconds ?? args.extendDeadlineSeconds);

    try {
        const result = claimMeshGraphGate({
            meshId: ctx.mesh.id,
            gateId,
            coordinatorSessionId,
            ...(leaseSeconds !== undefined ? { leaseSeconds } : {}),
            ...(extendDeadlineSeconds !== undefined ? { extendDeadlineSeconds } : {}),
        });
        if (!result.claimed) {
            // An expected refusal, not an error: the caller may legitimately retry
            // later (a held lease lapses) or stop (a terminal gate never reopens).
            return JSON.stringify({
                success: false,
                claimed: false,
                code: result.reason ?? 'gate_not_claimable',
                gateId,
                ...(result.gate ? { gateState: result.gate.state, action: result.gate.action } : {}),
                error: describeClaimRefusal(result.reason, result.gate?.state),
            });
        }
        recordGraphGateClaimed(ctx.mesh.id, {
            graphId: result.gate!.graphId,
            gateId,
            ref: result.gate!.ref,
            action: result.gate!.action,
            generation: result.leaseGeneration!,
            ownerSessionId: coordinatorSessionId,
            leaseExpiresAt: result.leaseExpiresAt,
            ambiguousExternalOutcome: result.ambiguousExternalOutcome,
            previousLeaseOwnerSessionId: result.previousLeaseOwnerSessionId,
        });
        return JSON.stringify({
            success: true,
            claimed: true,
            gateId,
            graphId: result.gate!.graphId,
            ...(result.gate!.ref ? { ref: result.gate!.ref } : {}),
            action: result.gate!.action,
            ...(result.gate!.instructions ? { instructions: result.gate!.instructions } : {}),
            // ★ Both values are REQUIRED by mesh_graph_gate_release. Losing them
            // means the lease must lapse before anyone can act on the gate again.
            leaseGeneration: result.leaseGeneration,
            fencingToken: result.fencingToken,
            leaseExpiresAt: result.leaseExpiresAt,
            ...(result.deadlineAt ? { deadlineAt: result.deadlineAt } : {}),
            onTimeout: result.gate!.onTimeout,
            ...(result.ambiguousExternalOutcome
                ? {
                    ambiguousExternalOutcome: true,
                    previousLeaseOwnerSessionId: result.previousLeaseOwnerSessionId,
                    ambiguousExternalOutcomeHint:
                        'This claim TOOK OVER from a previous owner whose lease lapsed. That owner may already have performed '
                        + 'the external side effect (merge, publish, deploy). Reconcile external evidence — check whether the '
                        + 'action already landed — BEFORE performing it again, then release with the real outcome.',
                }
                : {}),
            nextStep: 'Perform the gate action yourself, then call mesh_graph_gate_release with this leaseGeneration + fencingToken '
                + 'and an idempotency_key. The daemon never performs a gate action and never auto-releases: the gate stays shut '
                + 'until you release it (a deadline can only EXPIRE it, never pass it).',
        });
    } catch (e: any) {
        const message = e?.message || String(e);
        return JSON.stringify({ success: false, claimed: false, gateId, code: classifyGateError(message), error: message });
    }
}

function describeClaimRefusal(reason: string | undefined, state?: string): string {
    switch (reason) {
        case 'gate_not_found':
            return 'No such gate on this mesh. Use mesh_graph_view to list gates.';
        case 'gate_not_eligible':
            return 'This gate is restricted to a different coordinator session (eligible_coordinator_session_id).';
        case 'gate_not_awaiting':
            return 'The gate is still `declared` — its predecessors have not completed yet, so it is not open for a coordinator. '
                + 'Wait for the upstream work; the gate opens itself when its predecessors settle.';
        case 'gate_lease_held':
            return 'Another coordinator holds a LIVE lease on this gate. Wait for the lease to lapse — a live lease is never '
                + 'taken over, because the holder may be mid-action.';
        case 'gate_claim_race':
            return 'Another claim won the race for this gate. Re-read the gate state and retry if it is still awaiting.';
        default:
            if (reason?.startsWith('gate_terminal:')) {
                return `The gate is terminal (${state ?? reason.slice('gate_terminal:'.length)}) and cannot be claimed. `
                    + 'A released gate stays released; an expired gate under cancel_downstream/fail_graph has already applied its policy.';
            }
            return `The gate could not be claimed (${reason ?? 'unknown reason'}).`;
    }
}

/**
 * `mesh_graph_gate_release` (design :409-421).
 *
 * The ONLY way through a gate. Validates the fence, re-checks the gate's own
 * predecessors, applies any permitted downstream patches, materializes what the
 * release unblocks, and commits it all in ONE transaction — so a rejection
 * leaves the gate claimed and downstream blocked, exactly as before the call.
 */
export async function meshGraphGateRelease(
    ctx: MeshContext,
    args: {
        gate_id?: string; gateId?: string;
        fencing_token?: string; fencingToken?: string;
        lease_generation?: number; leaseGeneration?: number;
        idempotency_key?: string; idempotencyKey?: string;
        outcome?: string;
        result?: unknown;
        evidence?: unknown;
        patches?: Array<{ node?: string; base_spec_patch?: Record<string, unknown>; baseSpecPatch?: Record<string, unknown> }>;
    },
): Promise<string> {
    recordMeshCoordinatorToolCall(ctx, 'mesh_graph_gate_release');
    const gateId = readString(args.gate_id) || readString(args.gateId);
    const fencingToken = readString(args.fencing_token) || readString(args.fencingToken);
    const leaseGeneration = readNumber(args.lease_generation ?? args.leaseGeneration);
    const idempotencyKey = readString(args.idempotency_key) || readString(args.idempotencyKey);
    const outcome = readString(args.outcome);

    const missing = [
        !gateId ? 'gate_id' : null,
        !fencingToken ? 'fencing_token' : null,
        leaseGeneration === undefined ? 'lease_generation' : null,
        !idempotencyKey ? 'idempotency_key' : null,
        !outcome ? 'outcome' : null,
    ].filter((f): f is string => f !== null);
    if (missing.length > 0) {
        return JSON.stringify({
            success: false,
            code: 'missing_release_fields',
            missing,
            error: `mesh_graph_gate_release requires ${missing.join(', ')}. `
                + 'fencing_token and lease_generation come from the mesh_graph_gate_claim response; idempotency_key is yours to '
                + 'choose and makes a retried release a no-op instead of a double release.',
        });
    }

    const patches = (args.patches ?? [])
        .map(p => ({
            node: readString(p?.node) || '',
            baseSpecPatch: (p?.base_spec_patch ?? p?.baseSpecPatch ?? {}) as Record<string, unknown>,
        }))
        .filter(p => p.node.length > 0);

    try {
        const result = releaseMeshGraphGate({
            meshId: ctx.mesh.id,
            gateId: gateId!,
            fencingToken: fencingToken!,
            leaseGeneration: leaseGeneration!,
            idempotencyKey: idempotencyKey!,
            outcome: outcome!,
            ...(args.result !== undefined ? { result: args.result } : {}),
            ...(args.evidence !== undefined ? { evidence: args.evidence } : {}),
            ...(patches.length > 0 ? { patches } : {}),
        });
        recordGraphGateReleased(ctx.mesh.id, {
            graphId: result.gate!.graphId,
            gateId: gateId!,
            ref: result.gate!.ref,
            action: result.gate!.action,
            outcome: outcome!,
            generation: leaseGeneration!,
            releaseDigest: result.gate!.releaseEvidenceDigest,
            materializedNodeIds: result.materializedNodeIds,
            duplicate: result.duplicate,
        });
        // Newly materialized downstream rows are claimable now — nudge the queue so
        // an idle node picks them up without waiting for the next reconcile tick.
        const queueTrigger = result.materializedNodeIds.length > 0
            ? await triggerMeshQueueAndReport(ctx)
            : undefined;
        return JSON.stringify({
            success: true,
            released: true,
            // A replayed release (same key + same digest) is a NO-OP SUCCESS, not an
            // error — that is what makes a retried release safe (design :420-421).
            duplicate: result.duplicate,
            gateId,
            graphId: result.gate!.graphId,
            ...(result.gate!.ref ? { ref: result.gate!.ref } : {}),
            outcome,
            materializedNodeIds: result.materializedNodeIds,
            materializedCount: result.materializedNodeIds.length,
            ...(queueTrigger ? { queueTrigger } : {}),
            ...(result.duplicate
                ? { duplicateHint: 'This idempotency_key + payload was already committed; nothing changed. Re-sending an identical release is safe.' }
                : {}),
        });
    } catch (e: any) {
        const message = e?.message || String(e);
        const code = classifyGateError(message);
        return JSON.stringify({
            success: false,
            released: false,
            gateId,
            ...(code ? { code } : {}),
            error: message,
            ...(code === 'gate_lease_expired'
                ? {
                    hint: 'The lease expired before the release. Elapsed time is never completion evidence, so the release is refused. '
                        + 'Re-claim the gate (you get a HIGHER generation), reconcile whether the external action already landed, then release.',
                }
                : {}),
            ...(code === 'stale_fence'
                ? { hint: 'Another coordinator has claimed this gate since your claim. Your token is stale — re-claim before releasing.' }
                : {}),
            ...(code === 'gate_release_conflict'
                ? { hint: 'This idempotency_key was already used with a DIFFERENT payload. Use a new key, or re-send the identical payload.' }
                : {}),
        });
    }
}

/**
 * `mesh_graph_view` (design :759-763) — the read-only graph projection: nodes and
 * their refs, active edges, materialization receipts, gates, workspace sagas,
 * derived dependency failures, and the next required coordinator action.
 *
 * Defaults to the graphs that still need attention. It writes nothing, and every
 * explanatory field is derived at read time (a retried predecessor that succeeds
 * makes a dependency failure disappear on its own — the C3 contract).
 */
export async function meshGraphView(
    ctx: MeshContext,
    args: {
        graph_id?: string; graphId?: string;
        batch_id?: string; batchId?: string;
        include_terminal?: boolean; includeTerminal?: boolean;
        limit?: number;
    },
): Promise<string> {
    recordMeshCoordinatorToolCall(ctx, 'mesh_graph_view');
    try {
        await refreshMeshFromDaemon(ctx);
        const graphId = readString(args.graph_id) || readString(args.graphId);
        const batchId = readString(args.batch_id) || readString(args.batchId);
        const includeTerminal = args.include_terminal === true || args.includeTerminal === true;
        const graphs = buildMeshGraphViews(ctx.mesh.id, {
            ...(graphId ? { graphId } : {}),
            ...(batchId ? { batchId } : {}),
            activeOnly: !includeTerminal,
            ...(readNumber(args.limit) !== undefined ? { limit: readNumber(args.limit) } : {}),
        });
        const pendingActions = graphs.flatMap(g =>
            (g.nextCoordinatorAction ?? []).map(a => ({ graphId: g.graphId, ...a })));
        return JSON.stringify({
            success: true,
            meshId: ctx.mesh.id,
            graphCount: graphs.length,
            ...(graphId || batchId ? {} : { scope: includeTerminal ? 'all' : 'in_flight' }),
            graphs,
            ...(pendingActions.length > 0 ? { pendingCoordinatorActions: pendingActions } : {}),
            ...(graphs.length === 0
                ? {
                    hint: graphId || batchId
                        ? 'No graph with that id on this mesh.'
                        : 'No in-flight orchestration graphs. Only mesh_enqueue_batch requests that use graph features '
                            + '(gates, inputs_from, run_if, workspace_ref) create a graph; a plain depends_on batch runs on the '
                            + 'unchanged queue path. Pass include_terminal=true to see completed graphs.',
                }
                : {}),
        });
    } catch (e: any) {
        return JSON.stringify({ success: false, error: e?.message || String(e) });
    }
}

function readNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
    return undefined;
}
