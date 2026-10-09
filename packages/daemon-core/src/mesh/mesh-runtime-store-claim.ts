/**
 * The queue claim transaction of MeshRuntimeStore: one session atomically claims
 * the next pending task it may run — the dependency gate, notBefore, target pins,
 * readonly/write caps, per-node / per-slot / per-provider caps and difficulty floor
 * are all checked inside the same SQLite transaction that flips the row to
 * `assigned`. Same `self`-delegate pattern as the other mesh-runtime-store-*
 * modules; the class keeps the delegating method.
 */
import { LOG } from '../logging/logger.js';
import { nodeSatisfiesRequiredTags, isTaskReadonly, taskDependenciesSatisfied, meshTaskNotBeforeReady, meshTaskPriorityRank } from './mesh-work-queue.js';
import { taskIsParked } from './mesh-task-parking.js';
import { effectiveSlotCap } from './mesh-daemon-slot-axis.js';
import { meshNodeIdMatches, daemonIdsEquivalent, expandDaemonIdForms, sessionIdsEquivalent, findOwnershipConflicts, type InFlightOwnership } from '@adhdev/mesh-shared';
import type { MeshWorkQueueEntry } from './mesh-work-queue.js';
import { selectClaimCandidate, type MeshClaimRefusal, type MeshClaimRefusalReason } from './mesh-claim-refusal.js';
import type { MeshRuntimeStore } from './mesh-runtime-store.js';
import { dirtyWriteVerdict, describeDirtyWriteRefusal, type DirtyWriteGate } from './mesh-dirty-write-verdict.js';

/** The MeshRuntimeStore members these functions read or call (compiler-checked; no cast). */
export type MeshRuntimeStoreClaimHost = Pick<MeshRuntimeStore, 'activeProviderAssignmentCount' | 'activeSlotAssignmentCount' | 'assignedRowsMeshWide' | 'db' | 'ensureLegacyQueueMigrated' | 'hasActiveNodeWriteAssignment' | 'hasActiveSessionAssignment' | 'maybeCheckpointWal' | 'transaction'>;

// O(1) claim: transaction ensures only one session claims a pending task
export function claimNextQueueTask(host: MeshRuntimeStoreClaimHost, meshId: string, nodeId: string, sessionId: string, capabilityTags: string[] = [], opts?: {
            providerType?: string;
            providerMaxParallel?: number;
            assignedModel?: string;
            slotMaxParallel?: number;
            /** Every nodeId sharing this node's daemon machine — the scope the
             *  provider/slot maxParallel caps are counted over. Omit to count the
             *  single node (prior behavior; never widens a cap). */
            daemonNodeIds?: readonly string[];
            nodeIsWorktree?: boolean;
            assignedTranscriptProfile?: MeshWorkQueueEntry['assignedTranscriptProfile'];
            allowedTaskDifficulties?: readonly import('@adhdev/mesh-shared').MeshTaskDifficulty[];
            /**
             * GIT-GATE (owner-requested follow-up to H1): the claiming node's git
             * telemetry verdict, resolved by the CALLER (mesh-queue-assignment.ts
             * tryAssignQueueTask, which already has the mesh/node records at hand —
             * mirrors how `nodeIsWorktree` is threaded rather than the store importing
             * config/mesh-node-identity itself) via the SAME predicates the auto-launch
             * spawn gate uses (`isDirtyNode`, `isMeshNodeFreshEnoughToLaunch` +
             * `resolveAutoFastForwardPolicy(mesh).maxBehind`). Omitted or both flags
             * false ⇒ no gating (fail-open on unresolved/absent telemetry, matching
             * those predicates' own fail-open contract). Applies to non-readonly
             * candidates only — a readonly candidate bypasses this gate entirely, same
             * as `nodeConflictAllows` above.
             */
            nodeGitGate?: { dirty: boolean; worktreeBranch?: string; nodeId?: string; staleBehind: boolean; behind?: number; maxBehind?: number };
            /** A6-SILENT-REFUSAL: optional sink the claim fills in when it returns null,
             *  naming WHICH predicate refused. See MeshClaimRefusal. Purely diagnostic —
             *  the return contract (`MeshWorkQueueEntry | null`) is unchanged, so every
             *  existing caller that omits it behaves exactly as before. */
            outRefusal?: MeshClaimRefusal;
        }): MeshWorkQueueEntry | null {
    return host.transaction(() => {
        host.ensureLegacyQueueMigrated(meshId);
        const refuse = (reason: MeshClaimRefusalReason, detail?: string, deepest?: MeshWorkQueueEntry): null => {
            if (opts?.outRefusal) {
                opts.outRefusal.reason = reason;
                if (detail) opts.outRefusal.detail = detail;
                // Structural id/difficulty alongside the free-form `detail` string, so a
                // caller (LEDGER-AUTOLAUNCH-RETRY-SPAM ⑤ — the difficulty-floor claim-path
                // pager) can act on WHICH task was refused without parsing "closest
                // candidate <id> of <n>" back out of prose.
                if (deepest) {
                    opts.outRefusal.taskId = deepest.id;
                    if (deepest.difficulty) opts.outRefusal.difficulty = deepest.difficulty;
                }
            }
            return null;
        };
        // A session executes one task at a time regardless of mode — block early.
        // The node-level conflict is evaluated per-candidate below so that
        // read-only (live_debug_readonly) tasks can claim concurrently on a node
        // that already has an active assignment, while write tasks keep the
        // one-active-per-node invariant (worktree isolation).
        if (host.hasActiveSessionAssignment(meshId, sessionId)) return refuse('session_already_assigned');
        const nodeWriteBusy = host.hasActiveNodeWriteAssignment(meshId, nodeId);

        // Per-(daemon, provider) maxParallel cap (summed slots[].maxParallel).
        // Bounds the (daemon, provider) resource pool — one CLI, one auth file,
        // one upstream rate limit per machine — so sibling worktrees share it.
        // This composes with the global/taskMode caps enforced in the coordinator
        // (stricter wins); omitting providerMaxParallel preserves prior behavior.
        //
        // ★ Evaluated PER CANDIDATE (not once up front) because the effective cap
        // depends on whether the candidate is read-only: read-only work may not
        // take the last free slot, so a write task always has one within a single
        // completion (see effectiveSlotCap / the starvation note in
        // mesh-daemon-slot-axis). A write candidate still sees the full cap, so
        // this is never looser than before for writes.
        const providerType = typeof opts?.providerType === 'string' ? opts.providerType.trim() : '';
        const providerMaxParallel = opts?.providerMaxParallel;
        const providerCapDeclared = providerType
            && typeof providerMaxParallel === 'number'
            && Number.isFinite(providerMaxParallel)
            && providerMaxParallel >= 0;
        const liveProviderCount = providerCapDeclared
            ? host.activeProviderAssignmentCount(meshId, nodeId, providerType, opts?.daemonNodeIds)
            : 0;

        // Per-SLOT maxParallel cap. A slot — the (provider, model) pair — is an
        // independent unit: `maxParallel: 1` on claude-cli/opus means ONE opus task
        // on this DAEMON at a time, even while a sibling claude-cli/sonnet slot is
        // idle. The provider cap above bounds the shared pool (one CLI, one auth,
        // one upstream rate limit); this bounds the individual slot. Stricter wins,
        // so both are checked, and a claim missing either bound is refused.
        //
        // Enforced inside the same transaction as the provider cap so concurrent
        // claims cannot both read "1 free" and both commit. Like the provider cap,
        // the read-only reservation makes the effective bound candidate-dependent.
        const assignedModel = typeof opts?.assignedModel === 'string' ? opts.assignedModel.trim() : '';
        const slotMaxParallel = opts?.slotMaxParallel;
        const slotCapDeclared = providerType
            && typeof slotMaxParallel === 'number'
            && Number.isFinite(slotMaxParallel)
            && slotMaxParallel >= 0;
        const liveSlotCount = slotCapDeclared
            ? host.activeSlotAssignmentCount(meshId, nodeId, providerType, assignedModel, opts?.daemonNodeIds)
            : 0;

        /**
         * Both maxParallel axes for one candidate, with the read-only reservation
         * applied. Refuses when either axis is met — stricter wins, unchanged.
         */
        const parallelCapsAllow = (candidate: MeshWorkQueueEntry): boolean => {
            const readonlyCandidate = isTaskReadonly(candidate);
            if (providerCapDeclared) {
                const cap = effectiveSlotCap(providerMaxParallel as number, readonlyCandidate);
                if (cap !== undefined && liveProviderCount >= cap) return false;
            }
            if (slotCapDeclared) {
                const cap = effectiveSlotCap(slotMaxParallel as number, readonlyCandidate);
                if (cap !== undefined && liveSlotCount >= cap) return false;
            }
            return true;
        };

        // The node-pinned SELECT must match a row whose target_node_id was stamped
        // in ANY equivalent daemon-id form (config-form `daemon_mach_X` vs the
        // claiming session's stamp-form `mach_X`). A single `= ?` bind on the
        // stamp-form silently fails to fetch a config-form row, leaving the task
        // pending forever (the empty-session WORKTREE-CLAIM-GATE repro). Expand to
        // every equivalent form and bind an IN (...) set; the per-candidate
        // targetMatches() JS gate above re-validates each fetched row.
        const nodeIdForms = expandDaemonIdForms(nodeId);
        const nodePinnedPlaceholders = nodeIdForms.map(() => '?').join(', ');
        // Priority: session-targeted > node-targeted (no session) > unconstrained.
        // G6: WITHIN each targeting tier, a higher task-level priority is pulled first;
        // created_at ASC (from the SQL ORDER BY) is the intra-priority tie-break. The
        // tier ordering is preserved (a high-priority unconstrained task never jumps
        // ahead of a session/node-pinned task) so targeting stays the outer key and
        // priority is the inner key. Sort is stable, so equal-priority rows keep FIFO.
        const parseTier = (query: string, ...params: unknown[]): MeshWorkQueueEntry[] => {
            const tierRows = host.db.prepare(query).all(...params) as Array<{ payload: string }>;
            return tierRows
                .map(row => JSON.parse(row.payload) as MeshWorkQueueEntry)
                .sort((a, b) => meshTaskPriorityRank(b.priority) - meshTaskPriorityRank(a.priority));
        };
        const candidates = [
            ...parseTier(`
                SELECT payload FROM mesh_queue
                WHERE mesh_id = ? AND status = 'pending' AND target_session_id = ?
                ORDER BY created_at ASC
            `, meshId, sessionId),
            ...parseTier(`
                SELECT payload FROM mesh_queue
                WHERE mesh_id = ? AND status = 'pending' AND target_node_id IN (${nodePinnedPlaceholders}) AND target_session_id IS NULL
                ORDER BY created_at ASC
            `, meshId, ...nodeIdForms),
            ...parseTier(`
                SELECT payload FROM mesh_queue
                WHERE mesh_id = ? AND status = 'pending' AND target_node_id IS NULL AND target_session_id IS NULL
                ORDER BY created_at ASC
            `, meshId),
        ];

        // M1: a task with unmet dependencies is not claimable.
        // Resolve dependency statuses in one query over the union of referenced ids.
        const depIds = [...new Set(candidates.flatMap(c => Array.isArray(c.dependsOn) ? c.dependsOn : []))];
        const depStatus = new Map<string, string>();
        if (depIds.length > 0) {
            const placeholders = depIds.map(() => '?').join(', ');
            const depRows = host.db.prepare(
                `SELECT id, status FROM mesh_queue WHERE mesh_id = ? AND id IN (${placeholders})`
            ).all(meshId, ...depIds) as Array<{ id: string; status: string }>;
            for (const r of depRows) depStatus.set(r.id, r.status);
        }
        // DEPENDSON-GATE-SYMMETRY: the claim gate shares the single
        // taskDependenciesSatisfied predicate with the auto-launch filter and
        // the cloud eager P2P push, so a task blocked here is blocked there too.
        const dependenciesSatisfied = (candidate: MeshWorkQueueEntry): boolean =>
            taskDependenciesSatisfied(candidate, depStatus);

        // Per-candidate node-conflict gate: write tasks require a node with no other
        // assigned WRITE row (an assigned read-only row does not count); read-only
        // tasks bypass the node-busy check so N read-only diagnoses can run on one node
        // at once. Read-only classification is decided solely by isTaskReadonly (the
        // single predicate shared with the cap counters / auto-launch / guardrail).
        const nodeConflictAllows = (candidate: MeshWorkQueueEntry): boolean => {
            if (isTaskReadonly(candidate)) return true;
            return !nodeWriteBusy;
        };

        // H1 (path ownership, wiring-unification Phase H — docs/design/2026-09-23-
        // wiring-unification.md §7c): a write (non-readonly) candidate whose declared
        // owned_paths overlaps another currently-ASSIGNED write task's declared
        // owned_paths is refused. Scope is MESH-WIDE (assignedRowsMeshWide — every
        // node/daemon in the mesh), deliberately DIFFERENT from the provider/slot/
        // node-busy capacity gates above, which stay scoped to assignedRowsForDaemon
        // (one machine's resources). Path ownership exists to keep parallel branches
        // from touching the same files before they converge on main — two worktrees
        // on two DIFFERENT machines are exactly as parallel as two worktrees on one
        // machine, so a daemon-scoped query would miss the cross-daemon collision
        // entirely (live finding, preview rc.41 runs 3–7: a direct-dispatch row
        // `assigned` on one daemon did not stop an overlapping enqueued task from
        // being claimed on a completely different daemon).
        // Opt-in only: a candidate OR an in-flight task with no declaration never
        // conflicts (findOwnershipConflicts' own backward-compat contract). This is a
        // PATH-level refinement of the existing NODE-level nodeConflictAllows gate
        // above — it catches the case that gate cannot: two DIFFERENT nodes (same
        // daemon OR different daemons) racing on the same file, which
        // nodeConflictAllows never sees because it only compares a candidate against
        // ITS OWN node's busy bit.
        const inFlightOwnership: InFlightOwnership[] = host.assignedRowsMeshWide(meshId)
            .map((row): InFlightOwnership | null => {
                try {
                    const parsed = JSON.parse(row.payload) as MeshWorkQueueEntry;
                    if (parsed.id === undefined) return null;
                    if (!parsed.ownedPaths || isTaskReadonly(parsed)) return null;
                    return { taskId: parsed.id, paths: parsed.ownedPaths };
                } catch { return null; }
            })
            .filter((v): v is InFlightOwnership => v !== null);
        const ownedPathsConflictFor = (candidate: MeshWorkQueueEntry) =>
            candidate.ownedPaths && !isTaskReadonly(candidate)
                ? findOwnershipConflicts(candidate.ownedPaths, inFlightOwnership)
                : [];
        const ownedPathsAllows = (candidate: MeshWorkQueueEntry): boolean =>
            ownedPathsConflictFor(candidate).length === 0;

        // GIT-GATE (owner-requested follow-up to H1, wiring-unification): the
        // auto-launch SPAWN gate already refuses a dirty or stale-behind node
        // (mesh-queue-autolaunch.ts isDirtyNode / isMeshNodeFreshEnoughToLaunch), but
        // the CLAIM path for an already-idle/already-running session had no equivalent
        // — a dirty or stale node's idle session could pull a write task straight
        // through this atomic claim. `nodeGitGate` is resolved by the caller (the same
        // predicates, applied to the same node record) and threaded in as a plain
        // verdict so this DB-layer store never has to import mesh-node-identity /
        // mesh-auto-fast-forward policy resolution itself — same pattern as
        // `nodeIsWorktree`. Fail-open: an omitted gate (unresolved/absent telemetry)
        // never refuses. Applies to WRITE candidates only — a readonly candidate does
        // not touch the tree, so it bypasses this gate exactly like nodeConflictAllows.
        //
        // Dirty: the fixed per-node-type rule (mesh-dirty-write-verdict.ts) — a dirty
        // base node refuses every write; a dirty WORKTREE accepts a write bound to its
        // own branch (branch continuation) and refuses the rest.
        const nodeGitGate = opts?.nodeGitGate;
        const nodeDirtyGate: DirtyWriteGate | undefined = nodeGitGate
            ? { dirty: nodeGitGate.dirty, worktreeBranch: nodeGitGate.worktreeBranch, nodeId: nodeGitGate.nodeId ?? nodeId }
            : undefined;
        const nodeNotDirty = (candidate: MeshWorkQueueEntry): boolean => {
            if (!nodeDirtyGate) return true;
            return dirtyWriteVerdict(nodeDirtyGate, candidate) !== 'refuse';
        };
        const nodeNotStaleBehind = (candidate: MeshWorkQueueEntry): boolean => {
            if (!nodeGitGate || isTaskReadonly(candidate)) return true;
            return !nodeGitGate.staleBehind;
        };

        // G7: delayed execution. A task with a notBefore in the future is held pending
        // (skipped as a claim candidate) until the wall clock passes it. Fail-open on an
        // unparseable timestamp (meshTaskNotBeforeReady) so a bad value never strands work.
        const claimNowMs = Date.now();
        const notBeforeReady = (candidate: MeshWorkQueueEntry): boolean =>
            meshTaskNotBeforeReady(candidate, claimNowMs);

        // WTDISPATCH-FANOUT: a `convergence` task lands its work onto base (merge →
        // push → cleanup against the real checkout). It must NEVER be claimed by a
        // co-located worktree-clone session — N sibling worktree sessions on one daemon
        // each claiming the same convergence intent is the 4-way push/deploy fan-out the
        // live repro hit. Base-only, fail-closed: when the claiming node is a worktree
        // (nodeIsWorktree), exclude every convergence candidate so it stays pending for
        // the base node to pull.
        const nodeIsWorktree = opts?.nodeIsWorktree === true;
        const convergenceAllows = (candidate: MeshWorkQueueEntry): boolean =>
            candidate.taskMode !== 'convergence' || !nodeIsWorktree;

        // WTDISPATCH-FANOUT: defensive exact-target gate. The prioritized SQL above
        // already segregates session/node-pinned rows, but a future query change (or a
        // candidate row whose stored target drifted from its column) must never let a
        // sibling worktree session on the same daemon absorb another node's/session's
        // pinned task. When a task carries an explicit target, require an exact match
        // here too — fail-closed.
        // The target id may have been stamped in a different serialization /
        // daemon-id form than the claiming session's nodeId (config-form
        // `daemon_mach_X` vs stamp-form `mach_X`, or the 3-way id/nodeId/node_id
        // node forms). A raw `!==` here permanently strands a node-pinned task as
        // an empty session. Accept the candidate when the target resolves to the
        // same node under ANY equivalent form; keep targetSessionId an exact match.
        const targetMatches = (candidate: MeshWorkQueueEntry): boolean => {
            // Session ids are single-form (unlike node/daemon ids with their 3
            // serialization forms requiring expandDaemonIdForms) — see the
            // sessionIdsEquivalent doc; it is the one canonical exact-match
            // predicate for them.
            if (candidate.targetSessionId && !sessionIdsEquivalent(candidate.targetSessionId, sessionId)) return false;
            if (
                candidate.targetNodeId
                && !daemonIdsEquivalent(candidate.targetNodeId, nodeId)
                && !meshNodeIdMatches({ id: candidate.targetNodeId }, nodeId)
            ) {
                return false;
            }
            return true;
        };

        // DIFFICULTY HARD FLOOR (idle/event claim path): the auto-launch selector
        // filters slots before ranking, but an already-running session reaches this
        // atomic claim without that selector. Restrict classified candidates to the
        // grades its concrete model can run (or the conservative intersection when
        // the live model is unknown). Freeform/legacy rows remain unconstrained.
        const allowedTaskDifficulties = opts?.allowedTaskDifficulties;
        const difficultyAllows = (candidate: MeshWorkQueueEntry): boolean =>
            !allowedTaskDifficulties
            || candidate.difficulty === 'freeform'
            || !candidate.difficulty
            || allowedTaskDifficulties.includes(candidate.difficulty as import('@adhdev/mesh-shared').MeshTaskDifficulty);

        // PIN-PARKING: a PARKED row is claimable by nobody — not even the session it
        // is still pinned to. Parking means "this delta's addressee went stale and the
        // coordinator has not yet decided what to do with it"; letting the original
        // session claim it later would deliver an instruction whose premise the
        // coordinator was explicitly asked to re-confirm, which is the same
        // wrong-context delivery parking exists to prevent.
        //
        // Keeping the pin already hides the row from every OTHER session (the tier-1
        // SELECT only offers a session-pinned row to that session), so this guard is
        // the one remaining hole — and being in the shared candidate filter, it is
        // fail-closed against any future change to those queries. Unparking happens
        // exclusively through requeueTask.
        const notParked = (candidate: MeshWorkQueueEntry): boolean => !taskIsParked(candidate);

        // A6-SILENT-REFUSAL (rationale: mesh-claim-refusal.ts). Was one boolean `.find(...)`
        // whose failure collapsed into a bare `return null` — nine predicates, one silent
        // exit. Order and short-circuit semantics are preserved exactly; this only records
        // WHICH gate said no.
        const selected = selectClaimCandidate<MeshWorkQueueEntry>(candidates, [
            { reason: 'required_tags_unsatisfied', test: c => nodeSatisfiesRequiredTags(c.requiredTags, capabilityTags) },
            { reason: 'dependencies_unsatisfied', test: dependenciesSatisfied },
            { reason: 'not_before_delayed', test: notBeforeReady },
            { reason: 'task_parked', test: notParked },
            { reason: 'convergence_target_is_worktree', test: convergenceAllows },
            { reason: 'target_pin_unmatched', test: targetMatches },
            { reason: 'difficulty_floor_unmet', test: difficultyAllows },
            { reason: 'parallel_cap_reached', test: parallelCapsAllow },
            { reason: 'node_busy_with_active_assignment', test: nodeConflictAllows },
            { reason: 'owned_paths_conflict', test: ownedPathsAllows },
            { reason: 'dirty_workspace', test: nodeNotDirty },
            { reason: 'node_stale_behind_upstream', test: nodeNotStaleBehind },
        ]);
        if (!selected.entry) {
            if (!candidates.length) return refuse('no_pending_candidates');
            // H1: for an owned_paths_conflict refusal, name the specific conflicting
            // task id(s) and path(s) rather than the generic "closest candidate"
            // detail — that is exactly the diagnostic the design doc asks for
            // ("refused ... instead of silently racing it").
            if (selected.reason === 'owned_paths_conflict' && selected.deepest) {
                const conflicts = ownedPathsConflictFor(selected.deepest);
                const detail = conflicts.length
                    ? `owned_paths overlap with task(s): ${conflicts.map(c => `${c.taskId} [${c.overlappingPaths.join(', ')}]`).join('; ')}`
                    : undefined;
                return refuse('owned_paths_conflict', detail, selected.deepest);
            }
            // GIT-GATE: name the concrete git evidence (behind count / maxBehind) rather
            // than the generic "closest candidate" prose, mirroring the H1 detail above.
            if (selected.reason === 'dirty_workspace') {
                return refuse('dirty_workspace', describeDirtyWriteRefusal(nodeDirtyGate ?? { dirty: true }, nodeId), selected.deepest);
            }
            if (selected.reason === 'node_stale_behind_upstream') {
                const behindDetail = nodeGitGate?.behind !== undefined
                    ? `node ${nodeId} is ${nodeGitGate.behind} commit(s) behind upstream (max ${nodeGitGate.maxBehind ?? 0})`
                    : `node ${nodeId} is behind upstream beyond the configured maxBehind`;
                return refuse('node_stale_behind_upstream', behindDetail, selected.deepest);
            }
            return refuse(selected.reason, selected.deepest
                ? `closest candidate ${selected.deepest.id} of ${candidates.length}` : undefined,
                selected.deepest);
        }
        const entry = selected.entry;

        // GIT-GATE: a readonly candidate bypasses nodeNotDirty/nodeNotStaleBehind above
        // (an N-way readonly diagnosis does not touch the tree), but the operator asked
        // for visibility rather than silence when that happens — one INFO line, not a
        // refusal.
        if (nodeGitGate && (nodeGitGate.dirty || nodeGitGate.staleBehind) && isTaskReadonly(entry)) {
            LOG.info('MeshQueue', `Claiming readonly task ${entry.id} for node ${nodeId} despite git gate `
                + `(${nodeGitGate.dirty ? 'dirty_workspace' : ''}${nodeGitGate.dirty && nodeGitGate.staleBehind ? ', ' : ''}`
                + `${nodeGitGate.staleBehind ? `node_stale_behind_upstream${nodeGitGate.behind !== undefined ? ` behind=${nodeGitGate.behind}` : ''}` : ''}) `
                + `— readonly tasks are exempt from the write-gate.`);
        }

        const now = new Date().toISOString();
        entry.status = 'assigned';
        entry.assignedNodeId = nodeId;
        entry.assignedSessionId = sessionId;
        if (providerType) entry.assignedProviderType = providerType;
        // Per-slot cap accounting: record WHICH model this claim runs, so the next
        // claim can count assignments against the right slot instead of lumping
        // every same-provider task into one pool.
        if (assignedModel) entry.assignedModel = assignedModel;
        // P1 transcript-authority stamp (write-only for now): lets the
        // coordinator classify this worker without local provider access.
        if (opts?.assignedTranscriptProfile) entry.assignedTranscriptProfile = opts.assignedTranscriptProfile;
        entry.dispatchTimestamp = now;
        // REDRIVE-DUP: bump the per-task dispatch nonce on every claim so this dispatch
        // carries a nonce strictly greater than any prior (reclaimed) dispatch of the same
        // task. The worker echoes it on agent:generating_started; the coordinator rejects a
        // stale-nonce ack so a reclaimed+re-dispatched task's original inject cannot execute.
        entry.dispatchNonce = (entry.dispatchNonce || 0) + 1;
        // AUTOLAUNCH-SPAWN-CAP (P3): a successful claim is the healthy outcome the
        // durable spawn counter is waiting for — reset the budget here, at the ONE
        // choke point every claim path funnels through (idle drain, inline launch
        // claim, remote claim, redrive, direct-delivery fallback all end here).
        delete entry.autoLaunchUnclaimedCount;
        // SPAWN-CAP-TRANSPORT-AWARE: the dispatch-failure tally is scoped to the same
        // "since the last successful claim" window, so it clears here too.
        delete entry.autoLaunchDispatchFailedCount;
        entry.updatedAt = now;

        host.db.prepare(`
            UPDATE mesh_queue SET
                status = 'assigned', assigned_node_id = ?, assigned_session_id = ?,
                updated_at = ?, payload = ?
            WHERE id = ? AND mesh_id = ?
        `).run(nodeId, sessionId, now, JSON.stringify(entry), entry.id, meshId);

        host.maybeCheckpointWal();
        return entry;
    });
}
