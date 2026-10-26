/**
 * Mesh assignment attach/detach (verbatim move out of CliProviderInstance —
 * M-FILE-SIZE-DEBT decomposition).
 *
 * Owns the session<->mesh binding written into `settings`: which mesh/node this
 * session serves, and which task (plus its dispatch nonce and attempt identity)
 * is currently in flight on it. The distinction this cluster exists to hold is
 * SESSION-level membership vs TASK-level markers — a coordinator-LAUNCHED
 * worker keeps its membership across task completions, while an ad-hoc session
 * adopted by a direct dispatch is fully unpinned on detach.
 *
 * State lives ON THE HOST (the provider instance) exactly as before. Provenance
 * kept inline: ANTIGRAVITY-PREMATURE-COMPLETION injection stamp, WTCLAIM (A)
 * sticky meshLastNodeId, REDRIVE-DUP nonce lifetime, TURN-LEDGER Stage 5
 * attempt identity, and MESHID-DROP-ON-DETACH (Fix C).
 */

import { LOG } from '../logging/logger.js';
import { isWorkerMcpEnabled } from '../runtime-defaults.js';
import { emitDispatchFailed, emitTurnStarted, type TurnEvidencePort } from './turn-evidence-port.js';
import {
mergePendingMeshTaskAttachment,
meshTaskAttachments,
popCompletedMeshTaskAttachment,
pushMeshTaskAttachment,
type MeshTaskAttachment,
} from './mesh-task-attachment.js';

/** The narrow surface of CliProviderInstance the mesh binding reads/writes. */
export interface MeshAssignmentHost {
instanceId: string;
settings: Record<string, any>;
meshTaskInjectedAt: number;
meshTaskAttachmentHistory: MeshTaskAttachment[];
adapter: { updateRuntimeSettings?: (settings: Record<string, any>) => void; updateRuntimeMeta?: (meta: Record<string, unknown>) => void };
/** Turn-in-flight markers (CliProviderInstance fields; absent on narrow test hosts ⇒ treated as in flight). */
generatingStartedAt?: number;
completedDebouncePending?: unknown;
generatingDebouncePending?: unknown;
}

export interface MeshAssignmentSnapshot {
    settings: Record<string, any>;
    injectedAt: number;
    history: MeshTaskAttachment[];
}
/** Task metadata is separate from launch-time mesh enrollment. */
export function nativeMeshAssignmentMeta(settings: Record<string, any>): Record<string, unknown> {
    const ref = currentMeshAttemptRef(settings);
    const assignment = ref && settings.meshNodeFor && settings.meshNodeId && settings.meshActiveTaskId && settings.meshCoordinatorDaemonId
        ? { meshId: settings.meshNodeFor, nodeId: settings.meshNodeId, taskId: settings.meshActiveTaskId,
            attemptId: ref.attemptId, generation: ref.generation, dispatchNonce: settings.meshActiveDispatchNonce ?? 0,
            ownerDaemonId: settings.meshCoordinatorDaemonId } : null;
    return { meshCoordinatorDaemonId: settings.meshCoordinatorDaemonId ?? null, [PERSISTED_ATTEMPT_REF_META_KEY]: ref, meshActiveAssignment: assignment };
}
export function captureMeshAssignment(host: MeshAssignmentHost): MeshAssignmentSnapshot {
    const settings = Object.fromEntries(Object.entries(host.settings ?? {}).filter(([key]) => key.startsWith('mesh')));
    return JSON.parse(JSON.stringify({ settings, injectedAt: host.meshTaskInjectedAt, history: host.meshTaskAttachmentHistory }));
}
export function restoreMeshAssignment(host: MeshAssignmentHost, snapshot: MeshAssignmentSnapshot): void {
    host.settings = { ...Object.fromEntries(Object.entries(host.settings ?? {}).filter(([key]) => !key.startsWith('mesh'))), ...snapshot.settings };
    host.meshTaskInjectedAt = snapshot.injectedAt;
    host.meshTaskAttachmentHistory = snapshot.history;
    host.adapter.updateRuntimeSettings?.(host.settings);
    host.adapter.updateRuntimeMeta?.(nativeMeshAssignmentMeta(host.settings));
}

/**
 * Is a turn still running or still completing on this session? Only then can
 * an older attachment be the one a completion must be attributed to. A host
 * that does not expose the markers is assumed busy (keep the FIFO as is).
 */
function turnInFlight(host: MeshAssignmentHost): boolean {
    if (!('generatingStartedAt' in host) && !('completedDebouncePending' in host) && !('generatingDebouncePending' in host)) return true;
    return (typeof host.generatingStartedAt === 'number' && host.generatingStartedAt !== 0)
        || (host.completedDebouncePending !== null && host.completedDebouncePending !== undefined)
        || (host.generatingDebouncePending !== null && host.generatingDebouncePending !== undefined);
}

/**
 * Record a task stamp in the turn-aware attachment history (live rc.40,
 * 2026-09-24): the history is what `completingTurnTaskId()` — and so every
 * per-session `[EvtTrace]` line and completion-event taskId — reads FIRST. It
 * used to grow on every stamp and shrink only on a detach, so a re-stamp of the
 * same task left a duplicate and a task that ended without a local detach left
 * its entry at the head: DesktopA traced `task=441a2f87` for four minutes after
 * the session had been re-stamped to 9315fa4d. Now: (1) a new task stamped
 * while no turn is in flight drops every older entry — nothing is left to
 * complete for them; (2) a re-stamp of a task already in the history updates
 * that entry instead of queueing a duplicate (a new attempt also moves its
 * injection anchor; the same attempt keeps the original one).
 */
function recordMeshTaskAttachment(host: MeshAssignmentHost, attachment: MeshTaskAttachment): void {
    host.meshTaskAttachmentHistory = meshTaskAttachments(host.meshTaskAttachmentHistory);
    const history = host.meshTaskAttachmentHistory;
    const existing = history.find((entry) => entry.taskId === attachment.taskId);
    if (existing) {
        const sameAttempt = !attachment.attemptId || existing.attemptId === attachment.attemptId;
        if (attachment.attemptId) existing.attemptId = attachment.attemptId;
        if (typeof attachment.dispatchNonce === 'number') existing.dispatchNonce = attachment.dispatchNonce;
        if (!sameAttempt) existing.injectedAt = attachment.injectedAt;
        return;
    }
    if (history.length > 0 && !turnInFlight(host)) {
        const dropped = history.splice(0, history.length).map((entry) => entry.taskId);
        LOG.info('MeshTaskAttach', `[${host.instanceId}] idle re-stamp to task ${attachment.taskId} — dropped stale attachment(s) ${dropped.join(', ')}`);
    }
    const { droppedTaskId } = pushMeshTaskAttachment(history, attachment);
    if (droppedTaskId) LOG.warn('MeshTaskAttach', `[${host.instanceId}] turn-aware attachment history exceeded cap — dropped task ${droppedTaskId}.`);
}

export function attachMeshAssignment(host: MeshAssignmentHost, assignment: { meshId: string; nodeId?: string; taskId?: string; dispatchNonce?: number; attemptId?: string; attemptGeneration?: number; coordinatorDaemonId?: string; coordinatorSessionId?: string }): void {
    if (!assignment?.meshId) return;
    // A stamp for a DIFFERENT task must not inherit the previous task's attempt identity or
    // dispatch nonce: the spreads below only overwrite them when the new assignment carries
    // its own, so an attempt-less dispatch used to leave task=<new> paired with the prior
    // task's attempt — evidence and reports then named a task/attempt pair that never existed.
    const previousTaskId = typeof host.settings?.meshActiveTaskId === 'string' ? host.settings.meshActiveTaskId : '';
    const previousAttemptRef = attemptRefKey(host.settings);
    const taskChanged = !!(assignment.taskId && assignment.taskId.trim() && previousTaskId && previousTaskId !== assignment.taskId);
    // ANTIGRAVITY-PREMATURE-COMPLETION gate: stamp the injection moment for a task
    // attach so injectedTaskHasStartedGenerating() can require the producing turn to
    // START after this point (rejecting the prior turn's stale native-history tail
    // that would otherwise fire generating_completed before generating_started).
    if (assignment.taskId && assignment.taskId.trim()) {
        host.meshTaskInjectedAt = Date.now();
        if (isWorkerMcpEnabled()) recordMeshTaskAttachment(host, { taskId: assignment.taskId, attemptId: assignment.attemptId, dispatchNonce: assignment.dispatchNonce, injectedAt: host.meshTaskInjectedAt }); // WORKER-MCP T2 precursor — mesh-task-attachment.ts
    }
    host.settings = {
        ...host.settings,
        meshNodeFor: assignment.meshId,
        // WTCLAIM (A): track the bound node id under BOTH the active marker
        // (meshNodeId, cleared on detach) and a sticky marker (meshLastNodeId,
        // preserved across detach). The sticky marker lets a detached but still
        // coordinator-owned session be re-picked ONLY for the SAME node it served
        // — never auto-adopted for a sibling node (e.g. a cloned worktree) that
        // shares this daemon. See isMeshOwnedDelegateSession's post-detach gate.
        ...(assignment.nodeId ? { meshNodeId: assignment.nodeId, meshLastNodeId: assignment.nodeId } : {}),
        ...(assignment.taskId ? { meshActiveTaskId: assignment.taskId } : {}),
        // REDRIVE-DUP: task-level dispatch nonce, echoed on generating_started so the
        // coordinator can reject a stale (reclaimed) dispatch. Cleared with meshActiveTaskId
        // on detach so a subsequent unrelated turn never re-echoes a prior task's nonce.
        ...(typeof assignment.dispatchNonce === 'number' ? { meshActiveDispatchNonce: assignment.dispatchNonce } : {}),
        // TURN-LEDGER (Stage 5): the opaque attempt identity for this dispatch, echoed
        // on lifecycle events so the coordinator's reducer correlates ACKs/completion
        // proposals to (taskId, attemptId, session). Cleared with meshActiveTaskId on
        // detach so a later unrelated turn never re-echoes a prior attempt.
        ...(assignment.attemptId ? { meshActiveAttemptId: assignment.attemptId } : {}),
        // C4/C5: the attempt's ledger generation (absent → 0 in currentAttemptRef).
        // A new assignment without one must not inherit the previous attempt's.
        ...(assignment.attemptId && typeof assignment.attemptGeneration === 'number' ? { meshActiveAttemptGeneration: assignment.attemptGeneration } : {}),
        ...(assignment.coordinatorDaemonId ? { meshCoordinatorDaemonId: assignment.coordinatorDaemonId } : {}),
        // Session-level routing anchor: the originating coordinator session, so this
        // worker's completion events route back to the exact session that dispatched it.
        ...(assignment.coordinatorSessionId ? { meshCoordinatorSessionId: assignment.coordinatorSessionId } : {}),
    };
    if (assignment.attemptId && typeof assignment.attemptGeneration !== 'number') delete host.settings.meshActiveAttemptGeneration;
    if (taskChanged && !assignment.attemptId) { delete host.settings.meshActiveAttemptId; delete host.settings.meshActiveAttemptGeneration; }
    if (taskChanged && typeof assignment.dispatchNonce !== 'number') delete host.settings.meshActiveDispatchNonce;
    host.adapter.updateRuntimeSettings?.(host.settings);
    // Settings are in-memory; persist the work-owner daemon to the session-host
    // record so a restore after a restart of THIS daemon can still forward the
    // worker's report to the owner (cli-manager-restore.ts). Only the owner id:
    // membership (meshNodeFor) stays launch-time, so a session that was merely
    // handed one task is never restored as a worker. The attempt ref rides the
    // same write (see persistedAttemptRefMeta).
    const meta: Record<string, unknown> = {
        ...(assignment.coordinatorDaemonId ? { meshCoordinatorDaemonId: assignment.coordinatorDaemonId } : {}),
        ...persistedAttemptRefMeta(host.settings, previousAttemptRef),
        ...nativeMeshAssignmentMeta(host.settings),
    };
    if (Object.keys(meta).length > 0) {
        try {
            host.adapter.updateRuntimeMeta?.(meta);
        } catch { /* best-effort — the live settings above are authoritative */ }
    }
}

/**
 * Session-host record meta key holding the attempt ref this session's turn
 * evidence carries (`{ attemptId, generation }`, or null once released).
 *
 * Live 2026-10-09 (preview, BuildBox → Mac): a worker whose task the Mac owned
 * survived a restart of ITS daemon mid-turn. The restored settings had the
 * membership and the owner id but no attempt ref, so the session's idle edge
 * (`turn_end`) was built with no `attemptRef`; the worker's ledger cannot
 * resolve an attempt another daemon owns, so it refused to forward it
 * (`forward_without_attempt_ref`) and the owner logged "no idle edge within 60s
 * of the worker report". Persisting the ref (and clearing it on release /
 * detach) lets the restore re-attach it, so the evidence names the attempt
 * again. It is only a pointer: the owner's reducer still checks the attempt's
 * generation and state, so a stale ref is recorded, never applied.
 */
export const PERSISTED_ATTEMPT_REF_META_KEY = 'meshActiveAttemptRef';

function attemptRefKey(settings: Record<string, any> | undefined): string {
    const ref = currentMeshAttemptRef(settings);
    return ref ? `${ref.attemptId}#${ref.generation}` : '';
}

/** The meta write for the current attempt ref, or {} when it did not change since `previousKey`. */
function persistedAttemptRefMeta(settings: Record<string, any> | undefined, previousKey: string): Record<string, unknown> {
    if (attemptRefKey(settings) === previousKey) return {};
    return { [PERSISTED_ATTEMPT_REF_META_KEY]: currentMeshAttemptRef(settings) };
}

function persistAttemptRefChange(host: MeshAssignmentHost, previousKey: string): void {
    const meta = persistedAttemptRefMeta(host.settings, previousKey);
    if (Object.keys(meta).length === 0) return;
    try { host.adapter.updateRuntimeMeta?.({ ...meta, ...nativeMeshAssignmentMeta(host.settings) }); } catch { /* best-effort */ }
}

/**
 * The live attempt ref this session's turn evidence carries
 * (`settings.meshActiveAttemptId` + `meshActiveAttemptGeneration`), or null.
 * An absent generation reads as 0 (a pre-C dispatch carried none).
 */
export function currentMeshAttemptRef(settings: Record<string, any> | undefined): { attemptId: string; generation: number } | null {
    const attemptId = settings?.meshActiveAttemptId;
    if (typeof attemptId !== 'string' || !attemptId.trim()) return null;
    const generation = settings?.meshActiveAttemptGeneration;
    return { attemptId, generation: typeof generation === 'number' && Number.isInteger(generation) && generation >= 0 ? generation : 0 };
}

/**
 * The dispatch messageId of the task currently stamped on this session —
 * `task:<taskId>:n<nonce>`, the same identity mesh/mesh-queue-dispatch-evidence.ts
 * `dispatchMessageId` mints (spelled out here: providers/ must not value-import
 * mesh/, check:boundaries). Null when no mesh task is stamped.
 */
export function currentMeshDispatchMessageId(settings: Record<string, any> | undefined): string | null {
    const taskId = typeof settings?.meshActiveTaskId === 'string' ? settings.meshActiveTaskId.trim() : '';
    if (!taskId) return null;
    const nonce = settings?.meshActiveDispatchNonce;
    return `task:${taskId}:n${typeof nonce === 'number' ? nonce : 0}`;
}

/** The narrow host the submit-verdict report reads (CliProviderInstance satisfies it). */
type SubmitVerdictHost = { instanceId: string; settings: Record<string, any>; turnEvidencePort: TurnEvidencePort | null };

/**
 * Review f8c79690 R4-2: may a send under `messageId` / `attemptRef` be opted into
 * the driver's verdict machinery? Only when it IS this session's installed mesh
 * dispatch — the stamped task's `task:<id>:n<nonce>` and the stamped attempt —
 * and a report could reach a ledger. An `attemptId` string alone (a malformed
 * meshContext, a dashboard send) is not enough.
 */
export function canReportMeshSubmitVerdict(host: SubmitVerdictHost, messageId: string, attemptRef: string): boolean {
    const expected = currentMeshDispatchMessageId(host.settings);
    return !!expected && messageId === expected && !!host.turnEvidencePort
        && typeof host.settings?.meshActiveAttemptId === 'string' && host.settings.meshActiveAttemptId === attemptRef;
}

/**
 * SUBMIT-UNCONFIRMED-RECLAIM ①: the driver PROVED the write under `messageId`
 * was not taken — after its budget and one re-paste its own body stayed the
 * whole input row (exact native read) at an idle FSM with no other input, and
 * the driver has cleared it (providers/spec/submit-verdict.ts). Returns false
 * (synchronously) when that write is not this session's current mesh dispatch,
 * or nothing could carry a report; the driver's composer is empty either way.
 *
 * Otherwise returns true and reports `dispatch_failed{submit_unconfirmed}`,
 * which R24 reclaims (new nonce → new messageId; hard stop). One veto first
 * (review f8c79690 R4-1): a fresh read of the session's own transcript since
 * `firstWrittenAt` — the engine's FIRST body write under this messageId, never
 * a re-stamped scalar (review R5-2) — that shows agent activity means the
 * prompt WAS consumed after all: `turn_started{retro}` is reported instead.
 * Only that positive read changes the outcome; an absent or unreadable
 * transcript is not evidence either way (review R5-1), the composer proof is.
 * After the read the dispatch identity (messageId, attempt, generation, port)
 * is re-checked: a dispatch that moved on is not reported.
 */
export function reportMeshSubmitUnconfirmed(host: SubmitVerdictHost, messageId: string, firstWrittenAt: number): boolean {
    const port = host.turnEvidencePort;
    const expected = currentMeshDispatchMessageId(host.settings);
    if (!expected || messageId !== expected || !port) return false;
    const attemptRef = currentMeshAttemptRef(host.settings);
    const taskId = String(host.settings.meshActiveTaskId);
    const tag = `[${host.instanceId}] dispatch ${messageId} proven unconfirmed`;
    const sameDispatch = (): boolean => {
        const ref = currentMeshAttemptRef(host.settings);
        return currentMeshDispatchMessageId(host.settings) === messageId && host.turnEvidencePort === port
            && ref?.attemptId === attemptRef?.attemptId && ref?.generation === attemptRef?.generation;
    };
    const envelope = { sessionId: host.instanceId, observedBy: 'cli_fsm', source: 'input_service' as const, ...(attemptRef ? { attemptRef } : { taskId }) };
    const fail = (): void => {
        LOG.warn('MeshTaskAttach', `${tag} — reporting dispatch_failed(submit_unconfirmed)${attemptRef ? ` for attempt ${attemptRef.attemptId} g${attemptRef.generation}` : ''}`);
        emitDispatchFailed(port, { ...envelope, workerAbsent: false, reason: 'submit_unconfirmed' });
    };
    if (!port.confirmConsumption || !(Number.isFinite(firstWrittenAt) && firstWrittenAt > 0)) {
        LOG.warn('MeshTaskAttach', `${tag} — consumption check unavailable; quarantining without dispatch_failed reclaim`);
        return false;
    }
    void port.confirmConsumption(host.instanceId, firstWrittenAt, { messageId }).then(
        (check) => check,
        () => 'unknown' as const,
    ).then((check) => {
        if (!sameDispatch()) { LOG.info('MeshTaskAttach', `${tag} — the dispatch moved on during the consumption read; not reported`); return; }
        if (check === 'consumed') {
            LOG.warn('MeshTaskAttach', `${tag} — but its transcript shows agent activity since the first write: the prompt was consumed; reporting turn_started, not a failure`);
            emitTurnStarted(port, { ...envelope, retro: true });
            return;
        }
        if (check !== 'not_consumed') {
            LOG.warn('MeshTaskAttach', `${tag} — non-consumption unproven (${check}); quarantining without dispatch_failed reclaim`);
            return;
        }
        fail();
    });
    return true;
}

/**
 * The ledger's `release_attempt_ref` effect (wiring-unification C4/C5): the
 * attempt this session was echoing is no longer live here (reclaimed,
 * re-delivered elsewhere, or terminal), so later evidence from this session
 * must stop naming it. Clears ONLY the attempt identity — the task/node
 * binding is the queue's to detach. Returns whether anything was released
 * (a different/absent attempt is left untouched: releases are addressed).
 */
export function releaseMeshAttemptRef(host: MeshAssignmentHost, attemptId: string): boolean {
    if (!attemptId || host.settings?.meshActiveAttemptId !== attemptId) return false;
    const previousAttemptRef = attemptRefKey(host.settings);
    const { meshActiveAttemptId, meshActiveAttemptGeneration, ...rest } = host.settings;
    void meshActiveAttemptId; void meshActiveAttemptGeneration;
    host.settings = rest;
    host.adapter.updateRuntimeSettings?.(host.settings);
    persistAttemptRefChange(host, previousAttemptRef);
    LOG.info('MeshDispatch', `[${host.instanceId}] released attempt ref ${attemptId}`);
    return true;
}

/**
 * Clear a previously-attached mesh assignment after the task reaches a
 * terminal state. Leaving meshNodeFor pinned would route this session's
 * subsequent unrelated turns (e.g. ad-hoc dashboard chats) to the
 * coordinator as if they were task completions.
 *
 * MESHID-DROP-ON-DETACH (Fix C): a coordinator-LAUNCHED worker session
 * (launchedByCoordinator) holds its mesh membership (meshNodeFor / meshNodeId /
 * meshCoordinatorDaemonId) at the SESSION level — set once at launch
 * (mesh_launch_session / queue auto-launch), independent of any single task.
 * The original detach wiped meshNodeFor + meshNodeId together with the
 * task-level meshActiveTaskId, so the FIRST task completion stripped the
 * membership and EVERY subsequent completion forwarded with meshId absent —
 * resolveWorkerDelegateRouting fell to mesh_unresolved and the coordinator
 * rejected the forward "meshId required". For a launched member we therefore
 * clear ONLY the task-level marker (meshActiveTaskId) and preserve the
 * session-level membership so its next task's completion still resolves.
 * A task-less ad-hoc turn on a preserved-membership session is NOT misrouted:
 * its completion carries no taskId and the session holds no active assignment,
 * so the forwarder's WARMUPGAP guard skips the dispatch-row flip (it only
 * injects a benign task-less notification). A NON-launched session (a plain CLI
 * session adopted by mesh_send_task --direct, launchedByCoordinator falsy)
 * keeps the original full clear so an ad-hoc session is never left pinned.
 */
export function detachMeshAssignment(host: MeshAssignmentHost): void { // WORKER-MCP T2 precursor (mesh-task-attachment.ts): restores a still-pending attachment onto the scalar; flag off is a no-op.
    const pending = isWorkerMcpEnabled() ? popCompletedMeshTaskAttachment(meshTaskAttachments(host.meshTaskAttachmentHistory)) : undefined; if (!host.settings.meshNodeFor && !host.settings.meshActiveTaskId && !host.settings.meshNodeId) return;
    const previousAttemptRef = attemptRefKey(host.settings);
    // Session-level member: keep membership, drop only the task-level markers.
    if (host.settings.launchedByCoordinator === true) {
        if (!host.settings.meshActiveTaskId) return;
        // REDRIVE-DUP: clear the task-level dispatch nonce with the task marker.
        const { meshActiveTaskId, meshActiveDispatchNonce, meshActiveAttemptId, meshActiveAttemptGeneration, ...rest } = host.settings;
        void meshActiveTaskId; void meshActiveDispatchNonce; void meshActiveAttemptId; void meshActiveAttemptGeneration;
        host.settings = mergePendingMeshTaskAttachment(rest, pending);
        host.adapter.updateRuntimeSettings?.(host.settings);
        persistAttemptRefChange(host, previousAttemptRef);
        return;
    }
    const { meshNodeFor, meshNodeId, meshActiveTaskId, meshActiveDispatchNonce, meshActiveAttemptId, meshActiveAttemptGeneration, ...rest } = host.settings;
    void meshNodeFor; void meshActiveTaskId; void meshActiveDispatchNonce; void meshActiveAttemptId; void meshActiveAttemptGeneration;
    // WTCLAIM (A): clear the active binding but PRESERVE the last bound node id
    // (meshLastNodeId) so a later sessionless dispatch can re-adopt this idle
    // session ONLY for the node it last served. Carry the id being cleared, or
    // keep an already-present sticky marker if meshNodeId was absent.
    const lastNodeId = (typeof meshNodeId === 'string' && meshNodeId.trim())
        ? meshNodeId.trim()
        : (typeof rest.meshLastNodeId === 'string' && rest.meshLastNodeId.trim() ? rest.meshLastNodeId.trim() : undefined);
    host.settings = lastNodeId ? { ...rest, meshLastNodeId: lastNodeId } : rest;
    host.adapter.updateRuntimeSettings?.(host.settings);
    persistAttemptRefChange(host, previousAttemptRef);
}
