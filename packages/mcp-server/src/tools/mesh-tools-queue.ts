// Mesh tool implementations — queue domain.
// Pure move out of mesh-tools.ts (no behavior change). Shared helpers, types, module
// state and dependency re-exports live in ./mesh-tools-internal.ts; mesh-tools.ts is a barrel.

import {
    ACTIVE_QUEUE_STATUSES,
    COMPACT_MAX_ACTIVE_QUEUE_ROWS,
    COMPACT_MAX_ACTIVE_WORK_ROWS,
    HISTORICAL_QUEUE_STATUSES,
    IpcTransport,
    annotateQueueStaleness,
    buildActiveWorkPollingGuidance,
    buildCompactQueueMaintenanceReport,
    buildCompactStaleDirectWorkSummary,
    buildQueueMaintenanceReport,
    buildQueueStatusSummary,
    buildMissionInactiveWarning,
    buildQueueTriggerGuidance,
    compactActiveWorkRecords,
    compactQueueRow,
    compactQueueRows,
    describeTaskDependencyState,
    parseOnDependencyFailurePolicy,
    MeshGraphPolicyError,
    // GRAPH-ORCHESTRATION Phase E — batch v2 plan commit + enqueue provenance.
    normalizeOrchestrationDecision,
    MESH_DECLARED_ELIGIBLE_SINGLE_HINT,
    normalizeMeshTaskPriority,
    resolveNotBefore,
    filterQueueForView,
    meshNodeIdMatches,
    normalizeMeshCapabilityTags,
    providerPinsFromRequiredTags,
    normalizeQueueViewMode,
    buildOrphanedPinNotice,
    prioritizeActiveQueueRows,
    readString,
    readTaskInput,
    readActiveWorkFromDaemon,
    readQueueFromDaemon,
    recordMeshCoordinatorToolCall,
    refreshMeshFromDaemon,
    resolvePreferredWorktreeNodeId,
    sanitizeQueueStatusFilter,
    summarizeTaskMessage,
    triggerMeshQueueAndReport,
    unwrapCommandPayload,
} from './mesh-tools-internal.js';
// COORDINATOR-HELD NODE STATE (audit fix): mesh_view_queue's node/session
// decoration now answers from the coordinator daemon's held runtime first (no
// per-daemon get_status_metadata round trip for a node another daemon owns);
// the direct-dispatch transcript reconcile — a WRITE-side nudge, not something
// the response needs (see mesh-status-background.ts) — moved off the request
// path the same way mesh_status already runs it.
import { collectMeshViewQueueNodesHeldOrLive } from './mesh-status-held-git.js';
import { scheduleBackgroundDirectReconcile } from './mesh-status-background.js';
// MESH-IMAGE-DISPATCH: view-surface projection — not (yet) re-exported through mesh-tools-internal.ts,
// imported directly from the package like the other daemon-core symbols
// mesh-tools-internal.ts itself imports.
import { summarizeQueueEntryInputForView } from '@adhdev/daemon-core';
import { buildGraphPlanShape } from './mesh-tools-graph.js';
import { canonicalizeEnqueueTaskEntry, canonicalizeMeshTopLevelArgs } from './validate-tool-args.js';
// C-W9a: the queue and the records are the daemon's — every read and mutation
// below goes over its IPC commands (the mcp-server never opens mesh-runtime.db).
// C-W9c: + mission_query (mission_id existence check) and orphaned_pin_notify
// (CANCEL-ORPHANS-PINNED-TASK) — the last in-process daemon-core calls this file made.
import { missionQuery, orphanedPinNotify, queueCancel, queueEnqueue, queueEnqueueGraph, queueRequeue } from '../ipc/turn-commands.js';
import { MESH_TASK_GRAPH_MAX_TASKS } from '@adhdev/daemon-core';
import type { MeshGraphPlanResult, MeshWorkQueueEntry } from '@adhdev/daemon-core';
import type { GraphTaskFieldsShape, GraphWorkspaceDeclarationShape } from './mesh-tools-graph.js';
import type {
    MeshContext,
    MeshGraphGatePlanSpec,
    MeshTaskGraphEntrySpec,
    MeshTaskInput,
    OrphanedPinnedTask,
    QueueViewMode,
} from './mesh-tools-internal.js';

/**
 * G4: normalize a task message for duplicate fingerprinting. Collapses whitespace and
 * lowercases so trivial reformatting of the same instruction still matches. Intentionally
 * coarse — a false positive is a warning (warn-only default), never a silent drop.
 */
function normalizeDedupMessage(message: string): string {
    return (message || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * G4: find an in-flight (pending/assigned) queue task whose (normalized message + resolved
 * target node) matches the task about to be enqueued. Terminal rows (completed/failed/
 * cancelled) are historical and never a live duplicate. When no target node is pinned on the
 * new task, matching is on message alone (an unpinned re-enqueue of the same instruction is the
 * TASKBUBBLE-DUP case); when a target IS pinned, both message AND target must match so the same
 * instruction sent to two DIFFERENT nodes is not flagged. Returns the first match or null.
 */
async function findInFlightDuplicate(
    ctx: MeshContext,
    message: string,
    targetNodeId: string | undefined,
): Promise<{ id: string; status: string; assignedNodeId?: string; targetNodeId?: string } | null> {
    const fingerprint = normalizeDedupMessage(message);
    if (!fingerprint) return null;
    for (const task of await readQueueFromDaemon(ctx, { statuses: ['pending', 'assigned'] })) {
        if (task.status !== 'pending' && task.status !== 'assigned') continue;
        if (normalizeDedupMessage(task.message) !== fingerprint) continue;
        // Target-scoped match: only compare targets when the NEW task pins one. An unpinned
        // new task matches any in-flight task with the same message (broadest dup guard).
        if (targetNodeId) {
            const existingTarget = task.targetNodeId || task.assignedNodeId;
            if (!existingTarget || !meshNodeIdMatches({ id: existingTarget } as any, targetNodeId)) continue;
        }
        return { id: task.id, status: task.status, assignedNodeId: task.assignedNodeId, targetNodeId: task.targetNodeId };
    }
    return null;
}

/**
 * WORKTREE-ROUTING-ADVISORY (b1): flag an untargeted `code_change` enqueue that will be
 * claimed by whichever node polls first — in practice the base node, which strands general
 * code work on a shared checkout with no branch isolation. Advisory ONLY: the task still
 * enqueues unchanged. This is the tool-side companion to the coordinator prompt's
 * "base nodes are for environment-specific testing" boundary, for the case where the
 * coordinator ignored or never read it.
 *
 * EXEMPTIONS are the whole safety story here — a task is NOT flagged when:
 *   - `required_tags` is present (e.g. `os=win32`): the coordinator is deliberately pinning
 *     to a physical environment. Flagging these would push genuine win32 PATH / clean-install
 *     / machine-state verification onto worktrees, where it cannot be verified at all.
 *   - `target_node_id` (any spelling) resolved a concrete node: already explicitly routed.
 *   - `prefer_worktree` already asked for worktree routing.
 *   - the task is read-only (`readonly` / `live_debug_readonly`): exempt from the
 *     one-write-per-node invariant, needs no isolation, and may stack on a busy node.
 *   - `task_mode` is `convergence`: merge/push is base-only by design and must NOT be
 *     pinned to a worktree.
 * Only an untargeted, non-read-only `code_change` reaches the advisory.
 */
export function buildUntargetedCodeChangeWorktreeAdvisory(input: {
    taskMode?: string;
    readonly: boolean;
    requiredTags?: string[];
    targetNodeId?: string;
    preferWorktree: boolean;
}): { worktreeRoutingAdvisory: string } | null {
    if (input.taskMode !== 'code_change') return null;
    if (input.readonly) return null;
    if (input.targetNodeId) return null;
    if (input.preferWorktree) return null;
    if (Array.isArray(input.requiredTags) && input.requiredTags.length > 0) return null;
    return {
        worktreeRoutingAdvisory:
            'This untargeted `code_change` will be claimed by whichever node polls first — usually the BASE node, '
            + 'which gives it no branch isolation. Base nodes are for environment-specific testing (win32 PATH/registry, '
            + 'clean install on one OS, that machine\'s package state, OS-dependent runtime behavior). If this task only '
            + 'changes code, cancel it (mesh_queue_cancel), call mesh_clone_node (~10s, auto-launch starts the session), '
            + 'and re-enqueue with target_node_id set to the returned worktree node id — or pass prefer_worktree: true to '
            + 'route to the most recent worktree. If it DOES need a specific machine, pin it with required_tags '
            + '(e.g. ["os=win32"]) or target_node_id and this advisory will not appear.',
    };
}

/**
 * Argument surface shared by mesh_enqueue_task and each mesh_enqueue_batch entry
 * (the batch entry additionally carries `ref`; the G4 duplicate flags stay
 * top-level on both tools).
 */
interface EnqueueTaskArgsShape {
    message: string; task_mode?: string; taskMode?: string;
    /** MESH-IMAGE-DISPATCH: optional multipart attachment delivered with `message`. */
    input?: unknown;
    readonly?: boolean; read_only?: boolean;
    requiredTags?: string[]; required_tags?: string[];
    targetNodeId?: string; target_node_id?: string;
    targetNode?: string; target_node?: string;
    preferWorktree?: boolean; prefer_worktree?: boolean;
    dependsOn?: string[]; depends_on?: string[];
    missionId?: string; mission_id?: string;
    priority?: string;
    model?: string;
    thinkingLevel?: string; thinking_level?: string;
    difficulty?: string;
    notBefore?: string | number; not_before?: string | number;
    maxRetries?: number; max_retries?: number;
    /** H1 (path ownership) — see mesh-work-queue.ts MeshEnqueueTaskOptions.ownedPaths. */
    owned_paths?: unknown; ownedPaths?: unknown;
}

interface NormalizedEnqueueTaskArgs {
    message: string;
    taskMode: string | undefined;
    /** MESH-IMAGE-DISPATCH: optional multipart attachment, validated shallowly by readTaskInput. */
    input: MeshTaskInput | undefined;
    readonly: boolean;
    requiredTags: string[];
    dependsOn: string[] | undefined;
    missionId: string | undefined;
    priority: ReturnType<typeof normalizeMeshTaskPriority> | undefined;
    model: string | undefined;
    thinkingLevel: string | undefined;
    difficulty: string | undefined;
    notBefore: ReturnType<typeof resolveNotBefore>;
    maxRetries: number | undefined;
    explicitTargetRaw: string | undefined;
    preferWorktree: boolean;
    targetNodeId: string | undefined;
    /**
     * H1: raw declaration, normalized/validated by the daemon's enqueueTask.
     * Typed as `string[]` to match `MeshEnqueueTaskOptions.ownedPaths` (what both
     * `queueEnqueue`'s options and `MeshTaskGraphEntrySpec` declare) — this layer
     * does not itself validate element types, it only forwards the raw array
     * unchanged for the daemon to normalize/reject.
     */
    ownedPaths: string[] | undefined;
}

type NormalizeEnqueueTaskResult =
    | { ok: true; value: NormalizedEnqueueTaskArgs }
    | { ok: false; code: string; error: string; extra?: Record<string, unknown> };

/**
 * THE single alias/validation normalizer for an enqueue-shaped argument object.
 * mesh_enqueue_task and every mesh_enqueue_batch entry route through this one
 * function so the two surfaces can never drift (same alias resolution, same
 * target-pin canonicalization, same loud failure on an unresolvable target).
 * `callerLabel` scopes error text ('mesh_enqueue_task' vs "mesh_enqueue_batch
 * task 'fix'").
 */
async function normalizeEnqueueTaskArgs(
    ctx: MeshContext,
    rawArgs: EnqueueTaskArgsShape,
    callerLabel: string,
): Promise<NormalizeEnqueueTaskResult> {
    // ★CANONICAL-FIRST (2026-09-25): server.ts now dispatches with
    // canonicalizeMeshToolArgs's output, so a top-level mesh_enqueue_task call
    // already arrives canonicalized. This second pass is for the OTHER two
    // callers of this function that a top-level canonicalization does not
    // reach: (1) a task entry inside mesh_enqueue_batch's `tasks[]` — that
    // needs the `tasks` SCOPE's aliases, not the batch's top-level scope,
    // which is why this uses the dedicated per-entry helper rather than
    // canonicalizeMeshToolArgs('mesh_enqueue_batch', rawArgs) (see that
    // helper's own doc comment); (2) any existing/future test that constructs
    // args directly and calls this function without going through server.ts
    // at all. Idempotent: canonicalizing already-canonical args is a no-op.
    const args = canonicalizeEnqueueTaskEntry(rawArgs as unknown as Record<string, unknown>) as unknown as EnqueueTaskArgsShape;
    // DELIVERY-MSG-GUARD: make the schema's nominal `required: ['message']` real. The
    // tool dispatcher forwards raw args without runtime schema validation, so a caller
    // that omits message (or passes a non-string) would otherwise hand undefined to
    // enqueueTask → a message-less queue payload that crashes insertSessionDelivery's
    // NOT NULL at claim/dispatch. Reject at the tool boundary with a clear error.
    const message = readString(args.message);
    if (!message) {
        return {
            ok: false,
            code: 'invalid_message',
            error: `${callerLabel} requires a non-empty string \`message\`.`,
        };
    }
    // MESH-IMAGE-DISPATCH: optional structured attachment (e.g. a screenshot). Validated
    // at the tool boundary for the same reason `message` is above — the dispatcher performs
    // no runtime schema validation, so a malformed envelope would otherwise surface deep in
    // the worker daemon or be silently dropped.
    let input: MeshTaskInput | undefined;
    try {
        input = readTaskInput(args.input);
    } catch (e: any) {
        return {
            ok: false,
            code: 'invalid_input',
            error: `${callerLabel} received an unusable \`input\`: ${e?.message || e}`,
        };
    }
    const taskMode = readString(args.task_mode) || readString(args.taskMode);
    const readonly = args.readonly === true || args.read_only === true;
    const requiredTags = normalizeMeshCapabilityTags(Array.isArray(args.requiredTags) ? args.requiredTags : args.required_tags);
    const dependsOn = Array.isArray(args.dependsOn) ? args.dependsOn : Array.isArray(args.depends_on) ? args.depends_on : undefined;
    const missionId = readString(args.missionId) || readString(args.mission_id) || undefined;
    // MISSION-UPSERT-SILENT-CREATE: mission_id is a soft-looking reference but an
    // unresolvable one silently orphans the task from any mission with no error and no
    // warning (buildMissionInactiveWarning only warns for a KNOWN-but-inactive mission —
    // see its own doc comment). Reject loudly here, mirroring target_node_not_found below,
    // rather than letting the task enqueue unattributed under a typo'd/truncated id.
    // C-W9c: was in-process `getMeshMission`; now the `mission_query` IPC round
    // trip mesh-tools-mission.ts's read path already uses.
    if (missionId && !(await missionQuery(ctx.transport, { meshId: ctx.mesh.id, id: missionId })).missions[0]) {
        return {
            ok: false,
            code: 'mission_not_found',
            error: `mission '${missionId}' does not exist on this mesh — refusing to enqueue a task with an unresolvable mission_id. Omit mission_id, or use mesh_mission_list to get a valid full id.`,
            extra: { missionId },
        };
    }
    // G6: task-level priority ('low' | 'normal' | 'high'). Invalid input → undefined (defaults to normal).
    const priority = normalizeMeshTaskPriority(readString(args.priority)) || undefined;
    // Optional model override — best-effort, applied at launch by providers that
    // support a model flag. Trimmed; blank → undefined (provider default).
    const model = readString(args.model) || undefined;
    // Brain-routing thinking axis + difficulty preset. thinkingLevel is best-effort
    // at launch; difficulty resolves the mesh preset in daemon-core enqueueTask
    // (fills model/thinkingLevel left blank). Both trimmed; blank → undefined.
    // rc.37#2: the schema published thinking_level (snake_case) but this only ever
    // read the camelCase form — same unreachable-alias class as not_before below.
    const thinkingLevel = readString(args.thinkingLevel) || readString(args.thinking_level) || undefined;
    const difficulty = readString(args.difficulty) || undefined;
    // G7: delayed execution. Accept a camelCase or snake_case not_before; resolveNotBefore
    // (in daemon-core, at enqueue) does the ISO/epoch-ms/relative-ms normalization — echoing it
    // here only for the response and dedup fingerprint.
    const notBeforeRaw = args.notBefore !== undefined ? args.notBefore : args.not_before;
    const notBefore = resolveNotBefore(notBeforeRaw);
    // P3: max automatic requeue attempts before the task auto-fails. Absent → policy default.
    const maxRetriesRaw = typeof args.maxRetries === 'number' ? args.maxRetries
        : typeof args.max_retries === 'number' ? args.max_retries : undefined;
    const maxRetries = typeof maxRetriesRaw === 'number' && Number.isFinite(maxRetriesRaw) && maxRetriesRaw >= 0
        ? Math.floor(maxRetriesRaw) : undefined;
    // Routing hint: explicit target id wins; otherwise prefer_worktree resolves to the
    // most recently cloned worktree node so isolated work is not preemptively claimed by
    // the first idle base node. Either becomes a targetNodeId, which the node-targeted
    // claim tier honors as a HARD constraint (only that node may claim).
    //
    // MESH-DISPATCH-MISROUTE: accept target_node / targetNode in addition to
    // target_node_id / targetNodeId. A coordinator that passed target_node (the natural
    // name) previously had it silently dropped — the task enqueued UNPINNED and any idle
    // node, including a different machine's base, could claim it (the live cross-machine
    // misroute). Resolving every spelling closes that gap.
    const explicitTargetRaw = readString(args.targetNodeId) || readString(args.target_node_id)
        || readString(args.targetNode) || readString(args.target_node) || undefined;
    const preferWorktree = args.preferWorktree === true || args.prefer_worktree === true;

    // MESH-DISPATCH-MISROUTE: a target pin is a hard constraint, so an unresolvable target
    // id must FAIL LOUDLY rather than silently fall through to an unpinned (any-node) task.
    // Canonicalize the supplied id to the live mesh node's own id via the shared identity
    // normalizer (handles id / nodeId / node_id and daemon-id forms) so the downstream raw
    // `node.id === targetNodeId` compares and the claim-tier SQL both match exactly.
    let targetNodeId: string | undefined;
    if (explicitTargetRaw) {
        const matched = ctx.mesh.nodes.find(n => meshNodeIdMatches(n as any, explicitTargetRaw));
        if (!matched) {
            return {
                ok: false,
                code: 'target_node_not_found',
                error: `target node '${explicitTargetRaw}' is not a member of this mesh — refusing to enqueue an unpinned task (it could be claimed by any node, including a different machine). Use mesh_list_nodes to get a valid node id.`,
                extra: {
                    targetNodeId: explicitTargetRaw,
                    availableNodeIds: ctx.mesh.nodes.map(n => (n as any).id).filter(Boolean),
                },
            };
        }
        targetNodeId = readString((matched as any).id) || explicitTargetRaw;
    } else if (preferWorktree) {
        targetNodeId = resolvePreferredWorktreeNodeId(ctx) || undefined;
    }
    // H1 (path ownership): the mesh_enqueue_task schema has always advertised
    // owned_paths, but this normalizer dropped it, so an enqueued task never carried
    // its declaration (rc.37: task 5470f2e1's row had no ownedPaths while the
    // mesh_send_task row beside it did) and the claim-time overlap gate could not
    // fire for it. Same raw-array passthrough mesh_send_task uses; the daemon's
    // enqueueTask normalizes and rejects bad paths.
    const rawOwnedPaths = args.ownedPaths ?? args.owned_paths;
    const ownedPaths = Array.isArray(rawOwnedPaths) ? (rawOwnedPaths as string[]) : undefined;
    return {
        ok: true,
        value: {
            message, taskMode, input, readonly, requiredTags, dependsOn, missionId, priority,
            model, thinkingLevel, difficulty, notBefore, maxRetries,
            explicitTargetRaw, preferWorktree, targetNodeId, ownedPaths,
        },
    };
}

/**
 * ★PIN-OBSERVABILITY (D2) — tell the coordinator that `requiredTags` in this response
 * is its own REQUEST echoed back, not a confirmation.
 *
 * ★WHY THIS EXISTS. The enqueue response has always echoed `requiredTags: task.requiredTags`.
 * A coordinator reading it naturally concludes the pin is in force — but the response is
 * written BEFORE any dispatch happens (a task may be claimed minutes later, by a node the
 * queue drain picks). When a provider pin was
 * silently bypassed downstream, this echo is what made it invisible: the request said
 * antigravity-cli, the response said antigravity-cli, and only `task_dispatched.providerType`
 * in the ledger — which nobody had reason to check — said claude-cli.
 *
 * So the echo is not removed (it is a useful confirmation that the tags PARSED, and that a
 * misspelled `provider=` name was not silently dropped); it is labelled, and the response
 * names where the honored value actually lands. Advisory only — never blocks, never re-routes.
 */
function buildProviderPinAdvisory(requiredTags: string[]): Record<string, unknown> {
    const pins = providerPinsFromRequiredTags(requiredTags);
    if (!pins.length) return {};
    return {
        providerPin: pins,
        providerPinHint: `requiredTags above is the REQUEST as parsed, not a dispatch confirmation — the provider is chosen later, when a node's session claims the task. To verify the pin was honored, read the task's task_dispatched ledger entry: its providerType is the provider that actually ran.`,
    };
}

export async function meshEnqueueTask(
    ctx: MeshContext,
    args: EnqueueTaskArgsShape & {
        allowDuplicate?: boolean; allow_duplicate?: boolean;
        blockDuplicate?: boolean; block_duplicate?: boolean;
        orchestration_decision?: unknown; orchestrationDecision?: unknown;
    },
): Promise<string> {
    // ★CANONICAL-FIRST (2026-09-25): mesh_enqueue_task's own top-level scope
    // (allow_duplicate/block_duplicate/orchestration_decision — the fields
    // normalizeEnqueueTaskArgs does NOT own) — same rationale as
    // canonicalizeEnqueueTaskEntry above. Idempotent with server.ts's own
    // canonicalization pass.
    // Canonical spelling wins over a camelCase alias (validate-tool-args.ts). Reassigned
    // in place, not shadowed, so the schema/handler parity audit still reads the inline
    // `args` type on the signature.
    args = canonicalizeMeshTopLevelArgs('mesh_enqueue_task', args as unknown as Record<string, unknown>) as unknown as typeof args;
    // STALE-SNAPSHOT-TARGET-REJECT: refresh before validation. Every other
    // membership-reading tool refreshes first; enqueue alone validated
    // target_node_id against the startup snapshot, so a node cloned after this
    // MCP process started hard-failed with target_node_not_found even though
    // the daemon's get_mesh already knew it (observed live: the daemon had
    // completed the worktree bootstrap while the coordinator's snapshot still
    // listed 7 nodes). Best-effort: a refresh failure leaves the previous
    // behavior unchanged.
    await refreshMeshFromDaemon(ctx);
    const normalized = await normalizeEnqueueTaskArgs(ctx, args, 'mesh_enqueue_task');
    if (!normalized.ok) {
        return JSON.stringify({ success: false, code: normalized.code, error: normalized.error, ...(normalized.extra ?? {}) });
    }
    const {
        message, taskMode, input, readonly, requiredTags, dependsOn, missionId, priority,
        model, thinkingLevel, difficulty, notBefore, maxRetries,
        explicitTargetRaw, preferWorktree, targetNodeId, ownedPaths,
    } = normalized.value;
    // G4: duplicate detection. Default is warn-only; block is opt-in (block_duplicate=true).
    // allow_duplicate=true silences the warning entirely (explicit intentional re-enqueue).
    const allowDuplicate = args.allowDuplicate === true || args.allow_duplicate === true;
    const blockDuplicate = args.blockDuplicate === true || args.block_duplicate === true;

    // ── design :692-731 — the single surface's enqueue-decision record ────────
    //
    // The design asked the single tool to REQUIRE an orchestration_decision; it is
    // optional here because phase F is warn-only (mesh-tool-schemas.ts :58-59) and a
    // required field would reject legacy/external clients. An omitted record is not
    // an error, it is the `decision_missing` datapoint: without it a coordinator that
    // never declares is indistinguishable from one with no eligible singles.
    // Nothing below can fail or alter the enqueue — this is provenance only.
    //
    // ★ Both advisory strings are COMPOSED IN daemon-core and only forwarded here.
    // This file is a pinned scheduling surface (design :984-986) and may not contain
    // graph-layer vocabulary even inside a user-facing message — see the note on
    // MESH_DECLARED_ELIGIBLE_SINGLE_HINT for why the enforcing scan has no
    // prose exemption.
    const rawDecision = args.orchestration_decision ?? args.orchestrationDecision;
    const decisionMissing = rawDecision === undefined || rawDecision === null;
    const orchestration = normalizeOrchestrationDecision(rawDecision, 'single');
    const orchestrationWarning = {
        ...(orchestration.batchCapabilityAvailable ? { batchCapabilityAvailable: orchestration.batchCapabilityAvailable } : {}),
        ...(orchestration.declaredEligibleSingle
            ? {
                declaredEligibleSingle: true,
                declaredEligibleSingleHint: MESH_DECLARED_ELIGIBLE_SINGLE_HINT,
            }
            : {}),
        ...(decisionMissing ? { orchestrationDecisionMissing: true } : {}),
    };

    // ── G4: enqueue duplicate detection ──────────────────────────────────────
    // TASKBUBBLE-DUP is the recurring class where the SAME task is enqueued twice
    // (e.g. a coordinator re-sends after a slow turn) and both dispatch, doubling the
    // work. Fingerprint the new task by (normalized message + resolved targetNode) and
    // scan the IN-FLIGHT queue (pending/assigned only — terminal rows are historical and
    // never a live duplicate). Default is warn-only: the task still enqueues but the
    // response carries duplicateSuspect so the coordinator can notice and cancel one.
    // Blocking is opt-in (block_duplicate=true); allow_duplicate=true suppresses even the
    // warning for an intentional re-enqueue.
    const duplicateSuspect = allowDuplicate ? null : await findInFlightDuplicate(ctx, message, targetNodeId);
    if (duplicateSuspect && blockDuplicate) {
        return JSON.stringify({
            success: false,
            code: 'duplicate_suspect',
            error: `an in-flight task with the same message${targetNodeId ? ' and target node' : ''} already exists (task '${duplicateSuspect.id}', status '${duplicateSuspect.status}'). Refusing because block_duplicate=true. Cancel it, wait for it, or re-enqueue with allow_duplicate=true.`,
            duplicateOf: { taskId: duplicateSuspect.id, status: duplicateSuspect.status, assignedNodeId: duplicateSuspect.assignedNodeId, targetNodeId: duplicateSuspect.targetNodeId },
        });
    }

    try {
        // C-W9a: the insert and its single-surface decision record run in the daemon
        // (`queue_enqueue`) — the decision is written AFTER the insert there, so a
        // failed enqueue still leaves no decision row (design :697-731), and a daemon
        // guard refusal comes back as the same error message.
        const task = (await queueEnqueue(ctx.transport, {
            meshId: ctx.mesh.id,
            message,
            options: {
                taskMode, ...(input ? { input } : {}), ...(readonly ? { readonly: true } : {}), requiredTags, dependsOn, missionId, targetNodeId,
                ...(priority ? { priority } : {}),
                ...(model ? { model } : {}),
                ...(thinkingLevel ? { thinkingLevel } : {}),
                ...(difficulty ? { difficulty } : {}),
                ...(notBefore ? { notBefore } : {}),
                ...(maxRetries !== undefined ? { maxRetries } : {}),
                ...(ownedPaths ? { ownedPaths } : {}),
                ...(ctx.coordinatorSessionId ? { sourceCoordinatorSessionId: ctx.coordinatorSessionId } : {}),
            },
            decision: {
                ...(missionId ? { missionId } : {}),
                ...(ctx.coordinatorSessionId ? { coordinatorSessionId: ctx.coordinatorSessionId } : {}),
                decision: orchestration.decision,
                ...(decisionMissing ? { decisionMissing: true } : {}),
                ...(orchestration.declaredEligibleSingle ? { declaredEligibleSingle: true } : {}),
                ...(orchestration.batchCapabilityAvailable
                    ? { batchCapabilityAvailable: orchestration.batchCapabilityAvailable.reportedReason }
                    : {}),
            } as Record<string, unknown>,
        })).entry as unknown as MeshWorkQueueEntry;
        const duplicateWarning = duplicateSuspect
            ? { duplicateSuspect: { taskId: duplicateSuspect.id, status: duplicateSuspect.status, assignedNodeId: duplicateSuspect.assignedNodeId, targetNodeId: duplicateSuspect.targetNodeId }, duplicateSuspectHint: 'An in-flight task with the same message+target already exists. This new task was enqueued anyway (warn-only). Cancel one via mesh_queue_cancel if it is an accidental re-enqueue, or pass allow_duplicate=true to silence this, or block_duplicate=true to refuse next time.' }
            : {};
        // MISSION-STATUS-TASK-WARNING: warn (never block) when this task attaches to a
        // mission that is paused/completed/abandoned — see buildMissionInactiveWarning.
        const missionWarning = (await buildMissionInactiveWarning(ctx, missionId)) ?? {};
        // WORKTREE-ROUTING-ADVISORY (b1): advisory only — never blocks, never re-routes.
        const worktreeAdvisory = buildUntargetedCodeChangeWorktreeAdvisory({
            taskMode, readonly, requiredTags, targetNodeId, preferWorktree,
        }) ?? {};
        const enqueueEcho = {
            ...(task.priority ? { priority: task.priority } : {}),
            ...(task.notBefore ? { notBefore: task.notBefore } : {}),
            ...(task.maxRetries !== undefined ? { maxRetries: task.maxRetries } : {}),
        };

        // ── Delivery is ONLY through a claim (rc.37 Finding B). ─────────────────
        //    Both transports hand the new row to the daemon's queue drain
        //    (`triggerMeshQueue` → `tryAssignQueueTask`), which claims it for a local
        //    OR remote idle session (remote-idle store) or auto-launches one, and opens
        //    the turn-ledger attempt (`dispatch_accepted`) BEFORE the body is sent.
        //    The retired IpcTransport "enqueue-and-push" P2P-sent a still-`pending`
        //    row straight to a remote node's session with no claim and no attempt:
        //    live, it injected a pinned task into a session that was mid-way through
        //    another task (the node one-active gate had just refused it), re-stamped
        //    that session's mesh assignment (orphaning the in-flight task's report)
        //    and ran the body while the queue row stayed `pending`. A task the claim
        //    gates leave pending must never reach a session.
        const queueTrigger = await triggerMeshQueueAndReport(ctx);
        return JSON.stringify({
            success: true,
            source: 'queue',
            taskId: task.id,
            status: task.status,
            taskMode: task.taskMode,
            requiredTags: task.requiredTags,
            ...buildProviderPinAdvisory(requiredTags),
            ...enqueueEcho,
            ...(targetNodeId ? { targetNodeId } : {}),
            ...(preferWorktree && !explicitTargetRaw && !targetNodeId ? { preferWorktreeNoOp: true } : {}),
            ...duplicateWarning,
            ...missionWarning,
            ...worktreeAdvisory,
            ...orchestrationWarning,
            queueTrigger,
            ...buildQueueTriggerGuidance(queueTrigger),
        });
    } catch (e: any) {
        const message = e?.message || String(e);
        if (message.includes('live_debug_readonly_guardrail_violation')) {
            return JSON.stringify({ success: false, code: 'live_debug_readonly_guardrail_violation', taskMode, error: message });
        }
        if (message.includes('dependency_cycle_detected')) {
            return JSON.stringify({ success: false, code: 'dependency_cycle_detected', dependsOn, error: message });
        }
        return JSON.stringify({ success: false, error: message });
    }
}

/**
 * G5: error codes enqueueTaskGraph (and the per-entry enqueueTask calls inside it)
 * can throw, surfaced as a structured `code` so an LLM caller can correct without
 * parsing prose. Scanned by substring — the daemon errors are prefixed with these.
 */
const BATCH_ENQUEUE_ERROR_CODES = [
    'live_debug_readonly_guardrail_violation',
    'dependency_cycle_detected',
    'unknown_dependency',
    'duplicate_task_ref',
    'duplicate_task_id',
    'task_graph_too_large',
    'empty_task_graph',
    'missing_task_difficulty',
    'invalid_task_difficulty',
    'invalid_on_dependency_failure',
] as const;
// Batch-v2 plan rejections are NOT listed here: MeshGraphPlanError carries its own
// machine-readable `code`, so it is read straight off the error rather than
// recovered by substring — which also keeps this pinned scheduling surface free of
// graph vocabulary (design :984-986).

/**
 * G5: atomic multi-task enqueue — the graph-submission companion to
 * mesh_enqueue_task. Validates and normalizes every entry through the SAME
 * normalizer as the single-task tool, then inserts all tasks in ONE daemon-core
 * transaction (enqueueTaskGraph): any per-entry failure (cycle, bad difficulty,
 * guardrail violation, unknown dependency) rolls back the whole batch, closing the
 * half-registered-chain failure mode of wiring a graph via N sequential calls.
 * Batch-local `ref` labels let `depends_on` name sibling entries (forward
 * references allowed); non-ref depends_on values must be existing task ids.
 */
export async function meshEnqueueBatch(
    ctx: MeshContext,
    args: {
        tasks?: Array<EnqueueTaskArgsShape & GraphTaskFieldsShape & { ref?: string }>;
        missionId?: string; mission_id?: string;
        allowDuplicate?: boolean; allow_duplicate?: boolean;
        blockDuplicate?: boolean; block_duplicate?: boolean;
        on_dependency_failure?: string;
        onDependencyFailure?: string;
        // ── batch v2 (design :566-592) ──
        batch_id?: string; batchId?: string;
        gates?: MeshGraphGatePlanSpec[];
        workspaces?: GraphWorkspaceDeclarationShape[];
        orchestration_decision?: unknown; orchestrationDecision?: unknown;
    },
): Promise<string> {
    // ★CANONICAL-FIRST (2026-09-25): mesh_enqueue_batch's own top-level scope
    // (mission_id/allow_duplicate/block_duplicate/batch_id/
    // orchestration_decision/on_dependency_failure). `tasks[]` entries are
    // NOT touched here — each entry gets canonicalized against the `tasks`
    // scope inside normalizeEnqueueTaskArgs below, which is a different alias
    // table than this top-level one (see canonicalizeEnqueueTaskEntry's doc
    // comment for why the two must not be conflated). Idempotent with
    // server.ts's own canonicalization pass.
    args = canonicalizeMeshTopLevelArgs('mesh_enqueue_batch', args) as typeof args;
    const rawTasks = Array.isArray(args.tasks) ? args.tasks : undefined;
    if (!rawTasks || rawTasks.length === 0) {
        return JSON.stringify({
            success: false,
            code: 'empty_task_graph',
            error: 'mesh_enqueue_batch requires a non-empty `tasks` array.',
        });
    }
    if (rawTasks.length > MESH_TASK_GRAPH_MAX_TASKS) {
        return JSON.stringify({
            success: false,
            code: 'task_graph_too_large',
            error: `mesh_enqueue_batch accepts at most ${MESH_TASK_GRAPH_MAX_TASKS} tasks per call (got ${rawTasks.length}). Split the graph, or reconsider whether one batch really needs this many tasks.`,
        });
    }
    // Top-level mission applies to every entry that doesn't carry its own.
    const batchMissionId = readString(args.missionId) || readString(args.mission_id) || undefined;
    // MISSION-UPSERT-SILENT-CREATE: batchMissionId is a fallback applied to entries
    // OUTSIDE normalizeEnqueueTaskArgs (see `missionId: v.missionId ?? batchMissionId`
    // below), so its own per-entry existence check inside the normalizer never sees this
    // value. Validate it here up front — same reject-loudly convention, applied once for
    // the whole batch rather than once per entry.
    const rawFailurePolicy = (args as { on_dependency_failure?: unknown; onDependencyFailure?: unknown }).on_dependency_failure
        ?? (args as { onDependencyFailure?: unknown }).onDependencyFailure;
    let onDependencyFailure: 'block' | 'cancel' | undefined;
    if (rawFailurePolicy !== undefined) {
        try {
            onDependencyFailure = parseOnDependencyFailurePolicy(rawFailurePolicy);
        } catch (e) {
            const message = e instanceof MeshGraphPolicyError || e instanceof Error
                ? e.message
                : 'invalid_on_dependency_failure';
            return JSON.stringify({
                success: false,
                code: 'invalid_on_dependency_failure',
                error: message,
            });
        }
    }

    if (batchMissionId && !(await missionQuery(ctx.transport, { meshId: ctx.mesh.id, id: batchMissionId })).missions[0]) {
        return JSON.stringify({
            success: false,
            code: 'mission_not_found',
            error: `mission '${batchMissionId}' does not exist on this mesh — refusing to enqueue a batch with an unresolvable mission_id. Omit mission_id, or use mesh_mission_list to get a valid full id.`,
            missionId: batchMissionId,
        });
    }
    // G4 flags are batch-level: block refuses the WHOLE batch (it is atomic — refusing
    // one entry and inserting the rest would be exactly the partial-graph state this
    // tool exists to prevent); allow silences detection for every entry.
    const allowDuplicate = args.allowDuplicate === true || args.allow_duplicate === true;
    const blockDuplicate = args.blockDuplicate === true || args.block_duplicate === true;

    // STALE-SNAPSHOT-TARGET-REJECT (batch half): one refresh for the whole
    // batch, before any entry is validated. The batch is atomic, so a stale
    // snapshot rejecting one pinned target_node_id rolled back ALL entries —
    // a strictly worse blast radius than the single-enqueue path. Best-effort:
    // a refresh failure leaves the previous behavior unchanged.
    await refreshMeshFromDaemon(ctx);

    // ── Normalize every entry BEFORE inserting anything (atomic by construction:
    //    a normalization failure returns without touching the queue). ──
    const specs: MeshTaskGraphEntrySpec[] = [];
    // Raw entries kept parallel to `specs` so the graph module (not this pinned
    // scheduling surface) can read the v2 fields off them.
    const rawGraphEntries: Array<GraphTaskFieldsShape> = [];
    const normalizedEntries: Array<NormalizedEnqueueTaskArgs & { ref?: string }> = [];
    const duplicateSuspects: Array<{ taskIndex: number; ref?: string; duplicateOf: { taskId: string; status: string; assignedNodeId?: string; targetNodeId?: string } }> = [];
    for (let i = 0; i < rawTasks.length; i++) {
        const entry = rawTasks[i] ?? ({} as EnqueueTaskArgsShape & { ref?: string });
        const ref = readString((entry as { ref?: string }).ref) || undefined;
        const label = ref ? `task '${ref}'` : `task #${i}`;
        const normalized = await normalizeEnqueueTaskArgs(ctx, entry, `mesh_enqueue_batch ${label}`);
        if (!normalized.ok) {
            return JSON.stringify({
                success: false,
                code: normalized.code,
                error: normalized.error,
                taskIndex: i,
                ...(ref ? { ref } : {}),
                ...(normalized.extra ?? {}),
                enqueued: 0,
                atomic: true,
            });
        }
        const v = normalized.value;
        // G4 duplicate detection against the IN-FLIGHT queue (same fingerprint rules as
        // mesh_enqueue_task). Intra-batch repeats are not flagged — sending the same
        // instruction twice within one deliberate batch is the caller's explicit choice.
        if (!allowDuplicate) {
            const suspect = await findInFlightDuplicate(ctx, v.message, v.targetNodeId);
            if (suspect) {
                duplicateSuspects.push({
                    taskIndex: i,
                    ...(ref ? { ref } : {}),
                    duplicateOf: { taskId: suspect.id, status: suspect.status, assignedNodeId: suspect.assignedNodeId, targetNodeId: suspect.targetNodeId },
                });
            }
        }
        normalizedEntries.push({ ...v, ...(ref ? { ref } : {}) });
        rawGraphEntries.push(entry);
        specs.push({
            ...(ref ? { ref } : {}),
            message: v.message,
            taskMode: v.taskMode,
            ...(v.input ? { input: v.input } : {}),
            ...(v.readonly ? { readonly: true } : {}),
            requiredTags: v.requiredTags,
            dependsOn: v.dependsOn,
            missionId: v.missionId ?? batchMissionId,
            targetNodeId: v.targetNodeId,
            ...(v.priority ? { priority: v.priority } : {}),
            ...(v.model ? { model: v.model } : {}),
            ...(v.thinkingLevel ? { thinkingLevel: v.thinkingLevel } : {}),
            ...(v.difficulty ? { difficulty: v.difficulty } : {}),
            ...(v.notBefore ? { notBefore: v.notBefore } : {}),
            ...(v.maxRetries !== undefined ? { maxRetries: v.maxRetries } : {}),
            // H1 (path ownership) — mesh_enqueue_batch parity fix: this normalized value was
            // computed by the SAME normalizeEnqueueTaskArgs the single-task tool uses (which
            // already reads owned_paths/ownedPaths), but this specs.push was never updated to
            // copy it onto either the compat-path spec object OR the graph-path plan (both
            // read off this one `specs` array — see buildGraphPlanShape below), so a batch
            // entry's declaration silently never reached the daemon on either path.
            ...(v.ownedPaths ? { ownedPaths: v.ownedPaths } : {}),
            ...(ctx.coordinatorSessionId ? { sourceCoordinatorSessionId: ctx.coordinatorSessionId } : {}),
        });
    }
    if (duplicateSuspects.length > 0 && blockDuplicate) {
        return JSON.stringify({
            success: false,
            code: 'duplicate_suspect',
            error: `${duplicateSuspects.length} task(s) in this batch match an in-flight task with the same message (and target node when pinned). Refusing the WHOLE batch because block_duplicate=true and the batch is atomic. Cancel the in-flight duplicates, wait for them, or re-send with allow_duplicate=true.`,
            duplicateSuspects,
            enqueued: 0,
            atomic: true,
        });
    }

    // ── Atomic insert: all or nothing. ──
    //
    // ★ GRAPH-ORCHESTRATION Phase E (design :576-592). TWO paths, and the choice
    // is made by what the CALLER asked for, never by a heuristic:
    //
    //   compatibility path — no gates, no workspaces, no per-task graph field.
    //     `enqueueTaskGraph(specs)` exactly as before: same rows, same static
    //     message/target/dependsOn, and ** no graph-owned block merely because a
    //     task has dependencies ** (design :580). The prior batches would execute
    //     identically (design :583).
    //
    //   graph path — any v2 surface is present. The plan and every worker queue
    //     placeholder commit in ONE transaction (design :585); `enqueueTaskGraph`
    //     nests inside it, so per-entry validation is still the same code and a
    //     plan failure rolls the queue rows back with it.
    //
    // `atomic: true` means DB PLAN atomicity only. Git worktree preparation is a
    // compensated saga reported separately as `workspacePreparation` (design :587-588).
    //
    // ★ The v2 request vocabulary is parsed in mesh-tools-graph.ts, NOT here: this
    // file is a pinned scheduling surface and must not grow graph-layer tokens of
    // its own (design :984-986). See the note on buildGraphPlanShape.
    const batchIdArg = readString(args.batch_id) || readString(args.batchId) || undefined;
    const plan = buildGraphPlanShape(specs, rawGraphEntries, args.gates, args.workspaces, !!batchIdArg);
    // The static (compat) path has no place to carry a batch failure policy, so a
    // plain depends_on batch with on_dependency_failure=cancel used to drop the
    // policy while the response still echoed it (found 2026-09-25). `cancel` needs
    // the graph runner's cascade, so it selects the graph path; `block` is the
    // queue default and stays on the static path.
    const useGraphPath = plan.useGraphPath || onDependencyFailure === 'cancel';
    // design :697-731 — the enqueue-decision record. Recorded for BOTH paths so
    // batch adoption is countable without transcript scraping.
    const decision = normalizeOrchestrationDecision(
        args.orchestration_decision ?? args.orchestrationDecision,
        'batch',
    );

    // C-W9a: the atomic insert — either path — and its audit trail run in the
    // daemon (`queue_enqueue_graph`): the commit record on success, and on failure
    // the rolled-back / validation-failed record written AFTER the failed
    // transaction (design :741-743, :752-753). A refusal comes back as a result
    // carrying the same code / message / extra this tool always returned.
    const committed = await queueEnqueueGraph(ctx.transport, {
        meshId: ctx.mesh.id,
        ...(useGraphPath
            ? {
                mode: 'graph' as const,
                plan: {
                    tasks: plan.tasks,
                    gates: plan.gates,
                    workspaces: plan.workspaces,
                    ...(batchIdArg ? { batchId: batchIdArg } : {}),
                    ...(batchMissionId ? { missionId: batchMissionId } : {}),
                    ...(onDependencyFailure ? { onDependencyFailure } : {}),
                    ...(ctx.coordinatorSessionId ? { sourceCoordinatorSessionId: ctx.coordinatorSessionId } : {}),
                    enqueueSurface: 'batch',
                    orchestrationDecision: decision.decision as unknown as Record<string, unknown>,
                } as unknown as Record<string, unknown>,
            }
            : { mode: 'compat' as const, specs: specs as unknown as Record<string, unknown>[] }),
        audit: {
            ...(batchIdArg ? { batchId: batchIdArg } : {}),
            ...(batchMissionId ? { missionId: batchMissionId } : {}),
            ...(ctx.coordinatorSessionId ? { coordinatorSessionId: ctx.coordinatorSessionId } : {}),
            onDependencyFailure: onDependencyFailure ?? 'block',
            orchestrationDecision: decision.decision as unknown as Record<string, unknown>,
            taskCount: specs.length,
            errorCodes: [...BATCH_ENQUEUE_ERROR_CODES],
        },
    });
    if (!committed.ok) {
        return JSON.stringify({
            success: false,
            ...(committed.refusalCode ? { code: committed.refusalCode } : {}),
            error: committed.message,
            enqueued: 0,
            atomic: true,
            ...(committed.extra ?? {}),
        });
    }
    const tasks = committed.tasks as unknown as MeshWorkQueueEntry[];
    const graphPlan = committed.graph as unknown as Omit<MeshGraphPlanResult, 'tasks'> | undefined;

    // ── Post-insert (best-effort, never undoes the committed batch): mission
    //    warnings, routing advisories, queue drain. ──
    const distinctMissionIds = [...new Set(specs.map(s => s.missionId).filter((m): m is string => !!m))];
    const missionWarnings = await Promise.all(distinctMissionIds.map(missionId => buildMissionInactiveWarning(ctx, missionId)));
    const missionWarning = missionWarnings.find(w => w !== undefined) ?? {};
    const advisoryTasks: string[] = [];
    normalizedEntries.forEach((entry, i) => {
        const advisory = buildUntargetedCodeChangeWorktreeAdvisory({
            taskMode: entry.taskMode,
            readonly: entry.readonly,
            requiredTags: entry.requiredTags,
            targetNodeId: entry.targetNodeId,
            preferWorktree: entry.preferWorktree,
        });
        if (advisory) advisoryTasks.push(entry.ref ? `'${entry.ref}'` : `#${i}`);
    });
    const worktreeAdvisory = advisoryTasks.length > 0
        ? {
            ...buildUntargetedCodeChangeWorktreeAdvisory({ taskMode: 'code_change', readonly: false, preferWorktree: false })!,
            worktreeRoutingAdvisoryTasks: advisoryTasks,
        }
        : {};

    const queueTrigger = await triggerMeshQueueAndReport(ctx);

    // Delivery is only through a claim — see the note in meshEnqueueTask (rc.37 Finding B).

    return JSON.stringify({
        success: true,
        source: 'queue',
        atomic: true,
        enqueued: tasks.length,
        ...(onDependencyFailure ? { on_dependency_failure: onDependencyFailure } : {}),
        // ── batch v2 additive response fields (design :582) ──
        // Present only on the graph path: an old-path batch creates no graph, so
        // reporting a graphId for it would be a lie.
        ...(graphPlan
            ? {
                graphId: graphPlan.graphId,
                batchId: graphPlan.batchId,
                planDigest: graphPlan.planDigest,
                // design :585-588 — DB atomicity NEVER implies the git worktree exists.
                workspacePreparation: graphPlan.workspacePreparation,
                ...(graphPlan.replayed
                    ? {
                        replayed: true,
                        replayedHint: 'A graph with this batch_id and an identical plan digest already existed; nothing was re-inserted. '
                            + 'Re-sending the same batch_id with a DIFFERENT plan is rejected as batch_id_conflict.',
                    }
                    : {}),
                ...(graphPlan.gates.length > 0
                    ? {
                        gates: graphPlan.gates,
                        gateHint: 'Gates are declared shut. When their predecessors complete they open (awaiting_coordinator) and BLOCK their '
                            + 'downstream tasks. Pass one with mesh_graph_gate action=claim → do the action yourself → mesh_graph_gate action=release. '
                            + 'The daemon never performs a gate action and a deadline can only expire a gate, never pass it.',
                    }
                    : {}),
                ...(graphPlan.workspaces.length > 0 ? { workspaces: graphPlan.workspaces } : {}),
                ...(graphPlan.heldNodeIds.length > 0
                    ? {
                        graphHeldTasks: graphPlan.heldNodeIds.length,
                        graphHeldHint: 'Tasks declaring graph features (bound upstream outputs, a condition, a delayed worktree, or a gate) '
                            + 'are held until the graph settles them — that is what makes their final instruction knowable. Tasks with only '
                            + 'plain dependencies are NOT held; they use the unchanged queue dependency predicate.',
                    }
                    : {}),
            }
            : {}),
        ...(decision.batchCapabilityAvailable ? { batchCapabilityAvailable: decision.batchCapabilityAvailable } : {}),
        tasks: tasks.map((task, i) => ({
            ...(normalizedEntries[i].ref ? { ref: normalizedEntries[i].ref } : {}),
            taskId: task.id,
            status: task.status,
            taskMode: task.taskMode,
            ...(graphPlan?.nodeIdByIndex[i] ? { nodeId: graphPlan.nodeIdByIndex[i] } : {}),
            ...(Array.isArray(task.dependsOn) && task.dependsOn.length > 0 ? { dependsOn: task.dependsOn } : {}),
            ...(task.targetNodeId ? { targetNodeId: task.targetNodeId } : {}),
            ...(task.priority ? { priority: task.priority } : {}),
            ...(task.notBefore ? { notBefore: task.notBefore } : {}),
        })),
        ...(duplicateSuspects.length > 0
            ? {
                duplicateSuspects,
                duplicateSuspectHint: 'In-flight task(s) with the same message+target already exist. The batch was enqueued anyway (warn-only). Cancel duplicates via mesh_queue_cancel, or pass allow_duplicate=true / block_duplicate=true to silence or refuse next time.',
            }
            : {}),
        ...missionWarning,
        ...worktreeAdvisory,
        queueTrigger,
        ...buildQueueTriggerGuidance(queueTrigger),
    });
}

export async function meshViewQueue(
    ctx: MeshContext,
    args: { status?: string[]; view?: QueueViewMode; compact?: boolean; verbose?: boolean; refresh?: boolean },
): Promise<string> {
    const rateResult = await recordMeshCoordinatorToolCall(ctx, 'mesh_view_queue');
    // Default to the slim payload for LLM callers; verbose forces the full payload.
    const compact = args.verbose === true ? false : (args.compact ?? true);
    // Audit #7 (P7): bypass the shared get_status_metadata probe cache/dedupe when
    // the caller explicitly asks for a fresh read (see mesh_status's identical
    // probeOpts — mesh-tools-internal.ts probeStatusMetadataForNode).
    const probeOpts = args.refresh === true ? { refresh: true } : undefined;
    try {
        await refreshMeshFromDaemon(ctx);
        const statusFilter = sanitizeQueueStatusFilter(args.status);
        const view = normalizeQueueViewMode(args.view);
        const rawQueue = await readQueueFromDaemon(ctx);
        // M1: annotate dependency state (waitingOn, dependenciesSatisfied) at view time.
        const statusById = new Map(rawQueue.map(task => [task.id, task.status]));
        const depMetaById = new Map(rawQueue.map(task => [task.id, task] as const));
        const withDependencies = rawQueue.map(task => {
            if (!Array.isArray(task.dependsOn) || task.dependsOn.length === 0) return task;
            const depState = describeTaskDependencyState(task, statusById, depMetaById);
            return { ...task, ...depState };
        });
        // COORDINATOR-HELD NODE STATE (owner principle 2026-09-26): node/session
        // decoration answers from the coordinator daemon's held runtime first — no
        // per-daemon get_status_metadata round trip for a node another daemon
        // owns (falls back to a live probe only when the daemon predates the held
        // marker or nothing is held for that node yet). See
        // annotateQueueStaleness's liveVerifiedNodes param for why a failed probe
        // must never count as evidence of absence: __liveProbeVerified stays false
        // whenever neither held state nor a live probe could confirm anything.
        // The node shape is a superset of the plain one (adds __liveProbeVerified;
        // sessions merge identically), so it's reused below for the active-work
        // evidence instead of probing twice.
        const liveNodes = await collectMeshViewQueueNodesHeldOrLive(ctx, probeOpts);
        const fullQueue = prioritizeActiveQueueRows(annotateQueueStaleness(withDependencies, ctx.mesh, liveNodes));
        const queue = filterQueueForView(fullQueue, view, statusFilter);
        const summary = buildQueueStatusSummary(fullQueue);
        const visibleSummary = buildQueueStatusSummary(queue);
        const maintenance = buildQueueMaintenanceReport(fullQueue);
        // C-W9a: active work is computed in the daemon over the open direct dispatches
        // (mesh_direct attempts) and its records (+ turn outcomes), for THIS view's
        // annotated queue; the inputs come back for the dispatch-failure list below.
        // The direct-dispatch transcript reconcile is a WRITE-side nudge the response
        // does not need (see mesh-status-background.ts) — kicked in the background,
        // same as mesh_status, instead of blocking this read on a live read_chat.
        const activeWorkView = await readActiveWorkFromDaemon(ctx, { nodes: liveNodes, queue: fullQueue, recordTail: 200, includeInputs: true });
        scheduleBackgroundDirectReconcile(ctx, liveNodes, activeWorkView.directDispatches, activeWorkView.records);
        const ledgerEntries = activeWorkView.records;
        const activeWorkEvidence = activeWorkView.activeWork!;
        const recentDispatchFailures = ledgerEntries
            .filter(e => e.kind === 'p2p_dispatch_failed')
            .slice(-20)
            .map(e => ({
                nodeId: e.nodeId,
                taskId: e.payload?.taskId,
                error: e.payload?.error,
                via: e.payload?.via,
                failedAt: e.payload?.dispatchFailedAt || e.timestamp,
            }));
        // PIN-PARKING: surface parked rows as their own section rather than leaving
        // them to be spotted among the pending rows.
        //
        // A parked task is pending-shaped but behaves nothing like pending work: no
        // session will ever claim it and no timer will re-home it, so it is invisible
        // in every "is anything moving?" signal the coordinator actually reads
        // (activeWork, autoLaunch, the status counts). Left to blend in, it is a queue
        // row that looks like progress and is in fact a dead end — which is the same
        // silent loss parking was introduced to prevent, one layer up. Named
        // explicitly, with its original addressee and the reason it parked, it is
        // something the coordinator can act on.
        //
        // Deliberately NOT compacted away: this array is bounded by how many pins go
        // stale (single digits in practice, and each entry a handful of ids), and
        // hiding it in compact mode would defeat its purpose for exactly the busy
        // meshes where it matters most.
        const parkedTasks = fullQueue
            .filter((task: any) => task?.parked?.reason)
            .map((task: any) => ({
                taskId: task.id,
                parkedAt: task.parked.parkedAt,
                reason: task.parked.reason,
                originalTargetSessionId: task.parked.targetSessionId,
                originalTargetNodeId: task.parked.targetNodeId,
                currentTargetSessionId: task.targetSessionId,
                missionId: task.missionId,
                message: summarizeTaskMessage(task.message),
            }));
        const staleAssignedTasks = (maintenance as any).staleAssignedTasks || [];
        const requestedHistoricalRows = queue.some((task: any) => HISTORICAL_QUEUE_STATUSES.has(String(task?.status || '')));
        const pollingGuidance = buildActiveWorkPollingGuidance(activeWorkEvidence.summary);

        // Compact mode: completed/failed/cancelled historical row arrays are the main
        // payload bloat (mesh_view_queue has overflowed 250k chars on busy meshes).
        // Drop them in favor of the status counts that summary/visibleSummary already
        // carry, but keep pending/assigned active rows — those drive coordinator
        // dispatch decisions. verbose=true returns every row as before.
        const activeOnlyQueue = queue.filter((task: any) => !HISTORICAL_QUEUE_STATUSES.has(String(task?.status || '')));
        // Compact mode: cap active rows and truncate per-row messages (a busy mesh
        // can carry dozens of multi-KB task messages → 70KB+ in the active array).
        const compactQueueResult = compact ? compactQueueRows(activeOnlyQueue) : { rows: activeOnlyQueue, omitted: 0 };
        // MESH-IMAGE-DISPATCH: this is a VIEW surface, so a persisted input envelope
        // (which may carry base64 image data) must never be echoed verbatim here —
        // only the dispatch path needs the real envelope. Replace it with a
        // content-free summary (partCount/partTypes).
        const visibleQueue = (compact ? compactQueueResult.rows : queue).map((task: any) => summarizeQueueEntryInputForView(task));
        const wantActiveQueueArray = view === 'active' || statusFilter?.some(status => ACTIVE_QUEUE_STATUSES.has(status));
        const wantHistoricalQueueArray = !compact && (view === 'historical' || requestedHistoricalRows);
        // activeWork carries the full task message/summary per record — the single
        // largest payload source on a busy mesh. Slim + cap it in compact mode.
        const activeWorkResult = compact
            ? compactActiveWorkRecords(activeWorkEvidence.activeWork)
            : { records: activeWorkEvidence.activeWork, omitted: 0 };

        // staleDirectWork is a full MeshActiveWorkRecord[] of orphaned/historical
        // direct dispatches — it is the second major payload-bloat source (the first
        // being historical queue rows). In compact mode, collapse it to the same
        // bounded summary mesh_status uses and only emit the full array in verbose mode.
        const staleDirectWorkSummary = buildCompactStaleDirectWorkSummary(activeWorkEvidence.staleDirectWork, {
            note: activeWorkEvidence.staleDirectWorkNote,
            detailHint: 'Full stale direct entries are omitted from mesh_view_queue in compact mode. Call mesh_view_queue with verbose=true, or inspect mesh_task_history for ledger detail.',
        });
        // queueMaintenance/cleanupDryRun serialize the same maintenance object whose
        // cleanupCandidates array scales with old historical record count. In compact
        // mode drop the per-row arrays in favor of counts.
        const maintenanceForResponse = compact ? buildCompactQueueMaintenanceReport(maintenance) : maintenance;

        return JSON.stringify({
            success: true,
            payloadMode: compact ? 'compact' : 'full',
            sourceOfTruth: {
                kind: 'mesh_work_queue_file',
                activeStatuses: ['pending', 'assigned'],
                historicalStatuses: ['completed', 'failed', 'cancelled'],
                notes: 'pending/assigned are active work; completed/failed/cancelled are historical ledger records and never stale assignments.',
            },
            filter: {
                view,
                statuses: statusFilter,
                filtered: Boolean(statusFilter?.length) || view !== 'all',
            },
            queue: visibleQueue,
            ...(compact ? { historicalRowsOmitted: true, historicalRowsHint: 'Completed/failed/cancelled rows are omitted in compact mode; see historicalCounts. Call mesh_view_queue with verbose=true (or view=historical, compact=false) for full rows.' } : {}),
            ...(compact && compactQueueResult.omitted > 0 ? {
                activeRowsOmitted: compactQueueResult.omitted,
                activeRowsHint: `Showing the first ${COMPACT_MAX_ACTIVE_QUEUE_ROWS} active rows (per-row messages truncated). ${compactQueueResult.omitted} more active row(s) omitted — see activeCount/activeCounts for the complete total or use verbose=true.`,
            } : {}),
            activeWork: activeWorkResult.records,
            ...(compact && activeWorkResult.omitted > 0 ? {
                activeWorkOmitted: activeWorkResult.omitted,
                activeWorkHint: `Showing the first ${COMPACT_MAX_ACTIVE_WORK_ROWS} active-work records (messages truncated). ${activeWorkResult.omitted} more omitted — see activeWorkSummary for complete counts or use verbose=true.`,
            } : {}),
            staleDirectWorkSummary,
            ...(compact ? {} : { staleDirectWork: activeWorkEvidence.staleDirectWork }),
            activeWorkSummary: activeWorkEvidence.summary,
            ...(pollingGuidance ? { pollingGuidance } : {}),
            ...(rateResult.rateLimitExceeded ? { pollingRateAdvisory: { type: 'rate_limit_exceeded', tool: 'mesh_view_queue', callsInWindow: rateResult.callsInWindow, message: rateResult.advisory } } : {}),
            summary,
            visibleSummary,
            activeCounts: summary.activeCounts,
            historicalCounts: summary.historicalCounts,
            visibleActiveCounts: visibleSummary.activeCounts,
            visibleHistoricalCounts: visibleSummary.historicalCounts,
            activeCount: summary.activeCount,
            historicalCount: summary.historicalCount,
            visibleActiveCount: visibleSummary.activeCount,
            visibleHistoricalCount: visibleSummary.historicalCount,
            ...(parkedTasks.length > 0 ? {
                parkedTasks,
                parkedTaskCount: parkedTasks.length,
                parkedTaskNote: 'PARKED tasks are held for an explicit coordinator decision and are claimable by NOBODY — their delta was addressed to a session whose pin went stale, and the daemon deliberately will not re-home it onto another session. '
                    + 'Nothing will move them until you act. Exits: mesh_queue_requeue(task_id, target_session_id=<live session>) to re-target, or with clear_target_session=true to let any compatible session take it; '
                    + 'add message=<rewritten instruction> to the same call if the situation moved on while it waited; mesh_queue_cancel(task_id) if it is moot. Any requeue unparks the task. '
                    + 'Left untouched they are failed (with a notification) once past the parked-task retention window.',
            } : {}),
            staleAssignedTasks: compact ? staleAssignedTasks.slice(0, 10).map(compactQueueRow) : staleAssignedTasks,
            staleAssignedCount: (maintenance as any).staleAssignedCount,
            queueMaintenance: maintenanceForResponse,
            cleanupDryRun: maintenanceForResponse,
            ...(recentDispatchFailures.length > 0 ? {
                recentDispatchFailures,
                dispatchFailureCount: recentDispatchFailures.length,
                dispatchFailureNote: 'Remote P2P dispatch attempts that failed. Affected tasks remain pending and may require mesh_queue_requeue if no idle session picks them up.',
            } : {}),
            ...(wantActiveQueueArray && !compact ? {
                activeQueue: queue.filter((task: any) => ACTIVE_QUEUE_STATUSES.has(String(task?.status || ''))),
            } : {}),
            // In compact mode the `queue` field already holds exactly the slimmed+
            // capped active rows, so the separate activeQueue array would be a verbatim
            // duplicate (it doubled the payload). Point callers at `queue` instead.
            ...(wantActiveQueueArray && compact ? { activeQueueHint: 'In compact mode the active rows are in `queue` (already filtered to pending/assigned). Use verbose=true for the separate full activeQueue array.' } : {}),
            ...(wantHistoricalQueueArray ? {
                historicalQueue: queue.filter((task: any) => HISTORICAL_QUEUE_STATUSES.has(String(task?.status || ''))),
            } : {}),
            // Back-compat alias for callers already reading the first hardening payload.
            staleAssignments: compact ? staleAssignedTasks.slice(0, 10).map(compactQueueRow) : staleAssignedTasks,
        }, null, 2);
    } catch (e: any) {
        return JSON.stringify({ success: false, error: e.message });
    }
}

export async function meshQueueCancel(
    ctx: MeshContext,
    args: { task_id?: string; taskId?: string; reason?: string },
): Promise<string> {
    try {
        const taskId = (args.task_id || args.taskId || '').trim();
        if (!taskId) return JSON.stringify({ success: false, error: 'task_id required' });

        // MESH-DISPATCH-MISROUTE: read the PRE-cancel entry so we know whether the task was
        // already dispatched to a live worker. cancelTask overwrites status to 'cancelled'
        // but preserves assignedSessionId/Node/Provider, so the assignment fields survive —
        // only the status must be captured before the mutation.
        // C-W9a: the cancel runs in the daemon (`queue_cancel`), which returns the row
        // as it was BEFORE the mutation alongside the cancelled one.
        const cancelled = await queueCancel(ctx.transport, { meshId: ctx.mesh.id, taskId, ...(args.reason !== undefined ? { reason: args.reason } : {}) });
        const preCancel = (cancelled.before ?? undefined) as {
            status?: string; assignedSessionId?: string; assignedNodeId?: string; assignedProviderType?: string;
        } | undefined;
        const wasAssigned = preCancel?.status === 'assigned';
        const assignedSessionId = readString(preCancel?.assignedSessionId) || undefined;
        const assignedNodeId = readString(preCancel?.assignedNodeId) || undefined;
        const assignedProviderType = readString(preCancel?.assignedProviderType) || undefined;

        const task = cancelled.task as unknown as MeshWorkQueueEntry | null;
        if (!task) return JSON.stringify({ success: false, error: `Queue task '${taskId}' not found` });
        ctx.transport.command('trigger_mesh_queue', { meshId: ctx.mesh.id }).catch(() => {});

        // MESH-DISPATCH-MISROUTE (fix 2): cancelling the queue row alone does NOT stop a worker
        // that already claimed the task and is generating — it ran to completion and committed
        // to the (often base) checkout. When the task was dispatched to a live session, propagate
        // a stop so the worker halts its in-flight generation. Guards:
        //  - only for an 'assigned' task with a resolvable assignedSessionId (a pending/terminal
        //    task has no live worker to stop — sending one would be a no-op at best);
        //  - NEVER stop the coordinator's own session (ctx.coordinatorSessionId) — that is the
        //    session issuing the cancel, not the worker. Stopping it would kill the coordinator.
        // The stop rides agent_command(action:'stop'), which is already in the router's
        // MESH_FORWARDABLE_SESSION_COMMANDS set: a session hosted on a REMOTE worker daemon is
        // auto-forwarded to that daemon (cross-machine workers are reached), and meshContext.nodeId
        // keeps the fail-closed cross-node scoping AND now seeds the router's deterministic
        // owner-resolution fallback (assignedNodeId → owner daemon) so a worktree-clone worker
        // whose session id missed the coordinator's cached active-sessions snapshot is still reached.
        // CANCEL-STOP false-positive fix: AWAIT the stop and report its REAL outcome
        // (stopped / no response from remote worker daemon / "CLI agent not running") instead of
        // pre-stamping attempted:true on a fire-and-forget call. Best-effort: any stop failure is
        // caught and surfaced in workerStop.reason — it must NEVER fail the cancel itself, which
        // already committed the queue 'cancelled' transition above.
        let workerStop: {
            attempted: boolean; stopped?: boolean; sessionId?: string; nodeId?: string; reason?: string;
            /** CANCEL-STOP-TASK-SCOPE: the daemon spared this session — it had moved on. */
            skipped?: string; sessionTaskId?: string;
        } = { attempted: false };
        if (wasAssigned && assignedSessionId && assignedSessionId !== ctx.coordinatorSessionId && assignedProviderType) {
            workerStop = { attempted: true, sessionId: assignedSessionId, nodeId: assignedNodeId };
            try {
                const stopResult = await ctx.transport.command('agent_command', {
                    targetSessionId: assignedSessionId,
                    cliType: assignedProviderType,
                    agentType: assignedProviderType,
                    action: 'stop',
                    // CANCEL-STOP-TASK-SCOPE: taskId rides UNCONDITIONALLY, not only when a
                    // node is known. It is what makes the daemon's stop task-scoped: without
                    // it the daemon cannot tell whether this session is still running the
                    // cancelled task, and a stale 'assigned' row would kill a session that had
                    // moved on to unrelated work. nodeId stays optional (it only seeds the
                    // router's owner-resolution fallback), so it keeps its own guard.
                    meshContext: {
                        meshId: ctx.mesh.id,
                        taskId,
                        ...(assignedNodeId ? { nodeId: assignedNodeId } : {}),
                    },
                });
                const stopped = stopResult?.stopped === true || stopResult?.success === true;
                workerStop.stopped = stopped;
                if (!stopped) {
                    workerStop.reason = readString(stopResult?.error) || 'worker stop not confirmed';
                    // CANCEL-STOP-TASK-SCOPE: a task-mismatch refusal is not a failure — the
                    // daemon deliberately spared a session that had moved on to another task.
                    // Name it distinctly so the coordinator does not read it as an unreachable
                    // worker and retry/escalate against a session that is working correctly.
                    if (readString(stopResult?.reason) === 'stop_task_mismatch') {
                        workerStop.skipped = 'session_moved_to_other_task';
                        workerStop.sessionTaskId = readString(stopResult?.sessionTaskId) || undefined;
                    }
                }
            } catch (e: any) {
                workerStop.stopped = false;
                workerStop.reason = e?.message || String(e);
            }
        } else if (wasAssigned && assignedSessionId === ctx.coordinatorSessionId) {
            workerStop = { attempted: false, reason: 'assigned_session_is_coordinator_self — stop suppressed' };
        }

        // CANCEL-ORPHANS-PINNED-TASK: the stop above is a HARD stop (CliManager.stopSession
        // removes the instance), so every OTHER pending queue task hard-pinned to that same
        // session is now undeliverable AND un-launchable — it can neither reach the dead
        // session nor spawn a new one (the pin makes auto-launch skip with
        // 'target_session_constraint'). Live repro 2026-08-16: 12 minutes with zero
        // generating sessions before a human noticed. Detect it here — at the moment we
        // KNOW which session we just killed — and page the coordinator with the exact
        // requeue call. Notify-only by design; see mesh-orphaned-pin-notify.ts for why the
        // pins are not cleared automatically and why detection cannot live in stopSession.
        //
        // Gated on `attempted`, NOT on `stopped`. No stop attempt → no session death → no
        // orphans, so the guard is right. But an ATTEMPTED-yet-unconfirmed stop ("no response
        // from remote worker daemon") must still notify: either the stop landed and the pins
        // are dead, or the worker daemon is unreachable — in which case tasks pinned to a
        // session on it are no more deliverable. Both readings leave the coordinator with
        // stranded work, and the notice names the uncertainty by naming its cause. Staying
        // silent on the unconfirmed case would re-open the exact hole this closes, since that
        // is the case where a stop is MOST likely to have half-happened.
        //
        // Best-effort, exactly like the stop itself — a failure here must never fail the
        // cancel, which already committed the 'cancelled' transition.
        //
        // CANCEL-STOP-TASK-SCOPE exception: a `stop_task_mismatch` refusal is categorically
        // different from an unconfirmed stop. It is a POSITIVE answer from a reachable daemon
        // — "that session is alive and working another task, so I did not kill it". No session
        // died, so nothing pinned to it is orphaned, and paging the coordinator would be a
        // false alarm telling it to requeue work that is fine where it is.
        // C-W9c: was in-process `notifyCoordinatorOfOrphanedPins` (a live queue read
        // + a `notifyMeshCoordinator` event write, both daemon-only concerns); now
        // the `orphaned_pin_notify` IPC round trip runs the whole call in the daemon.
        let orphanedPinnedTasks: OrphanedPinnedTask[] = [];
        if (workerStop.attempted && assignedSessionId && workerStop.skipped !== 'session_moved_to_other_task') {
            try {
                const { orphans } = await orphanedPinNotify(ctx.transport, {
                    meshId: ctx.mesh.id,
                    stoppedSessionId: assignedSessionId,
                    excludeTaskId: taskId,
                    cause: `Cancelling task ${taskId}`,
                    ...(assignedNodeId ? { nodeId: assignedNodeId } : {}),
                    ...(ctx.coordinatorSessionId ? { coordinatorSessionId: ctx.coordinatorSessionId } : {}),
                });
                orphanedPinnedTasks = orphans as unknown as OrphanedPinnedTask[];
            } catch {
                // The daemon-side helper already logs its own failures (queue read /
                // event persist). This outer catch only guarantees the cancel response
                // is still returned.
                orphanedPinnedTasks = [];
            }
        }

        return JSON.stringify({
            success: true,
            task,
            workerStop,
            // Surface the orphans inline too: the pending event reaches the coordinator on its
            // next drain, but the cancel's own response is read immediately — the coordinator
            // can act without waiting for the event round-trip.
            ...(orphanedPinnedTasks.length > 0 ? {
                orphanedPinnedTasks,
                orphanedPinnedTasksWarning: buildOrphanedPinNotice(
                    orphanedPinnedTasks,
                    assignedSessionId!,
                    `Cancelling task ${taskId}`,
                ),
            } : {}),
        }, null, 2);
    } catch (e: any) {
        return JSON.stringify({ success: false, error: e.message });
    }
}

export async function meshQueueRequeue(
    ctx: MeshContext,
    args: {
        task_id?: string;
        taskId?: string;
        reason?: string;
        target_node_id?: string;
        targetNodeId?: string;
        target_session_id?: string;
        targetSessionId?: string;
        clear_target_node?: boolean;
        clearTargetNode?: boolean;
        keep_target_session?: boolean;
        keepTargetSession?: boolean;
        force?: boolean;
        message?: string;
    },
): Promise<string> {
    try {
        const taskId = (args.task_id || args.taskId || '').trim();
        if (!taskId) return JSON.stringify({ success: false, error: 'task_id required' });
        const targetNodeId = (args.target_node_id || args.targetNodeId || '').trim() || undefined;
        const targetSessionId = (args.target_session_id || args.targetSessionId || '').trim() || undefined;
        const keepTargetSession = args.keep_target_session === true || args.keepTargetSession === true;
        const clearTargetNode = args.clear_target_node === true || args.clearTargetNode === true;
        // clearTargetSession contract: an explicit target session pins the row (never cleared);
        // otherwise clear the stale target session unless the caller asked to keep it.
        const clearTargetSession = targetSessionId ? false : !keepTargetSession;
        const force = args.force === true;
        // PIN-PARKING (edit): optional instruction rewrite. Blank-guarded in
        // requeueTask so an empty string never blanks a task's only instruction.
        const message = typeof args.message === 'string' && args.message.trim() ? args.message : undefined;

        // CANON-IDENTITY cross-process single-flight: the in-flight guard set
        // (daemon-core mesh-task-inflight) is process-LOCAL. In IpcTransport (cloud /
        // multi-coordinator) mode this tool runs in the COORDINATOR process, but the
        // dispatch that marks a task in-flight (tryAssignQueueTask → beginTaskDispatchInFlight)
        // runs in the mesh-host DAEMON process. An in-process requeueTask here would consult a
        // DIFFERENT (empty) Set, so isTaskDispatchInFlight is always false, the guard is a
        // no-op, and a requeue-while-generating flips the row to pending → a SECOND session
        // claims the SAME task (the double-dispatch). Delegate the requeue to the daemon so
        // begin (dispatch) and check (requeue guard) are co-located in ONE process. The daemon
        // handler (requeue_mesh_queue_task) implements the same guard + the refused signal,
        // which we surface to the caller verbatim. LocalTransport (standalone) runs daemon and
        // coordinator in the same process, so its in-process path already sees the right Set.
        if (ctx.transport instanceof IpcTransport) {
            const raw = await ctx.transport.command('requeue_mesh_queue_task', {
                meshId: ctx.mesh.id,
                taskId,
                reason: args.reason,
                ...(targetNodeId ? { targetNodeId } : {}),
                ...(targetSessionId ? { targetSessionId } : {}),
                clearTargetNode,
                clearTargetSession,
                force,
                ...(message ? { message } : {}),
            });
            const result = unwrapCommandPayload(raw) || {};
            // Refused (in-flight / live-generating guard) or daemon error → surface verbatim
            // so the coordinator learns the requeue did NOT open a second dispatch.
            if (result.success === false) {
                return JSON.stringify(result, null, 2);
            }
            const task = result.task;
            if (!task) return JSON.stringify({ success: false, error: `Queue task '${taskId}' not found` });
            if (task.status === 'failed' && task.cancelReason?.startsWith('max_retries_exceeded')) {
                return JSON.stringify({
                    success: false,
                    code: 'max_retries_exceeded',
                    error: task.cancelReason,
                    task,
                    hint: 'Use force=true to bypass the retry cap for explicit operator recovery.',
                }, null, 2);
            }
            const triggerPreferredNodeId = targetNodeId || task.targetNodeId || undefined;
            ctx.transport.command('trigger_mesh_queue', {
                meshId: ctx.mesh.id,
                ...(triggerPreferredNodeId ? { preferredNodeId: triggerPreferredNodeId } : {}),
            }).catch(() => {});
            return JSON.stringify({ success: true, task }, null, 2);
        }

        // C-W9a: the requeue runs in the daemon (`queue_requeue`).
        const task = (await queueRequeue(ctx.transport, {
            meshId: ctx.mesh.id,
            taskId,
            options: {
                ...(args.reason !== undefined ? { reason: args.reason } : {}),
                ...(targetNodeId !== undefined ? { targetNodeId } : {}),
                ...(targetSessionId !== undefined ? { targetSessionId } : {}),
                ...(clearTargetNode !== undefined ? { clearTargetNode } : {}),
                ...(clearTargetSession !== undefined ? { clearTargetSession } : {}),
                ...(force !== undefined ? { force } : {}),
                ...(message ? { message } : {}),
            },
        })).task as unknown as MeshWorkQueueEntry | null;
        if (!task) return JSON.stringify({ success: false, error: `Queue task '${taskId}' not found` });
        if (task.status === 'failed' && task.cancelReason?.startsWith('max_retries_exceeded')) {
            return JSON.stringify({
                success: false,
                code: 'max_retries_exceeded',
                error: task.cancelReason,
                task,
                hint: 'Use force=true to bypass the retry cap for explicit operator recovery.',
            }, null, 2);
        }
        // Pass the task's target node as preferredNodeId so the trigger claims the
        // requeued task on the intended node's idle session FIRST (router.ts
        // preferred-node tier) before the general round-robin picks a different node.
        // Honours an explicit requeue target_node_id over the persisted one.
        const triggerPreferredNodeId = targetNodeId || task.targetNodeId || undefined;
        ctx.transport.command('trigger_mesh_queue', {
            meshId: ctx.mesh.id,
            ...(triggerPreferredNodeId ? { preferredNodeId: triggerPreferredNodeId } : {}),
        }).catch(() => {});
        return JSON.stringify({ success: true, task }, null, 2);
    } catch (e: any) {
        return JSON.stringify({ success: false, error: e.message });
    }
}
