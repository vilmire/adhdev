/**
 * DaemonCommandRouter — Unified command routing for daemon-level commands
 *
 * Unified command routing for daemon-level commands.
 *
 * Routing flow:
 *   1. Daemon-level commands (launch_ide, stop_ide, restart_ide, etc.) → handled here
 *   2. CLI/ACP commands → delegated to cliManager
 *   3. Everything else → delegated to commandHandler.handle()
 */

import { DaemonCdpManager } from '../cdp/manager.js';
import { registerExtensionProviders } from '../cdp/setup.js';
import { DaemonCommandHandler } from './handler.js';
import { DaemonCliManager } from './cli-manager.js';
import type { ProviderLoader } from '../providers/provider-loader.js';
import type { ProviderInstanceManager } from '../providers/provider-instance-manager.js';
import { launchWithCdp, killIdeProcess, isIdeRunning } from '../launch.js';
import { loadConfig, saveConfig, updateConfig } from '../config/config.js';
import { resolveIdeLaunchWorkspace } from '../config/workspaces.js';
import { appendRecentActivity, markSessionSeen } from '../config/recent-activity.js';
import { detectIDEs } from '../detection/ide-detector.js';
import { SessionRegistry } from '../sessions/registry.js';
import { LOG } from '../logging/logger.js';
import { logCommand } from '../logging/command-log.js';
import { getRecentLogs, LOG_PATH } from '../logging/logger.js';
import { buildSessionEntries } from '../status/builders.js';
import { getSessionCompletionMarker } from '../status/snapshot.js';
import { spawnDetachedDaemonUpgradeHelper } from './upgrade-helper.js';
import * as fs from 'fs';

// ─── Types ───

export interface CommandRouterDeps {
    commandHandler: DaemonCommandHandler;
    cliManager: DaemonCliManager;
    cdpManagers: Map<string, DaemonCdpManager>;
    providerLoader: ProviderLoader;
    instanceManager: ProviderInstanceManager;
    /** Reference to detected IDEs array (mutable — router updates it) */
    detectedIdes: { value: any[] };
    sessionRegistry: SessionRegistry;
    /** Callback for CDP manager creation after launch_ide */
    onCdpManagerCreated?: (ideType: string, manager: DaemonCdpManager) => void;
    /** Callback after IDE connected (e.g., startAgentStreamPolling) */
    onIdeConnected?: () => void;
    /** Callback after status change (stop_ide, restart) */
    onStatusChange?: () => void;
    /** Callback after chat-related commands */
    onPostChatCommand?: () => void;
    /** Get a connected CDP manager (for agent stream reset check) */
    getCdpLogFn?: (ideType: string) => (msg: string) => void;
    /** Package name for upgrade detection ('adhdev' or '@adhdev/daemon-standalone') */
    packageName?: string;
}

export interface CommandRouterResult {
    success: boolean;
    [key: string]: unknown;
}

// Commands that trigger post-chat status updates
const CHAT_COMMANDS = [
    'send_chat', 'new_chat', 'switch_chat', 'set_mode',
    'change_model',
];
const READ_DEBUG_ENABLED = process.argv.includes('--dev') || process.env.ADHDEV_READ_DEBUG === '1';

export class DaemonCommandRouter {
    private deps: CommandRouterDeps;

    constructor(deps: CommandRouterDeps) {
        this.deps = deps;
    }

    /**
     * Unified command routing.
     * Returns result for all commands:
     *   1. Daemon-level commands (launch_ide, stop_ide, etc.)
     *   2. CLI commands (launch_cli, stop_cli, agent_command)
     *   3. DaemonCommandHandler delegation (CDP/agent-stream/file commands)
     *
     * @param cmd Command name
     * @param args Command arguments
     * @param source Log source ('ws' | 'p2p' | 'standalone' | etc.)
     */
    async execute(cmd: string, args: any, source: string = 'unknown'): Promise<CommandRouterResult> {
        const cmdStart = Date.now();

        try {
            // 1. Try daemon-level command
            const daemonResult = await this.executeDaemonCommand(cmd, args);
            if (daemonResult) {
                logCommand({ ts: new Date().toISOString(), cmd, source: source as any, args, success: daemonResult.success, durationMs: Date.now() - cmdStart });
                return daemonResult;
            }

            // 2. Delegate to DaemonCommandHandler
            const handlerResult = await this.deps.commandHandler.handle(cmd, args);
            logCommand({ ts: new Date().toISOString(), cmd, source: source as any, args, success: handlerResult.success, durationMs: Date.now() - cmdStart });

            // 3. Post-chat command callback
            if (CHAT_COMMANDS.includes(cmd) && this.deps.onPostChatCommand) {
                this.deps.onPostChatCommand();
            }

            return handlerResult;
        } catch (e: any) {
            logCommand({ ts: new Date().toISOString(), cmd, source: source as any, args, success: false, error: e.message, durationMs: Date.now() - cmdStart });
            throw e;
        }
    }

    // ─── Daemon-level command core ───────────────────

    /**
     * Daemon-level command execution (IDE start/stop/restart, CLI, detect, logs).
     * Returns null if not handled at this level → caller delegates to CommandHandler.
     */
    private async executeDaemonCommand(cmd: string, args: any): Promise<CommandRouterResult | null> {
        switch (cmd) {
            // ─── CLI / ACP commands ───
            case 'launch_cli':
            case 'stop_cli':
            case 'set_cli_view_mode':
            case 'agent_command': {
                return this.deps.cliManager.handleCliCommand(cmd, args);
            }

            // ─── Logs ───
            case 'get_logs': {
                const count = parseInt(args?.count) || parseInt(args?.lines) || 100;
                const minLevel = args?.minLevel || 'info';
                const sinceTs = args?.since || 0;

                try {
                    // Priority 1: ring buffer (fast and structured)
                    let logs = getRecentLogs(count, minLevel);
                    if (sinceTs > 0) {
                        logs = logs.filter((l: any) => l.ts > sinceTs);
                    }
                    if (logs.length > 0) {
                        return { success: true, logs, totalBuffered: logs.length };
                    }
                    // Priority 2: file fallback
                    if (fs.existsSync(LOG_PATH)) {
                        const content = fs.readFileSync(LOG_PATH, 'utf-8');
                        const allLines = content.split('\n');
                        const recent = allLines.slice(-count).join('\n');
                        return { success: true, logs: recent, totalLines: allLines.length };
                    }
                    return { success: true, logs: [], totalBuffered: 0 };
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }

            // ─── restart_session: IDE / CLI / ACP unified ───
            case 'restart_session': {
                const targetType = args?.cliType || args?.agentType || args?.ideType;
                if (!targetType) throw new Error('cliType or ideType required');

                // Check if IDE (in cdpManagers or provider category is ide)
                const isIde = this.deps.cdpManagers.has(targetType) ||
                    this.deps.providerLoader.getMeta(targetType)?.category === 'ide';

                if (isIde) {
                    // IDE restart: stop (with process kill) → launch
                    await this.stopIde(targetType, true);
                    const launchResult = await this.executeDaemonCommand('launch_ide', { ideType: targetType, enableCdp: true, workspace: args?.workspace });
                    return { success: true, restarted: true, ideType: targetType, launch: launchResult };
                }

                // CLI/ACP restart: delegate to CliManager
                return this.deps.cliManager.handleCliCommand(cmd, args);
            }

            // ─── IDE stop ───
            case 'stop_ide': {
                const ideType = args?.ideType;
                if (!ideType) throw new Error('ideType required');
                const killProcess = args?.killProcess !== false; // default true
                await this.stopIde(ideType, killProcess);
                return { success: true, ideType, stopped: true, processKilled: killProcess };
            }

            // ─── IDE restart ───
            case 'restart_ide': {
                const ideType = args?.ideType;
                if (!ideType) throw new Error('ideType required');
                await this.stopIde(ideType, true); // always kill process on restart
                const launchResult = await this.executeDaemonCommand('launch_ide', { ideType, enableCdp: true, workspace: args?.workspace });
                return { success: true, ideType, restarted: true, launch: launchResult };
            }

            // ─── IDE launch + CDP connect ───
            case 'launch_ide': {
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

                if (result.success && result.port && result.ideId && !this.deps.cdpManagers.has(result.ideId)) {
                    const logFn = this.deps.getCdpLogFn
                        ? this.deps.getCdpLogFn(result.ideId)
                        : LOG.forComponent(`CDP:${result.ideId}`).asLogFn();
                    const provider = this.deps.providerLoader.getMeta(result.ideId);
                    const manager = new DaemonCdpManager(result.port, logFn, undefined, (provider as any)?.targetFilter);
                    const connected = await manager.connect();
                    if (connected) {
                        // Register active extension providers for this IDE in CDP manager
                        registerExtensionProviders(this.deps.providerLoader, manager, result.ideId);
                        this.deps.cdpManagers.set(result.ideId, manager);
                        LOG.info('CDP', `Connected: ${result.ideId} (port ${result.port})`);
                        LOG.info('CDP', `${this.deps.cdpManagers.size} IDE(s) connected`);

                        // Notify consumer (e.g. setupIdeInstance)
                        this.deps.onCdpManagerCreated?.(result.ideId, manager);
                    }
                }
                this.deps.onIdeConnected?.();
                if (result.success && resolvedWorkspace) {
                    try {
                        const next = appendRecentActivity(loadConfig(), {
                            kind: 'ide',
                            providerType: result.ideId || ideKey,
                            providerName: result.ideId || ideKey,
                            workspace: resolvedWorkspace,
                            title: result.ideId || ideKey,
                        });
                        saveConfig(next);
                    } catch { /* ignore activity persist errors */ }
                } else if (result.success && (result.ideId || ideKey)) {
                    try {
                        saveConfig(appendRecentActivity(loadConfig(), {
                            kind: 'ide',
                            providerType: result.ideId || ideKey,
                            providerName: result.ideId || ideKey,
                            title: result.ideId || ideKey,
                        }));
                    } catch { /* ignore activity persist errors */ }
                }
                return { success: result.success, ...result as any };
            }

            // ─── Detect IDEs ───
            case 'detect_ides': {
                const results = await detectIDEs();
                this.deps.detectedIdes.value = results;
                return { success: true, detectedInfo: results };
            }

            // ─── Set User Name ───
            case 'set_user_name': {
                const name = args?.userName;
                if (!name || typeof name !== 'string') throw new Error('userName required');
                updateConfig({ userName: name });
                return { success: true, userName: name };
            }

            case 'mark_session_seen': {
                const sessionId = args?.sessionId;
                if (!sessionId || typeof sessionId !== 'string') {
                    return { success: false, error: 'sessionId is required' };
                }
                const currentConfig = loadConfig();
                const prevSeenAt = currentConfig.sessionReads?.[sessionId] || 0;
                const sessionEntries = buildSessionEntries(
                    this.deps.instanceManager.collectAllStates(),
                    this.deps.cdpManagers as Map<string, any>,
                );
                const targetSession = sessionEntries.find((entry) => entry.id === sessionId);
                const completionMarker = targetSession ? getSessionCompletionMarker(targetSession) : '';
                const next = markSessionSeen(
                    currentConfig,
                    sessionId,
                    typeof args?.seenAt === 'number' ? args.seenAt : Date.now(),
                    completionMarker,
                );
                if (READ_DEBUG_ENABLED) {
                    LOG.info('RecentRead', `mark_session_seen sessionId=${sessionId} seenAt=${String(args?.seenAt || '')} prevSeenAt=${String(prevSeenAt)} nextSeenAt=${String(next.sessionReads?.[sessionId] || 0)} marker=${completionMarker || '-'}`);
                }
                saveConfig(next);
                this.deps.onStatusChange?.();
                return {
                    success: true,
                    sessionId,
                    seenAt: next.sessionReads?.[sessionId] || Date.now(),
                    completionMarker,
                };
            }

            // ─── Daemon Self-Upgrade ───
            case 'daemon_upgrade': {
                LOG.info('Upgrade', 'Remote upgrade requested from dashboard');
                try {
                    const { execSync } = await import('child_process');

                    // Detect package name for upgrade
                    const isStandalone = this.deps.packageName === '@adhdev/daemon-standalone'
                        || process.argv[1]?.includes('daemon-standalone');
                    const pkgName = isStandalone ? '@adhdev/daemon-standalone' : 'adhdev';

                    // Check latest version
                    const latest = execSync(`npm view ${pkgName} version`, { encoding: 'utf-8', timeout: 10000 }).trim();
                    LOG.info('Upgrade', `Latest ${pkgName}: v${latest}`);
                    let currentInstalled: string | null = null;
                    try {
                        const currentJson = execSync(`npm ls -g ${pkgName} --depth=0 --json`, {
                            encoding: 'utf-8',
                            timeout: 10000,
                            stdio: ['pipe', 'pipe', 'pipe'],
                        }).trim();
                        const parsed = JSON.parse(currentJson);
                        currentInstalled = parsed?.dependencies?.[pkgName]?.version || null;
                    } catch {
                        // ignore ls failures; upgrade can still proceed
                    }

                    if (currentInstalled === latest) {
                        LOG.info('Upgrade', `Already on latest version v${latest}; skipping install`);
                        return { success: true, upgraded: false, alreadyLatest: true, version: latest };
                    }

                    spawnDetachedDaemonUpgradeHelper({
                        packageName: pkgName,
                        targetVersion: latest,
                        parentPid: process.pid,
                        restartArgv: process.argv.slice(1),
                        cwd: process.cwd(),
                        sessionHostAppName: process.env.ADHDEV_SESSION_HOST_NAME || 'adhdev',
                    });
                    LOG.info('Upgrade', `Scheduled detached upgrade to v${latest}`);

                    // Exit after the command response has been sent so the helper can replace the package cleanly.
                    setTimeout(() => {
                        LOG.info('Upgrade', 'Exiting daemon so detached upgrader can continue...');
                        process.exit(0);
                    }, 3000);

                    return { success: true, upgraded: true, version: latest, restarting: true };
                } catch (e: any) {
                    LOG.error('Upgrade', `Failed: ${e.message}`);
                    return { success: false, error: e.message };
                }
            }

            // ─── Machine Settings ───
            case 'set_machine_nickname': {
                const nickname = args?.nickname;
                updateConfig({ machineNickname: nickname || null });
                return { success: true };
            }

            default:
                break;
        }

        return null; // Not handled at this level → delegate to CommandHandler
    }

    /**
     * IDE stop: CDP disconnect + InstanceManager cleanup + optionally kill OS process
     */
    private async stopIde(ideType: string, killProcess: boolean = false): Promise<void> {
        // 1. Release CDP manager(s) — handle multi-instance (e.g. "cursor" and "cursor_workspace")
        const cdpKeysToRemove: string[] = [];
        for (const key of this.deps.cdpManagers.keys()) {
            if (key === ideType || key.startsWith(`${ideType}_`)) {
                cdpKeysToRemove.push(key);
            }
        }
        for (const key of cdpKeysToRemove) {
            const cdp = this.deps.cdpManagers.get(key);
            if (cdp) {
                try { cdp.disconnect(); } catch { /* noop */ }
                this.deps.cdpManagers.delete(key);
                this.deps.sessionRegistry.unregisterByManagerKey(key);
                LOG.info('StopIDE', `CDP disconnected: ${key}`);
            }
        }

        // 2. Remove IDE instance(s) from InstanceManager
        const keysToRemove: string[] = [];
        for (const key of this.deps.instanceManager.listInstanceIds()) {
            if (key === `ide:${ideType}` || (typeof key === 'string' && key.startsWith(`ide:${ideType}_`))) {
                keysToRemove.push(key);
            }
        }
        for (const instanceKey of keysToRemove) {
            const ideInstance = this.deps.instanceManager.getInstance(instanceKey) as any;
            if (ideInstance) {
                this.deps.instanceManager.removeInstance(instanceKey);
                LOG.info('StopIDE', `Instance removed: ${instanceKey}`);
            }
        }
        // Fallback: single instance key
        if (keysToRemove.length === 0) {
            const instanceKey = `ide:${ideType}`;
            const ideInstance = this.deps.instanceManager.getInstance(instanceKey) as any;
            if (ideInstance) {
                this.deps.instanceManager.removeInstance(instanceKey);
                LOG.info('StopIDE', `Instance removed: ${instanceKey}`);
            }
        }

        // 3. Kill OS process if requested
        if (killProcess) {
            const running = isIdeRunning(ideType);
            if (running) {
                LOG.info('StopIDE', `Killing IDE process: ${ideType}`);
                const killed = await killIdeProcess(ideType);
                if (killed) {
                    LOG.info('StopIDE', `✅ Process killed: ${ideType}`);
                } else {
                    LOG.warn('StopIDE', `⚠ Could not kill process: ${ideType} (may need manual intervention)`);
                }
            } else {
                LOG.info('StopIDE', `Process not running: ${ideType}`);
            }
        }

        // 4. Notify consumer for status update
        this.deps.onStatusChange?.();
        LOG.info('StopIDE', `IDE stopped: ${ideType} (processKill=${killProcess})`);
    }
}
