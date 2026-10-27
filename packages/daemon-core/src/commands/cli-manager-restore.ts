import { assertRecoveryLaunchIdentity } from '@adhdev/session-host-core';
import { diagnoseCoordinatorRestoreConflict, isCoordinatorRestoreConflict, planCoordinatorRestores, repairCoordinatorBinding, verifyCoordinatorRecoveryInventory, type CoordinatorRestorePlan } from './coordinator-identity-restore.js';
import { sameHostedBindingOwner, type HostedBindingOwner } from '../session-host/binding-owner.js';
import { assistantRestoreCandidate } from '../assistant/assistant-identity.js';
import { maintenanceHeld, readCooperativeMaintenance, withMaintenanceAdmission } from '../maintenance/cooperative-gate.js';
import { observeHeldHostedSessions, verifyHeldObservationPromotion } from '../maintenance/held-observation.js';
/**
 * DaemonCliManager — boot-time re-attach of hosted CLI runtimes
 * (`restoreHostedSessions`): rebuild each instance's launch-time settings
 * (provider settings, coordinator mark, mesh membership), register it, and
 * prune stale coordinator-registry entries.
 *
 * Split out of cli-manager.ts (file-size gate).
 */
import { getCoordinatorForSession, pruneDeadMeshCoordinators } from '../mesh/coordinator-registry.js';
import { LOG } from '../logging/logger.js';
import { reconcileWorkerSessionBindsAfterRestore } from '../runtime-defaults.js';
import { getAssistantRegistry } from '../assistant/assistant-registry.js';
import { buildRestoredLaunchRecord } from '../sessions/launch-record.js';
import { shouldRestoreHostedRuntime } from './hosted-runtime-restore.js';
import { resolveCliSessionBinding } from './cli-session-binding.js';
import { ensureCoordinatorContextFileMaterialized } from './mesh-coordinator.js';
import type { DaemonCliManager, HostedCliRuntimeDescriptor } from './cli-manager.js';

/** The DaemonCliManager members these functions read or call (compiler-checked; no cast). */
export type CliRestoreHost = Pick<DaemonCliManager, 'adapters' | 'deps' | 'providerLoader' | 'registerCliInstance'>;

export async function restoreHostedSessions(host: CliRestoreHost, records?: HostedCliRuntimeDescriptor[], signal?: AbortSignal): Promise<number> {
    signal?.throwIfAborted();
    if (maintenanceHeld()) {
        if (records) throw new Error('maintenance_complete_inventory_required');
        return (await observeHeldHostedSessions(host, 'held-boot-restore')).sessions.length;
    }
    return withMaintenanceAdmission(() => restoreWritableHostedSessions(host, records, signal));
}

async function restoreWritableHostedSessions(host: CliRestoreHost, records?: HostedCliRuntimeDescriptor[], signal?: AbortSignal): Promise<number> {
    const instanceManager = host.deps.getInstanceManager();
    if (!instanceManager) {
        if (readCooperativeMaintenance()) throw new Error('maintenance_instance_manager_required');
        return 0;
    }
    const promoted = await verifyHeldObservationPromotion(host);
    let sessions = records || await host.deps.listHostedCliRuntimes?.({ includeLaunchDetails: true }) || [];
    if (sessions.some(r => r.cliArgsOmitted)) {
        const details = await host.deps.listHostedCliRuntimes?.({ includeLaunchDetails: true });
        if (!details) throw new Error('session_host_launch_details_unavailable');
        sessions = sessions.map(record => {
            if (!record.cliArgsOmitted) return record;
            const exact = details.find(r => r.runtimeId === record.runtimeId && r.runtimeKey === record.runtimeKey && r.startedAtMs === record.startedAtMs);
            if (!exact || exact.cliArgsOmitted) throw new Error('session_host_inventory_changed_during_restore');
            return exact;
        });
    }
    signal?.throwIfAborted();
    if (promoted && ((!records && sessions.length !== promoted.length) || sessions.some(r=>!promoted.some(p=>p.runtimeId===r.runtimeId && p.providerType===r.cliType && p.providerSessionId===r.providerSessionId && p.workspace===r.workspace && p.startedAt===r.startedAtMs)))) throw new Error('maintenance_complete_promotion_inventory_required');
    for (const r of sessions) {
        // An original provider UUID may be persisted under a fresh runtime UUID.
        // Refuse the complete restore rather than quietly registering a revival.
        assertRecoveryLaunchIdentity({ runtimeId: r.runtimeId, providerSessionId: r.providerSessionId, cliArgs: r.cliArgs });
    }
    const owner = host.deps.getHostedBindingOwner?.();
    const registry = getAssistantRegistry();
    // Full verified inventory must reconcile a dead binding before candidate selection.
    if (!records && host.deps.listHostedCliRuntimes) registry.pruneAfterRestore(new Set(sessions.map(r => r.runtimeId)), owner);
    const entry = registry.reload();
    const eligible = sessions.filter(r => (!r.lifecycle || ['running', 'interrupted'].includes(r.lifecycle)) && shouldRestoreHostedRuntime(r, host.deps.hostedRuntimeManagerTag));
    // A known foreign binding cannot be claimed through this endpoint.
    const assistant = entry?.sessionId && entry.hostOwner && !sameHostedBindingOwner(entry.hostOwner, owner)
        ? undefined : assistantRestoreCandidate(entry, eligible);
    let restored = 0;
    const restoredBindings = new Set<string>();
    const managerTag = host.deps.hostedRuntimeManagerTag;

    const restoredRuntimeIds = new Set(sessions.map(r => r.runtimeId));
    const coordinatorPlanning = planCoordinatorRestores(eligible, owner, restoredRuntimeIds, sessions);
    const coordinatorPlans = coordinatorPlanning.plans;
    let coordinatorPruneAllowed = coordinatorPlanning.registryAvailable;

    for (const record of sessions) {
        signal?.throwIfAborted();
        if (!record?.runtimeId || !record?.cliType || !record?.workspace) continue;
        if (record.lifecycle && !['running', 'interrupted'].includes(record.lifecycle)) continue;
        if (!shouldRestoreHostedRuntime(record, managerTag)) {
            LOG.info(
                'CLI',
                `↷ Skipping hosted runtime restore owned by ${record.managedBy}: ${record.runtimeKey || record.runtimeId}`
            );
            continue;
        }
        if (host.adapters.has(record.runtimeId) || instanceManager.getInstance(record.runtimeId)) {
            if (promoted) throw new Error('maintenance_existing_writable_binding_requires_reconciliation');
            continue;
        }
        const normalizedType = host.providerLoader.resolveAlias(record.cliType);
        const providerMeta = host.providerLoader.getMeta(normalizedType);
        if (!providerMeta || providerMeta.category !== 'cli') continue;

        const resolvedProvider = host.providerLoader.resolve(normalizedType) || providerMeta;
        const sessionBinding = resolveCliSessionBinding(
            resolvedProvider,
            normalizedType,
            record.cliArgs,
            record.providerSessionId,
        );
        const bindingKey = [
            normalizedType,
            record.workspace,
            sessionBinding.providerSessionId || record.runtimeId,
        ].join('::');
        if (restoredBindings.has(bindingKey)) {
            LOG.info(
                'CLI',
                `↷ Skipping duplicate hosted runtime restore: ${record.runtimeKey || record.runtimeId} (${normalizedType} @ ${record.workspace}) binding=${sessionBinding.providerSessionId || 'runtime'}`
            );
            continue;
        }
        let coordinatorPlan = coordinatorPlans.get(record.runtimeId);
        if (records && coordinatorPlan?.recovered) {
            try {
                await verifyCoordinatorRecoveryInventory(coordinatorPlan, record, owner, host.deps.listHostedCliRuntimes);
            } catch (error) {
                signal?.throwIfAborted();
                diagnoseCoordinatorRestoreConflict(record.runtimeId, error);
                coordinatorPlan = undefined;
            }
        }
        signal?.throwIfAborted();
        const restoredSettings = buildRestoredSettings(host, record, normalizedType, coordinatorPlan, assistant?.runtimeId);
        try {
            await host.registerCliInstance(
                record.runtimeId,
                normalizedType,
                record.cliType,
                record.workspace,
                record.cliArgs,
                resolvedProvider,
                restoredSettings,
                true,
                {
                    providerSessionId: sessionBinding.providerSessionId,
                    launchMode: 'manual',
                    // Thread the runtime's REAL past spawn time so the attach restores
                    // the per-session native-history birth-floor instead of collapsing
                    // to spawnedAtMs:0 (which disabled the antigravity per-session floor
                    // and let co-located workers claim the coordinator's own conversation).
                    // Undefined → registerCliInstance keeps the 0 fallback.
                    attachStartedAtMs: record.startedAtMs,
                    // Phase E: the provenance stored at spawn, launchedBy → 'restore'
                    // with the axis sources preserved (see buildRestoredLaunchRecord).
                    launchRecord: buildRestoredLaunchRecord(record.launchRecord, {
                        sessionId: record.runtimeId,
                        providerType: normalizedType,
                        workspace: record.workspace,
                        launchedAt: record.startedAtMs ?? Date.now(),
                    }),
                },
            );
            signal?.throwIfAborted();
            if (restoredSettings.assistant === true) {
                const latest = registry.reload();
                if ((latest?.sessionId && latest.sessionId !== record.runtimeId)
                    || (latest?.sessionId && latest.hostOwner && !sameHostedBindingOwner(latest.hostOwner, owner))) {
                    throw new Error('assistant_identity_conflict: binding changed during attach');
                }
                registry.bindSession({ sessionId: record.runtimeId, cliType: normalizedType, workspace: record.workspace,
                    hostOwner: owner, mcpConfigPath: entry?.mcpConfigPath, at: Date.now() });
            }
            if (coordinatorPlan?.recovered) {
                await verifyCoordinatorRecoveryInventory(coordinatorPlan, record, host.deps.getHostedBindingOwner?.(), host.deps.listHostedCliRuntimes);
                signal?.throwIfAborted();
            }
            if (coordinatorPlan) {
                repairCoordinatorBinding(coordinatorPlan, record, host.deps.getHostedBindingOwner?.(), restoredRuntimeIds);
                // Materialization updates registry injection metadata. Do it only
                // after the unchanged-binding fence, using its current exact entry.
                // Otherwise our own prompt repair invalidates the attach snapshot.
                if (normalizedType === 'antigravity-cli' || coordinatorPlan.entry.cliType === 'antigravity-cli') {
                    try { ensureCoordinatorContextFileMaterialized(getCoordinatorForSession(record.runtimeId)); } catch { /* best-effort */ }
                }
            }
            restoredBindings.add(bindingKey);
            restored += 1;
            LOG.info('CLI', `♻ Restored hosted runtime: ${record.runtimeKey || record.runtimeId} (${record.displayName || record.workspace})`);
        } catch (error: any) {
            if (signal?.aborted || isCoordinatorRestoreConflict(error)) {
                // Release only this daemon's attachment; the retained runtime is
                // neither stopped nor sent input when recovery loses its fence.
                host.adapters.get(record.runtimeId)?.detach?.();
                host.adapters.delete(record.runtimeId);
                instanceManager.removeInstance(record.runtimeId);
                signal?.throwIfAborted();
                coordinatorPruneAllowed = false;
                diagnoseCoordinatorRestoreConflict(record.runtimeId, error);
                continue;
            }
            LOG.warn('CLI', `Failed to restore hosted runtime ${record.runtimeId}: ${error?.message || error}`);
            if (promoted || String(error?.message).startsWith('assistant_identity_conflict')) throw error;
        }
    }

    if (promoted && restored !== sessions.length) throw new Error('maintenance_incomplete_writable_promotion');
    if (!records && typeof host.deps.listHostedCliRuntimes === 'function') {
        if (coordinatorPruneAllowed) pruneStaleCoordinatorEntries(sessions, restoredRuntimeIds, owner);
        pruneStaleAssistantBinding(sessions, restoredRuntimeIds, owner);
        reconcileWorkerBindsAfterRestore(sessions, restoredRuntimeIds);
    }

    return restored;
}

/**
 * Rebuild one restored record's launch-time settings: provider settings, the
 * coordinator mark (exact owned binding or verified persisted launch),
 * and the persisted session-level mesh membership.
 */
function buildRestoredSettings(
    host: CliRestoreHost,
    record: HostedCliRuntimeDescriptor,
    normalizedType: string,
    coordinatorPlan?: CoordinatorRestorePlan,
    assistantRuntimeId?: string,
): Record<string, any> {
    const restoredSettings: Record<string, any> = { ...host.providerLoader.getSettings(normalizedType) };
    // Provider defaults cannot grant a role whose exact coordinator proof failed.
    delete restoredSettings.meshCoordinatorFor;
    const coordinatorEntry = coordinatorPlan?.entry;
    if (coordinatorEntry) {
        restoredSettings.meshCoordinatorFor = coordinatorEntry.meshId;
    }
    // RESTART-REBOUND RELAY ENVELOPE (rc.20): re-apply the session-level mesh
    // membership the launch/dispatch path persisted into the session-host
    // record meta. A rebuilt instance otherwise carries NONE of it (settings
    // are in-memory), so a rebound LOCAL mesh worker failed
    // resolveWorkerDelegateRouting (no_worker_envelope) on its very first
    // post-restart event, mesh_read_terminal / mesh_send_keys refused it as
    // non-worker, and the post-completion detach did a FULL clear
    // (launchedByCoordinator falsy) — stripping the membership a launched
    // member is supposed to KEEP. This restores membership, the work-owner
    // daemon id and the evidence attempt ref ONLY; the task markers
    // (meshActiveTaskId / dispatchNonce) are never resurrected here — the owner
    // re-resolves the session's task from its own queue row and ledger.
    const recordMeshNodeFor = typeof record.meshNodeFor === 'string' && record.meshNodeFor.trim()
        ? record.meshNodeFor.trim() : '';
    const recordMeshNodeId = typeof record.meshNodeId === 'string' && record.meshNodeId.trim()
        ? record.meshNodeId.trim() : '';
    if (recordMeshNodeFor) restoredSettings.meshNodeFor = recordMeshNodeFor;
    // The work-owner daemon, with the membership only: the remote-owner report /
    // progress / mailbox path (worker-report.ts assignmentStampReader) needs
    // membership + owner to forward, and nothing on this daemon re-derives it
    // after a restart (a remote-owned task has no queue row here).
    const recordOwner = typeof record.meshCoordinatorDaemonId === 'string' ? record.meshCoordinatorDaemonId.trim() : '';
    if (recordMeshNodeFor && recordOwner) restoredSettings.meshCoordinatorDaemonId = recordOwner;
    // The attempt ref this session's turn evidence carried, with membership +
    // owner only (it is useless without a forward target). A turn that spans a
    // restart of THIS daemon otherwise ends with an untagged turn_end the worker
    // ledger cannot forward, and the owner never sees the idle edge (live
    // 2026-10-09). A pointer, not a verdict: the owner's reducer checks its
    // generation and state, so a stale ref is recorded, never applied — and the
    // owner's later release (turn.committed) clears it here as usual.
    const recordAttemptRef = record.meshActiveAttemptRef;
    if (recordMeshNodeFor && recordOwner && recordAttemptRef?.attemptId) {
        restoredSettings.meshActiveAttemptId = recordAttemptRef.attemptId;
        restoredSettings.meshActiveAttemptGeneration = recordAttemptRef.generation;
    }
    if (recordMeshNodeId) {
        restoredSettings.meshNodeId = recordMeshNodeId;
        // Keep the sticky last-node marker consistent with the active binding
        // (attachMeshAssignment maintains the same pair at dispatch time).
        restoredSettings.meshLastNodeId = recordMeshNodeId;
    }
    if (record.launchedByCoordinator === true) {
        restoredSettings.launchedByCoordinator = true;
        if (!restoredSettings.meshCoordinatorFor) {
            const visibility = typeof record.spawnedSessionVisibility === 'string' ? record.spawnedSessionVisibility.trim() : '';
            restoredSettings.spawnedSessionVisibility = visibility || 'hidden';
        }
    } else if (typeof record.spawnedSessionVisibility === 'string' && record.spawnedSessionVisibility.trim()) {
        restoredSettings.spawnedSessionVisibility = record.spawnedSessionVisibility.trim();
    }
    // The session's own approval mode survives the restart (without it a restored
    // coordinator fell back to the provider default — auto-approve off — and asked
    // for every command).
    if (typeof record.autoApproveMode === 'string' && record.autoApproveMode.trim()) {
        restoredSettings.autoApproveMode = record.autoApproveMode.trim();
    }
    applyAssistantRestoreMark(record, restoredSettings, assistantRuntimeId);
    return restoredSettings;
}

/**
 * Restore the batch's exact binding or its one positive-provenance candidate.
 * Workspace/title alone never establishes the assistant role. Unless
 * the session carried its own approval mode, auto-approve stays OFF (a
 * provider-level `autoApprove` default must not turn on for the assistant).
 */
function applyAssistantRestoreMark(record: HostedCliRuntimeDescriptor, restoredSettings: Record<string, any>, assistantRuntimeId?: string): void {
    if (record.runtimeId !== assistantRuntimeId) return;
    restoredSettings.assistant = true;
    if (typeof restoredSettings.autoApproveMode !== 'string') {
        restoredSettings.autoApprove = false;
        delete restoredSettings.autoApproveMode;
    }
    LOG.info('CLI', `↻ Re-bound assistant session ${record.runtimeId}`);
}

/**
 * Full boot restore only: a restored worker keeps running with the session bind
 * it was spawned with (in its MCP server's env), so re-adopt the persisted bind
 * of every session that came back and drop the rows of sessions that did not.
 */
function reconcileWorkerBindsAfterRestore(sessions: HostedCliRuntimeDescriptor[], restoredRuntimeIds: ReadonlySet<string>): void {
    const live = new Set<string>(restoredRuntimeIds);
    for (const r of sessions) if (r?.runtimeId) live.add(r.runtimeId);
    try {
        const { rehydrated, pruned, deferred } = reconcileWorkerSessionBindsAfterRestore(live);
        if (rehydrated || pruned || deferred) {
            LOG.info(
                'CLI',
                `♻ Worker session binds after restore: ${rehydrated} re-adopted for restored session(s), ${pruned} pruned (session did not come back)`
                + (deferred ? `, ${deferred} kept for hosted session(s) whose restore did not register here` : ''),
            );
        }
    } catch (e: any) {
        LOG.warn('CLI', `worker session bind reconcile failed: ${e?.message || e}`);
    }
}

/** Full boot restore only: clear an assistant binding whose runtime is not live (FULL restore set). */
function pruneStaleAssistantBinding(sessions: HostedCliRuntimeDescriptor[], restoredRuntimeIds: ReadonlySet<string>, owner?: HostedBindingOwner): void {
    const live = new Set<string>(restoredRuntimeIds);
    for (const r of sessions) if (r?.runtimeId) live.add(r.runtimeId);
    try {
        const cleared = getAssistantRegistry().pruneAfterRestore(live, owner);
        if (cleared) LOG.info('CLI', `🧹 Cleared stale assistant binding ${cleared}: not among the ${live.size} live hosted runtime(s)`);
    } catch (e: any) {
        LOG.warn('CLI', `assistant binding prune failed: ${e?.message || e}`);
    }
}

/** Full boot inventory may prune only stale entries owned by this host. */
function pruneStaleCoordinatorEntries(
    sessions: HostedCliRuntimeDescriptor[],
    restoredRuntimeIds: ReadonlySet<string>,
    owner?: HostedBindingOwner,
): void {
    const liveSessionIds = new Set<string>(restoredRuntimeIds);
    for (const r of sessions) {
        if (r?.runtimeId) liveSessionIds.add(r.runtimeId);
    }
    for (const entry of pruneDeadMeshCoordinators(liveSessionIds, owner)) {
        LOG.info(
            'CLI',
            `🧹 Pruned stale mesh coordinator entry ${entry.sessionId} (mesh ${entry.meshId}${entry.workspace ? ` @ ${entry.workspace}` : ''}, started ${new Date(entry.startedAt || 0).toISOString()}): session is not among the ${liveSessionIds.size} live hosted runtime(s) after daemon restart`
        );
    }
}
