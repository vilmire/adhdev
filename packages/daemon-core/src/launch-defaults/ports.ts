import { evaluateProviderQuotaGate } from '../mesh/mesh-quota-routing.js';
import { liveLocalQuotaForRouting } from '../mesh/mesh-quota-sources.js';
/** Production adapters for the existing defaults core. No launch effects,
 * catalog refreshes, repo config, browser state or parallel persistence. */
import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { getConfigDir } from '../config/config.js';
import { readMeshConfigFromDisk, saveMeshConfigDurable, withStrictMeshConfigWriteLock } from '../config/mesh-config-store.js';
import { resolveMeshHostStatus } from '../mesh/mesh-host-ownership.js';
import { resolveAssistantProject } from '../assistant/assistant-projects.js';
import { describeAssistantEligibility } from '../assistant/assistant-launch-plan.js';
import { getAssistantServices } from '../assistant/assistant-services.js';
import { getAssistantRegistry } from '../assistant/assistant-registry.js';
import { resolveMeshCoordinatorSetup } from '../commands/mesh-coordinator.js';
import { readModelCache } from '../models/registry.js';
import { LaunchDefaultsStore, isLaunchDefaultsDocument } from './store.js';
import { hasOnlyKeys, isRecord, type LaunchValidationPorts } from './validate.js';
import type { HighFamilyContext } from '../commands/high-family/types.js';
import type { HostProjectLaunchState, LaunchDefaultsCommandPorts, LaunchDefaultsProjectPort } from '../commands/high-family/launch-defaults.js';
import type { LocalMeshEntry } from '../repo-mesh-types.js';

// coordinatorLaunch is a sibling of coordinator; a clear retains the CAS token.
function stateOf(mesh: LocalMeshEntry): HostProjectLaunchState | null {
    const raw: unknown = mesh.coordinatorLaunch;
    if (raw === undefined) return { projectId: mesh.id, revision: 0, entry: null };
    if (!isRecord(raw) || !hasOnlyKeys(raw, ['version', 'revision', 'entry']) || raw.version !== 1
        || !Number.isSafeInteger(raw.revision) || (raw.revision as number) < 1) return null;
    if (raw.entry !== null && (!isRecord(raw.entry) || raw.entry.revision !== raw.revision
        || !isLaunchDefaultsDocument({ version: 1, revision: raw.revision, coordinator: raw.entry, history: [] }))) return null;
    return { projectId: mesh.id, revision: raw.revision as number, entry: raw.entry as HostProjectLaunchState['entry'] };
}

export function createLaunchValidationPorts(ctx: { deps: Pick<HighFamilyContext['deps'], 'providerLoader'> }, configDir = getConfigDir()): LaunchValidationPorts {
    const loader = ctx.deps.providerLoader;
    return {
        resolveAlias: value => loader.resolveAlias(value, ['cli']),
        getProvider: (type, model) => {
            const manifest = loader.getMeta(type);
            if (!manifest) return undefined;
            const availability = loader.getAvailableProviderInfos().find(p => p.type === type);
            const setup = resolveMeshCoordinatorSetup({ provider: manifest, cliType: type, meshId: '', workspace: configDir,
                adhdevMcpCommand: 'adhdev', adhdevMcpTransport: 'ipc', adhdevMcpPort: 1 });
            return { type: manifest.type, category: manifest.category, enabled: availability?.enabled === true,
                detected: availability?.installed === true,
                quotaGated: !!evaluateProviderQuotaGate({}, type, null, Date.now(), {
                    liveLocalQuota: liveLocalQuotaForRouting(() => true), suppressObservabilityLogs: true,
                }, { model }),
                assistant: describeAssistantEligibility({ cliType: type, provider: manifest, configDir }),
                coordinator: setup.kind === 'unsupported' ? 'unsupported' : setup.kind === 'manual' ? 'manual' : 'supported',
                modelLaunchArgs: manifest.modelLaunchArgs, modelOptions: manifest.modelOptions,
                modelLaunchValueMap: manifest.modelLaunchValueMap, discovery: readModelCache(type),
                thinkingLaunchArgs: manifest.thinkingLaunchArgs, thinkingLevelOptions: manifest.thinkingLevelOptions,
                runtimeThinking: !!manifest.thinkingControlId && !!manifest.controls?.some(control =>
                    control.id === manifest.thinkingControlId && !!control.setScript),
            };
        },
    };
}

function createHostProjectPort(ctx: Pick<HighFamilyContext, 'deps'>): LaunchDefaultsProjectPort {
    let transactionOpen = false;
    const read = (ref: string) => {
        // Same host-owned meshes.json inventory as getMesh, without its migration
        // write path: inspecting defaults must never persist unrelated changes.
        const config = readMeshConfigFromDisk();
        if (!config) return { ok: false as const, code: 'project_storage_unavailable' as const };
        const resolved = resolveAssistantProject(ref, config.meshes);
        if (!resolved.ok) return { ok: false as const, code: resolved.code };
        const host = resolveMeshHostStatus(resolved.mesh, { localDaemonId: ctx.deps.statusInstanceId });
        if (!ctx.deps.statusInstanceId || !host.canOwnCoordinator || !host.hostDaemonId
            || !daemonIdsEquivalent(host.hostDaemonId, ctx.deps.statusInstanceId)) {
            return { ok: false as const, code: 'project_not_hosted' as const };
        }
        const state = stateOf(resolved.mesh);
        return state ? { ok: true as const, state } : { ok: false as const, code: 'project_storage_unavailable' as const };
    };
    return {
        read,
        withWriteLock: operation => withStrictMeshConfigWriteLock(() => {
            const prior = transactionOpen;
            transactionOpen = true;
            try { return operation(); } finally { transactionOpen = prior; }
        }),
        replace: next => {
            if (!transactionOpen) return { ok: false, reason: 'strict_write_lock_required', committed: false };
            const current = read(next.projectId);
            if (!current.ok) return { ok: false, reason: current.code, committed: false };
            if (current.state.revision !== next.revision - 1) return { ok: false, reason: 'revision_conflict', committed: false };
            const config = readMeshConfigFromDisk();
            const mesh = config?.meshes.find(m => m.id === next.projectId);
            if (!config || !mesh) return { ok: false, reason: 'project_storage_unavailable', committed: false };
            // Touch only this host's sibling override, retaining every other byte
            // of domain data (including unrelated/root extension properties).
            mesh.coordinatorLaunch = {
                version: 1, revision: next.revision, entry: next.entry,
            };
            return saveMeshConfigDurable(config);
        },
    };
}

const instances = new WeakMap<HighFamilyContext['deps'], { configDir: string; ports: LaunchDefaultsCommandPorts }>();
export class LaunchDefaultsCatalogError extends Error {}
/** Shared by command dispatch and later launch integrations on this router. */
export function getLaunchDefaultsCommandPorts(ctx: Pick<HighFamilyContext, 'deps'>): LaunchDefaultsCommandPorts {
    const configDir = getConfigDir();
    const existing = instances.get(ctx.deps);
    if (existing?.configDir === configDir) return existing.ports;
    const validation = createLaunchValidationPorts(ctx, configDir);
    const ports: LaunchDefaultsCommandPorts = {
        store: new LaunchDefaultsStore(configDir, validation), validation, projects: createHostProjectPort(ctx),
        assistantContext: sessionId => {
            const log = getAssistantServices().inputLog;
            return { origin: log.writeContext(sessionId).origin, reviewTurnOpen: !!sessionId && log.isReviewTurnOpen(sessionId) };
        },
        currentAssistantToolRestriction: () => {
            // The registry supplies ONLY the exact live binding, never a provider
            // preference. No sticky cliType or implicit provider enters resolution.
            const sessionId = getAssistantRegistry().read()?.sessionId;
            const live = sessionId ? ctx.deps.instanceManager.getInstance(sessionId) : undefined;
            if (!live) return undefined;
            const eligibility = describeAssistantEligibility({ cliType: live.type,
                provider: ctx.deps.providerLoader.getMeta(live.type), configDir });
            if (!eligibility.supported) throw new LaunchDefaultsCatalogError('Cannot verify the active assistant tool restriction.');
            return eligibility.toolRestriction;
        },
        get stage() {
            // Read the current service when used, including after a service
            // replacement. Missing Inbox authority remains staging_unavailable.
            const inbox = getAssistantServices().launchDefaults;
            if (!inbox) return undefined;
            return (proposal: Parameters<NonNullable<LaunchDefaultsCommandPorts['stage']>>[0]) => {
                const stored = ports.store.read();
                // Only an explicit global bootstrap may stage an absent file.
                // Invalid/unreadable evidence must never become revision zero.
                if (stored.status !== 'ok' && !(stored.status === 'missing'
                    && !proposal.project && proposal.expectedRevision === 0)) {
                    throw new Error('Launch-default setup cannot be read for staging.');
                }
                return inbox.write(proposal, {
                    documentRevision: stored.status === 'ok' ? stored.document.revision : 0,
                });
            };
        },
    };
    instances.set(ctx.deps, { configDir, ports });
    return ports;
}
