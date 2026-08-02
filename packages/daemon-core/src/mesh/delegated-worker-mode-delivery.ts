import { loadRepoMeshJsonConfig } from '../config/mesh-json-config.js';
import { LOG } from '../logging/logger.js';
import {
    resolveDelegatedWorkerAutoApprove,
    resolveDelegatedWorkerDangerousModeAllow,
} from '../repo-mesh-types.js';
import type { ProviderModule } from '../providers/contracts.js';

/**
 * REMOTE-NODE-AUTO-APPROVE-MODE-DELIVERY.
 *
 * The delegated-worker auto-approve MODE is chosen from the repo-shared
 * `.adhdev/mesh.json` (`providerDefaults.autoApproveModes[providerType]`). The
 * coordinator computes that choice up front and ships it inside the launch
 * envelope (`settings.autoApproveMode`) — but it computes it by reading
 * `node.workspace` on the COORDINATOR's filesystem. For a REMOTE node that path
 * belongs to the worker machine and cannot exist locally, so the read fails and
 * the repo's explicit request is silently replaced by the provider spec default.
 *
 * AUTHORITY: the WORKER's own checkout is authoritative for the MODE.
 *   - The repo config is a property of the checkout the agent will actually run
 *     in. When coordinator and worker sit on different branches/commits, the
 *     mode that matches the code under the agent's cwd is the correct one.
 *   - It is the only copy that is guaranteed readable at launch time; the
 *     coordinator's read of a remote path is structurally impossible.
 *   - The coordinator's cwd fallback (loadRepoMeshJsonConfig probes process.cwd()
 *     when the workspace has no config) actively MISATTRIBUTES the coordinator's
 *     own mesh.json to a remote node. Re-resolving on the worker removes that.
 *
 * SAFETY — this function only ever moves the MODE, never the ENABLE decision and
 * never the DANGEROUS opt-in:
 *   ① ENABLE stays coordinator-owned. It is a MACHINE-LOCAL policy
 *      (mesh/node `delegatedWorkerAutoApprove`) that lives in the coordinator's
 *      meshes.json, NOT in the repo, so the worker has no authority over it. When
 *      the coordinator resolved ENABLE=false the envelope carries
 *      `autoApprove:false` with no mode, and we return untouched.
 *   ② DANGEROUS stays coordinator-owned too: the machine-local opt-in is
 *      forwarded as `delegatedWorkerDangerousModeAllow` and we feed it straight
 *      back into the resolver, so a repo-requested dangerous mode is still
 *      downgraded on the worker exactly as it would be on the coordinator.
 *   ③ A missing/unreadable/invalid repo config keeps the coordinator's envelope
 *      value verbatim — the pre-fix behavior — so nodes without a repo config are
 *      unaffected.
 */

export type DelegatedWorkerModeSource =
    /** Session was not launched by a coordinator — nothing to re-resolve. */
    | 'not_delegated'
    /** Coordinator resolved ENABLE=false; mode selection never runs. */
    | 'enable_gate_off'
    /** Provider declares no autoApproveModes (legacy boolean provider). */
    | 'no_provider_modes'
    /** No readable repo config in the worker workspace → keep the envelope value. */
    | 'no_repo_config'
    /** Repo config read from the WORKER filesystem decided the mode. */
    | 'worker_repo_file';

export interface DelegatedWorkerModeResolution {
    /** The mode the worker should launch with, or undefined when none applies. */
    autoApproveMode: string | undefined;
    /** True when re-resolution changed the mode the coordinator shipped. */
    changed: boolean;
    source: DelegatedWorkerModeSource;
}

export interface DelegatedWorkerModeInput {
    /** The worker's own on-disk workspace (the resolved launch directory). */
    workspace: string | undefined;
    providerType: string | undefined;
    provider: Pick<ProviderModule, 'autoApproveModes'> | null | undefined;
    /** The launch envelope settings shipped by the coordinator. */
    settings: Record<string, unknown> | undefined;
}

/**
 * Re-resolve the delegated-worker auto-approve MODE against the worker's own
 * repo checkout at launch time. Returns the envelope value unchanged whenever the
 * worker has nothing better to say.
 */
export function resolveDelegatedWorkerAutoApproveModeForLaunch(
    input: DelegatedWorkerModeInput,
): DelegatedWorkerModeResolution {
    const settings = input.settings;
    const envelopeMode = typeof settings?.autoApproveMode === 'string' && settings.autoApproveMode.trim()
        ? settings.autoApproveMode.trim()
        : undefined;

    // Only coordinator-delegated worker launches carry this policy at all.
    if (settings?.launchedByCoordinator !== true) {
        return { autoApproveMode: envelopeMode, changed: false, source: 'not_delegated' };
    }

    // ① ENABLE gate is machine-local and coordinator-owned. `autoApprove:false`
    //    means the owner opted this mesh/node out entirely — a repo-requested mode
    //    must never re-enable it (the documented PRIORITY INVERSION GUARD).
    if (settings.autoApprove === false) {
        return { autoApproveMode: undefined, changed: false, source: 'enable_gate_off' };
    }

    const providerType = typeof input.providerType === 'string' ? input.providerType.trim() : '';
    if (!providerType || !input.provider?.autoApproveModes) {
        return { autoApproveMode: envelopeMode, changed: false, source: 'no_provider_modes' };
    }

    const workspace = typeof input.workspace === 'string' ? input.workspace.trim() : '';
    if (!workspace) {
        return { autoApproveMode: envelopeMode, changed: false, source: 'no_repo_config' };
    }

    let repoConfig = null as ReturnType<typeof loadRepoMeshJsonConfig>['config'] | null;
    try {
        // Read the WORKER workspace explicitly. We deliberately reject anything
        // that did not come from a real repo file in this workspace — including
        // the loader's process.cwd() fallback, which on a daemon serving several
        // workspaces would attribute an unrelated checkout's config to this launch.
        const result = loadRepoMeshJsonConfig(workspace);
        const fromThisWorkspace = result.sourceType === 'repo_file'
            && typeof result.path === 'string'
            && isPathInsideWorkspace(result.path, workspace);
        repoConfig = fromThisWorkspace && result.config ? result.config : null;
    } catch {
        repoConfig = null;
    }

    const requestedMode = repoConfig?.providerDefaults?.autoApproveModes?.[providerType];
    const requestedModeId = typeof requestedMode === 'string' && requestedMode.trim() ? requestedMode.trim() : '';
    if (!requestedModeId) {
        return { autoApproveMode: envelopeMode, changed: false, source: 'no_repo_config' };
    }

    // ② + ③: run the SAME resolver the coordinator runs, with the machine-local
    //    dangerous opt-in the coordinator forwarded. ENABLE is passed as true
    //    because the false case already returned above.
    const dangerousAllowed = settings.delegatedWorkerDangerousModeAllow === true;
    const resolved = resolveDelegatedWorkerAutoApprove(
        { delegatedWorkerAutoApprove: true, delegatedWorkerDangerousModeAllow: dangerousAllowed },
        undefined,
        input.provider,
        repoConfig,
        providerType,
    );
    if (typeof resolved !== 'string') {
        return { autoApproveMode: envelopeMode, changed: false, source: 'no_repo_config' };
    }

    return {
        autoApproveMode: resolved,
        changed: resolved !== envelopeMode,
        source: 'worker_repo_file',
    };
}

/**
 * Guard the loader's process.cwd() fallback: only accept a config file that
 * actually lives under the workspace we asked about.
 */
function isPathInsideWorkspace(configPath: string, workspace: string): boolean {
    const normalize = (value: string) => value.replace(/[\\/]+$/, '');
    const ws = normalize(workspace);
    if (!ws) return false;
    const separatorAgnostic = (value: string) => value.replace(/\\/g, '/');
    const normalizedPath = separatorAgnostic(configPath);
    const normalizedWs = separatorAgnostic(ws);
    return normalizedPath === normalizedWs || normalizedPath.startsWith(`${normalizedWs}/`);
}

/**
 * Observability for the previously SILENT downgrade. Emitted at launch time on
 * the machine that actually runs the worker, so the log names the workspace whose
 * config decided (or failed to decide) the mode.
 *
 * Fires in exactly two cases:
 *   - `repo_mode_applied`: the worker's checkout requested a mode that differs
 *     from what the coordinator shipped. This is the positive signal that the fix
 *     is live — on a remote node it is what turns `pty-parse` back into `auto`.
 *   - `repo_mode_unavailable`: the coordinator shipped a mode but the worker found
 *     no readable repo config, so the envelope value stands. This is the case that
 *     used to be invisible.
 */
export function logDelegatedWorkerModeDelivery(
    resolution: DelegatedWorkerModeResolution,
    context: { workspace?: string; providerType?: string; meshNodeId?: string; envelopeMode?: string },
): void {
    if (resolution.source !== 'worker_repo_file' && resolution.source !== 'no_repo_config') return;

    const node = context.meshNodeId || 'unknown-node';
    const workspace = context.workspace || 'unknown-workspace';
    const provider = context.providerType || 'unknown-provider';

    if (resolution.source === 'worker_repo_file' && resolution.changed) {
        LOG.info(
            'MeshWorker',
            `auto-approve mode re-resolved from worker repo config: node=${node} workspace=${workspace} `
            + `provider=${provider} coordinatorMode=${context.envelopeMode ?? '(none)'} `
            + `workerMode=${resolution.autoApproveMode}`,
        );
        return;
    }

    if (resolution.source === 'no_repo_config' && context.envelopeMode) {
        LOG.warn(
            'MeshWorker',
            `auto-approve mode NOT confirmed by worker repo config (keeping coordinator value): `
            + `node=${node} workspace=${workspace} provider=${provider} mode=${context.envelopeMode} `
            + `— no readable .adhdev/mesh.json in this workspace`,
        );
    }
}
