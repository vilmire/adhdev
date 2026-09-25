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
 *  - `mesh_graph_gate_abandon` → abandonMeshGraphGate (design :399)
 *  - `mesh_graph_view`         → buildMeshGraphViews  (design :759-775)
 *
 * C-W9c (wiring-unification, 2026-09-24 19:00 stamp): every one of those cores
 * — plus `patchGraphNodeAndRetry` and `collectGateConvergenceEvidence` — now
 * runs in the daemon that owns the graph rows, reached over the
 * `graph_gate_claim` / `graph_gate_release` / `graph_gate_abandon` /
 * `graph_node_patch` / `graph_view_query` IPC commands (`../ipc/turn-commands.js`,
 * `@adhdev/mesh-shared` `turn-ipc.ts`). This file is now a thin client + the
 * response-shape mapping (`gateField()` below reads the wire's JSON-passthrough
 * `gate` object) — the tool-facing JSON shape is unchanged from before the move.
 *
 * There is NO tool that expires, force-releases, or auto-passes a gate. The
 * deadline sweep runs on the daemon reconcile tick and can only EXPIRE a gate
 * (design :431-432: no `auto_release`; elapsed time is never completion
 * evidence). Adding a coordinator-callable "force release" would reintroduce the
 * exact M-TERMINAL-ADMISSION-GATE defect class the gate contract exists to
 * prevent — do not add one.
 *
 * ★ `mesh_graph_gate_abandon` is NOT that force-release, and the distinction is
 * the whole reason it is safe to expose. A force-release would GRANT passage
 * without the evidence a release requires — that is the forbidden class. Abandon
 * DENIES passage permanently: it settles the gate `cancelled` (the design's own
 * `-> cancelled` edge, :399), materializes nothing, produces no outcome or
 * evidence for downstream bindings, and cancels every downstream node the gate
 * was holding. It exists because a gate whose work was cancelled is otherwise
 * uncloseable — the C3 cancel cascade skips gate nodes by design, the deadline
 * sweep skips gates that have no deadline at all, and `classifyGraphRollup`
 * refuses to classify a graph while any gate is unsettled — so the graph could
 * reach NO terminal state, not even `cancelled`. If you ever find yourself
 * widening abandon so that it opens something downstream, stop: that is the
 * force-release this header forbids, wearing a different name.
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
    requestUsesGraphV2,
    MESH_NODE_PATCH_KEYS,
    readString,
    recordMeshCoordinatorToolCall,
    refreshMeshFromDaemon,
} from './mesh-tools-internal.js';
import type { MeshContext, MeshGraphGatePlanSpec, MeshTaskGraphEntrySpec } from './mesh-tools-internal.js';
// C-W9c: the whole graph-gate/patch/view core now runs in the daemon that owns
// the graph rows — claim/release/abandon/patch/view and the gate's provenance
// audit record and post-materialization queue nudge all happen there in one
// round trip. This tool layer is now a thin client + response-shape mapper.
import { graphGateAbandon, graphGateClaim, graphGateRelease, graphNodePatch, graphViewQuery } from '../ipc/turn-commands.js';
import { unwrapCommandPayload } from './mesh-session-helpers.js';

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
    gated_by?: string[] | string;
    gatedBy?: string[] | string;
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
    // A single string is one gate ref, not "no gates": dropping it silently built a
    // gate with no edge (live 2026-09-25). Other non-array shapes are refused by
    // validate-tool-args.ts nestedArrayItemArrayTypeError before reaching here.
    const gatedByList = typeof rawGatedBy === 'string' ? [rawGatedBy] : rawGatedBy;
    const gatedBy = Array.isArray(gatedByList)
        ? gatedByList.map(g => readString(g)).filter((g): g is string => !!g)
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
 * `MeshGraphGateRow` field reader — the wire carries `gate` as a JSON
 * passthrough (`Record<string, unknown>`, see turn-ipc.ts's content-boundary
 * note on this section), so every access goes through this instead of a typed
 * property read.
 */
function gateField(gate: Record<string, unknown> | undefined, key: string): any {
    return gate ? (gate as any)[key] : undefined;
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
        extend_seconds?: number;
        coordinator_session_id?: string; coordinatorSessionId?: string;
    },
): Promise<string> {
    await recordMeshCoordinatorToolCall(ctx, 'mesh_graph_gate_claim');
    const gateId = readString(args.gate_id) || readString(args.gateId);
    if (!gateId) {
        return JSON.stringify({
            success: false,
            code: 'missing_gate_id',
            error: 'mesh_graph_gate_claim requires gate_id. Use mesh_graph_view to list gates awaiting a coordinator.',
        });
    }
    // D3(c) extend verb — see meshGraphGateExtend. Decided BEFORE the coordinator-
    // session check: extending a deadline takes no lease, so it needs no owner.
    if (args.extend_seconds !== undefined) {
        return meshGraphGateExtend(ctx, gateId, args);
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
        // C-W9c: the claim, its provenance audit record and the G4 convergence-
        // evidence probe all run in the daemon now — one round trip instead of
        // an in-process claim + a separate graphAuditRecord IPC call.
        const result = await graphGateClaim(ctx.transport, {
            meshId: ctx.mesh.id,
            gateId,
            coordinatorSessionId,
            ...(leaseSeconds !== undefined ? { leaseSeconds } : {}),
            ...(extendDeadlineSeconds !== undefined ? { extendDeadlineSeconds } : {}),
            probeConvergenceEvidence: true,
        });
        if (!result.claimed) {
            // An expected refusal, not an error: the caller may legitimately retry
            // later (a held lease lapses) or stop (a terminal gate never reopens).
            return JSON.stringify({
                success: false,
                claimed: false,
                code: result.reason ?? 'gate_not_claimable',
                gateId,
                ...(result.gate ? { gateState: gateField(result.gate, 'state'), action: gateField(result.gate, 'action') } : {}),
                error: describeClaimRefusal(result.reason, gateField(result.gate, 'state')),
            });
        }
        return JSON.stringify({
            success: true,
            claimed: true,
            gateId,
            graphId: gateField(result.gate, 'graphId'),
            ...(result.convergenceEvidence ? { convergenceEvidence: result.convergenceEvidence } : {}),
            ...(gateField(result.gate, 'ref') ? { ref: gateField(result.gate, 'ref') } : {}),
            action: gateField(result.gate, 'action'),
            ...(gateField(result.gate, 'instructions') ? { instructions: gateField(result.gate, 'instructions') } : {}),
            // ★ Both values are REQUIRED by mesh_graph_gate_release. Losing them
            // means the lease must lapse before anyone can act on the gate again.
            leaseGeneration: result.leaseGeneration,
            fencingToken: result.fencingToken,
            leaseExpiresAt: result.leaseExpiresAt,
            ...(result.deadlineAt ? { deadlineAt: result.deadlineAt } : {}),
            onTimeout: gateField(result.gate, 'onTimeout'),
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
        return JSON.stringify({ success: false, claimed: false, gateId, error: message });
    }
}

/** The daemon command behind the extend verb (graph-orchestration-simplification D3(c)). */
export const MESH_GRAPH_GATE_EXTEND_COMMAND = 'mesh_graph_gate_extend';

/**
 * `mesh_graph_gate_claim` with `extend_seconds` — the gate EXTEND verb
 * (docs/design/2026-09-25-graph-orchestration-simplification.md D3(c)).
 *
 * Exposed as an optional argument on claim rather than a separate tool because
 * the published tool count is pinned at 60 (scripts/verify-docs.mjs). It is a
 * different verb, not a claim variant: it takes NO lease and returns no fencing
 * token — it only pushes the deadline so the gate's on_timeout policy fires later.
 * The daemon command is the one the dashboard's "Extend 24h" button calls, with
 * the design's snake_case wire args `{mesh_id, gate_id, extend_seconds}`.
 *
 * Mixing it with the claim-only knobs is refused rather than guessed at: a caller
 * that passes lease_seconds too believes it is taking a lease, and silently
 * returning without one would leave it acting on a gate it does not hold.
 */
async function meshGraphGateExtend(
    ctx: MeshContext,
    gateId: string,
    args: { extend_seconds?: unknown; lease_seconds?: unknown; leaseSeconds?: unknown; extend_deadline_seconds?: unknown; extendDeadlineSeconds?: unknown },
): Promise<string> {
    const extendSeconds = readNumber(args.extend_seconds);
    if (extendSeconds === undefined || extendSeconds <= 0) {
        return JSON.stringify({
            success: false,
            code: 'invalid_extend_seconds',
            gateId,
            error: 'extend_seconds must be a positive number of seconds (e.g. 86400 for 24h).',
        });
    }
    const conflicting = ([
        ['lease_seconds', args.lease_seconds ?? args.leaseSeconds],
        ['extend_deadline_seconds', args.extend_deadline_seconds ?? args.extendDeadlineSeconds],
    ] as const).filter(([, value]) => value !== undefined).map(([key]) => key);
    if (conflicting.length > 0) {
        return JSON.stringify({
            success: false,
            code: 'extend_with_claim_args',
            gateId,
            conflicting,
            error: `extend_seconds is extend-only (no claim, no lease) and cannot be combined with ${conflicting.join(', ')}. `
                + 'To take a lease AND push the deadline, claim with extend_deadline_seconds instead.',
        });
    }
    let raw: unknown;
    try {
        raw = await ctx.transport.command(MESH_GRAPH_GATE_EXTEND_COMMAND, {
            mesh_id: ctx.mesh.id,
            gate_id: gateId,
            extend_seconds: extendSeconds,
        });
    } catch (e: any) {
        const message = e?.message || String(e);
        return JSON.stringify({
            success: false,
            extended: false,
            gateId,
            code: /unknown command|not supported|unsupported|no handler/i.test(message) ? 'gate_extend_unavailable' : 'gate_extend_failed',
            error: message,
            hint: 'If this daemon predates the extend verb, claim the gate with extend_deadline_seconds instead (that takes a lease).',
        });
    }
    const payload = unwrapCommandPayload(raw);
    const failed = !payload || typeof payload !== 'object'
        || (payload as any).success === false || (payload as any).extended === false
        || (typeof (payload as any).error === 'string' && (payload as any).error.length > 0 && (payload as any).success !== true);
    if (failed) {
        const error = typeof (payload as any)?.error === 'string' ? (payload as any).error : 'mesh_graph_gate_extend failed';
        return JSON.stringify({
            success: false,
            extended: false,
            gateId,
            code: typeof (payload as any)?.code === 'string' ? (payload as any).code
                : /unknown command|not supported|unsupported|no handler/i.test(error) ? 'gate_extend_unavailable' : 'gate_extend_failed',
            ...(typeof (payload as any)?.gateState === 'string' ? { gateState: (payload as any).gateState } : {}),
            error,
        });
    }
    // Pass the daemon's answer through (deadlineAt / gate state) — no local math.
    const { success: _success, ...rest } = payload as Record<string, unknown>;
    return JSON.stringify({
        success: true,
        extended: true,
        gateId,
        extendSeconds,
        ...rest,
        note: 'Deadline extended; no lease was taken. Claim the gate (mesh_graph_gate_claim) when you are ready to act on it.',
    });
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
        patches?: Array<{
            node?: string; node_id?: string; nodeId?: string; ref?: string;
            base_spec_patch?: Record<string, unknown>; baseSpecPatch?: Record<string, unknown>;
        }>;
    },
): Promise<string> {
    await recordMeshCoordinatorToolCall(ctx, 'mesh_graph_gate_release');
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

    // rc.37 audit item 2: this used to read ONLY p.node and silently DROP any patch
    // item given as node_id/nodeId/ref via `.filter(p => p.node.length > 0)` — the
    // sibling mesh_graph_node_patch has always accepted all four spellings
    // (`readString(args.node) || readString(args.node_id) || readString(args.nodeId)
    // || readString(args.ref)`), so a caller following that convention here had its
    // patch silently discarded and the release still committed the UNPATCHED spec —
    // irreversible, since a released gate can never be re-released. Now: accept the
    // same aliases, and REJECT the whole release (rather than silently dropping the
    // item) when a patch entry names no resolvable node.
    const rawPatches = args.patches ?? [];
    const unresolvedPatchIndices: number[] = [];
    const patches = rawPatches.map((p, i) => {
        const node = readString(p?.node) || readString(p?.node_id) || readString(p?.nodeId) || readString(p?.ref) || '';
        if (!node) unresolvedPatchIndices.push(i);
        return { node, baseSpecPatch: (p?.base_spec_patch ?? p?.baseSpecPatch ?? {}) as Record<string, unknown> };
    });
    if (unresolvedPatchIndices.length > 0) {
        return JSON.stringify({
            success: false,
            code: 'unresolvable_patch_node',
            error: `mesh_graph_gate_release patches[${unresolvedPatchIndices.join(', ')}] name no resolvable node — `
                + 'each entry needs one of node, node_id, nodeId or ref. Refusing the release rather than silently dropping '
                + 'the patch and committing the unpatched spec, since a released gate can never be re-released.',
            unresolvedPatchIndices,
        });
    }

    try {
        // C-W9c: release, its provenance audit record, and the post-materialization
        // queue nudge all run in the daemon now. A domain refusal comes back as a
        // RESULT (`released: false` + `refusalCode`) — releaseMeshGraphGate's THROW
        // is caught daemon-side (mesh-graph-ipc.ts) rather than crossing the wire.
        const result = await graphGateRelease(ctx.transport, {
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
        if (!result.released) {
            const code = result.refusalCode;
            return JSON.stringify({
                success: false,
                released: false,
                gateId,
                ...(code ? { code } : {}),
                error: result.message,
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
        // ── P3: interpret materializedCount: 0 ───────────────────────────────────
        //
        // `materializedCount: 0` is otherwise silent — the coordinator has no way to tell
        // whether it is fine or means the batch bought nothing. Three cases:
        //
        //   1. dependents exist, none materialized → they were skipped or are still blocked
        //      by another gate/dependency. Ordinary graph behavior, visible in
        //      mesh_graph_view. NOT flagged.
        //   2. no dependents, and this release COMPLETED the graph → the approval was the
        //      final act of a plan that did its work first. Legitimate: a graph may end at
        //      a gate (the release rollup treats a released gate as terminal-equivalent).
        //      NOT flagged — this is the terminal-gate suppression.
        //   3. no dependents, and the graph did NOT complete here → nothing declared this
        //      gate in gated_by while work remains outstanding, so the claim/release
        //      round-trip gated nothing. This is the one worth flagging.
        //
        // Advisory only: never an error, never blocks, never changes the release.
        const releasedNothingDownstream = !result.duplicate
            && result.materializedNodeIds.length === 0
            && result.downstreamNodeCount === 0
            && result.graphCompleted !== true;
        return JSON.stringify({
            success: true,
            released: true,
            // A replayed release (same key + same digest) is a NO-OP SUCCESS, not an
            // error — that is what makes a retried release safe (design :420-421).
            duplicate: result.duplicate,
            gateId,
            graphId: gateField(result.gate, 'graphId'),
            ...(gateField(result.gate, 'ref') ? { ref: gateField(result.gate, 'ref') } : {}),
            outcome,
            materializedNodeIds: result.materializedNodeIds,
            materializedCount: result.materializedNodeIds.length,
            ...(result.downstreamNodeCount !== undefined ? { downstreamNodeCount: result.downstreamNodeCount } : {}),
            ...(releasedNothingDownstream
                ? {
                    noDownstreamAdvisory: 'This gate opened nothing downstream: no task declared it in gated_by, so claiming and releasing it '
                        + 'bought no scheduling while the rest of the graph is still outstanding. Declare the next step in the same batch and point '
                        + 'it at this gate with gated_by, so releasing the gate dispatches it — or drop the gate and enqueue that step directly.',
                }
                : {}),
            ...(result.duplicate
                ? { duplicateHint: 'This idempotency_key + payload was already committed; nothing changed. Re-sending an identical release is safe.' }
                : {}),
        });
    } catch (e: any) {
        const message = e?.message || String(e);
        return JSON.stringify({ success: false, released: false, gateId, error: message });
    }
}

/**
 * `mesh_graph_gate_abandon` (design :399 — the `awaiting_coordinator -> cancelled` edge).
 *
 * ★ THE ONE THING THIS TOOL IS NOT: a way past a gate. It exists because a gate
 * whose work was cancelled is otherwise UNCLOSEABLE — the cancel cascade skips
 * gate nodes by design, the deadline sweep skips gates with no deadline (and
 * `deadline_seconds` is optional), and the rollup refuses to classify a graph
 * while any gate is unsettled. So the graph could reach no terminal state at all.
 *
 * Abandon closes that hole WITHOUT weakening the gate contract, because it is
 * strictly destructive: it materializes nothing, produces no outcome/evidence for
 * downstream bindings, and CANCELS every downstream node the gate was holding. A
 * coordinator that wants downstream to run still has exactly one option —
 * `mesh_graph_gate_release`. This is not the "force release" the C2 header
 * forbids: that tool would GRANT passage on no evidence, which is the
 * M-TERMINAL-ADMISSION-GATE defect class. This one denies passage permanently.
 */
export async function meshGraphGateAbandon(
    ctx: MeshContext,
    args: {
        gate_id?: string; gateId?: string;
        reason?: string;
        force?: boolean;
        coordinator_session_id?: string; coordinatorSessionId?: string;
    },
): Promise<string> {
    await recordMeshCoordinatorToolCall(ctx, 'mesh_graph_gate_abandon');
    const gateId = readString(args.gate_id) || readString(args.gateId);
    const reason = readString(args.reason);
    const missing = [
        !gateId ? 'gate_id' : null,
        !reason ? 'reason' : null,
    ].filter((f): f is string => f !== null);
    if (missing.length > 0) {
        return JSON.stringify({
            success: false,
            code: 'missing_abandon_fields',
            missing,
            error: `mesh_graph_gate_abandon requires ${missing.join(', ')}. `
                + 'The reason is recorded on the gate, on every cancelled downstream row, and in the provenance ledger — '
                + 'an abandon with no stated reason is indistinguishable from a mistake when someone reads it back later.',
        });
    }
    const coordinatorSessionId = resolveGateSession(ctx, args.coordinator_session_id ?? args.coordinatorSessionId);

    try {
        // C-W9c: the abandon and its provenance audit record both run in the daemon now.
        const result = await graphGateAbandon(ctx.transport, {
            meshId: ctx.mesh.id,
            gateId: gateId!,
            reason: reason!,
            ...(coordinatorSessionId ? { coordinatorSessionId } : {}),
            ...(args.force === true ? { force: true } : {}),
        });
        if (!result.abandoned) {
            return JSON.stringify({
                success: false,
                abandoned: false,
                code: result.reason ?? 'gate_not_abandonable',
                gateId,
                ...(result.gate ? { gateState: gateField(result.gate, 'state'), action: gateField(result.gate, 'action') } : {}),
                error: describeAbandonRefusal(result.reason, gateField(result.gate, 'state')),
            });
        }
        const duplicate = result.reason === 'gate_already_abandoned';
        return JSON.stringify({
            success: true,
            abandoned: true,
            // Re-abandoning an abandoned gate is a safe no-op, so a retried cleanup
            // never has to tell "I did it" from "it was already done".
            duplicate,
            gateId,
            graphId: gateField(result.gate, 'graphId'),
            ...(gateField(result.gate, 'ref') ? { ref: gateField(result.gate, 'ref') } : {}),
            gateState: gateField(result.gate, 'state'),
            cancelledNodeIds: result.cancelledNodeIds,
            cancelledCount: result.cancelledNodeIds.length,
            ...(result.cancelledTaskIds.length > 0 ? { cancelledTaskIds: result.cancelledTaskIds } : {}),
            ...(result.graphStatus ? { graphStatus: result.graphStatus } : {}),
            materializedNodeIds: [],
            note: 'Abandon is not a pass: nothing was materialized and no gate outcome was produced. Everything this gate was '
                + 'holding is cancelled. If the graph still shows a non-terminal status, another gate or an in-flight worker is '
                + 'still outstanding — check mesh_graph_view.',
        });
    } catch (e: any) {
        const message = e?.message || String(e);
        return JSON.stringify({ success: false, abandoned: false, gateId, error: message });
    }
}

function describeAbandonRefusal(reason: string | undefined, state?: string): string {
    switch (reason) {
        case 'gate_not_found':
            return 'No such gate on this mesh. Use mesh_graph_view to list gates.';
        case 'gate_lease_held':
            return 'Another coordinator holds a LIVE lease on this gate, and it may be mid-action on a real external side effect '
                + '(a merge, a publish, a deploy). Wait for the lease to lapse, or pass force=true if you know that holder is dead.';
        case 'gate_abandon_race':
            return 'The gate moved (a concurrent claim or release) while this abandon was committing. Re-read it with mesh_graph_view '
                + 'and decide again — it may no longer need abandoning.';
        default:
            if (reason?.startsWith('gate_terminal:')) {
                return `The gate is already terminal (${state ?? reason.slice('gate_terminal:'.length)}) and cannot be abandoned. `
                    + 'A RELEASED gate already let its downstream run, so abandoning it would claim closure over work that is in '
                    + 'flight or finished — cancel that work directly instead.';
            }
            return `The gate could not be abandoned (${reason ?? 'unknown reason'}).`;
    }
}

/**
 * `mesh_graph_node_patch` — fix a node the graph could not materialize, and
 * retry it in the same call.
 *
 * ★ WHY THIS TOOL EXISTS. `inputs_from` / `run_if` are baked into a node's
 * IMMUTABLE base spec when the batch is accepted, but a binding that cannot be
 * resolved is only rejected at MATERIALIZATION — which happens after every
 * predecessor has completed. So the failure lands at the worst possible moment:
 * the upstream work all succeeded, and the one step that was supposed to consume
 * it is blocked on `materialization_error:*` forever. The graph does retry the
 * node on later upstream terminals, but it re-reads the same baked spec and
 * fails identically every time — it cannot self-heal, because nothing has
 * changed. daemon-core documented the patch-and-retry recovery and implemented
 * it, but nothing exposed it: the only patch surface was
 * `mesh_graph_gate_release`, which needs a CLAIMED GATE and a direct gate edge,
 * so a plain binding node with no gate was unrecoverable. This is that missing
 * surface.
 *
 * It is NOT a way to re-task a worker. The patch surface is exactly the
 * gate-release one — run_if, on_false, inputs_from, workspace_ref — so the
 * message, routing, permissions, task mode and model stay immutable, and an
 * already-claimed task cannot be patched at all. Prefer fixing the plan at
 * enqueue: a malformed `inputs_from` is now rejected by mesh_enqueue_batch, so
 * the case this tool remains necessary for is the one that is NOT knowable up
 * front — `required_input_missing`, where the shape was right and the upstream
 * simply never produced that field.
 */
export async function meshGraphNodePatch(
    ctx: MeshContext,
    args: {
        node?: string; node_id?: string; nodeId?: string; ref?: string;
        graph_id?: string; graphId?: string;
        base_spec_patch?: Record<string, unknown>; baseSpecPatch?: Record<string, unknown>;
    },
): Promise<string> {
    await recordMeshCoordinatorToolCall(ctx, 'mesh_graph_node_patch');
    const node = readString(args.node) || readString(args.node_id) || readString(args.nodeId) || readString(args.ref);
    const patch = (args.base_spec_patch ?? args.baseSpecPatch) as Record<string, unknown> | undefined;
    const missing = [
        !node ? 'node' : null,
        !patch || typeof patch !== 'object' || Array.isArray(patch) ? 'base_spec_patch' : null,
    ].filter((f): f is string => f !== null);
    if (missing.length > 0) {
        return JSON.stringify({
            success: false,
            code: 'missing_patch_fields',
            missing,
            error: `mesh_graph_node_patch requires ${missing.join(', ')}. `
                + '`node` is the node id or ref from mesh_graph_view; `base_spec_patch` holds the keys to replace '
                + `(${MESH_NODE_PATCH_KEYS.join(', ')}).`,
        });
    }
    if (Object.keys(patch!).length === 0) {
        return JSON.stringify({
            success: false,
            code: 'empty_patch',
            error: 'base_spec_patch is empty — there is nothing to change, and re-settling an unchanged spec would fail exactly as before.',
        });
    }

    const graphId = readString(args.graph_id) || readString(args.graphId);
    try {
        // C-W9c: the patch, its provenance audit record, and the post-materialization
        // queue nudge all run in the daemon now. A domain refusal comes back as a
        // RESULT (`patched: false` + `refusalCode`) — patchGraphNodeAndRetry's THROW
        // is caught daemon-side (mesh-graph-ipc.ts) rather than crossing the wire.
        const result = await graphNodePatch(ctx.transport, {
            meshId: ctx.mesh.id,
            node: node!,
            ...(graphId ? { graphId } : {}),
            baseSpecPatch: patch!,
        });
        if (!result.patched) {
            const code = result.refusalCode;
            return JSON.stringify({
                success: false,
                patched: false,
                node,
                ...(code ? { code } : {}),
                error: result.message,
                ...(code === 'task_already_claimed'
                    ? {
                        hint: 'This node\'s task is already assigned or finished, and an assigned task is immutable. If the work must change, '
                            + 'cancel it with mesh_queue_cancel and enqueue the corrected step.',
                    }
                    : {}),
                ...(code === 'node_patch_forbidden'
                    ? { hint: `Only ${MESH_NODE_PATCH_KEYS.join(', ')} may be patched. A task's message, routing, permissions, task mode and model are immutable by policy — enqueue a new task instead.` }
                    : {}),
                ...(code === 'ambiguous_node_ref'
                    ? { hint: 'That ref exists in more than one live graph. Pass graph_id, or use the exact node id from mesh_graph_view.' }
                    : {}),
            });
        }
        const recovered = result.outcomeKind === 'materialized';
        return JSON.stringify({
            success: true,
            patched: true,
            graphId: result.graphId,
            nodeId: result.nodeId,
            ...(result.ref ? { ref: result.ref } : {}),
            ...(result.queueTaskId ? { taskId: result.queueTaskId } : {}),
            patchedKeys: Object.keys(patch!),
            materializationVersion: result.materializationVersion,
            // ★ The patch and the RETRY are one transaction, so this answers "did
            // it actually work?" now — the caller never has to poll to find out.
            retryOutcome: result.outcomeKind,
            recovered,
            state: result.state,
            ...(result.blockedReason ? { blockedReason: result.blockedReason } : {}),
            ...(recovered
                ? { note: 'The node materialized and its task is claimable again.' }
                : {}),
            ...(result.outcomeKind === 'error'
                ? {
                    hint: `The patch was applied but the node still cannot materialize (${result.blockedReason ?? 'see blockedReason'}). `
                        + 'Read the new reason: `required_input_missing` means the upstream genuinely never produced that field — '
                        + 'point the selector at something it did produce, or drop `required` — while `invalid_selector` / '
                        + '`invalid_binding_spec` mean the replacement is still malformed. Inspect the upstream envelope with mesh_graph_view.',
                }
                : {}),
            ...(result.outcomeKind === 'deferred'
                ? {
                    hint: 'The patch was applied but the node is not ready to settle yet — a predecessor has not completed, or an '
                        + 'incoming gate is still unreleased. It will settle on its own when they do; nothing further is needed here.',
                }
                : {}),
            ...(result.outcomeKind === 'skipped'
                ? { hint: `The patched run_if evaluated FALSE, so the node is now skipped (${result.skippedReason}). Skipped is terminal and never satisfies a downstream dependency.` }
                : {}),
        });
    } catch (e: any) {
        const message = e?.message || String(e);
        return JSON.stringify({ success: false, patched: false, node, error: message });
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
        probe_gate_evidence?: boolean; probeGateEvidence?: boolean;
        limit?: number;
    },
): Promise<string> {
    await recordMeshCoordinatorToolCall(ctx, 'mesh_graph_view');
    try {
        await refreshMeshFromDaemon(ctx);
        const graphId = readString(args.graph_id) || readString(args.graphId);
        const batchId = readString(args.batch_id) || readString(args.batchId);
        const includeTerminal = args.include_terminal === true || args.includeTerminal === true;
        const probeGateEvidence = args.probe_gate_evidence === true || args.probeGateEvidence === true;
        // C-W9c: buildMeshGraphViews and the G4 gate-evidence probe both run in the
        // daemon now — one round trip returns the fully-assembled view.
        const { graphs } = await graphViewQuery(ctx.transport, {
            meshId: ctx.mesh.id,
            ...(graphId ? { graphId } : {}),
            ...(batchId ? { batchId } : {}),
            activeOnly: !includeTerminal,
            ...(readNonNegativeInt(args.limit) !== undefined ? { limit: readNonNegativeInt(args.limit) } : {}),
            ...(probeGateEvidence ? { probeGateEvidence: true } : {}),
        });
        const pendingActions = graphs.flatMap((g: any) =>
            (g.nextCoordinatorAction ?? []).map((a: any) => ({ graphId: g.graphId, ...a })));
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

/**
 * rc.37 audit item 4: `mesh_graph_view`'s `limit` schema declares `number`, but the
 * wire decoder (mesh-shared turn-ipc `isGraphViewQueryRequest` → `isNonNegativeInt`)
 * demands a non-negative INTEGER — `readNumber` passed 2.5 / -1 / "5" straight
 * through, so any of those failed the wire's shape check with an opaque "request
 * failed decode (bad shape)" instead of either working or naming the problem.
 * Coerce here (floor + clamp to 0) rather than reject, since limit is advisory
 * paging, not a value whose exactness matters.
 */
function readNonNegativeInt(value: unknown): number | undefined {
    const n = readNumber(value);
    if (n === undefined) return undefined;
    return Math.max(0, Math.floor(n));
}

function readNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
    return undefined;
}
