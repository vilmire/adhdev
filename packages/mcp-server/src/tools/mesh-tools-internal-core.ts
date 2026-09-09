// ─── Internal pure core ───────────────────────────
// The pure helper layer of ./mesh-tools-internal.ts, physically moved here as a
// pure move (`check:file-sizes` decomposition — mesh-tools-internal.ts is a
// frozen baseline entry; same split as mesh-tools-magi.ts → mesh-tools-magi-core.ts).
//
// Everything in this file depends only on data shapes (mesh/node entries, command
// payloads, git status objects, ledger entries) — no MeshContext, no transport,
// no ledger access, no module-level mutable state. The ctx-bound orchestration
// (dispatch, drain, refresh, probes) stays in mesh-tools-internal.ts, which
// re-exports this whole surface so the domain tool files and the mesh-tools.ts
// barrel keep importing from the hub unchanged.

import { normalizeNodeCapabilitySlots, deriveProviderPriorityFromSlots } from '@adhdev/mesh-shared';
import type { LocalMeshEntry, LocalMeshNodeEntry, RepoMeshRelatedRepo } from '@adhdev/daemon-core';
import {
    buildMeshNodeCapabilityTags,
    classifyP2pRelayFailure,
    meshNodeIdMatches,
    serializeV2EnvelopeToWire,
} from '@adhdev/daemon-core';
import { isCoordinatorVisibleMessage, messageContent } from './chat-compact.js';
import {
    LARGE_LEDGER_FIELD_KEYS,
    elideLargeNestedValue,
    readNumeric,
    readString,
    summarizeLargeLedgerField,
} from './mesh-tool-shared.js';
import {
    isIdleSessionRecord,
    isTerminalSessionRecord,
    readSessionRecordId,
    unwrapCommandPayload,
} from './mesh-session-helpers.js';

export function summarizeTaskMessage(message: string): { taskTitle: string; taskSummary: string } {
    const taskSummary = message.replace(/\s+/g, ' ').trim();
    const taskTitle = taskSummary.length > 96 ? `${taskSummary.slice(0, 93)}...` : taskSummary;
    return { taskTitle: taskTitle || '(untitled task)', taskSummary };
}

export function buildDirectTaskPayload(
    message: string,
    via: 'p2p_direct' | 'local_direct' | 'mesh_send_task',
    opts: {
        taskId: string;
        taskMode?: string;
        providerType?: string;
        targetSessionId?: string;
        /** When true, the target session was idle at time of dispatch. This flag helps
         *  mesh-active-work stale detection identify unacknowledged direct dispatches. */
        dispatchedToIdleSession?: boolean;
        /** NOTIF-DROP-SYNTH-NO-MESSAGE: the originating coordinator SESSION that dispatched this
         *  task. Persisted in the task_dispatched ledger so a later transcript-reconcile synth of
         *  the completion can STRICT-route the [System] notification back to the exact coordinator
         *  session (not just the daemon). Mirrors the `coordinatorSessionId` already stamped into
         *  the worker's meshContext. */
        coordinatorSessionId?: string;
        /** COORD-EVENT-MISROUTE (anchor preservation): the originating coordinator DAEMON that
         *  dispatched this task. Persisted in the task_dispatched ledger so a later transcript-
         *  reconcile synth recovers the DISPATCHING coordinator's daemon anchor from the ledger
         *  instead of stamping the WORKER's own self-daemon (mesh-completion-synthesis selfIds) —
         *  the anchor corruption that downgraded a cross-machine completion to a broadcast
         *  deliverable to any coordinator. Mirrors the `coordinatorDaemonId` already stamped into
         *  the worker's meshContext. Absent on legacy rows → daemon-level fallback (unchanged). */
        coordinatorDaemonId?: string;
        /** LEDGER-TASK-TRACEABILITY (A/D): the node this direct dispatch targeted, plus the
         *  resolved model/thinking axes (when known), surfaced in the routingDecision sub-object
         *  so the dashboard renders direct dispatches with the same "who/via/why" shape as
         *  queue-claim dispatches. Optional — pre-existing callers omit them. */
        selectedNodeId?: string;
        resolvedModel?: string;
        resolvedThinkingLevel?: string;
    },
): Record<string, unknown> {
    const descriptor = summarizeTaskMessage(message);
    return {
        source: 'direct',
        via,
        taskId: opts.taskId,
        message,
        taskTitle: descriptor.taskTitle,
        taskSummary: descriptor.taskSummary,
        ...(opts.taskMode ? { taskMode: opts.taskMode } : {}),
        ...(opts.providerType ? { providerType: opts.providerType } : {}),
        ...(opts.targetSessionId ? { targetSessionId: opts.targetSessionId } : {}),
        ...(opts.dispatchedToIdleSession !== undefined ? { dispatchedToIdleSession: opts.dispatchedToIdleSession } : {}),
        ...(opts.coordinatorSessionId ? { coordinatorSessionId: opts.coordinatorSessionId } : {}),
        ...(opts.coordinatorDaemonId ? { coordinatorDaemonId: opts.coordinatorDaemonId } : {}),
        // Uniform routing rationale (mirrors the queue-claim task_dispatched shape) so both
        // paths render identically in mesh_task_history / the dashboard. The legacy top-level
        // `source`/`via`/`providerType` fields above are preserved verbatim for existing
        // consumers (mesh-active-work / mesh-events-stale key on payload.source === 'direct').
        routingDecision: {
            source: 'direct',
            via,
            ...(opts.selectedNodeId ? { selectedNodeId: opts.selectedNodeId } : {}),
            ...(opts.providerType ? { resolvedProviderType: opts.providerType } : {}),
            ...(opts.resolvedModel ? { resolvedModel: opts.resolvedModel } : {}),
            ...(opts.resolvedThinkingLevel ? { resolvedThinkingLevel: opts.resolvedThinkingLevel } : {}),
        },
    };
}

export function findNode(mesh: LocalMeshEntry, nodeId: string): LocalMeshNodeEntry {
    const node = mesh.nodes.find(n => meshNodeIdMatches(n as any, nodeId));
    if (!node) throw new Error(`Node '${nodeId}' is not a member of mesh '${mesh.name}'`);
    return node;
}

export function isDirectDispatchLedgerEntry(entry: any): boolean {
    if (entry?.kind !== 'task_dispatched') return false;
    const payload = entry.payload || {};
    const via = readString(payload.via);
    return payload.source === 'direct' || via === 'p2p_direct' || via === 'local_direct' || via === 'mesh_send_task';
}

export function readMessageTimestampIso(message: any): string | undefined {
    for (const value of [message?.timestamp, message?.createdAt, message?.created_at, message?.updatedAt, message?.time]) {
        if (typeof value === 'number' && Number.isFinite(value)) {
            const ms = value > 10_000_000_000 ? value : value * 1000;
            return new Date(ms).toISOString();
        }
        if (typeof value === 'string' && value.trim()) {
            const ms = new Date(value.trim()).getTime();
            if (Number.isFinite(ms)) return new Date(ms).toISOString();
        }
    }
    return undefined;
}

// EARLYNOTIFY-GATEBYPASS (a)/(b): mirror daemon-core's selectFinalAssistantTurnEndMessage
// turn-finality rule so the MCP mesh_status transcript reconcile applies the SAME "which bubble is
// the turn's final answer" judgement as the daemon path it delegates to. A genuine turn end is a
// NON-EMPTY LATEST coordinator-visible assistant/agent bubble: scanning from the end, the first
// coordinator-visible message must itself be a non-empty assistant reply. An empty (streaming /
// mid-turn) latest assistant bubble, or a trailing user message, means the turn is not proven done
// — we do NOT walk back past it to promote an earlier narration to "final" (the Defect-B walk-back)
// and we do NOT fall back to a bare payload.summary in that case. This structural check plus the
// daemon-side grace gate (reconcileDirectDispatchCompletionFromTranscript) keep a coordinator poll
// from synthesizing a completion mid-turn.
export function readFinalAssistantTranscriptEvidence(payload: any): { finalSummary?: string; transcriptMessageAt?: string } {
    const rawMessages = Array.isArray(payload?.messages) ? payload.messages : [];
    let turnEnd: any | undefined;
    for (let i = rawMessages.length - 1; i >= 0; i--) {
        const message = rawMessages[i];
        if (!isCoordinatorVisibleMessage(message)) continue; // skip tool/thought/status activity
        const role = String(message?.role ?? '').toLowerCase();
        // First coordinator-visible message from the end = who had the last word.
        turnEnd = (role === 'assistant' || role === 'agent') && messageContent(message).trim()
            ? message
            : undefined;
        break;
    }
    if (!turnEnd) return { finalSummary: undefined, transcriptMessageAt: undefined };
    return {
        finalSummary: messageContent(turnEnd).trim(),
        transcriptMessageAt: readMessageTimestampIso(turnEnd),
    };
}

export function findNodeSession(nodes: any[], nodeId?: string | null, sessionId?: string | null): { node?: any; session?: any } {
    if (!nodeId || !sessionId) return {};
    const node = nodes.find((candidate: any) => meshNodeIdMatches(candidate, nodeId));
    if (!node) return {};
    const sessions = Array.isArray(node.sessions) ? node.sessions : [];
    const session = sessions.find((candidate: any) => readSessionRecordId(candidate) === sessionId);
    return { node, session };
}

export function buildQueueTriggerGuidance(queueTrigger: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!queueTrigger || queueTrigger.claimed === true) return undefined;
    if (queueTrigger.success === false) {
        return {
            queueClaimed: false,
            queueDispatchState: 'trigger_failed',
            nextAction: 'Do not assume the queued task is running. Check mesh_view_queue and daemon connectivity before redispatching.',
        };
    }
    if (queueTrigger.autoLaunchPending === true) {
        // The coordinator already spun up (or is spinning up) a worker session for this
        // task — it is booting and will claim within a few seconds. Telling the caller to
        // launch ANOTHER session here would double-edit the worktree. Do NOT advise a new
        // launch; just wait for the in-flight session to claim.
        return {
            queueClaimed: false,
            queueDispatchState: 'pending_waiting_for_autolaunch',
            nextAction: 'A worker session was just auto-launched for this task and is booting; it will claim the task shortly. Wait for it to claim — do NOT launch another session. Use mesh_view_queue to confirm the assignment lands.',
        };
    }
    if (queueTrigger.noIdleMeshSessionAvailable === true) {
        return {
            queueClaimed: false,
            queueDispatchState: 'pending_no_idle_mesh_session',
            nextAction: 'The task is queued but not running. Launch a managed worker with mesh_launch_session, or wait for a delegated session to become ready and trigger the queue again.',
        };
    }
    return {
        queueClaimed: false,
        queueDispatchState: 'pending_or_waiting_for_ready',
        nextAction: 'The task is queued but this trigger did not claim it. Use mesh_view_queue for the current active-work source of truth before retrying.',
    };
}

export function isMeshOwnedDelegateSession(session: any, meshId: string, nodeId: string): boolean {
    const settings = session?.settings;
    const sessionMeshId = typeof settings?.meshNodeFor === 'string' ? settings.meshNodeFor.trim() : '';
    const sessionNodeId = typeof settings?.meshNodeId === 'string' ? settings.meshNodeId.trim() : '';
    // meshNodeFor is the primary ownership signal. Relay safety is checked separately
    // for remote dispatch because older local delegates may not carry coordinator
    // daemon metadata.
    if (sessionMeshId) {
        if (sessionMeshId !== meshId) return false;
        return !sessionNodeId || sessionNodeId === nodeId;
    }
    // Post-detach: detachMeshAssignment intentionally clears meshNodeFor / meshNodeId /
    // meshActiveTaskId after a relay-safe completion, but preserves the coordinator
    // markers (launchedByCoordinator / meshCoordinatorDaemonId). Without recognizing
    // those, a follow-up dispatch to the SAME session would be misclassified as an
    // unrelated alias and rejected — even though the router self-heals meshNodeFor /
    // meshNodeId at dispatch time (buildMeshWorkerRelayStamp). Treat the preserved
    // coordinator markers as ownership evidence so the dispatch-time restamp can run.
    const coordinatorOwned = settings?.launchedByCoordinator === true || Boolean(readString(settings?.meshCoordinatorDaemonId));
    if (!coordinatorOwned) return false;
    // WTCLAIM (A): a detached coordinator session is reusable, but ONLY for the node
    // it last served. detachMeshAssignment preserves meshLastNodeId (the sticky bind
    // marker). On a daemon hosting BOTH a base node and a cloned worktree node (same
    // daemonId), without this gate a detached BASE session would be auto-picked for a
    // worktree-targeted sessionless dispatch — running worktree work on the base node.
    // When the sticky marker is present it must equal the requested node; legitimate
    // same-node reuse still passes. When absent (never bound, or a pre-fix session),
    // fall back to the prior permissive behavior — fix (B)'s worker-side nodeId/
    // workspace scoping is the defense-in-depth backstop for that residual case.
    const lastNodeId = readString(settings?.meshLastNodeId);
    if (lastNodeId) return lastNodeId === nodeId;
    return true;
}

export function hasRemoteRelayMetadata(session: any): boolean {
    return Boolean(
        readString(session?.settings?.meshCoordinatorDaemonId)
        || readString(session?.meta?.meshCoordinatorDaemonId)
        || readString(session?.metadata?.meshCoordinatorDaemonId)
        || readString(session?.meshCoordinatorDaemonId),
    );
}

export function isRelaySafeRemoteDelegateSession(session: any, meshId: string, nodeId: string): boolean {
    return isMeshOwnedDelegateSession(session, meshId, nodeId) && hasRemoteRelayMetadata(session);
}


/**
 * Pre-dispatch relay-safety classification for an explicit remote delegate
 * session. The local direct-dispatch path (commandForNode → agent_command) has
 * no such gate: it always dispatches with meshContext.coordinatorDaemonId, and
 * the remote router self-heals the session's meshCoordinatorDaemonId at dispatch
 * time (router.ts buildMeshWorkerRelayStamp). The remote path used to hard-block
 * any session lacking meshCoordinatorDaemonId, which prevented that dispatch-time
 * stamp from ever running — leaving launch-stamp-less but otherwise mesh-owned
 * sessions permanently relay-unsafe.
 *
 * Mirror the local path: a session that is mesh-owned for THIS mesh self-heals
 * as long as we can hand the remote router a coordinator anchor to stamp.
 *
 *   - 'safe'         — already carries meshCoordinatorDaemonId; dispatch as-is.
 *   - 'self_heal'    — mesh-owned for this mesh, missing the anchor, but a
 *                      coordinatorDaemonId is resolvable → dispatch and let the
 *                      remote router stamp the anchor (parity with local path).
 *   - 'missing_anchor' — mesh-owned for this mesh, missing the anchor, AND no
 *                      coordinatorDaemonId resolvable → cannot delegate the stamp,
 *                      so completion events would still be undeliverable → block.
 *   - 'unsafe_alias' — not mesh-owned for this mesh (different mesh / unrelated
 *                      session). Dispatching risks aliasing an unrelated transcript
 *                      and orphaning completion events → block.
 */
export function classifyRemoteDelegateRelaySafety(
    session: any,
    meshId: string,
    nodeId: string,
    coordinatorDaemonId: string,
): 'safe' | 'self_heal' | 'missing_anchor' | 'unsafe_alias' {
    if (!isMeshOwnedDelegateSession(session, meshId, nodeId)) return 'unsafe_alias';
    if (hasRemoteRelayMetadata(session)) return 'safe';
    return coordinatorDaemonId ? 'self_heal' : 'missing_anchor';
}

export function chooseDispatchableSession(sessions: any[], providerType: string, meshId: string, nodeId: string, coordinatorDaemonId: string): any | undefined {
    const live = sessions.filter(session => !isTerminalSessionRecord(session));
    const matchingProvider = (session: any) => !providerType || session?.providerType === providerType || session?.cliType === providerType;
    // Accept mesh-owned sessions whose relay anchor is either already present or
    // self-healable at dispatch time (coordinatorDaemonId resolvable). Mirrors the
    // explicit-session relay-safety classification so auto-pick and explicit
    // dispatch converge on the same set of safe delegates.
    const meshSessions = live.filter((session: any) => {
        const safety = classifyRemoteDelegateRelaySafety(session, meshId, nodeId, coordinatorDaemonId);
        return safety === 'safe' || safety === 'self_heal';
    });
    // Only auto-pick an IDLE matching session. The previous
    // `|| meshSessions.find(matchingProvider)` fallback accepted a generating/busy
    // session, injecting a new task into a session mid-generation — the exact case
    // the explicit-session path guards against via resolveDeliveryDecision (queue or
    // reject when !idle). When no idle session exists, return undefined so the caller
    // dispatches sessionless and lets the worker pick/create a session (or the task
    // queues), instead of clobbering an in-flight one.
    return meshSessions.find(session => isIdleSessionRecord(session) && matchingProvider(session))
        || undefined;
}

export function findNestedPayload(value: any, predicate: (payload: any) => boolean): any {
    const seen = new Set<any>();
    const stack: Array<{ payload: any; depth: number }> = [{ payload: value, depth: 0 }];

    while (stack.length) {
        const { payload, depth } = stack.pop()!;
        if (predicate(payload)) return payload;
        if (!payload || typeof payload !== 'object' || seen.has(payload) || depth >= 8) continue;
        seen.add(payload);

        // Cloud/daemon relay layers have used both `result` and `payload` for
        // command_result bodies. Follow only those envelope keys so clone node
        // discovery stays tied to returned command payloads, not arbitrary data.
        for (const key of ['payload', 'result']) {
            if (key in payload) stack.push({ payload: payload[key], depth: depth + 1 });
        }
    }

    return value;
}

export function extractCloneNodePayload(value: any): any {
    return findNestedPayload(value, payload => Boolean(payload?.node?.id));
}

export function extractGitStatus(value: any): any {
    const payload = unwrapCommandPayload(value);
    return payload?.status ?? value?.status ?? payload;
}

export function extractGitDiff(value: any): any {
    const payload = unwrapCommandPayload(value);
    return payload?.diffSummary ?? payload?.diff ?? value?.diffSummary ?? value?.diff ?? payload;
}

export function extractSubmodules(value: any, ignorePaths: string[]): any[] | undefined {
    const payload = unwrapCommandPayload(value);
    const subs = payload?.status?.submodules
        ?? payload?.submodules
        ?? value?.status?.submodules
        ?? value?.submodules;
    if (!Array.isArray(subs)) return undefined;
    if (ignorePaths.length === 0) return subs;
    const ignoreSet = new Set(ignorePaths);
    return subs.filter((s: any) => s?.path && !ignoreSet.has(s.path));
}

/**
 * Pull the reported provider-quota map out of a git_status response.
 *
 * Quota rides `reporterNodeFacts` — the versioned node-facts bundle the
 * reporting daemon ships wholesale. Only this ONE field is read out here; the
 * bundle itself must keep travelling opaquely through relays (deploy-lag
 * visibility design §a), so this is a read, never a rebuild. Returns undefined
 * for a reporter that predates the field, which the caller renders as "this
 * node never told us" — distinct from a reported entry whose status is a
 * failure.
 */
export function extractReporterNodeFactsQuota(value: any): Record<string, any> | undefined {
    const payload = unwrapCommandPayload(value);
    const facts = payload?.reporterNodeFacts ?? value?.reporterNodeFacts;
    const quota = facts?.quota;
    if (!quota || typeof quota !== 'object' || Array.isArray(quota)) return undefined;
    return Object.keys(quota).length > 0 ? quota : undefined;
}

export function assignFullGitSnapshot(entry: Record<string, unknown>, status: any): void {
    if (!status || typeof status !== 'object' || Array.isArray(status)) return;
    entry.git = status;
}

export function extractLaunchPayload(value: any): any {
    return findNestedPayload(value, payload => Boolean(payload?.sessionId || payload?.id || payload?.runtimeSessionId));
}

export type MeshLaunchFailureClassification = {
    code: string;
    reason: string;
    transport: string;
    recoverable: boolean;
    retryRecommended: boolean;
    nextAction: string;
    noFallbackReason?: string;
};

export function classifyMeshLaunchFailure(error: unknown): MeshLaunchFailureClassification {
    const message = error instanceof Error ? error.message : String(error || 'launch failed');
    const lower = message.toLowerCase();
    const p2pClassification = classifyP2pRelayFailure(error, { command: 'launch_cli' });
    if (p2pClassification.recoverable) {
        return p2pClassification;
    }
    if (lower.includes('cannot connect to daemon ipc') || lower.includes('daemon ipc command')) {
        return {
            code: 'local_ipc_unavailable',
            reason: 'local_daemon_ipc_unavailable',
            transport: 'local_ipc',
            recoverable: true,
            retryRecommended: true,
            nextAction: 'Check the local daemon IPC connection, then retry mesh_launch_session once after the daemon is reachable.',
        };
    }
    if (lower.includes('timed out') || lower.includes('timeout')) {
        return {
            code: 'mesh_transport_timeout',
            reason: 'mesh_transport_timeout',
            transport: 'mesh_transport',
            recoverable: true,
            retryRecommended: true,
            nextAction: 'Check mesh transport health, then do one bounded retry before requeueing or relaunching the task.',
        };
    }
    return {
        code: 'mesh_launch_failed',
        reason: 'provider_launch_failed',
        transport: 'mesh_transport',
        recoverable: false,
        retryRecommended: false,
        nextAction: 'Inspect the provider launch error and fix the underlying provider/configuration issue before retrying.',
    };
}

export function buildWorktreeCleanupHint(node: LocalMeshNodeEntry): Record<string, unknown> | undefined {
    if (!node.isLocalWorktree) return undefined;
    return {
        tool: 'mesh_remove_node',
        args: { node_id: node.id, session_cleanup_mode: 'preserve' },
        hint: `If the worktree is no longer needed, remove the orphan worktree node with mesh_remove_node(node_id: "${node.id}").`,
    };
}

export function countUncommittedChanges(status: any): number {
    if (typeof status?.uncommittedChanges === 'number') return status.uncommittedChanges;
    const keys = ['staged', 'modified', 'untracked', 'deleted', 'renamed'];
    const counted = keys.reduce((sum, key) => sum + (Number.isFinite(Number(status?.[key])) ? Number(status[key]) : 0), 0);
    const conflicts = Array.isArray(status?.conflictFiles) ? status.conflictFiles.length : (status?.hasConflicts ? 1 : 0);
    return counted + conflicts;
}

export function isGitStatusDirty(status: any): boolean {
    if (typeof status?.isDirty === 'boolean') return status.isDirty;
    if (typeof status?.dirty === 'boolean') return status.dirty;
    if (Array.isArray(status?.submodules) && status.submodules.some((submodule: any) => submodule?.dirty || submodule?.outOfSync || submodule?.error)) return true;
    return countUncommittedChanges(status) > 0;
}

// Large structured fields that bloat refine/batch ledger entries (each can carry a
// full per-node validation plan + suggested config). In compact mode these are
// summarized rather than dropped — full detail stays available via verbose=true /
// mesh_reconcile_ledger.
// (large-value compaction utils moved to ./mesh-tool-shared.ts)

// LEDGER-TASK-TRACEABILITY (E1): compact a task_dispatched routingDecision for the
// slim ledger view — keep every scalar field (source, selectedNodeId, daemonId,
// resolvedProviderType/Model/ThinkingLevel/Difficulty, fitnessScore, reason, transport,
// requiredTagsResult) verbatim, and bound skippedCandidates to a handful with a dropped
// count so a large fleet's candidate list can't bloat the compact payload.
const ROUTING_SKIPPED_COMPACT_MAX = 5;
export function compactRoutingDecision(routing: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(routing)) {
        if (k === 'skippedCandidates' && Array.isArray(v)) {
            const kept = v.slice(0, ROUTING_SKIPPED_COMPACT_MAX);
            out[k] = kept;
            if (v.length > kept.length) out.skippedCandidatesDropped = v.length - kept.length;
        } else {
            out[k] = v;
        }
    }
    return out;
}

export function slimLedgerPayload(payload: Record<string, unknown>): Record<string, unknown> {
    const slim: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload)) {
        if (k === 'message' || k === 'taskSummary') {
            slim[k] = typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '…' : v;
        } else if (k === 'routingDecision' && v && typeof v === 'object' && !Array.isArray(v)) {
            // LEDGER-TASK-TRACEABILITY (E1): the routing rationale (source, device/daemon,
            // resolved provider/model/thinking, why) is the whole point of task_dispatched —
            // preserve it even in compact mode. It is small by construction; only bound the
            // skippedCandidates list so a large fleet can't blow the compact budget. The
            // message/finalSummary truncation policy above is untouched.
            slim[k] = compactRoutingDecision(v as Record<string, unknown>);
        } else if (k === 'evidence' || k === 'workerResult' || k === 'gitStatus' || k === 'validationResults') {
            // Skip large nested evidence objects — accessible via mesh_reconcile_ledger if needed.
        } else if (k === 'finalSummary') {
            slim[k] = typeof v === 'string' && v.length > 300 ? v.slice(0, 300) + '…' : v;
        } else if (LARGE_LEDGER_FIELD_KEYS.has(k)) {
            // plan / validationPlan / suggestedConfig / nested payload — these are the
            // refine_batch task_dispatched offenders that blow past the token limit.
            slim[k] = summarizeLargeLedgerField(k, v);
        } else {
            // Primary, key-agnostic defense: elide any oversized nested evidence blob
            // (validationSummary, result, patchEquivalence, submoduleReachability, and
            // any future large key) by serialized byte size. Small scalars/short fields
            // are returned as-is.
            slim[k] = elideLargeNestedValue(k, v);
        }
    }
    return slim;
}

export function readRelatedRepos(node: LocalMeshNodeEntry): RepoMeshRelatedRepo[] {
    const raw = Array.isArray((node as any).relatedRepos)
        ? (node as any).relatedRepos
        : Array.isArray((node.policy as any)?.relatedRepos)
            ? (node.policy as any).relatedRepos
            : [];

    return raw
        .map((entry: any) => ({
            label: typeof entry?.label === 'string' ? entry.label.trim() : '',
            workspace: typeof entry?.workspace === 'string' ? entry.workspace.trim() : '',
        }))
        .filter((entry: RepoMeshRelatedRepo) => Boolean(entry.label && entry.workspace));
}

export function summarizeRelatedRepoStatus(repo: RepoMeshRelatedRepo, status: any): Record<string, unknown> {
    const dirty = isGitStatusDirty(status);
    return {
        label: repo.label,
        workspace: repo.workspace,
        isGitRepo: status?.isGitRepo === true,
        branch: status?.branch ?? null,
        upstream: status?.upstream ?? null,
        upstreamStatus: typeof status?.upstreamStatus === 'string' ? status.upstreamStatus : (status?.upstream ? 'unchecked' : 'no_upstream'),
        upstreamFetchedAt: Number.isFinite(Number(status?.upstreamFetchedAt)) ? Number(status.upstreamFetchedAt) : null,
        upstreamFetchError: typeof status?.upstreamFetchError === 'string' ? status.upstreamFetchError : null,
        ahead: Number.isFinite(Number(status?.ahead)) ? Number(status.ahead) : 0,
        behind: Number.isFinite(Number(status?.behind)) ? Number(status.behind) : 0,
        dirty,
        uncommittedChanges: countUncommittedChanges(status),
        head: status?.headCommit ?? null,
        lastCommitSummary: status?.headMessage ?? null,
        ...(status?.reason ? { reason: status.reason } : {}),
        ...(status?.error ? { error: status.error } : {}),
    };
}

export function findNodeByWorkspace(mesh: LocalMeshEntry, workspace: string): LocalMeshNodeEntry {
    const node = mesh.nodes.find(n => n.workspace === workspace);
    if (!node) throw new Error(`Workspace '${workspace}' is not a member of mesh '${mesh.name}'`);
    return node;
}

/**
 * The node's provider preference order for a type-omitted manual launch.
 *
 * SLOTS FIRST, providerPriority as the LEGACY FALLBACK — deliberately aligned
 * with the auto-launch/queue-drain path (daemon-core resolveUsableProvider →
 * resolveNodeCapabilitySlots), which reads `policy.slots` as the authoritative
 * capability list (ORCHESTRATION_NODE_SLOTS.md) and only derives from
 * providerPriority when a node declares no slots at all.
 *
 * WHY THE ORDER WAS FLIPPED: this function used to prefer providerPriority, so
 * on a node declaring BOTH, the two dispatch paths could pick a DIFFERENT first
 * provider for the same node — auto-launch honouring the slot order, a manual
 * mesh_launch_session honouring the legacy hint. Slots are also the surface the
 * fail-closed explicit-type gate above validates against, so resolving a
 * type-omitted launch from a different list than the one that authorizes an
 * explicit type was incoherent.
 *
 * providerPriority is NOT removed: a legacy node that declares no slots has it
 * as its only preference signal, and dropping the fallback would report such a
 * node as missing_provider_priority (unlaunchable). Slots absent → behaviour is
 * byte-identical to before.
 */
export function readProviderPriority(policy: unknown): string[] {
    const fromSlots = deriveProviderPriorityFromSlots((policy as any)?.slots);
    if (fromSlots.length) return fromSlots;
    const raw = (policy as any)?.providerPriority;
    return Array.isArray(raw)
        ? raw.map((type: unknown) => typeof type === 'string' ? type.trim() : '').filter(Boolean)
        : [];
}

/**
 * Ordered, de-duplicated provider types a node can launch — every provider it could
 * be asked to run. Reads `policy.slots` (the SSOT — ORCHESTRATION_NODE_SLOTS.md),
 * unioned with the legacy `policy.providerPriority`. Used to ENUMERATE per-provider
 * capability-tag sets for observability (buildNodeCapabilityExposure). Note: the
 * mesh_launch_session fail-closed GATE deliberately checks slots ALONE (not this
 * union) — providerPriority is a preference hint, not a capability whitelist.
 */
export function readNodeSupportedProviders(policy: unknown): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const push = (type: unknown) => {
        const trimmed = typeof type === 'string' ? type.trim() : '';
        if (!trimmed || seen.has(trimmed)) return;
        seen.add(trimmed);
        out.push(trimmed);
    };
    for (const slot of normalizeNodeCapabilitySlots((policy as any)?.slots)) push(slot.provider);
    for (const type of readProviderPriority(policy)) push(type);
    return out;
}


/**
 * Surface the capability tags a node can match against required_tags routing,
 * plus its operator-defined capability labels. Computed via the same
 * buildMeshNodeCapabilityTags the queue/dispatch matcher uses, so what the
 * coordinator sees is exactly what routing will match.
 *
 *   - capabilityTags: the representative tag set (os=/arch=/converge= plus the
 *     first declared provider's provider= tag and any worktree= tag). This is
 *     what nodeSatisfiesRequiredTags compares against when no provider is pinned.
 *   - capabilityTagsByProvider: per-provider tag sets, one per entry in the
 *     node's providerPriority — the provider= tag differs by provider, so a tag
 *     like provider=codex-cli only matches when that provider is launchable here.
 *   - capabilities: the operator-defined capability labels persisted on the node
 *     (already folded into capabilityTags; surfaced raw so operators can see
 *     which tags they configured vs. which are auto-advertised).
 *
 * Note: os=/arch= reflect the TARGET node's own machine — for remote member
 * nodes these come from the platform/arch the member daemon stamped into its
 * node record at join time (node.userOverrides.platform/arch), falling back to
 * the local process platform/arch only for the coordinator's own / local
 * worktree nodes. This matches the matcher's behavior, so the exposed set is a
 * faithful preview of routing, not an independent re-derivation.
 */
export function buildNodeCapabilityExposure(node: LocalMeshNodeEntry): {
    capabilityTags: string[];
    capabilityTagsByProvider?: Record<string, string[]>;
    capabilities?: string[];
} {
    // Enumerate EVERY provider the node can launch (policy.slots is the single source
    // of truth, else legacy providerPriority) — not just providerPriority — so the
    // per-provider tag sets cover a provider that lives in slots but is not the first
    // priority entry (e.g. cursor-cli). The representative capabilityTags already
    // advertises a provider= tag for each of these (buildMeshNodeCapabilityTags).
    const providers = readNodeSupportedProviders(node.policy);
    const capabilityTags = buildMeshNodeCapabilityTags(node);
    const exposure: {
        capabilityTags: string[];
        capabilityTagsByProvider?: Record<string, string[]>;
        capabilities?: string[];
    } = { capabilityTags };
    if (providers.length) {
        const byProvider: Record<string, string[]> = {};
        for (const provider of providers) {
            byProvider[provider] = buildMeshNodeCapabilityTags(node, provider);
        }
        exposure.capabilityTagsByProvider = byProvider;
    }
    const capabilities = Array.isArray(node.capabilities)
        ? node.capabilities.filter((tag): tag is string => typeof tag === 'string' && !!tag.trim())
        : [];
    if (capabilities.length) exposure.capabilities = capabilities;
    return exposure;
}

export function readSpawnedSessionVisibility(policy: unknown): 'visible' | 'hidden' {
    return (policy as any)?.spawnedSessionVisibility === 'hidden' ? 'hidden' : 'visible';
}

export function missingProviderPriorityMessage(nodeId: string): string {
    return `Node '${nodeId}' has no providerPriority policy; pass type explicitly or configure node.policy.providerPriority`;
}

export function getNodeLaunchReadiness(node: LocalMeshNodeEntry): Record<string, unknown> {
    const bootstrap = (node as any).worktreeBootstrap;
    if ((node as any).isLocalWorktree && bootstrap?.status === 'failed' && bootstrap?.required !== false) {
        return {
            providerPriority: readProviderPriority(node.policy),
            launchReady: false,
            launchBlockedReason: 'worktree_bootstrap_failed',
            launchBlockedMessage: typeof bootstrap.error === 'string' && bootstrap.error.trim()
                ? bootstrap.error.trim()
                : 'Required worktree bootstrap failed; resolve it before launching an agent into this node.',
            worktreeBootstrap: bootstrap,
        };
    }

    const providerPriority = readProviderPriority(node.policy);
    if (providerPriority.length) {
        return {
            providerPriority,
            launchReady: true,
        };
    }

    return {
        providerPriority,
        launchReady: false,
        launchBlockedReason: 'missing_provider_priority',
        launchBlockedMessage: missingProviderPriorityMessage(node.id),
    };
}

// MESH_LAUNCH_SESSION SEMANTICS (pinned, rc.15 orchestration RCA Fix B): mesh_launch_session is
// an EXPLICIT, caller-directed spawn — the caller is asking for a NEW session on this node right
// now, force or not. By default this block does NOT refuse a 'running' worktreeBootstrap status;
// it only fail-closes on a 'failed' bootstrap, or (opt-in via mesh policy
// requireBootstrapBeforeLaunch) any non-'ready' status. This is DELIBERATELY more permissive than
// the two automatic paths that share the same worktreeBootstrap signal:
//   - auto-launch candidacy (mesh-queue-assignment.isLaunchableNode → shouldDeferDispatchForBootstrap)
//     now excludes a 'running' node outright, so the background queue drain never spawns an
//     ORPHAN session competing with the bootstrap's own session-under-construction.
//   - explicit mesh_send_task dispatch to a node with 'running' bootstrap (med-family/cli-agent.ts
//     agent_command) defers UNLESS the caller pinned a specific target session that is
//     independently re-confirmed idle/ready right now (narrow, session-scoped override — never
//     applies to a brand-new spawn, since there is no existing session to confirm).
// mesh_launch_session has no such override to reason about because it never targets an existing
// session in the first place — every call is a fresh spawn, so the caller/coordinator remains
// responsible for not launching redundantly onto a node mid-bootstrap. Do not add an implicit
// 'running' refusal here without also updating MESH_LAUNCH_SESSION_TOOL's description — a change
// here is a documented contract change, not just an internal tweak.
export function getWorktreeBootstrapLaunchBlock(node: LocalMeshNodeEntry, meshPolicy?: unknown): Record<string, unknown> | undefined {
    if (!(node as any).isLocalWorktree) return undefined;
    const bootstrap = (node as any).worktreeBootstrap;

    // M2-4 (opt-in): with policy.requireBootstrapBeforeLaunch, any non-ready
    // bootstrap state blocks the launch fail-closed - not just failures.
    const requireReady = !!(meshPolicy && typeof meshPolicy === 'object'
        && (meshPolicy as Record<string, unknown>).requireBootstrapBeforeLaunch === true);
    if (requireReady && bootstrap?.status !== 'ready') {
        return {
            success: false,
            code: 'bootstrap_not_ready',
            error: `Node '${node.id}' bootstrap state is '${bootstrap?.status ?? 'unknown'}' and mesh policy requireBootstrapBeforeLaunch is enabled.`,
            nodeId: node.id,
            worktreeBootstrap: bootstrap ?? null,
            recoveryHint: 'Run the worktree bootstrap (clone runOnClone or a refine with bootstrap inherit) until the node reports ready, or disable requireBootstrapBeforeLaunch.',
        };
    }

    if (bootstrap?.status !== 'failed' || bootstrap?.required === false) return undefined;
    return {
        success: false,
        code: 'worktree_bootstrap_failed',
        error: typeof bootstrap.error === 'string' && bootstrap.error.trim()
            ? bootstrap.error.trim()
            : `Node '${node.id}' has a failed required worktree bootstrap.`,
        nodeId: node.id,
        worktreeBootstrap: bootstrap,
        recoveryHint: 'Fix the configured worktree bootstrap command or remove/recreate the worktree node before launching an agent.',
    };
}

/**
 * Coordinator-facing summary of a failed/rolled-back daemon upgrade.
 *
 * Deliberately NOT the raw notice: that body carries a full npm/health trace
 * (lock-holder pids, command lines, recovery commands) and can run to many
 * lines. mesh_status is a payload-budgeted surface, so this keeps the fields a
 * coordinator needs to DECIDE — did an upgrade fail, when, targeting what — plus
 * a truncated first line for recognizability, and points at the existing full
 * paths for the detail.
 */
export interface MeshUpgradeFailureSummary {
    /** First line of the notice body, truncated. Enough to recognize the failure class. */
    summary: string;
    /** ISO timestamp the notice was recorded, when parseable. */
    recordedAt?: string;
    /** Human age at probe time (`3h ago`), when parseable. */
    ageLabel?: string;
    /** Version the failed attempt targeted, when the notice carries the marker. */
    targetVersion?: string;
    /** Durable notice file — read it for the full body. */
    noticePath: string;
    /** Full install/health trace. */
    logPath: string;
}

/** Cap on the notice excerpt carried in mesh_status (see MeshUpgradeFailureSummary). */
const UPGRADE_FAILURE_SUMMARY_MAX_CHARS = 200;

export function extractUpgradeFailureSummary(value: any): MeshUpgradeFailureSummary | undefined {
    const payload = unwrapCommandPayload(value);
    const raw = payload?.upgradeFailure && typeof payload.upgradeFailure === 'object'
        ? payload.upgradeFailure
        : (value?.upgradeFailure && typeof value.upgradeFailure === 'object' ? value.upgradeFailure : undefined);
    if (!raw) return undefined;
    const notice = readString(raw.notice) || '';
    const noticePath = readString(raw.noticePath) || '';
    if (!notice && !noticePath) return undefined;
    // Skip the `[ISO]` header line — the timestamp is already a structured field
    // — and take the first line of actual prose as the summary.
    const bodyLine = notice
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line && !/^\[[^\]\n]+\]$/.test(line)) || '';
    const summary = bodyLine.length > UPGRADE_FAILURE_SUMMARY_MAX_CHARS
        ? `${bodyLine.slice(0, UPGRADE_FAILURE_SUMMARY_MAX_CHARS)}…`
        : bodyLine;
    const recordedAt = readString(raw.recordedAt);
    const ageLabel = readString(raw.ageLabel);
    const targetVersion = readString(raw.targetVersion);
    return {
        summary,
        ...(recordedAt ? { recordedAt } : {}),
        ...(ageLabel ? { ageLabel } : {}),
        ...(targetVersion ? { targetVersion } : {}),
        noticePath,
        logPath: readString(raw.logPath) || '',
    };
}

export function extractDaemonBuildInfo(value: any): { commit: string; commitShort: string; version: string; builtAt?: string; track: 'stable' | 'preview' | 'unknown' } | undefined {
    const payload = unwrapCommandPayload(value);
    const build = payload?.daemonBuild && typeof payload.daemonBuild === 'object'
        ? payload.daemonBuild
        : (value?.daemonBuild && typeof value.daemonBuild === 'object' ? value.daemonBuild : undefined);
    if (!build) return undefined;
    const commit = readString(build.commit);
    if (!commit) return undefined;
    const reportedTrack = readString(build.track);
    // Missing/unrecognized is UNKNOWN, never stable. resolveBuildTrack()'s
    // fail-closed stable default applies inside the reporting daemon; it is not
    // evidence that a legacy remote daemon actually reported stable.
    const track = reportedTrack === 'stable' || reportedTrack === 'preview'
        ? reportedTrack
        : 'unknown';
    return {
        commit,
        commitShort: readString(build.commitShort) || commit.slice(0, 7),
        version: readString(build.version) || 'unknown',
        ...(readString(build.builtAt) ? { builtAt: readString(build.builtAt) } : {}),
        track,
    };
}

export function buildBranchConvergence(
    mesh: LocalMeshEntry,
    node: LocalMeshNodeEntry,
    status: any,
    dirty: boolean,
    uncommittedChanges: number,
): Record<string, unknown> {
    const defaultBranch = readString(mesh.defaultBranch) ?? 'main';
    const branch = readString(status?.branch) ?? readString(node.worktreeBranch) ?? null;
    const ahead = readNumeric(status?.ahead);
    const behind = readNumeric(status?.behind);
    const upstream = readString(status?.upstream) ?? null;
    const upstreamStatus = readString(status?.upstreamStatus) ?? (upstream ? 'unchecked' : 'no_upstream');
    const hasConflicts = status?.hasConflicts === true || (Array.isArray(status?.conflictFiles) && status.conflictFiles.length > 0);
    const base = {
        defaultBranch,
        branch,
        upstream,
        upstreamStatus,
        ahead,
        behind,
        isWorktree: node.isLocalWorktree === true,
        isDefaultBranch: branch === defaultBranch,
    };

    if (status?.isGitRepo !== true) {
        return {
            ...base,
            status: 'blocked_review',
            needsConvergence: true,
            reason: 'git_status_unavailable',
            nextStep: `Resolve git status for node '${node.id}' before marking the task complete.`,
        };
    }

    if (!branch) {
        return {
            ...base,
            status: 'blocked_review',
            needsConvergence: true,
            reason: 'branch_unknown',
            nextStep: `Inspect node '${node.id}' git branch before deciding whether it is merged to ${defaultBranch}.`,
        };
    }

    if (hasConflicts || dirty || uncommittedChanges > 0) {
        return {
            ...base,
            status: 'not_mergeable',
            needsConvergence: true,
            reason: hasConflicts ? 'conflicts_present' : 'dirty_workspace',
            nextStep: `Commit, checkpoint, or resolve node '${node.id}' before any main convergence step.`,
        };
    }

    if (branch === defaultBranch) {
        if (upstream && upstreamStatus !== 'fresh') {
            return {
                ...base,
                status: 'blocked_review',
                needsConvergence: true,
                reason: 'default_branch_upstream_unverified',
                nextStep: `Refresh ${defaultBranch}'s upstream refs or resolve the fetch failure before declaring convergence complete for node '${node.id}'.`,
            };
        }
        if (ahead > 0 || behind > 0) {
            return {
                ...base,
                status: 'blocked_review',
                needsConvergence: true,
                reason: 'default_branch_not_even_with_upstream',
                nextStep: `Bring ${defaultBranch} even with its upstream before declaring convergence complete.`,
            };
        }
        return {
            ...base,
            status: 'merged_to_main',
            needsConvergence: false,
            reason: 'clean_default_branch',
            nextStep: null,
        };
    }

    if (node.isLocalWorktree) {
        return {
            ...base,
            status: 'cleanup_candidate',
            needsConvergence: true,
            reason: 'clean_non_default_worktree_branch',
            nextStep: `Run mesh_refine_node(node_id: "${node.id}") or explicitly classify this worktree as blocked_review/not_mergeable before ending the task.`,
        };
    }

    if (upstream && upstreamStatus !== 'fresh') {
        return {
            ...base,
            status: 'blocked_review',
            needsConvergence: true,
            reason: 'feature_branch_upstream_unverified',
            nextStep: `Refresh branch '${branch}' upstream refs or resolve the fetch failure before deciding whether it is ready to merge into ${defaultBranch}.`,
        };
    }

    if (!upstream || ahead > 0 || behind > 0) {
        return {
            ...base,
            status: 'blocked_review',
            needsConvergence: true,
            reason: !upstream ? 'feature_branch_missing_upstream' : 'feature_branch_not_even_with_upstream',
            nextStep: `Push or reconcile branch '${branch}', then merge it into ${defaultBranch} or mark it not_mergeable with a reason.`,
        };
    }

    return {
        ...base,
        status: 'pushed_feature_branch_needs_merge',
        needsConvergence: true,
        reason: 'clean_non_default_branch',
        nextStep: `Review and merge branch '${branch}' into ${defaultBranch}; do not report the task as fully complete while it remains off main.`,
    };
}


// In compact mode the per-node followUp rows are capped so this summary can't grow
// unbounded with node count; the dropped rows are folded into a by-status count and
// the full list stays available via verbose.
export const COMPACT_MAX_CONVERGENCE_FOLLOWUPS = 12;

export function summarizeBranchConvergence(nodes: any[], compact = false): Record<string, unknown> {
    const allFollowUps = nodes
        .filter(node => node?.branchConvergence?.needsConvergence === true)
        .map(node => ({
            nodeId: node.nodeId,
            // workspace is a long absolute path redundant with nodeId — drop it in
            // compact mode to keep this summary bounded.
            ...(compact ? {} : { workspace: node.workspace }),
            branch: node.branchConvergence.branch,
            status: node.branchConvergence.status,
            reason: node.branchConvergence.reason,
            // The per-node nextStep is long prose that repeats node ids/branch names.
            // In compact mode drop it (the status+reason carry the actionable signal;
            // verbose still surfaces the full nextStep) so this summary stays bounded
            // as node count grows.
            ...(compact ? {} : { nextStep: node.branchConvergence.nextStep }),
        }));

    const byStatus: Record<string, number> = {};
    for (const f of allFollowUps) {
        const s = typeof f.status === 'string' ? f.status : 'unknown';
        byStatus[s] = (byStatus[s] ?? 0) + 1;
    }

    const followUps = compact ? allFollowUps.slice(0, COMPACT_MAX_CONVERGENCE_FOLLOWUPS) : allFollowUps;
    const omitted = allFollowUps.length - followUps.length;

    return {
        needsFollowUp: allFollowUps.length > 0,
        unresolvedCount: allFollowUps.length,
        byStatus,
        requiredFinalStates: ['merged_to_main', 'pushed_feature_branch_needs_merge', 'blocked_review', 'cleanup_candidate', 'not_mergeable'],
        followUps,
        ...(omitted > 0 ? { followUpsOmitted: omitted, followUpsHint: 'Per-node followUp rows are capped in compact mode; counts above are complete. Use verbose=true for the full list.' } : {}),
    };
}

export function normalizePendingMeshCoordinatorEvents(value: any): any[] {
    const payload = unwrapCommandPayload(value);
    const events = Array.isArray(payload?.events)
        ? payload.events
        : Array.isArray(value?.events)
            ? value.events
            : [];
    return events.filter((event: unknown) => event && typeof event === 'object');
}

export function buildMeshForwardPayloadFromPendingEvent(event: any): Record<string, unknown> {
    const metadataEvent = event?.metadataEvent && typeof event.metadataEvent === 'object'
        ? event.metadataEvent as Record<string, unknown>
        : {};
    return {
        event: readString(event?.event),
        meshId: readString(event?.meshId),
        nodeId: readString(event?.nodeId) || readString(metadataEvent.meshNodeId),
        workspace: readString(event?.workspace) || readString(metadataEvent.workspace),
        targetSessionId: readString(metadataEvent.targetSessionId) || readString(metadataEvent.sessionId) || readString(metadataEvent.instanceId),
        providerType: readString(metadataEvent.providerType),
        providerSessionId: readString(metadataEvent.providerSessionId),
        finalSummary: readString(metadataEvent.finalSummary) || readString(metadataEvent.summary),
        jobId: readString(metadataEvent.jobId),
        interactionId: readString(metadataEvent.interactionId),
        status: readString(metadataEvent.status),
        targetDaemonId: readString(metadataEvent.targetDaemonId),
        // RC32: carry the coordinator DAEMON anchor across the remote-pull relay (the
        // pending event stores it top-level, not inside metadataEvent). The receive-side
        // whitelist (daemon-core buildRelayMetadataEvent) reads it back so a sessionless
        // refine terminal event re-queues targeted at THIS coordinator instead of
        // self-fallback-stamping the relaying worker daemon.
        targetCoordinatorDaemonId: readString(event?.targetCoordinatorDaemonId),
        startedAt: readString(metadataEvent.startedAt),
        completedAt: readString(metadataEvent.completedAt),
        retryOfJobId: readString(metadataEvent.retryOfJobId),
        ...(metadataEvent.result && typeof metadataEvent.result === 'object' && !Array.isArray(metadataEvent.result) ? { result: metadataEvent.result } : {}),
        ...(metadataEvent.intentional === true ? { intentional: true } : {}),
        ...(metadataEvent.intentionalStop === true ? { intentionalStop: true } : {}),
        ...(metadataEvent.operatorCleanup === true ? { operatorCleanup: true } : {}),
        ...(readString(metadataEvent.reason) ? { reason: readString(metadataEvent.reason) } : {}),
        ...(readString(metadataEvent.stopReason) ? { stopReason: readString(metadataEvent.stopReason) } : {}),
        ...(readString(metadataEvent.cleanupReason) ? { cleanupReason: readString(metadataEvent.cleanupReason) } : {}),
        ...(readString(metadataEvent.source) ? { source: readString(metadataEvent.source) } : {}),
        // T4 (B3b): carry the v2 envelope across the P2P relay so a remote worker's
        // completion pulled by an MCP/LLM coordinator re-forwards with its ORIGINAL
        // eventId (idempotency) and unicast routing intact, matching the reconcile-loop
        // relay path (buildForwardPayloadFromPending). Spread LAST so the authoritative
        // envelope always wins. Empty for a v1 event (version-skew safe).
        ...serializeV2EnvelopeToWire(event as any),
    };
}

/**
 * Distinguish a P2P read_chat transport failure between "the peer is reachable but
 * saturated/slow" (REQUEST_TIMEOUT — acked, result deadline elapsed) and "the peer was
 * never connected / the request never reached a working handler" (CONNECT_TIMEOUT,
 * ACK_TIMEOUT delivery failure, NO_PEER, datachannel closed, …). Both still warrant the
 * cached-summary fallback, but the advisory wording differs so the coordinator knows
 * whether a quick retry is plausible (saturated) or the daemon is simply offline.
 *
 * The transport-layer code (meshCode) is lost crossing IPC — only the error message
 * string survives — so classification is by message text.
 */
export function classifyReadChatTransportCause(error: unknown): 'not_connected' | 'saturated' {
    const message = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase();
    if (/not acknowledged|delivery failure|channel never opened|connect timed out|not connected|datachannel|disconnected|\bclosed\b|offline|no route|failed to initiate p2p|p2p mesh is not available|connect queue full/.test(message)) {
        return 'not_connected';
    }
    // Acked but the result deadline elapsed (REQUEST_TIMEOUT) — peer reachable but
    // saturated / still working and could not return the transcript in time.
    return 'saturated';
}
