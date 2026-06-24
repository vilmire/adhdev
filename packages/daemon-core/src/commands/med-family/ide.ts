/**
 * RF-ROUTER MED family — IDE lifecycle + provider/IDE detection commands.
 *
 * stop_ide, restart_ide, launch_ide, detect_provider, detect_ides. launch_ide
 * spawns the IDE, connects CDP, registers extension providers and refreshes
 * detection. restart_ide stops (with kill) then launches.
 *
 * launch_ide self-recursion: the original case bodies for restart_session
 * (cli-agent family) and restart_ide re-entered `executeDaemonCommand('launch_ide')`.
 * Lifting the launch_ide body into the module-level `launchIde(ctx, args)` helper
 * lets those handlers invoke the launch directly (ctx.launchIde) without recursing
 * back through the registry, while the launch_ide handler simply delegates to it.
 */
import { DaemonCdpManager } from '../../cdp/manager.js';
import { registerExtensionProviders } from '../../cdp/setup.js';
import { launchWithCdp } from '../../launch.js';
import { loadConfig } from '../../config/config.js';
import { loadState, saveState } from '../../config/state-store.js';
import { resolveIdeLaunchWorkspace } from '../../config/workspaces.js';
import { appendRecentActivity } from '../../config/recent-activity.js';
import { detectIDEs } from '../../detection/ide-detector.js';
import { detectCLI } from '../../detection/cli-detector.js';
import { LOG } from '../../logging/logger.js';
import type { CommandRouterResult } from '../router.js';
import type { MedFamilyContext, MedFamilyHandler } from './types.js';

/**
 * IDE launch + CDP connect. Lifted verbatim from the original `launch_ide` switch
 * case so restart_session / restart_ide can call it directly instead of recursing
 * through executeDaemonCommand. Reads the router's CDP managers and detection
 * caches via ctx.deps.
 */
export async function launchIde(ctx: MedFamilyContext, args: any): Promise<CommandRouterResult> {
    const ideKey = args?.ideId || args?.ideType;
    const resolvedWorkspace = resolveIdeLaunchWorkspace(
        {
            workspace: args?.workspace,
            workspaceId: args?.workspaceId,
            useDefaultWorkspace: args?.useDefaultWorkspace,
        },
        loadConfig(),
    );
    const launchArgs = {
        ideId: ideKey,
        workspace: resolvedWorkspace,
        newWindow: args?.newWindow,
    };
    LOG.info('LaunchIDE', `target=${ideKey || 'auto'}`);
    const result = await launchWithCdp(launchArgs);

    if (result.success && result.port && result.ideId && !ctx.deps.cdpManagers.has(result.ideId)) {
        const logFn = ctx.deps.getCdpLogFn
            ? ctx.deps.getCdpLogFn(result.ideId)
            : LOG.forComponent(`CDP:${result.ideId}`).asLogFn();
        const provider = ctx.deps.providerLoader.getMeta(result.ideId);
        const manager = new DaemonCdpManager(result.port, logFn, undefined, provider?.targetFilter);
        const connected = await manager.connect();
        if (connected) {
            // Register active extension providers for this IDE in CDP manager
            registerExtensionProviders(ctx.deps.providerLoader, manager, result.ideId);
            ctx.deps.cdpManagers.set(result.ideId, manager);
            LOG.info('CDP', `Connected: ${result.ideId} (port ${result.port})`);
            LOG.info('CDP', `${ctx.deps.cdpManagers.size} IDE(s) connected`);

            // Notify consumer (e.g. setupIdeInstance)
            ctx.deps.onCdpManagerCreated?.(result.ideId, manager);
        }
    }
    ctx.deps.onIdeConnected?.();
    try {
        const results = await detectIDEs(ctx.deps.providerLoader);
        ctx.deps.detectedIdes.value = results;
        ctx.deps.providerLoader.setIdeDetectionResults(results, true);
    } catch { /* ignore detection refresh errors */ }
    if (result.success && resolvedWorkspace) {
        try {
            const next = appendRecentActivity(loadState(), {
                kind: 'ide',
                providerType: result.ideId || ideKey,
                providerName: result.ideId || ideKey,
                workspace: resolvedWorkspace,
                title: result.ideId || ideKey,
            });
            saveState(next);
        } catch { /* ignore activity persist errors */ }
    } else if (result.success && (result.ideId || ideKey)) {
        try {
            saveState(appendRecentActivity(loadState(), {
                kind: 'ide',
                providerType: result.ideId || ideKey,
                providerName: result.ideId || ideKey,
                title: result.ideId || ideKey,
            }));
        } catch { /* ignore activity persist errors */ }
    }
    return { ...result };
}

export const ideHandlers: Record<string, MedFamilyHandler> = {
    // ─── IDE stop ───
    stop_ide: async (ctx: MedFamilyContext, args: any) => {
        const ideType = args?.ideType;
        if (!ideType) throw new Error('ideType required');
        const killProcess = args?.killProcess !== false; // default true
        await ctx.stopIde(ideType, killProcess);
        try {
            const results = await detectIDEs(ctx.deps.providerLoader);
            ctx.deps.detectedIdes.value = results;
            ctx.deps.providerLoader.setIdeDetectionResults(results, true);
        } catch { /* ignore detection refresh errors */ }
        return { success: true, ideType, stopped: true, processKilled: killProcess };
    },

    // ─── IDE restart ───
    restart_ide: async (ctx: MedFamilyContext, args: any) => {
        const ideType = args?.ideType;
        if (!ideType) throw new Error('ideType required');
        await ctx.stopIde(ideType, true); // always kill process on restart
        const launchResult = await ctx.launchIde({ ideType, enableCdp: true, workspace: args?.workspace });
        return { success: true, ideType, restarted: true, launch: launchResult };
    },

    // ─── IDE launch + CDP connect ───
    launch_ide: async (ctx: MedFamilyContext, args: any) => {
        return launchIde(ctx, args);
    },

    // ─── Detect providers ───
    detect_provider: async (ctx: MedFamilyContext, args: any) => {
        const providerType = typeof args?.providerType === 'string' ? args.providerType.trim() : '';
        if (!providerType) return { success: false, error: 'providerType is required' };
        const normalizedType = ctx.deps.providerLoader.resolveAlias(providerType);
        const provider = ctx.deps.providerLoader.getByAlias(providerType);
        if (!provider) return { success: false, error: `Provider not found: ${providerType}` };
        if (provider.category !== 'cli' && provider.category !== 'acp') {
            return { success: false, error: `Provider detection is only supported for CLI/ACP providers: ${providerType}` };
        }
        if (!ctx.deps.providerLoader.isMachineProviderEnabled(normalizedType)) {
            return { success: false, error: `Provider is disabled on this machine: ${providerType}` };
        }
        const detected = await detectCLI(normalizedType, ctx.deps.providerLoader, { includeVersion: false });
        ctx.deps.providerLoader.setCliDetectionResults([{
            id: normalizedType,
            installed: !!detected,
            path: detected?.path,
        }], false);
        ctx.deps.onStatusChange?.();
        return {
            success: true,
            providerType: normalizedType,
            detected: !!detected,
            path: detected?.path || null,
        };
    },

    // ─── Detect IDEs ───
    detect_ides: async (ctx: MedFamilyContext, _args: any) => {
        const results = await detectIDEs(ctx.deps.providerLoader);
        ctx.deps.detectedIdes.value = results;
        ctx.deps.providerLoader.setIdeDetectionResults(results, true);
        return { success: true, detectedInfo: results };
    },
};
