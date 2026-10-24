import { parseSessionLaunchRecord } from '@adhdev/mesh-shared';
import type { HostedCliRuntimeDescriptor } from './cli-manager.js';
import { persistedBindingEvidence, readHostedBindingOwner, resolveHostedBindingOwner, sameHostedBindingOwner,
    type HostedBindingOwner } from '../session-host/binding-owner.js';
import { getCoordinatorForSession, listCoordinatorsForMesh, loadMeshCoordinatorRegistry, registerMeshCoordinator,
    type CoordinatorRegistryEntry } from '../mesh/coordinator-registry.js';
import { readCoordinatorMeshAssociation } from '../session-host/coordinator-association.js';
import { LOG } from '../logging/logger.js';
import { shouldRestoreHostedRuntime } from './hosted-runtime-restore.js';

function refuseCoordinatorRestore(reason: string): never {
    throw Object.assign(new Error('coordinator_identity_conflict: ' + reason), { code: 'coordinator_identity_conflict' });
}

export function isCoordinatorRestoreConflict(error: unknown): boolean {
    return !!error && typeof error === 'object' && ('code' in error && error.code === 'coordinator_identity_conflict'
        || 'message' in error && typeof error.message === 'string' && error.message.startsWith('coordinator_identity_'));
}

/** A refused role is a per-runtime diagnostic, never authority to block its peers. */
export function diagnoseCoordinatorRestoreConflict(runtimeId: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : 'coordinator evidence unverifiable';
    LOG.warn('CLI', `coordinator_identity_conflict: runtime ${runtimeId} coordinator role refused: ${detail}`);
}

export interface CoordinatorRestorePlanning {
    plans: Map<string, CoordinatorRestorePlan>;
    registryAvailable: boolean;
}

function readCoordinatorEvidence(sessionId: string) {
    try { return persistedBindingEvidence(sessionId); }
    catch { refuseCoordinatorRestore('persisted coordinator evidence unavailable or invalid'); }
}

function hasCoordinatorLaunch(record: HostedCliRuntimeDescriptor): boolean {
    const launch = parseSessionLaunchRecord(record.launchRecord);
    return !!launch && launch.sessionId === record.runtimeId && launch.providerType === record.cliType
        && (!launch.workspace || launch.workspace === record.workspace)
        && launch.roleLaunch?.role === 'coordinator' && launch.roleLaunch.selection.provider === record.cliType
        && (launch.launchedBy === 'mesh' || launch.launchedBy === 'restore');
}

/** Missing registry recovery requires independent exact persisted evidence in this
 * host's namespace. Neither a caller-supplied descriptor nor workspace/title can
 * confer a role. A legacy mark without launch provenance needs an exact registry row. */
function verifyPersistedCoordinator(record: HostedCliRuntimeDescriptor, owner?: HostedBindingOwner): void {
    if (!readHostedBindingOwner(owner) || !owner?.namespace || record.managedBy !== owner.managedBy
        || !Number.isFinite(record.startedAtMs) || !(record.startedAtMs! > 0)
        || !hasCoordinatorLaunch(record)) refuseCoordinatorRestore('unverified coordinator launch or host owner');
    if (record.assistant === true) refuseCoordinatorRestore('conflicting assistant and coordinator roles');
    const evidence = readCoordinatorEvidence(record.runtimeId);
    if (evidence.length !== 1 || evidence[0].namespace !== owner.namespace || evidence[0].terminal) {
        refuseCoordinatorRestore('missing, foreign, ambiguous or terminated runtime evidence');
    }
    const persisted = evidence[0].record;
    if (persisted.category !== 'cli' || !['running', 'interrupted'].includes(persisted.lifecycle)
        || persisted.providerType !== record.cliType || persisted.workspace !== record.workspace
        || persisted.meta?.managedBy !== owner.managedBy || persisted.meta?.assistant === true
        || persisted.meta?.providerSessionId !== record.providerSessionId
        || persisted.startedAt !== record.startedAtMs
        || readCoordinatorMeshAssociation(persisted.meta?.meshCoordinatorFor) !== record.meshCoordinatorFor
        || !hasCoordinatorLaunch({ ...record, launchRecord: persisted.meta?.launchRecord })) {
        refuseCoordinatorRestore('persisted runtime identity or coordinator provenance does not match');
    }
}

export interface CoordinatorRestorePlan {
    entry: CoordinatorRegistryEntry;
    /** Compare again after attach so another binding generation cannot be overwritten. */
    registrySnapshot: string;
    recovered: boolean;
}

function meshSnapshot(meshId: string): string {
    return JSON.stringify(listCoordinatorsForMesh(meshId));
}

function planCoordinatorRestore(record: HostedCliRuntimeDescriptor, owner: HostedBindingOwner | undefined,
    liveIds: ReadonlySet<string>): CoordinatorRestorePlan | undefined {
    const exact = getCoordinatorForSession(record.runtimeId);
    const meshId = readCoordinatorMeshAssociation(record.meshCoordinatorFor);
    let owned = false;
    try {
        owned = !!exact && sameHostedBindingOwner(
            resolveHostedBindingOwner(exact.sessionId, exact.hostOwner, owner, liveIds), owner);
    } catch { refuseCoordinatorRestore('coordinator binding owner unverifiable'); }
    if (exact && !owned) {
        if (meshId) refuseCoordinatorRestore('exact binding belongs to a foreign or unknown host');
        return undefined;
    }
    if (!exact && !meshId) return undefined;
    const evidence = readCoordinatorEvidence(record.runtimeId);
    if (evidence.some(e => e.namespace === owner?.namespace && e.terminal)) refuseCoordinatorRestore('terminated coordinator runtime');
    if (exact && ((meshId && meshId !== exact.meshId) || (exact.cliType && exact.cliType !== record.cliType)
        || (exact.workspace && exact.workspace !== record.workspace))) refuseCoordinatorRestore('registry and runtime identity disagree');
    // Existing exact bindings remain the authority for legacy records. New
    // recovery requires the mark AND validated persisted launch provenance.
    const recovered = !exact;
    if (recovered || (meshId && record.launchRecord !== undefined)) verifyPersistedCoordinator(record, owner);
    const entry: CoordinatorRegistryEntry = exact ? { ...exact, hostOwner: owner } : {
        sessionId: record.runtimeId, meshId: meshId!, cliType: record.cliType, workspace: record.workspace,
        startedAt: record.startedAtMs ?? 0, hostOwner: owner,
    };
    if (listCoordinatorsForMesh(entry.meshId).some(e => e.sessionId !== record.runtimeId)) {
        refuseCoordinatorRestore('another coordinator binding already exists for this mesh');
    }
    return { entry, registrySnapshot: meshSnapshot(entry.meshId), recovered };
}

export function planCoordinatorRestores(records: HostedCliRuntimeDescriptor[], owner: HostedBindingOwner | undefined,
    liveIds: ReadonlySet<string>, inventory = records): CoordinatorRestorePlanning {
    const plans = new Map<string, CoordinatorRestorePlan>();
    try { loadMeshCoordinatorRegistry({ strict: true }); }
    catch (error) {
        for (const record of records) {
            if (record.meshCoordinatorFor || getCoordinatorForSession(record.runtimeId)) {
                diagnoseCoordinatorRestoreConflict(record.runtimeId, error);
            }
        }
        return { plans, registryAvailable: false };
    }
    for (const record of records) {
        try {
            const plan = planCoordinatorRestore(record, owner, liveIds);
            if (!plan) continue;
            // A verified exact registry owner wins over unbound retained marks.
            // Only missing-row recovery must exclude all competing candidates,
            // including starting/stopping and foreign-managed hosted sessions.
            if (plan.recovered && inventory.some(peer => peer.runtimeId !== record.runtimeId
                && (!peer.lifecycle || ['starting', 'running', 'stopping', 'interrupted'].includes(peer.lifecycle))
                && readCoordinatorMeshAssociation(peer.meshCoordinatorFor) === plan.entry.meshId)) {
                refuseCoordinatorRestore('another hosted coordinator candidate exists for this mesh');
            }
            plans.set(record.runtimeId, plan);
        } catch (error) {
            diagnoseCoordinatorRestoreConflict(record.runtimeId, error);
        }
    }
    return { plans, registryAvailable: true };
}

/** Called only after attach succeeds and its cancellation fence passes. Keep
 * cleanup/prompt ownership only when an existing exact entry supplied it. */
export function repairCoordinatorBinding(plan: CoordinatorRestorePlan, record: HostedCliRuntimeDescriptor,
    owner: HostedBindingOwner | undefined, liveIds: ReadonlySet<string>): void {
    loadMeshCoordinatorRegistry({ strict: true });
    if (meshSnapshot(plan.entry.meshId) !== plan.registrySnapshot) refuseCoordinatorRestore('binding changed during attach');
    if (plan.recovered) verifyPersistedCoordinator(record, owner);
    const current = planCoordinatorRestore(record, owner, liveIds);
    if (!current || current.entry.meshId !== plan.entry.meshId) refuseCoordinatorRestore('coordinator identity changed during attach');
    registerMeshCoordinator(current.entry);
}

/** A partial adoption cannot certify the absence of a newer hosted coordinator.
 * Require the trusted endpoint's complete census, including after awaited attach. */
export async function verifyCoordinatorRecoveryInventory(plan: CoordinatorRestorePlan, record: HostedCliRuntimeDescriptor,
    owner: HostedBindingOwner | undefined, list?: () => Promise<HostedCliRuntimeDescriptor[]>): Promise<void> {
    if (!list) refuseCoordinatorRestore('complete hosted inventory required for coordinator recovery');
    let inventory: HostedCliRuntimeDescriptor[];
    try { inventory = await list(); } catch { refuseCoordinatorRestore('coordinator recovery inventory unavailable'); }
    if (!Array.isArray(inventory)) refuseCoordinatorRestore('coordinator recovery inventory unavailable');
    const eligible = inventory.filter(r => (!r.lifecycle || ['running', 'interrupted'].includes(r.lifecycle))
        && shouldRestoreHostedRuntime(r, owner?.managedBy));
    const exact = eligible.find(r => r.runtimeId === record.runtimeId);
    if (!exact || exact.cliType !== record.cliType || exact.workspace !== record.workspace
        || exact.startedAtMs !== record.startedAtMs || exact.providerSessionId !== record.providerSessionId
        || exact.meshCoordinatorFor !== record.meshCoordinatorFor) refuseCoordinatorRestore('recovered runtime absent or changed in hosted inventory');
    const { plans } = planCoordinatorRestores(eligible, owner, new Set(inventory.map(r => r.runtimeId)), inventory);
    const current = plans.get(record.runtimeId);
    if (!current || current.registrySnapshot !== plan.registrySnapshot) refuseCoordinatorRestore('coordinator binding changed during recovery');
}
