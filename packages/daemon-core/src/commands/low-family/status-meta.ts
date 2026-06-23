/**
 * RF-ROUTER LOW family — status/metadata + user-name commands.
 *
 * Extracted verbatim from DaemonCommandRouter.executeDaemonCommand. Each handler
 * reads only ctx.deps (+ process-global config/status builders) and returns the
 * same CommandRouterResult the inlined case did. get_session_info aggregates the
 * session/coordinator registries the router already holds via deps; none of these
 * touch the router's inline-mesh cache or other instance state.
 */
import { loadConfig, updateConfig } from '../../config/config.js';
import { buildMachineInfo, buildStatusSnapshot } from '../../status/snapshot.js';
import { getDaemonBuildInfo } from '../../build-info.js';
import { getCoordinatorForSession } from '../../mesh/coordinator-registry.js';
import type { LowFamilyContext, LowFamilyHandler } from './types.js';

export const statusMetaHandlers: Record<string, LowFamilyHandler> = {
    set_user_name: async (_ctx: LowFamilyContext, args: any) => {
        const name = args?.userName;
        if (!name || typeof name !== 'string') throw new Error('userName required');
        updateConfig({ userName: name });
        return { success: true, userName: name };
    },

    get_status_metadata: async (ctx: LowFamilyContext, _args: any) => {
        const snapshot = buildStatusSnapshot({
            allStates: ctx.deps.instanceManager.collectAllStates(),
            cdpManagers: ctx.deps.cdpManagers,
            providerLoader: ctx.deps.providerLoader,
            detectedIdes: ctx.deps.detectedIdes.value,
            instanceId: ctx.deps.statusInstanceId || loadConfig().machineId || 'daemon',
            version: ctx.deps.statusVersion || 'unknown',
            profile: 'metadata',
        });
        // Surface the daemon's build stamp so coordinators (mesh_status)
        // can detect a running daemon that predates a just-merged fix and
        // is awaiting deploy/restart. Sibling of `status` to avoid
        // perturbing the dashboard status snapshot shape.
        return { success: true, status: snapshot, daemonBuild: getDaemonBuildInfo() };
    },

    get_machine_runtime_stats: async (_ctx: LowFamilyContext, _args: any) => {
        return {
            success: true,
            machine: buildMachineInfo('full'),
            timestamp: Date.now(),
        };
    },

    // Session-info popup data. Aggregates whatever the daemon knows
    // about a single live session into one envelope so the dashboard
    // doesn't need to stitch together status + coordinator registry +
    // session registry on the client. Includes the actual system
    // prompt that was injected at launch when the session is a mesh
    // coordinator — that's the "what prompt did the agent see?"
    // question the info-icon dialog is meant to answer.
    get_session_info: async (ctx: LowFamilyContext, args: any) => {
        const sessionId = typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim()
            : typeof args?.sessionId === 'string' ? args.sessionId.trim() : '';
        if (!sessionId) return { success: false, error: 'targetSessionId required' };
        // Fetch both lookups up front. We used to bail with "Session not
        // found" when sessionRegistry forgot the SID (auto-cleanup,
        // daemon restart with the session not yet restored, etc), which
        // hid the coordinator-side metadata even though the
        // coordinator-registry still has it. Now we return whichever
        // side we have. The dashboard renders "no coordinator-specific
        // prompt" only when *neither* side knows the session.
        const target = ctx.deps.sessionRegistry.get(sessionId);
        const coord = getCoordinatorForSession(sessionId);
        if (!target && !coord) return { success: false, error: 'Session not found', sessionId };
        const adapter = target
            ? ctx.deps.cliManager.findAdapter(target.providerType, { instanceKey: sessionId })?.adapter
            : undefined;
        const runtimeMeta = (adapter && typeof (adapter as any).getRuntimeMetadata === 'function')
            ? (adapter as any).getRuntimeMetadata()
            : undefined;
        // Launch metadata (args / cwd / extra-env keys / providerSessionId) is
        // derived from the live adapter's spawn plan; only available while the
        // adapter is alive (resumed-from-history sessions report nothing here).
        const launchInfo = (adapter && typeof (adapter as any).getLaunchInfo === 'function')
            ? (adapter as any).getLaunchInfo()
            : undefined;
        const providerType = target?.providerType || coord?.cliType || '';
        const providerMetaForSession = providerType
            ? ctx.deps.providerLoader.resolve?.(providerType) || ctx.deps.providerLoader.getMeta(providerType)
            : undefined;
        return {
            success: true,
            session: {
                sessionId,
                providerType,
                providerName: providerMetaForSession?.name,
                transport: target?.transport,
                workspace: (target as any)?.workspace || coord?.workspace,
                spawnedAtMs: (target as any)?.spawnedAtMs || coord?.startedAt,
                // providerSessionId now comes from the live adapter's launch info
                // (the registry target never carried it — it was always undefined).
                providerSessionId: launchInfo?.providerSessionId || (target as any)?.providerSessionId,
                runtimeMetadata: runtimeMeta,
                launch: launchInfo,
            },
            coordinator: coord ? {
                meshId: coord.meshId,
                startedAt: coord.startedAt,
                cliType: coord.cliType,
                systemPrompt: coord.systemPrompt,
                extraSystemPrompt: coord.extraSystemPrompt,
                injection: coord.injection,
                mcpConfigPath: coord.mcpConfigPath,
            } : null,
        };
    },
};
