/**
 * DaemonCliManager — boot-time re-attach of hosted CLI runtimes
 * (`restoreHostedSessions`): rebuild each instance's launch-time settings
 * (provider settings, coordinator mark, mesh membership), register it, and
 * prune stale coordinator-registry entries.
 *
 * Split out of cli-manager.ts (file-size gate).
 */
import {
    getCoordinatorForSession, listCoordinatorsForWorkspace, pruneDeadMeshCoordinators,
} from '../mesh/coordinator-registry.js';
import { LOG } from '../logging/logger.js';
import { findAssistantRestoreRecord, getAssistantRegistry } from '../assistant/assistant-registry.js';
import { buildRestoredLaunchRecord } from '../sessions/launch-record.js';
import { shouldRestoreHostedRuntime } from './hosted-runtime-restore.js';
import { resolveCliSessionBinding } from './cli-session-binding.js';
import type { DaemonCliManager, HostedCliRuntimeDescriptor } from './cli-manager.js';

/** The DaemonCliManager members these functions read or call (compiler-checked; no cast). */
export type CliRestoreHost = Pick<DaemonCliManager, 'adapters' | 'deps' | 'providerLoader' | 'registerCliInstance'>;

export async function restoreHostedSessions(host: CliRestoreHost, records?: HostedCliRuntimeDescriptor[]): Promise<number> {
    const instanceManager = host.deps.getInstanceManager();
    if (!instanceManager) return 0;
    const sessions = records || await host.deps.listHostedCliRuntimes?.() || [];
    let restored = 0;
    const restoredBindings = new Set<string>();
    const managerTag = host.deps.hostedRuntimeManagerTag;

    // CORDBADGE worker-overbind guard pre-pass: the workspace-scoped coordinator
    // rebind fallback (below) recovers a coordinator's mark when its runtimeId
    // changed across restart. But a delegated WORKER session that shares the
    // coordinator's workspace+cliType ALSO misses the exact by-id lookup, so the
    // fallback would wrongly stamp it with the lone registered coordinator's mesh
    // mark (the reported bug: a worker shown with role:coordinator after restart).
    // Two batch-level signals let the fallback refuse to mark a worker:
    //   - restoredRuntimeIds: every runtimeId in this restore batch. If a
    //     registered coordinator's own sessionId appears here, that coordinator is
    //     being restored under its known id (the exact match binds it), so ANY
    //     other same-workspace session is a worker — not the renamed coordinator.
    //   - workspaceTypeCounts: how many sessions in the batch share a
    //     workspace+cliType. >1 means we cannot tell the coordinator from a worker
    //     even if the coordinator's id changed, so we stay unbound (ambiguous).
    const restoredRuntimeIds = new Set<string>();
    const workspaceTypeCounts = new Map<string, number>();
    for (const r of sessions) {
        if (!r?.runtimeId || !r?.cliType || !r?.workspace) continue;
        restoredRuntimeIds.add(r.runtimeId);
        const key = `${r.workspace}::${r.cliType}`;
        workspaceTypeCounts.set(key, (workspaceTypeCounts.get(key) || 0) + 1);
    }
    // STALE-COORDINATOR-PRUNE: registry entries adopted through the workspace
    // rebind fallback below. Such an entry belongs to a LIVE coordinator whose
    // runtimeId changed across restart, so its registered sessionId is (by
    // definition) absent from the live-runtime list — the post-loop prune must
    // exempt it, or the fix would delete the very entry the fallback just used
    // and reintroduce the badge loss on the NEXT restart.
    const rebindAdoptedSessionIds = new Set<string>();

    for (const record of sessions) {
        if (!record?.runtimeId || !record?.cliType || !record?.workspace) continue;
        if (!shouldRestoreHostedRuntime(record, managerTag)) {
            LOG.info(
                'CLI',
                `↷ Skipping hosted runtime restore owned by ${record.managedBy}: ${record.runtimeKey || record.runtimeId}`
            );
            continue;
        }
        if (host.adapters.has(record.runtimeId) || instanceManager.getInstance(record.runtimeId)) continue;
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
        const restoredSettings = buildRestoredSettings(host, record, normalizedType, restoredRuntimeIds, workspaceTypeCounts, rebindAdoptedSessionIds);
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
            restoredBindings.add(bindingKey);
            restored += 1;
            LOG.info('CLI', `♻ Restored hosted runtime: ${record.runtimeKey || record.runtimeId} (${record.displayName || record.workspace})`);
        } catch (error: any) {
            LOG.warn('CLI', `Failed to restore hosted runtime ${record.runtimeId}: ${error?.message || error}`);
        }
    }

    if (!records && typeof host.deps.listHostedCliRuntimes === 'function') {
        pruneStaleCoordinatorEntries(sessions, restoredRuntimeIds, rebindAdoptedSessionIds);
        pruneStaleAssistantBinding(sessions, restoredRuntimeIds);
    }

    return restored;
}

/**
 * Rebuild one restored record's launch-time settings: provider settings, the
 * coordinator mark (exact registry match, else the guarded workspace rebind),
 * and the persisted session-level mesh membership.
 */
function buildRestoredSettings(
    host: CliRestoreHost,
    record: HostedCliRuntimeDescriptor,
    normalizedType: string,
    restoredRuntimeIds: ReadonlySet<string>,
    workspaceTypeCounts: ReadonlyMap<string, number>,
    rebindAdoptedSessionIds: Set<string>,
): Record<string, any> {
    // Re-establish the launch-time settings a fresh launch applies. startSession
    // seeds every new instance with { ...providerLoader.getSettings(type), ...override };
    // passing a bare {} here on restart silently dropped TWO launch settings, so a
    // restored session diverged from a freshly-launched one:
    //   - autoApprove (a provider/machine setting from getSettings) → a restored
    //     coordinator self-session lost auto-approve and re-prompted on every tool call.
    //   - meshCoordinatorFor (the coordinator launch's settingsOverride) → the restored
    //     session was no longer recognized as this daemon's live CLI coordinator by
    //     findLiveCoordinators (so pending mesh events stopped draining into its PTY) nor
    //     surfaced with the coordinator badge via settings. The persisted coordinator
    //     registry (loaded on boot) is the source of truth to rebuild that mark.
    // Both restores are provider-agnostic — getSettings is keyed by provider type and the
    // registry mark is type-independent.
    const restoredSettings: Record<string, any> = { ...host.providerLoader.getSettings(normalizedType) };
    // Primary rebind: exact persisted-registry match by runtimeId (stable across
    // restart, see session-host runtimeId = runtimeRecord.sessionId).
    let coordinatorEntry = getCoordinatorForSession(record.runtimeId);
    // CORDBADGE fallback: the by-id match misses when a coordinator's runtime
    // re-attaches under a different runtimeId than the one it was registered with
    // (the registry survived, but its key no longer lines up). Without a rebind the
    // restored session silently loses meshCoordinatorFor → the coordinator badge and
    // selfIdentification block vanish and pending mesh events stop draining into its
    // PTY, and the only recovery is a manual coordinator restart. Recover the mark
    // from the persisted registry scoped to this exact workspace, but ONLY when it is
    // UNAMBIGUOUS: exactly one registered coordinator for this workspace AND its
    // cliType matches the restored session's type.
    //
    // WORKER-OVERBIND guard: "exactly one registered coordinator" is NOT enough —
    // a delegated worker session sharing the coordinator's workspace+cliType also
    // misses the by-id lookup, and the registry holding only the (single) real
    // coordinator does NOT stop the fallback from projecting that coordinator's
    // mark onto the worker record. So before adopting the mark we positively rule
    // the worker out:
    //   (a) coordinatorPresentById — the registered coordinator's own sessionId is
    //       in this restore batch, i.e. it is being restored under its known id and
    //       the exact match already binds it. Then THIS record (which missed) is a
    //       worker, not the renamed coordinator → do not rebind.
    //   (b) siblingCount > 1 — more than one session shares this workspace+cliType,
    //       so even if the coordinator's id changed we cannot tell it from a worker
    //       → stay unbound (ambiguous).
    // Anything ambiguous stays unbound (we would rather miss a badge than
    // mis-attribute one).
    if (!coordinatorEntry?.meshId && record.workspace) {
        const workspaceCoordinators = listCoordinatorsForWorkspace(record.workspace)
            .filter(e => e.meshId && (!e.cliType || e.cliType === record.cliType));
        if (workspaceCoordinators.length === 1) {
            const candidate = workspaceCoordinators[0];
            const coordinatorPresentById = !!candidate.sessionId && restoredRuntimeIds.has(candidate.sessionId);
            const siblingCount = workspaceTypeCounts.get(`${record.workspace}::${record.cliType}`) || 1;
            if (!coordinatorPresentById && siblingCount === 1) {
                coordinatorEntry = candidate;
                if (candidate.sessionId) rebindAdoptedSessionIds.add(candidate.sessionId);
                LOG.info(
                    'CLI',
                    `↻ Rebound coordinator mark by workspace for ${record.runtimeKey || record.runtimeId} (mesh ${candidate.meshId} @ ${record.workspace}); registry key did not match runtimeId`
                );
            } else {
                LOG.info(
                    'CLI',
                    `↷ Skipping workspace coordinator rebind for ${record.runtimeKey || record.runtimeId} (${record.cliType} @ ${record.workspace}): ${coordinatorPresentById
                        ? 'registered coordinator is restoring under its own id — this is a delegated worker'
                        : `ambiguous (${siblingCount} sessions share this workspace+cliType)`}`
                );
            }
        } else if (workspaceCoordinators.length === 0) {
            // CORDBADGE-DIAG: the by-id lookup missed AND the workspace fallback has
            // NOTHING to rebind to — the registry holds no coordinator for this
            // workspace at all (evicted registry, or the coordinator registered under
            // a different workspace). Both other branches log; this one was silent,
            // which sent the 2026-08-21 badge-loss investigation down the wrong path
            // (no 'Rebound' and no 'Skipping' line at all).
            LOG.debug(
                'CLI',
                `No registered coordinator for workspace ${record.workspace} — workspace rebind fallback empty for ${record.runtimeKey || record.runtimeId} (${record.cliType}); the session stays unmarked`
            );
        }
    }
    if (coordinatorEntry?.meshId) {
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
    // member is supposed to KEEP. This restores membership ONLY; the
    // task-level envelope (meshActiveTaskId / attemptId / dispatchNonce /
    // coordinator ids) is re-derived separately with causal guards by
    // restampReboundMeshWorkerAssignment, so no terminal/stale/
    // session-mismatched attempt is ever resurrected here.
    const recordMeshNodeFor = typeof record.meshNodeFor === 'string' && record.meshNodeFor.trim()
        ? record.meshNodeFor.trim() : '';
    const recordMeshNodeId = typeof record.meshNodeId === 'string' && record.meshNodeId.trim()
        ? record.meshNodeId.trim() : '';
    if (recordMeshNodeFor) restoredSettings.meshNodeFor = recordMeshNodeFor;
    if (recordMeshNodeId) {
        restoredSettings.meshNodeId = recordMeshNodeId;
        // Keep the sticky last-node marker consistent with the active binding
        // (attachMeshAssignment maintains the same pair at dispatch time).
        restoredSettings.meshLastNodeId = recordMeshNodeId;
    }
    if (record.launchedByCoordinator === true) restoredSettings.launchedByCoordinator = true;
    // The session's own approval mode survives the restart (without it a restored
    // coordinator fell back to the provider default — auto-approve off — and asked
    // for every command).
    if (typeof record.autoApproveMode === 'string' && record.autoApproveMode.trim()) {
        restoredSettings.autoApproveMode = record.autoApproveMode.trim();
    }
    applyAssistantRestoreMark(record, restoredSettings);
    return restoredSettings;
}

/**
 * Assistant layer (design 2026-10-07 §4.5): the assistant session re-binds by
 * EXACT runtimeId only (`findAssistantRestoreRecord`) — one assistant per
 * daemon, so no workspace fallback. The mark is `assistant: true`, and unless
 * the session carried its own approval mode, auto-approve stays OFF (a
 * provider-level `autoApprove` default must not turn on for the assistant).
 */
function applyAssistantRestoreMark(record: HostedCliRuntimeDescriptor, restoredSettings: Record<string, any>): void {
    let entry;
    try {
        entry = getAssistantRegistry().read();
    } catch {
        return;
    }
    if (!findAssistantRestoreRecord(entry, [record])) return;
    restoredSettings.assistant = true;
    if (typeof restoredSettings.autoApproveMode !== 'string') {
        restoredSettings.autoApprove = false;
        delete restoredSettings.autoApproveMode;
    }
    LOG.info('CLI', `↻ Re-bound assistant session ${record.runtimeId}`);
}

/** Full boot restore only: clear an assistant binding whose runtime is not live (FULL restore set). */
function pruneStaleAssistantBinding(sessions: HostedCliRuntimeDescriptor[], restoredRuntimeIds: ReadonlySet<string>): void {
    const live = new Set<string>(restoredRuntimeIds);
    for (const r of sessions) if (r?.runtimeId) live.add(r.runtimeId);
    try {
        const cleared = getAssistantRegistry().pruneAfterRestore(live);
        if (cleared) LOG.info('CLI', `🧹 Cleared stale assistant binding ${cleared}: not among the ${live.size} live hosted runtime(s)`);
    } catch (e: any) {
        LOG.warn('CLI', `assistant binding prune failed: ${e?.message || e}`);
    }
}

/**
 * STALE-COORDINATOR-PRUNE (boot path only): when this is the full boot-time
 * restore (no explicit records — an ad-hoc single-record restore must NEVER
 * prune), the fetched list IS the set of live hosted runtimes, so any
 * persisted coordinator entry whose sessionId is absent is a leftover from
 * a previous daemon generation: unregisterMeshCoordinator only runs on
 * explicit stop/exit paths, and an upgrade/restart takes none of them.
 * Those stale entries accumulate in mesh-coordinators.json and permanently
 * break the workspace rebind fallback's "exactly one registered
 * coordinator" unambiguity condition above (the lost-coordinator-badge
 * bug). Runs AFTER the restore loop so a live coordinator whose runtimeId
 * changed (adopted via the rebind fallback) is exempted through
 * rebindAdoptedSessionIds. The live-id set deliberately includes runtimes
 * owned by OTHER manager tags (shouldRestoreHostedRuntime skips them, but
 * they are live sessions whose entries must survive).
 */
function pruneStaleCoordinatorEntries(
    sessions: HostedCliRuntimeDescriptor[],
    restoredRuntimeIds: ReadonlySet<string>,
    rebindAdoptedSessionIds: ReadonlySet<string>,
): void {
    const liveSessionIds = new Set<string>(restoredRuntimeIds);
    for (const r of sessions) {
        if (r?.runtimeId) liveSessionIds.add(r.runtimeId);
    }
    for (const sessionId of rebindAdoptedSessionIds) liveSessionIds.add(sessionId);
    for (const entry of pruneDeadMeshCoordinators(liveSessionIds)) {
        LOG.info(
            'CLI',
            `🧹 Pruned stale mesh coordinator entry ${entry.sessionId} (mesh ${entry.meshId}${entry.workspace ? ` @ ${entry.workspace}` : ''}, started ${new Date(entry.startedAt || 0).toISOString()}): session is not among the ${liveSessionIds.size} live hosted runtime(s) after daemon restart`
        );
    }
}
