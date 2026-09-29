// Mesh tool implementations — MAGI (Multi-Agent Ground-truth Insight) domain.
//
// A standing mesh cross-verification quorum for any read-only investigation:
// fan the SAME question out to N independent (node × provider) replicas, then
// synthesize consensus / disagreement / unique evidence into a needs_verification
// list — NOT a majority vote (high agreement among coupled agents ≠ correct).
//
// Design: docs/design/2026-06-28-mesh-magi-review.md.
//
// The pure core (parseMagiResponse / synthesizeMagiResponses / buildMagiFanoutPlan)
// is unit-tested in mesh-tools-magi.test.ts; the handlers wire it to the mesh
// queue/mission/transport. Shared helpers and dependency re-exports live in
// ./mesh-tools-internal.ts; mesh-tools.ts is the barrel.

import {
    getMagiKindPanel,
    listMagiKindPanels,
    setMagiKindPanel,
    normalizeMagiSlots,
    collectIgnoredMagiSlotFields,
    randomUUID,
    readString,
    refreshMeshFromDaemon,
    triggerMeshQueueAndReport,
    readQueueFromDaemon,
} from './mesh-tools-internal.js';
// C-W9a: MAGI's records (fan-out, synthesis) and replica queue rows are the daemon's — over IPC.
// C-W9c: MAGI's mission reads/writes (upsert-on-start, close-on-collect) are the daemon's too —
// the same `mission_upsert`/`mission_query` mesh-tools-mission.ts's write path already uses.
import { missionUpsert, queueEnqueue, recordLocal } from '../ipc/turn-commands.js';
import type { MeshWorkQueueEntry } from '@adhdev/daemon-core';
import type {
    MagiMode,
    MagiTaskKind,
    MagiSlot,
    MeshContext,
} from './mesh-tools-internal.js';
/**
 * Default wall-clock budget for wait=true replica collection.
 *
 * MAGI-DEADLINE-MISLABEL: was 180_000 (3 min). A live 3-replica fan-out measured
 * kimi taking 16m09s (claim → completed) to produce a fully-evidenced answer — the
 * 180s deadline force-finalized it as `unparseable_output` 13 minutes before it
 * actually answered, which the coordinator then read as "kimi failed to produce
 * valid output" instead of "kimi hadn't answered yet". Raised to 480_000 (8 min) —
 * comfortably past typical replica latency without making every `wait:true` review
 * block the coordinator for a long time by default. Not differentiated per
 * task_kind (rca/design/freeform): the one measured overrun was an `rca` replica,
 * and a per-kind budget would need its own config surface for a single data point —
 * not worth the complexity. A review that may run long should prefer `wait:false` +
 * `mesh_magi_collect` (async collection, no coordinator block) over raising this
 * further; `wait_timeout_ms` can still override up to MAGI_MAX_WAIT_MS per call.
 */
export const MAGI_DEFAULT_WAIT_MS = 480_000;
/**
 * Hard ceiling on wait_timeout_ms (both the default above and any caller override).
 * Raised 600_000 (10 min) → 1_200_000 (20 min) alongside the default bump so a
 * caller that explicitly wants to block past the new default (e.g. to cover the
 * measured 16m09s kimi case synchronously) has headroom to do so; the async
 * wait:false + mesh_magi_collect path remains the recommended way to avoid
 * blocking the coordinator at all.
 */
export const MAGI_MAX_WAIT_MS = 1_200_000;

/**
 * Pure clamp applied to a caller-supplied wait_timeout_ms (mesh_magi_review /
 * mesh_magi_collect): falls back to MAGI_DEFAULT_WAIT_MS when absent/non-numeric/zero,
 * then bounds the result to [MAGI_POLL_INTERVAL_MS, MAGI_MAX_WAIT_MS]. Extracted so the
 * exact arithmetic both call sites share is independently unit-testable without waiting
 * out real (or mocked) minutes-long timers.
 */
export function resolveMagiWaitTimeoutMs(raw: unknown): number {
    return Math.min(MAGI_MAX_WAIT_MS, Math.max(MAGI_POLL_INTERVAL_MS, Number(raw) || MAGI_DEFAULT_WAIT_MS));
}

// ─── Task kinds (MAGI-REDESIGN) ─────────────────
//
// A `task_kind` selects ONE output schema that is injected into the replica prompt
// (no schema-on-schema conflict) and ONE strict parser used at collection. The
// kinds are: claim_audit (default, backward-compatible), rca, design, freeform.
// Every kind except freeform requires non-empty evidence[]; an empty-evidence
// answer is a validation failure that triggers the single delta re-request (E).
//
// To avoid rewriting the diversity-weighted synthesis (which is defined over the
// common-schema MagiAgentResponse — claims/top_findings/open_questions), each kind
// ADAPTS its typed payload into a MagiAgentResponse so clustering/independence still
// work, while the raw typed payload is preserved on the source for display.

// MagiTaskKind SSOT lives in the mesh-shared leaf, consumed here through daemon-core's
// re-export (mesh-tools-internal) — same indirection as the other Magi* types, so this
// module takes no direct @adhdev/mesh-shared dependency. Re-exported for existing
// callers that import MagiTaskKind from this module.
export type { MagiTaskKind } from './mesh-tools-internal.js';

// The MAGI pure core (task-kind normalization, response parsing/coercion, claim
// clustering, diversity-weighted synthesis, git-skew) was split out to
// mesh-tools-magi-core.ts (pure move — this file is a frozen file-size baseline
// entry). Public symbols are re-exported so the mesh-tools.ts barrel and existing
// importers/tests are unaffected; the handlers below import what they consume.
import {
    DEFAULT_TASK_KIND,
    normalizeMagiTaskKind,
    synthesizeMagiResponses,
    VALID_TASK_KINDS,
} from './mesh-tools-magi-core.js';
import { MAGI_MAX_REPLICAS, MAGI_MIN_TARGETS, buildMagiFanoutPlan, resolveMagiReferenceCommit, resolveMagiReferenceSubmoduleKey } from './mesh-magi-fanout.js';
import { findMagiReplicaTasks, resolveMagiAutoCleanupMode, cleanupMagiAutoLaunchedSessions, persistMagiDispatched, recoverMagiDispatchSettings, stripRawAnswers, persistMagiSynthesis, closeMagiMissionIfTerminal } from './mesh-magi-lifecycle.js';
import { collectMagiResponses } from './mesh-magi-collect.js';
import type { MagiFanoutPlan } from './mesh-magi-fanout.js';
import type { RepoMeshMagiSessionCleanupMode } from '@adhdev/daemon-core';
import { magiOutputContractFor } from './mesh-tools-magi-core.js';
import { MAGI_POLL_INTERVAL_MS } from './mesh-magi-collect.js';
export { magiOutputContractFor } from './mesh-tools-magi-core.js';
export { findMagiReplicaTasks, computeMagiCleanupTargets, resolveMagiAutoCleanupMode, cleanupMagiAutoLaunchedSessions, sessionSharedWithAnotherReplica, classifyStaleReplicas } from './mesh-magi-lifecycle.js';
export { MAGI_MAX_REPLICAS, buildMagiFanoutPlan } from './mesh-magi-fanout.js';
export type { MagiReplicaPlan, MagiUnavailableSlot, MagiUnhealthySlot, MagiSlotResolution, MagiFanoutPlan } from './mesh-magi-fanout.js';
export {
    normalizeMagiTaskKind,
    parseMagiResponse,
    parseMagiResponseForKind,
    parseFirstMagiCandidateForKind,
    collectMagiCandidateTexts,
    parseFirstMagiCandidate,
    parseFirstMagiCandidateWithCompactFallback,
    magiReadIndicatesApprovalWedge,
    synthesizeMagiResponses,
    computeMagiGitSkew,
} from './mesh-tools-magi-core.js';
export type {
    MagiRcaResponse,
    MagiDesignResponse,
    MagiFreeformResponse,
    MagiKindParseResult,
} from './mesh-tools-magi-core.js';

/**
 * Detect that the coordinator accidentally embedded an OUTPUT-FORMAT schema inside the
 * question text. MAGI injects exactly one output contract per kind (B); a second schema
 * in the question collides with it (the antigravity fusion symptom — the agent merges the
 * two and the result is unparseable). We do NOT strip or block it (the question may
 * legitimately quote a schema as the subject of investigation) — we SURFACE a warning so
 * the coordinator removes it. Pure.
 */
export function detectQuestionOutputSchemaConflict(question: string): string | null {
    const q = typeof question === 'string' ? question : '';
    if (!q.trim()) return null;
    const lower = q.toLowerCase();
    const signals = [
        'respond with only',
        'respond with a single json',
        'single json object',
        'output format',
        'output schema',
        'reply with only',
        '"claims"',
        '"top_findings"',
        'matching this exact schema',
    ];
    const hit = signals.find(s => lower.includes(s));
    if (!hit) return null;
    return `The question text appears to embed an output-format schema (matched "${hit}"). MAGI already injects exactly one output contract for the selected task_kind, so a second schema in the question collides with it and replicas may fuse the two into unparseable output. Move any output-format instructions OUT of the question — describe only WHAT to investigate.`;
}

export function buildMagiTaskPrompt(args: {
    question: string;
    target?: string;
    artifacts?: string[];
    mode?: MagiMode;
    taskKind?: MagiTaskKind;
}): string {
    const kind = args.taskKind ?? DEFAULT_TASK_KIND;
    const parts: string[] = [];
    parts.push('You are one independent member of a multi-agent cross-verification quorum (MAGI). Several other agents on different machines/providers are answering the SAME question independently; your job is a rigorous, READ-ONLY investigation. Do NOT write, edit, commit, or push anything.');
    parts.push(`Task kind: ${kind}.`);
    if (args.mode) parts.push(`Investigation mode: ${args.mode}.`);
    parts.push(`\n## Question\n${args.question.trim()}`);
    if (args.target && args.target.trim()) parts.push(`\n## Target to investigate\n${args.target.trim()}`);
    if (Array.isArray(args.artifacts) && args.artifacts.length > 0) {
        parts.push(`\n## Artifacts\n${args.artifacts.map(a => String(a)).join('\n\n---\n\n')}`);
    }
    parts.push(`\n## Output\n${magiOutputContractFor(kind)}`);
    return parts.join('\n');
}

// ─── Handlers ───────────────────────────────────

/**
 * The scope descriptor every kind-panel response carries. Panels are stored PER MESH
 * (machine-local `~/.adhdev/meshes.json` → `meshes[].magiKindPanels`), so a bare
 * `scope: 'machine_local'` string — what these handlers used to return — understated
 * it and read as one global binding per task_kind. Naming the resolved mesh makes the
 * scope unambiguous at the call site.
 */
function magiPanelScope(meshId: string, meshName?: string) {
    return {
        kind: 'mesh' as const,
        storage: 'machine_local' as const,
        meshId,
        ...(meshName ? { meshName } : {}),
        note: 'Kind-panels are per mesh, stored machine-locally (not repo-committed). Another mesh on this machine has its own independent bindings.',
    };
}

/**
 * Set the MAGI kind→panel slot binding for one task_kind, scoped to THIS coordinator's
 * mesh (machine-local `~/.adhdev/meshes.json` → `meshes[].magiKindPanels`). MCP surface
 * for the daemon `magi_kind_panel_set` command.
 *
 * IMPORTANT — kind-slot write is a WHOLESALE REPLACEMENT of the slot list for that
 * kind (a task_kind has exactly one binding per mesh; setMagiKindPanel always
 * overwrites). So this is NOT an additive upsert — the passed `slots` become the
 * complete new set and any prior slots for the kind are dropped. It therefore requires
 * explicit user approval before a write (present the current-vs-new slot lists first).
 * Mirrors the mesh_magi_panel_set write/dry-run precedent: defaults to dry-run
 * (write=false). A slot's optional `nodeId` must name a node of this mesh — a foreign
 * node id is rejected rather than silently stored.
 */
export async function meshMagiKindPanelSet(
    ctx: MeshContext,
    args: { task_kind?: string; slots?: unknown; write?: boolean },
): Promise<string> {
    // D2#2: there used to be a `|| readString(args.kind)` fallback here. It was dead —
    // validate-tool-args rejects any key the schema does not declare, and the schema
    // declares only `task_kind`, so a {kind} call never reached this line. Removed
    // rather than declared: the repo's alias convention is camelCase↔snake_case pairs
    // of the same word (task_mode/taskMode, gate_id/gateId), and `kind` is a different,
    // shorter word that also collides with the `kind` field magiPanelScope() returns.
    const kind = readString(args.task_kind);
    if (!kind) return JSON.stringify({ success: false, error: 'task_kind required' });
    const write = args.write === true;
    const meshId = ctx.mesh.id;
    const scope = magiPanelScope(meshId, ctx.mesh.name);
    try {
        // The current binding for this kind, so the coordinator can diff current-vs-new
        // before an overwrite (the write drops any slot not in the new list).
        const current: MagiSlot[] = getMagiKindPanel(kind, meshId) ?? [];
        // A MagiSlot is a deliberately reduced schema (provider + optional model/nodeId/
        // capabilityTags/n) — the normalizer drops everything else silently, which is
        // right for read-back but used to make a `thinkingLevel` on a write a no-op with
        // no signal. Surface the drops on BOTH branches: a dry-run that hid them would
        // let the operator approve a payload whose ignored keys only show up after the
        // write. Never fatal — the slots still normalize and persist exactly as before.
        const ignoredFields = collectIgnoredMagiSlotFields(args.slots);
        const ignoredNote = ignoredFields.length
            ? { ignoredFields, ignoredFieldsNote: 'These keys are not part of the MAGI slot schema and were DROPPED (the panel was still saved without them). A MAGI panel decides WHO answers independently; per-slot routing axes like thinkingLevel/difficulty/maxParallel belong on the node capability slots (mesh_node_slots action "set").' }
            : {};
        if (!write) {
            // Dry-run: normalize + validate WITHOUT persisting (same normalizer AND the
            // same mesh node list as the persisted write path, so a preview that passes
            // cannot fail at write time on an unknown nodeId).
            const preview = normalizeMagiSlots(args.slots, ctx.mesh.nodes.map(n => n.id));
            return JSON.stringify({
                success: true,
                dryRun: true,
                taskKind: kind,
                scope,
                replacement: true,
                currentSlots: current,
                slots: preview,
                ...ignoredNote,
                note: `Dry-run only — no file written. This is a WHOLESALE replacement of the kind's slot list for mesh '${meshId}' (machine-local ~/.adhdev/meshes.json); the currentSlots would be fully replaced. Other meshes on this machine are unaffected. Re-run with write=true after explicit user approval.`,
            }, null, 2);
        }
        const slots = setMagiKindPanel(kind, args.slots, meshId);
        return JSON.stringify({
            success: true,
            written: true,
            taskKind: kind,
            scope,
            replacement: true,
            previousSlots: current,
            slots,
            ...ignoredNote,
            nextAction: 'Verify with mesh_magi_kind_panel (action "list"), then mesh_magi_review({ task_kind }) resolves this binding.',
        }, null, 2);
    } catch (e: any) {
        const message = e?.message || String(e);
        const code = message.includes('invalid_magi_kind_panel') ? 'invalid_magi_kind_panel' : undefined;
        return JSON.stringify({ success: false, ...(code ? { code } : {}), scope, error: message });
    }
}

/**
 * List the kind→panel slot bindings configured for THIS coordinator's mesh. Read-only.
 * Use to confirm what a `task_kind` resolves to before mesh_magi_review, and to diff
 * before an overwrite. The response names the mesh the bindings belong to — panels are
 * per mesh, so "configured" is only ever meaningful relative to one.
 */
export async function meshMagiKindPanelList(
    ctx: MeshContext,
    args: { task_kind?: string } = {},
): Promise<string> {
    // D2#2: dead `|| readString(args.kind)` fallback removed — see meshMagiKindPanelSet.
    const only = readString(args.task_kind);
    const meshId = ctx.mesh.id;
    const scope = magiPanelScope(meshId, ctx.mesh.name);
    const all = listMagiKindPanels(meshId);
    if (only) {
        const slots = getMagiKindPanel(only, meshId);
        if (slots === undefined) {
            return JSON.stringify({
                success: false,
                code: 'magi_kind_not_configured',
                error: `task_kind '${only}' has no configured kind-panel binding in mesh '${meshId}'`,
                scope,
                configuredKinds: Object.keys(all),
            }, null, 2);
        }
        return JSON.stringify({ success: true, scope, taskKind: only, slots }, null, 2);
    }
    return JSON.stringify({ success: true, scope, kindPanels: all, configuredKinds: Object.keys(all) }, null, 2);
}


// MAGI-KIND-PANEL: the panel a mesh_magi_review fans out to is resolved SOLELY from the
// user's explicitly configured kind-panel binding (magiKindPanels: task_kind → slots).
// The former named-panel / inline-members / preset-auto-synthesis paths were REMOVED —
// an unconfigured task_kind is a hard error (magi_kind_not_configured). See the panel
// resolution block in meshMagiReview.

/** freeform contributes no structured claims, so cross-verification is weak — banner it. */
const MAGI_FREEFORM_BANNER = 'task_kind=freeform: answers are unstructured natural language; cross-verification is WEAK (no claim clustering / independence scoring). Treat the collected answers as parallel opinions, not a verified consensus.';

/**
 * Resolve the review panel SOLELY from the user's configured kind→slots binding
 * (magiKindPanels). There is NO named-panel, inline-members, or preset
 * auto-synthesis path — an unconfigured kind is a hard error so the user must
 * explicitly bind (machine + provider + model) slots in mesh settings. Returns the
 * JSON refusal as a string.
 */
function resolveMagiReviewPanel(ctx: MeshContext, explicitTaskKind: string): {
    taskKind: MagiTaskKind; panelName: string; planSlots: MagiSlot[]; danglingSlots: MagiSlot[];
} | string {
    const taskKind = normalizeMagiTaskKind(explicitTaskKind);
    const panelName = `(kind:${taskKind})`;
    // Panels are per mesh — resolve against THIS coordinator's mesh so a binding never
    // leaks in from another mesh on the same machine (whose slots name its own nodes).
    const slots = getMagiKindPanel(taskKind, ctx.mesh.id);
    if (!slots || slots.length === 0) {
        return JSON.stringify({
            success: false,
            code: 'magi_kind_not_configured',
            error: `No panel slots are configured for this task_kind in mesh '${ctx.mesh.id}' settings. Add at least one (machine + provider + model) slot in settings — task_kind '${taskKind}' has no configured kind-panel.`,
            taskKind,
            meshId: ctx.mesh.id,
            configuredKinds: Object.keys(listMagiKindPanels(ctx.mesh.id)),
            hint: 'Configure this kind in mesh settings (MagiKindPanelEditor), or set it with mesh_magi_kind_panel (action "set"), then retry.',
        }, null, 2);
    }
    // Slots are already normalized at write time (setMagiKindPanel → normalizeMagiSlots),
    // but re-normalize here so a bad stored slot surfaces a clear error before dispatch.
    // Deliberately WITHOUT the mesh node list: a slot whose node has since left the mesh
    // must not hard-fail the whole review — it is skipped below with a reason instead.
    let planSlots: MagiSlot[];
    try {
        planSlots = normalizeMagiSlots(slots);
    } catch (e: any) {
        return JSON.stringify({
            success: false,
            code: 'invalid_magi_kind_panel',
            error: `configured kind-panel for '${taskKind}' is invalid: ${e?.message || String(e)}`,
            taskKind,
            meshId: ctx.mesh.id,
            hint: 'Re-save the kind-panel slots in mesh settings — each slot needs a provider; nodeId / model are optional.',
        }, null, 2);
    }
    // Drop slots pinned to a node this mesh no longer has (removed between the write
    // and now, or carried over from a legacy global binding written by another mesh).
    // Skipped WITH a reason rather than dispatched — a dangling pin would otherwise
    // park a replica in 'pending' forever. The ≥2-target floor is enforced AFTER
    // this exclusion, so the panel still never silently degrades to N=1.
    const meshNodeIds = new Set(ctx.mesh.nodes.map(n => n.id));
    const danglingSlots = planSlots.filter(s => s.nodeId && !meshNodeIds.has(s.nodeId));
    if (danglingSlots.length) {
        planSlots = planSlots.filter(s => !s.nodeId || meshNodeIds.has(s.nodeId));
        if (planSlots.length === 0) {
            return JSON.stringify({
                success: false,
                code: 'magi_kind_panel_all_slots_dangling',
                error: `Every slot in kind-panel '${panelName}' is pinned to a node that is not in mesh '${ctx.mesh.id}' (${danglingSlots.map(s => s.nodeId).join(', ')}).`,
                taskKind,
                meshId: ctx.mesh.id,
                danglingSlots,
                hint: 'Re-bind this kind to nodes of THIS mesh with mesh_magi_kind_panel action "set" (or in mesh settings). Check mesh_status for the current node list.',
            }, null, 2);
        }
    }
    return { taskKind, panelName, planSlots, danglingSlots };
}

/**
 * The plan resolved to fewer than MAGI_MIN_TARGETS independent targets. Health
 * exclusion is the PRIMARY cause: a degraded/offline node was excluded up front
 * (it would have parked in `pending` forever). Surfaced as a distinct code so the
 * coordinator knows the panel is under-quorum because a node is unhealthy — NOT
 * because the panel is mis-configured — and never silently degrades to N=1.
 */
function buildMagiInsufficientTargetsFailure(plan: MagiFanoutPlan, panelName: string, referenceCommit: string | undefined, danglingSlots: MagiSlot[]): string {
    const droppedByStale = plan.staleSlots.length > 0;
    const droppedByHealth = plan.unhealthySlots.length > 0;
    const code = droppedByHealth
        ? 'magi_insufficient_targets_after_health_exclusion'
        : droppedByStale
            ? 'magi_insufficient_targets_after_stale_exclusion'
            : 'magi_insufficient_targets';
    const error = droppedByHealth
        ? `Kind-panel '${panelName}' resolves to only ${plan.distinctTargets} independent (node, provider) target(s) AFTER excluding ${plan.unhealthySlots.length} unhealthy slot(s) (${plan.unhealthySlots.map(s => `${s.nodeId ?? `[${s.provider}]`}=${s.health}`).join(', ')}); MAGI requires ≥${MAGI_MIN_TARGETS} and never silently degrades to N=1. A degraded node would leave its replica parked in 'pending' forever, so it is excluded rather than dispatched.`
        : droppedByStale
            ? `Kind-panel '${panelName}' resolves to only ${plan.distinctTargets} independent (node, provider) target(s) AFTER excluding ${plan.staleSlots.length} git-stale slot(s) (HEAD differs from reference ${referenceCommit ?? '(unknown)'}); MAGI requires ≥${MAGI_MIN_TARGETS} and never silently degrades to N=1.`
            : `Kind-panel '${panelName}' resolves to ${plan.distinctTargets} available (node, provider) target(s); MAGI requires ≥${MAGI_MIN_TARGETS} and never silently degrades to N=1.`;
    const hint = droppedByHealth
        ? 'Bring the degraded node(s) back online (check P2P/git health via mesh_status), or configure additional healthy (machine + provider) slots for this kind-panel, then retry.'
        : droppedByStale
            ? 'Bring the stale node(s) to the reference commit, or pass include_stale=true to mesh_magi_review to fan out to them anyway (results will be git-skewed).'
            : 'Fix the kind-panel slots with mesh_magi_kind_panel action "set" (or in mesh settings), and use mesh_status to confirm nodes/providers are online.';
    return JSON.stringify({
        success: false,
        code,
        error,
        ...(referenceCommit ? { referenceCommit } : {}),
        unavailableSlots: plan.unavailableSlots,
        ...(droppedByHealth ? { unhealthySlots: plan.unhealthySlots } : {}),
        ...(droppedByStale ? { staleSlots: plan.staleSlots } : {}),
        // Surface slots dropped for naming a node outside this mesh, so an
        // under-quorum panel caused by a stale pin is diagnosable rather than
        // looking like a mis-sized panel.
        ...(danglingSlots.length ? { danglingSlots } : {}),
        hint,
    }, null, 2);
}

type MagiReplicaRecord = { taskId: string; provider: string; targetNodeId?: string; requiredTags: string[] };

/**
 * Enqueue one read-only task per replica, all sharing the consensus group id. A
 * single replica enqueue failure must not abort the quorum — it is recorded and
 * the rest continue.
 */
async function enqueueMagiReplicas(
    ctx: MeshContext,
    plan: MagiFanoutPlan,
    p: { prompt: string; missionId: string; consensusGroupId: string },
): Promise<MagiReplicaRecord[]> {
    const { consensusGroupId } = p;
    const replicaRecords: MagiReplicaRecord[] = [];
    for (const replica of plan.replicas) {
        try {
            // C-W9a: the replica enqueue runs in the daemon (`queue_enqueue`).
            const replicaOptions = {
                readonly: true,
                taskMode: 'live_debug_readonly',
                // DIFFICULTY-REQUIRED (MAGI decision): a fixed 'freeform' sentinel, NOT an
                // exemption from the guard. MAGI routes on a different axis entirely — each
                // replica is already hard-pinned to a (node, provider) slot by the kind-panel
                // via requiredTags (`provider=<X>`) and often an explicit targetNodeId, and
                // its model comes from that slot. Difficulty exists to MATCH a task against
                // node capability slots at assignment time; here the slot is already chosen,
                // so any difficulty we stamped would be inert at best and would fight the
                // panel's own slot selection at worst.
                //
                // 'freeform' is the correct sentinel rather than a guard bypass: it is a real
                // member of the axis meaning "no difficulty-based constraint", so the fan-out
                // satisfies the required-difficulty invariant honestly instead of carving out
                // a hole that a future non-MAGI caller could slip through. Deliberately NOT
                // caller-configurable — exposing a difficulty knob on mesh_magi_review would
                // imply it influences replica placement, which it does not.
                difficulty: 'freeform',
                requiredTags: replica.requiredTags,
                missionId: p.missionId,
                consensusGroupId,
                ...(replica.targetNodeId ? { targetNodeId: replica.targetNodeId } : {}),
                ...(replica.model ? { model: replica.model } : {}),
                ...(ctx.coordinatorSessionId ? { sourceCoordinatorSessionId: ctx.coordinatorSessionId } : {}),
            };
            const task = (await queueEnqueue(ctx.transport, { meshId: ctx.mesh.id, message: p.prompt, options: replicaOptions })).entry as unknown as MeshWorkQueueEntry;
            replicaRecords.push({ taskId: task.id, provider: replica.provider, targetNodeId: replica.targetNodeId, requiredTags: replica.requiredTags });
        } catch (e: any) {
            try {
                await recordLocal(ctx.transport, { meshId: ctx.mesh.id,
                    kind: 'magi_replica_enqueue_failed' as any,
                    payload: { consensusGroupId, missionId: p.missionId, provider: replica.provider, error: e?.message || String(e) },
                });
            } catch { /* ledger write is best-effort */ }
        }
    }
    return replicaRecords;
}

/** The dispatch half of a mesh_magi_review response (shared by wait / no-wait). */
function buildMagiReviewDispatchResult(p: {
    consensusGroupId: string; missionId: string; panelName: string; taskKind: MagiTaskKind; question: string;
    questionSchemaWarning: unknown; replicaRecords: MagiReplicaRecord[]; plan: MagiFanoutPlan; queueTrigger: unknown;
}) {
    const { plan, replicaRecords } = p;
    return {
        success: true,
        consensusGroupId: p.consensusGroupId,
        missionId: p.missionId,
        panel: p.panelName,
        taskKind: p.taskKind,
        ...(p.questionSchemaWarning ? { questionSchemaWarning: p.questionSchemaWarning } : {}),
        question: p.question,
        replicaCount: replicaRecords.length,
        replicas: replicaRecords.map(r => ({ taskId: r.taskId, provider: r.provider, targetNodeId: r.targetNodeId })),
        independence: {
            distinctProviders: plan.distinctProviders,
            distinctMachines: plan.distinctNodeTargets,
            coupled: plan.coupled,
            ...(plan.coupled ? { banner: 'Panel collapsed to a single provider or machine — agreements will be flagged source-coupled.' } : {}),
        },
        ...(plan.referenceCommit ? { referenceCommit: plan.referenceCommit } : {}),
        // Surface health-gate exclusions even when quorum still held: these replicas were
        // NEVER dispatched (their node is degraded/offline and would park in `pending`
        // forever), so the coordinator/collect must know not to wait on them.
        ...(plan.unhealthySlots.length > 0 ? {
            excludedSlots: plan.unhealthySlots,
            healthExcludedWarning: `${plan.unhealthySlots.length} slot(s) were excluded from this fan-out because their node health is not launch-ready (${plan.unhealthySlots.map(s => `${s.nodeId ?? `[${s.provider}]`}=${s.health}`).join(', ')}) — those replicas were NOT dispatched. Bring the node(s) online (mesh_status) to include them.`,
        } : {}),
        // Surface git-stale handling: which slots were excluded (default), or included
        // despite being stale (include_stale=true) — the latter makes results git-skewed.
        ...(plan.staleSlots.length > 0 ? {
            gitStaleExcluded: plan.staleSlots,
            gitStaleWarning: `${plan.staleSlots.length} git-stale slot(s) (HEAD ≠ reference ${plan.referenceCommit ?? '(unknown)'}) were excluded from this fan-out; pass include_stale=true to include them.`,
        } : {}),
        ...(plan.includedStaleSlots.length > 0 ? {
            gitStaleIncluded: plan.includedStaleSlots,
            gitStaleWarning: `include_stale=true: ${plan.includedStaleSlots.length} git-stale slot(s) (HEAD ≠ reference ${plan.referenceCommit ?? '(unknown)'}) were INCLUDED — their evidence compares different code, so synthesis will be git-skewed.`,
        } : {}),
        ...(plan.droppedReplicas > 0 ? {
            cappedReplicas: plan.droppedReplicas,
            cappedNote: `Total replicas requested (${plan.totalRequested}) exceeded the guard cap (${MAGI_MAX_REPLICAS}); ${plan.droppedReplicas} dropped (logged, not silent).`,
        } : {}),
        costNote: `MAGI dispatched ${replicaRecords.length} read-only sessions — token spend scales with the replica count.`,
        queueTrigger: p.queueTrigger,
    };
}

/**
 * Collect one consensus group's replicas (bounded), synthesize, persist the
 * synthesis (retrievable by consensusGroupId; folds into mesh_status), auto-close
 * the group's inline mission once every replica is terminal (FIX#3 — the replica
 * tasks' OWN missionId), and run the post-collection auto-cleanup, gated terminal
 * so a partial snapshot never kills still-generating replicas. Shared by
 * mesh_magi_review (wait=true) and mesh_magi_collect.
 */
async function collectAndSynthesizeMagiGroup(ctx: MeshContext, p: {
    consensusGroupId: string;
    missionId: string | undefined;
    panel?: string;
    question?: string;
    replicaTaskIds: string[];
    timeoutMs: number;
    taskKind: MagiTaskKind;
    requireIndependentEvidence: boolean;
    cleanupMode: RepoMeshMagiSessionCleanupMode;
    /** The replica tasks the cleanup reads their final session ids from. */
    replicaTasksForCleanup: () => Promise<any[]>;
}) {
    const collected = await collectMagiResponses(ctx, { replicaTaskIds: p.replicaTaskIds, timeoutMs: p.timeoutMs, taskKind: p.taskKind });
    const synthesis = synthesizeMagiResponses(collected.responses, {
        replicasExpected: p.replicaTaskIds.length,
        requireIndependentEvidence: p.requireIndependentEvidence,
    });
    // rawAnswer gate: always strip from the persisted ledger entry (bounds payload).
    const synthesisNoRaw = stripRawAnswers(synthesis);
    await persistMagiSynthesis(ctx, {
        consensusGroupId: p.consensusGroupId,
        missionId: p.missionId,
        ...(p.panel ? { panel: p.panel } : {}),
        ...(p.question ? { question: p.question } : {}),
        staleReplicas: collected.staleCount,
        synthesis: synthesisNoRaw,
    });
    await closeMagiMissionIfTerminal(ctx, p.missionId, collected.terminal);
    const cleanup = await cleanupMagiAutoLaunchedSessions(ctx, {
        replicaTasks: await p.replicaTasksForCleanup(),
        terminal: collected.terminal,
        mode: p.cleanupMode,
    });
    return {
        collected,
        synthesis,
        synthesisNoRaw,
        sessionCleanup: cleanup ? { sessionCleanup: { mode: p.cleanupMode, cleanedSessionCount: cleanup.cleanedSessionCount, perNode: cleanup.perNode } } : {},
    };
}

export async function meshMagiReview(
    ctx: MeshContext,
    args: {
        question?: string;
        target?: string;
        artifacts?: string[];
        n?: number;
        mode?: string;
        require_independent_evidence?: boolean;
        requireIndependentEvidence?: boolean;
        include_stale?: boolean;
        includeStale?: boolean;
        wait?: boolean;
        wait_timeout_ms?: number;
        waitTimeoutMs?: number;
        task_kind?: string;
        taskKind?: string;
        auto_cleanup?: boolean;
        autoCleanup?: boolean;
    },
): Promise<string> {
    const question = readString(args.question);
    if (!question) return JSON.stringify({ success: false, error: 'question required' });

    // task_kind is REQUIRED — it is BOTH the output-schema selector AND the sole panel
    // resolution key (magiKindPanels: task_kind → slots). There is no named-panel /
    // inline-members / preset fallback, so an omitted or unrecognized task_kind is a hard
    // error rather than a normalize-to-default.
    const explicitTaskKind = args.task_kind ?? args.taskKind;
    if (typeof explicitTaskKind !== 'string' || !(VALID_TASK_KINDS as readonly string[]).includes(explicitTaskKind.trim().toLowerCase())) {
        return JSON.stringify({
            success: false,
            code: 'task_kind_required',
            error: 'task_kind is required and selects both the output schema and the configured kind-panel slots. Pass one of: claim_audit / rca / design / freeform.',
            validTaskKinds: VALID_TASK_KINDS,
            hint: 'Configure the kind-panel slots for this task_kind in mesh settings (magiKindPanels) or via mesh_magi_kind_panel (action "set"), then call mesh_magi_review({ question, task_kind }).',
        }, null, 2);
    }
    // B: warn (do NOT block) if the coordinator embedded an output schema in the question —
    // it collides with the single kind contract MAGI injects and causes fusion/unparseable.
    const questionSchemaWarning = detectQuestionOutputSchemaConflict(question);

    await refreshMeshFromDaemon(ctx);

    // Reference commit (coordinator HEAD) is read here, immediately after the mesh
    // refresh, so slot resolution pins fresh live nodes against the SAME baseline
    // buildMagiFanoutPlan uses for git-staleness. read-only — safe to hoist.
    const referenceCommit = resolveMagiReferenceCommit(ctx);
    // Extend the base fingerprint with the coordinator's submodule gitlinks so two nodes
    // on the SAME root HEAD but a different oss/adhdev-providers pointer are not treated
    // as the same base (that submodule carries the actual fix code). Undefined when the
    // coordinator has no submodule telemetry → root-HEAD-only comparison.
    const referenceSubmoduleKey = resolveMagiReferenceSubmoduleKey(ctx);

    // 1. The panel, from the configured kind→slots binding only.
    const panel = resolveMagiReviewPanel(ctx, explicitTaskKind);
    if (typeof panel === 'string') return panel;
    const { taskKind, panelName, planSlots, danglingSlots } = panel;

    // 2. Plan the fan-out. Git-stale slots (node HEAD differs from the coordinator's
    // reference commit) are EXCLUDED by default — they would investigate different code;
    // include_stale=true keeps them (with a warning). The ≥2-target guard is re-checked
    // AFTER this exclusion, so it never silently degrades to N=1.
    const includeStale = (args.include_stale ?? args.includeStale) === true;
    const plan = buildMagiFanoutPlan(planSlots, ctx.mesh.nodes, { n: args.n, referenceCommit, referenceSubmoduleKey, includeStale });
    if (!plan.enoughTargets) return buildMagiInsufficientTargetsFailure(plan, panelName, referenceCommit, danglingSlots);

    const mode = readString(args.mode) as MagiMode | '';
    const requireIndependentEvidence = (args.require_independent_evidence ?? args.requireIndependentEvidence) !== false;
    const autoCleanupArg = typeof (args.auto_cleanup ?? args.autoCleanup) === 'boolean' ? (args.auto_cleanup ?? args.autoCleanup) as boolean : undefined;
    const wait = args.wait !== false;
    const waitTimeoutMs = resolveMagiWaitTimeoutMs(args.wait_timeout_ms ?? args.waitTimeoutMs);

    // 3. Mission container + shared consensus group id.
    const consensusGroupId = `magi_${randomUUID().replace(/-/g, '')}`;
    const titleQ = question.length > 80 ? `${question.slice(0, 77)}...` : question;
    // C-W9c: the `mission_upsert` IPC round trip mesh-tools-mission.ts's write path uses.
    const { mission } = await missionUpsert(ctx.transport, {
        meshId: ctx.mesh.id,
        title: `MAGI: ${titleQ}`,
        goal: `Cross-verify (read-only) across panel '${panelName}': ${question}${args.target ? `\nTarget: ${args.target}` : ''}`,
        // Tag provenance so the completed inline mission is bounded out of the default
        // mesh_mission_list (these accumulate one-per-run and auto-close on collection).
        source: 'magi',
    });

    // 4. Enqueue one read-only task per replica, all sharing the consensus group id.
    const prompt = buildMagiTaskPrompt({ question, target: args.target, artifacts: args.artifacts, mode: (mode || undefined) as MagiMode | undefined, taskKind });
    const replicaRecords = await enqueueMagiReplicas(ctx, plan, { prompt, missionId: mission.id, consensusGroupId });
    if (replicaRecords.length < MAGI_MIN_TARGETS) {
        return JSON.stringify({ success: false, code: 'magi_enqueue_failed', error: 'fewer than 2 replicas enqueued successfully', consensusGroupId, missionId: mission.id });
    }

    // deltaE: persist the fan-out so the group is visible in mesh_status (running) and
    // survives a coordinator restart even before any synthesis is collected.
    await persistMagiDispatched(ctx, {
        consensusGroupId,
        missionId: mission.id,
        panel: panelName,
        question,
        replicaCount: replicaRecords.length,
        taskKind,
        // wait:false → mesh_magi_collect runs the synthesis + cleanup later, in another
        // call that only has the group id: persist the caller's choices so collect honours
        // them (an auto_cleanup:false review must never have its sessions deleted by a
        // collect that fell back to the policy default).
        ...(typeof autoCleanupArg === 'boolean' ? { autoCleanup: autoCleanupArg } : {}),
        requireIndependentEvidence,
    });

    // 5. Trigger queue pickup. This is the SOLE dispatch path for every replica,
    // local AND remote: triggerMeshQueue (on the coordinator's local IPC) drains each
    // pending replica task — including ones pinned to a remote node — to its target (a
    // remote idle session is claimed and send_chat'd over P2P; a pinned remote target
    // with no idle session is auto-launched, then claims on ready). Every replica is
    // dispatched exactly once via the queue.
    const queueTrigger = await triggerMeshQueueAndReport(ctx);

    const baseResult = buildMagiReviewDispatchResult({
        consensusGroupId, missionId: mission.id, panelName, taskKind, question, questionSchemaWarning, replicaRecords, plan, queueTrigger,
    });

    if (!wait) {
        return JSON.stringify({
            ...baseResult,
            waited: false,
            // The dispatch record carries auto_cleanup / require_independent_evidence, so
            // collect honours them without being told again; echoed here for visibility.
            pollWith: {
                tool: 'mesh_magi_collect',
                args: {
                    consensus_group_id: consensusGroupId,
                    ...(autoCleanupArg !== undefined ? { auto_cleanup: autoCleanupArg } : {}),
                    ...(requireIndependentEvidence === false ? { require_independent_evidence: false } : {}),
                },
            },
            nextAction: `Replicas are running. Drive off mission completion / pendingCoordinatorEvents rather than polling chat, then collect + synthesize once with mesh_magi_collect({ consensus_group_id: '${consensusGroupId}' }).`,
        }, null, 2);
    }

    // 6. Collect by consensus group id (bounded), then synthesize. mesh_magi_review has
    // no rawAnswer contract — only the stripped synthesis is returned (rawAnswer is
    // surfaced only via mesh_magi_collect verbose). The post-review auto-cleanup
    // (default ON) re-reads the replica tasks from the live queue so it sees their final
    // assignedSessionId / autoLaunch.sessionId.
    const { collected, synthesis, synthesisNoRaw, sessionCleanup } = await collectAndSynthesizeMagiGroup(ctx, {
        consensusGroupId,
        missionId: mission.id,
        panel: panelName,
        question,
        replicaTaskIds: replicaRecords.map(r => r.taskId),
        timeoutMs: waitTimeoutMs,
        taskKind,
        requireIndependentEvidence,
        cleanupMode: resolveMagiAutoCleanupMode(ctx, autoCleanupArg),
        replicaTasksForCleanup: async () => findMagiReplicaTasks(await readQueueFromDaemon(ctx), consensusGroupId),
    });

    return JSON.stringify({
        ...baseResult,
        waited: true,
        ...sessionCleanup,
        collection: {
            terminal: collected.terminal,
            timedOut: collected.timedOut,
            answered: synthesis.replicasAnswered,
            missing: synthesis.replicasMissing,
            staleReplicas: collected.staleCount,
            ...(collected.staleCount > 0 ? { staleNote: `${collected.staleCount} replica(s) were detected STALE — assigned to a node/session no longer present in the live mesh; collection stopped early rather than waiting out the timeout.` } : {}),
            ...(collected.retriedCount > 0 ? { retriedReplicas: collected.retriedCount, retryNote: `${collected.retriedCount} replica(s) failed the ${taskKind} schema and were sent one delta re-request for a corrected single-JSON answer.` } : {}),
            ...(synthesis.replicasMissing > 0 ? { missingNote: `Partial synthesis — ${synthesis.replicasMissing} of ${replicaRecords.length} replicas did not return a parseable response (timed out / failed / unparseable / schema-invalid / stale).` } : {}),
        },
        ...(taskKind === 'freeform' ? { freeformBanner: MAGI_FREEFORM_BANNER } : {}),
        synthesis: synthesisNoRaw,
    }, null, 2);
}

/**
 * Poll-by-group collection (featureC). Re-collect + synthesize a previously
 * dispatched MAGI fan-out by its consensus group id — the async companion to a
 * wait=false mesh_magi_review. Rediscovers the replica tasks from the queue, then
 * reuses the SAME collection + synthesis path as the wait=true review. Tolerates
 * partial/stale replicas: when wait=false it snapshots whatever is terminal right now.
 */
export async function meshMagiCollect(
    ctx: MeshContext,
    args: {
        consensus_group_id?: string;
        consensusGroupId?: string;
        require_independent_evidence?: boolean;
        requireIndependentEvidence?: boolean;
        wait?: boolean;
        wait_timeout_ms?: number;
        waitTimeoutMs?: number;
        task_kind?: string;
        taskKind?: string;
        auto_cleanup?: boolean;
        autoCleanup?: boolean;
        verbose?: boolean;
    },
): Promise<string> {
    const consensusGroupId = readString(args.consensus_group_id) || readString(args.consensusGroupId);
    if (!consensusGroupId) return JSON.stringify({ success: false, error: 'consensus_group_id required' });

    await refreshMeshFromDaemon(ctx);

    // MAGI-REDESIGN: recover the kind this group was dispatched with from the ledger so the
    // right schema parser is used (collect rediscovers replicas from the queue, not the call).
    // An explicit task_kind arg overrides (escape hatch if the dispatched ledger was pruned).
    const explicitKind = args.task_kind ?? args.taskKind;
    const dispatchSettings = await recoverMagiDispatchSettings(ctx, consensusGroupId);
    const taskKind = explicitKind !== undefined
        ? normalizeMagiTaskKind(explicitKind)
        : dispatchSettings.taskKind;

    const replicaTasks = findMagiReplicaTasks(await readQueueFromDaemon(ctx), consensusGroupId);
    if (replicaTasks.length === 0) {
        return JSON.stringify({
            success: false,
            code: 'magi_group_not_found',
            error: `No MAGI replicas found for consensus group '${consensusGroupId}'. It may have been pruned, or the id is wrong.`,
            consensusGroupId,
        });
    }

    const requireIndependentEvidenceArg = args.require_independent_evidence ?? args.requireIndependentEvidence;
    // Explicit collect args override; otherwise the settings the review was dispatched with.
    const requireIndependentEvidence = typeof requireIndependentEvidenceArg === 'boolean'
        ? requireIndependentEvidenceArg
        : dispatchSettings.requireIndependentEvidence ?? true;
    // Default to a SNAPSHOT (wait=false): poll-by-group is the async path, so the
    // common case is "collect whatever finished so far". Pass wait=true to block for
    // the remaining replicas up to wait_timeout_ms.
    const wait = args.wait === true;
    const timeoutMs = wait
        ? resolveMagiWaitTimeoutMs(args.wait_timeout_ms ?? args.waitTimeoutMs)
        : 0;
    const autoCleanupArg = args.auto_cleanup ?? args.autoCleanup;

    const replicaTaskIds = replicaTasks.map((t: any) => readString(t.id)).filter(Boolean) as string[];
    // Panel/question are merged from the earlier magi_dispatched entry by
    // consensusGroupId, so they need not be re-derived here. The inline mission id is
    // the replica tasks' OWN missionId (MAGI-owned).
    const { collected, synthesis, synthesisNoRaw, sessionCleanup } = await collectAndSynthesizeMagiGroup(ctx, {
        consensusGroupId,
        missionId: readString(replicaTasks[0]?.missionId),
        replicaTaskIds,
        timeoutMs,
        taskKind,
        requireIndependentEvidence,
        cleanupMode: resolveMagiAutoCleanupMode(ctx, typeof autoCleanupArg === 'boolean' ? autoCleanupArg : dispatchSettings.autoCleanup),
        replicaTasksForCleanup: async () => replicaTasks,
    });
    // The RETURNED synthesis carries rawAnswer only when verbose=true; default strips it.
    const verbose = args.verbose === true;

    return JSON.stringify({
        success: true,
        consensusGroupId,
        taskKind,
        replicaCount: replicaTaskIds.length,
        waited: wait,
        ...sessionCleanup,
        collection: {
            terminal: collected.terminal,
            timedOut: collected.timedOut,
            answered: synthesis.replicasAnswered,
            missing: synthesis.replicasMissing,
            staleReplicas: collected.staleCount,
            ...(collected.staleCount > 0 ? { staleNote: `${collected.staleCount} replica(s) were detected STALE — assigned to a node/session no longer present in the live mesh.` } : {}),
            ...(collected.retriedCount > 0 ? { retriedReplicas: collected.retriedCount, retryNote: `${collected.retriedCount} replica(s) failed the ${taskKind} schema and were sent one delta re-request for a corrected single-JSON answer.` } : {}),
            ...(!collected.terminal ? { pendingNote: 'Not all replicas are terminal yet — this is a partial snapshot. Re-collect once mission/pendingCoordinatorEvents report more completions.' } : {}),
        },
        ...(taskKind === 'freeform' ? { freeformBanner: MAGI_FREEFORM_BANNER } : {}),
        ...(verbose ? { rawAnswersIncluded: true } : {}),
        synthesis: verbose ? synthesis : synthesisNoRaw,
    }, null, 2);
}
