// Mesh auto-launch candidacy predicates — pure move out of mesh-queue-assignment.ts
// (2026-08-23), following the mesh-branch-convergence.ts / mesh-event-suppression.ts
// precedent: barrel-preserving, behaviour-identical, no new tests.
//
// Why this cluster: these are the read-only "is this session/node a candidate?"
// predicates the dispatch path consults before it claims or launches anything. They
// share one contract — they OBSERVE runtime state (instanceManager, queue rows, node
// records) and return a verdict; none of them mutate mesh state, hold module-local
// mutable state, or perform IO. That makes them a leaf: importable from anywhere in
// src/mesh without a cycle.
//
// Cycle note: mesh-auto-fast-forward.ts and mesh-skip-notify.ts already imported
// isIdleSessionState / nodeHasActiveMeshWork / isLocalAutoLaunchNode /
// resolveSessionBusyVerdict back OUT of mesh-queue-assignment.ts while
// mesh-queue-assignment.ts imports from both of them — a genuine import cycle that
// mesh-autolaunch-integrity.ts works around today by keeping a hand-copied
// isIdleSessionState (see the comment at its top). Hosting the predicates here lets
// those modules depend on a leaf instead. This move does NOT change any of their
// import sites yet — mesh-queue-assignment.ts re-exports every symbol below, so the
// existing paths keep resolving exactly as before. Collapsing the duplicate copy is a
// separate, behaviour-visible follow-up.
//
// sweepExpiredCooldowns() deliberately stayed behind: it mutates the
// autoLaunchCooldownUntil module state that lives in mesh-queue-assignment.ts, so it
// is not a leaf predicate. resolveAutoLaunchTarget() likewise stayed behind — it reads
// the localCoordinatorDaemonId() CANON helper defined there.

import type { DaemonComponents } from '../boot/daemon-lifecycle.js';
import { loadConfig } from '../config/config.js';
import { buildMeshNodeCapabilityTags, nodeSatisfiesRequiredTags, getQueue } from './mesh-work-queue.js';
import type { MeshWorkQueueEntry } from './mesh-work-queue.js';
import { daemonIdsEquivalent, sessionIdsEquivalent } from '@adhdev/mesh-shared';
import { readNonEmptyString } from './mesh-events-utils.js';
import { readMeshNodeDaemonId, isMeshNodeHealthLaunchable } from './mesh-node-identity.js';
import { shouldDeferDispatchForBootstrap } from './worktree-bootstrap-config.js';
import { inWindowAutoLaunchSessionIdsForNode } from './mesh-autolaunch-integrity.js';
import { nodeHasActiveAssignment } from './mesh-scheduling-fitness.js';
import { resolveNodeCapabilitySlots } from './mesh-node-slots.js';
import { allowedClassifiedDifficultiesForSession, readSessionModel, taskMeetsSessionDifficultyFloor } from './mesh-difficulty-floor.js';

export function normalizeProviderPriority(policy: unknown): string[] {
    const raw = policy && typeof policy === 'object' && !Array.isArray(policy)
        ? (policy as Record<string, unknown>).providerPriority
        : undefined;
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    return raw
        .map(type => typeof type === 'string' ? type.trim() : '')
        .filter(Boolean)
        .filter(type => {
            if (seen.has(type)) return false;
            seen.add(type);
            return true;
        });
}

export function isTerminalSessionStatus(status: string): boolean {
    return ['stopped', 'failed', 'terminated', 'exited', 'closed'].includes(status);
}

// Exported (Fix B, rc.15 orchestration RCA) so the explicit mesh_send_task dispatch path
// (med-family/cli-agent.ts) can reuse the SAME status/liveness probe to independently confirm a
// pinned target session is genuinely ready before overriding the coarse worktreeBootstrap
// 'running' defer for that one session. Never returns true for 'starting' / 'waiting_approval' /
// 'generating' / any other non-idle status — those still refuse the override.
export function isIdleSessionState(state: any): boolean {
    const status = readNonEmptyString(state?.status).toLowerCase();
    if (isTerminalSessionStatus(status)) return false;
    return status === 'idle' || state?.activeChat?.status === 'waiting_input';
}


export function sessionStateLooksActive(state: any): boolean {
    const status = readNonEmptyString(state?.status).toLowerCase();
    const chatStatus = readNonEmptyString(state?.activeChat?.status).toLowerCase();
    // 'long_generating' is retained as a legacy alias for the renamed 'no_progress' busy status.
    const active = new Set(['generating', 'streaming', 'no_progress', 'long_generating', 'working', 'starting', 'waiting_approval']);
    return active.has(status) || active.has(chatStatus);
}

/** @internal Split-visibility only: the auto-fast-forward module gates its ff on the
 *  same "is this node busy" predicate. Not public surface — no consumer outside
 *  src/mesh imports it, and neither re-export barrel lists it. */
export function nodeHasActiveMeshWork(components: DaemonComponents, meshId: string, nodeId: string, currentSessionId?: string): boolean {
    if (nodeHasActiveAssignment(meshId, nodeId)) return true;
    return components.instanceManager.getByCategory('cli').some((inst: any) => {
        const state = inst.getState();
        const settings = state.settings as Record<string, unknown> || {};
        if (readNonEmptyString(settings.meshNodeFor) !== meshId) return false;
        const instNodeId = readNonEmptyString(settings.meshNodeId) || readNonEmptyString(settings.nodeId);
        // Match under canonical machine-core form, NOT a raw `!==`: a session's stamped
        // meshNodeId and the candidate nodeId can carry interchangeable daemon-id forms
        // (bare `mach_X` vs `daemon_mach_X`). A raw mismatch makes a BUSY node look idle,
        // so the active-work gate passes and a SECOND session is launched/claimed for a
        // task already running here — the CANON-IDENTITY duplicate dispatch.
        if (!daemonIdsEquivalent(instNodeId, nodeId)) return false;
        const sessionId = readNonEmptyString(state.instanceId);
        if (currentSessionId && sessionIdsEquivalent(sessionId, currentSessionId) && isIdleSessionState(state)) return false;
        return sessionStateLooksActive(state);
    });
}

export function isLaunchableNode(node: any): boolean {
    if (!node || node.status === 'disabled' || node.status === 'removed') return false;
    // BOOTSTRAP-POLICY-CONSISTENCY (Fix B, rc.15 orchestration RCA): a worktree node whose
    // bootstrap is still 'running' must be excluded from auto-launch candidacy, not merely
    // deferred at claim time. Before this, isLaunchableNode passed a bootstrapping node through,
    // so maybeAutoLaunchOneQueueSession could spawn a session (launch_cli) on it — an ORPHAN,
    // since tryAssignQueueTask's own bootstrap gate (mirrors this same predicate) then defers the
    // claim onto that freshly-spawned session anyway, leaving it stranded with nothing assigned
    // while the node's real bootstrap-driven session comes up separately. Reusing
    // shouldDeferDispatchForBootstrap (rather than a raw status check) keeps this in agreement
    // with the claim gate's stale-running backstop: a 'running' stamp old enough and verified
    // git-clean is treated as silently complete and does not block launch.
    if (shouldDeferDispatchForBootstrap(node as { worktreeBootstrap?: { status?: string; startedAt?: string; updatedAt?: string; completedAt?: string }; workspace?: string })) {
        return false;
    }
    // Delegate the health gate to the shared resolver so the auto-launch gate and the
    // MAGI fan-out planner agree on exactly what "launchable health" means (online /
    // unknown / absent pass; degraded / offline / dirty / wrong_branch are blocked).
    return isMeshNodeHealthLaunchable(node);
}

/** Whether a mesh node's daemon/machine identity resolves to THIS coordinator daemon
 *  (i.e. the queue session can be spawned by a direct local `launch_cli`). */
/** @internal Split-visibility only: the auto-fast-forward and skip-notify modules both
 *  need the same local-vs-remote node verdict. Not public surface — no consumer outside
 *  src/mesh imports it, and neither re-export barrel lists it. */
export function isLocalAutoLaunchNode(node: any): boolean {
    const daemonId = readNonEmptyString(node?.daemonId);
    const machineId = readNonEmptyString(node?.machineId);
    const appConfig = loadConfig();
    const localMachineId = readNonEmptyString(appConfig.machineId) || readNonEmptyString(appConfig.registeredMachineId);

    // Route BOTH the daemonId and the machineId through the canonical machine-core
    // equivalence helper so a node carrying any interchangeable id form (bare `mach_<hex>`
    // or a `daemon_`/`standalone_` prefixed form) resolves to THIS coordinator instead of
    // being misjudged as remote. machineId used to use a raw `===`, which — AND-combined
    // with the daemonId match — would misjudge a local node as remote whenever a
    // form-mismatched machineId arrived, dispatching a local task to a remote node (B-2).
    const daemonMatchesLocal = !daemonId || daemonIdsEquivalent(daemonId, localMachineId);
    const machineMatchesLocal = !machineId || daemonIdsEquivalent(machineId, localMachineId);

    if (node?.isLocalWorktree === true) {
        return daemonMatchesLocal && machineMatchesLocal;
    }
    if (daemonId || machineId) {
        return daemonMatchesLocal && machineMatchesLocal;
    }
    return true;
}

/**
 * CANON-IDENTITY single-flight hardening (restart-safe, observation-based).
 *
 * The in-memory single-flight Set (mesh-task-inflight) is process-local and is LOST on a
 * daemon restart — after a restart, a task still being generated by a live local worker is
 * no longer marked in-flight, so requeueTask's Set check passes and would re-open the task
 * for a duplicate second dispatch. This recovers the "still generating" signal from
 * observable runtime state instead of the in-memory mark: a session is actively generating
 * when its live local CLI instance reports an active (generating/streaming/…) status — the
 * same predicate the dispatch active-work gate uses (sessionStateLooksActive).
 *
 * Local-only by design: it inspects THIS daemon's instanceManager. The primary cross-process
 * fix (IpcTransport requeue delegating to the mesh-host daemon) keeps begin (dispatch) and
 * check (requeue guard) co-located so the in-memory mark stays authoritative in the common
 * path; this is the restart-safety net for sessions hosted on this daemon. A genuinely
 * dead/stale session is not generating → returns false → the requeue proceeds as before.
 */
export function isSessionActivelyGenerating(components: DaemonComponents, sessionId: string): boolean {
    if (!sessionId) return false;
    const state = components.instanceManager?.getInstance?.(sessionId)?.getState?.();
    if (!state) return false;
    return sessionStateLooksActive(state);
}

/**
 * RECLAIM-FALSEPOS tri-state busy verdict for a session id.
 *
 * The binary isSessionActivelyGenerating() folds "absence of a positive generating
 * signal" into a definitive NEGATIVE (returns false when the instance is absent). But a
 * REMOTE session (never in THIS daemon's instanceManager) — or a locally-present session
 * looked up under a skewed id form — then looks "not generating" and can be reclaimed out
 * from under a worker that is genuinely mid-turn. This resolves an explicit three-way
 * verdict instead:
 *   - GENERATING       — a locally-present instance reports an active/streaming state.
 *   - IDLE_CONFIRMED    — a locally-present instance reports a non-active (idle/terminal)
 *                         state. Positive local evidence the worker is not working.
 *   - UNKNOWN           — no locally-present instance matches (remote / gone / id-skew) or
 *                         the observation failed. NEVER treated as IDLE_CONFIRMED.
 *
 * The lookup scans getByCategory('cli') with sessionIdsEquivalent (the same equivalence
 * matching nodeHasActiveMeshWork / liveSessionCountForNode use) rather than a raw
 * instanceManager.getInstance(id) Map.get, so an id-form-skewed but present session is
 * found (closing the same id-form-skew hole class e245c2f9's F1 fixed elsewhere).
 */
export type SessionBusyVerdict = 'GENERATING' | 'IDLE_CONFIRMED' | 'UNKNOWN';
export function resolveSessionBusyVerdict(components: DaemonComponents, sessionId: string): SessionBusyVerdict {
    if (!sessionId) return 'UNKNOWN';
    try {
        const instances = components.instanceManager?.getByCategory?.('cli') || [];
        const inst = instances.find((i: any) => {
            const sid = readNonEmptyString(i?.getState?.().instanceId);
            return sid && sessionIdsEquivalent(sid, sessionId);
        });
        if (!inst) return 'UNKNOWN'; // remote / gone / id-form skew not present locally
        const state = inst.getState?.();
        if (!state) return 'UNKNOWN';
        return sessionStateLooksActive(state) ? 'GENERATING' : 'IDLE_CONFIRMED';
    } catch {
        return 'UNKNOWN'; // failed observation ⇒ unknown, never a definitive idle
    }
}

export function liveSessionCountForNode(components: DaemonComponents, meshId: string, nodeId: string): number {
    const localInstances = components.instanceManager.getByCategory('cli').filter((inst: any) => {
        const state = inst.getState();
        const settings = state.settings as Record<string, unknown> || {};
        if (readNonEmptyString(settings.meshNodeFor) !== meshId) return false;
        const instNodeId = readNonEmptyString(settings.meshNodeId) || readNonEmptyString(settings.nodeId);
        // Canonical-form match (see nodeHasActiveMeshWork): a daemon-id form skew between
        // the session's stamped nodeId and the candidate nodeId must not undercount this
        // node's live sessions, which would defeat the maxConcurrentSessions cap.
        if (!daemonIdsEquivalent(instNodeId, nodeId)) return false;
        const status = readNonEmptyString(state.status).toLowerCase();
        return !isTerminalSessionStatus(status);
    });
    let count = localInstances.length;
    // (A) AUTOLAUNCH-CLAIM-CHURN: also count launched-but-not-yet-claimed sessions targeting this
    // node whose await-claim window is still open. A REMOTE such session is invisible to the local
    // instanceManager above, so without this the maxConcurrentSessions cap undercounts it and a
    // duplicate ghost launch slips through. Exclude any id already represented by a local instance
    // so a co-located launch is not double-counted.
    const localSessionIds = localInstances
        .map((inst: any) => readNonEmptyString(inst.getState().instanceId))
        .filter(Boolean);
    for (const sid of inWindowAutoLaunchSessionIdsForNode(meshId, nodeId)) {
        if (!localSessionIds.some(local => sessionIdsEquivalent(local, sid))) count += 1;
    }
    return count;
}

/**
 * DOUBLE-DISPATCH auto-launch gate: does this node already have a LIVE mesh session that
 * is NOT holding an assigned queue task — i.e. one that is idle, booting toward its first
 * claim, or in a momentary non-idle flip? Such a session WILL claim a still-pending task
 * on its own via the idle→claim / agent:ready drain, so spawning a NEW session here only
 * races it and yields a duplicate worker that double-stamps the same taskId (the
 * enqueue → drain-miss → auto-launch RCA: the drain skipped a momentarily-non-idle idle
 * session as a candidate, and the write-only nodeHasActiveAssignment gate — which only
 * inspects status='assigned' rows — could not see the about-to-claim session either).
 *
 * A session that already HOLDS an assigned queue task is genuine concurrent work, not a
 * free claimer, and is excluded — so a read-only auto-launch onto a busy-but-no-idle node
 * is still allowed. A node with NO live mesh session at all (dead, or never launched) does
 * not match, preserving the legitimate first-session spawn.
 *
 * PROVIDER-MATCH gate (DISPATCH-DEADLOCK-PROVIDER-MISMATCH): a live session only suppresses
 * this launch if it could ACTUALLY claim THIS task. A session whose providerType does not
 * satisfy the task's requiredTags (e.g. a claude-cli coordinator/worker session on a node,
 * while the pending task is required_tags: [provider=codex-cli]) is NOT a pending claimer for
 * this task — claimNextQueueTask's nodeSatisfiesRequiredTags gate would reject its claim. Left
 * unchecked, such a mismatched session made this gate return true for a task it can never claim,
 * so the required-provider worker never auto-launched AND no session could claim → nobody made
 * progress → permanent silent deadlock. Mirror the claim path: build the session's own
 * capability tags (its providerType pinned onto the node) and only count it as a pending claimer
 * when those tags satisfy task.requiredTags. `node` is passed in so the tag set reflects this
 * node's os/arch/worktree/converge context, matching claimNextQueueTask exactly.
 */
export function nodeHasLiveSessionPendingClaim(components: DaemonComponents, meshId: string, nodeId: string, task: MeshWorkQueueEntry, node: any): boolean {
    // (A) AUTOLAUNCH-CLAIM-CHURN remote-awareness: a task whose auto-launch record targets this
    // node and is still inside its await-claim window (base or backoff) already has a session on
    // its way to claim — even when that session is REMOTE and thus invisible to the local
    // instanceManager scan below. Treat it as a live pending-claim session so a duplicate launch
    // is suppressed and no ghost accumulates every ~90s.
    if (inWindowAutoLaunchSessionIdsForNode(meshId, nodeId).length > 0) return true;
    // Session ids currently holding an assigned queue task on this node — those are busy,
    // not pending claimers, so they must NOT suppress a (read-only) launch.
    const busySessionIds = new Set(
        getQueue(meshId, { status: ['assigned'] as any })
            .filter(task => daemonIdsEquivalent(task.assignedNodeId, nodeId))
            .map(task => readNonEmptyString(task.assignedSessionId))
            .filter(Boolean),
    );
    return components.instanceManager.getByCategory('cli').some((inst: any) => {
        const state = inst.getState();
        const settings = state.settings as Record<string, unknown> || {};
        if (readNonEmptyString(settings.meshNodeFor) !== meshId) return false;
        // DISPATCH-DEADLOCK-COORD-SESSION-SLOT: a coordinator session for THIS mesh
        // (meshCoordinatorFor === meshId) is never a pending-claim worker — the idle→claim
        // drain (drainMeshQueue, isIdleSessionState + worker role) never picks it up, because
        // a coordinator is generating/non-idle and is the dispatcher, not a claimer. The claim
        // path excludes it structurally; the skip gate must apply the SAME exclusion. Without
        // this, a node whose only live mesh session is the coordinator makes this gate return
        // true, so no worker auto-launches and no session ever claims → the task pends forever
        // with no error/requeue (silent deadlock). The busy-set / non-idle guards below don't
        // help because the coordinator holds no *assigned* queue task, so it is neither busy
        // nor terminal here.
        if (readNonEmptyString(settings.meshCoordinatorFor) === meshId) return false;
        const instNodeId = readNonEmptyString(settings.meshNodeId) || readNonEmptyString(settings.nodeId);
        // Canonical-form match (see nodeHasActiveMeshWork / liveSessionCountForNode): a
        // daemon-id form skew must not make a present session look absent and reopen the
        // duplicate-launch hole.
        if (!daemonIdsEquivalent(instNodeId, nodeId)) return false;
        const status = readNonEmptyString(state.status).toLowerCase();
        if (isTerminalSessionStatus(status)) return false; // dead → no claimer here, allow launch
        const sessionId = readNonEmptyString(state.instanceId);
        if (sessionId && busySessionIds.has(sessionId)) return false; // busy with its own assigned task
        // PROVIDER-MATCH gate (DISPATCH-DEADLOCK-PROVIDER-MISMATCH): only count this session as a
        // pending claimer if its own provider could satisfy THIS task's requiredTags. A session
        // whose providerType does not match (e.g. a claude-cli session while task requires
        // provider=codex-cli) can never claim this task via claimNextQueueTask's
        // nodeSatisfiesRequiredTags gate, so it must not suppress the required-provider launch —
        // otherwise the task deadlocks (mismatched session blocks launch, yet cannot claim). Mirror
        // the claim path: pin the session's providerType onto this node and check the tags.
        const sessionProviderType = state.type || readNonEmptyString(settings.providerType);
        if (task.requiredTags?.length) {
            if (sessionProviderType && !nodeSatisfiesRequiredTags(task.requiredTags, buildMeshNodeCapabilityTags(node, sessionProviderType))) {
                return false; // provider mismatch → this session can't claim this task; not a pending claimer
            }
        }
        const allowance = allowedClassifiedDifficultiesForSession(node, resolveNodeCapabilitySlots(node, meshId), sessionProviderType, readSessionModel(state));
        if (!taskMeetsSessionDifficultyFloor(task, allowance)) return false;
        return true; // live + unassigned + provider-capable → will claim the pending task itself
    });
}
