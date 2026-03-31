/**
 * DaemonCliManager — CLI session creation, management, and command handling
 *
 * Separated from adhdev-daemon.ts.
 * CLI cases of createAdapter, startCliSession, stopCliSession, executeDaemonCommand extracted to independent module extract.
 */

import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import chalk from 'chalk';
import { ProviderCliAdapter } from '../cli-adapters/provider-cli-adapter.js';
import { detectCLI } from '../detection/cli-detector.js';
import { loadConfig, saveConfig, addCliHistory } from '../config/config.js';
import { getWorkspaceState, resolveLaunchDirectory } from '../config/workspaces.js';
import { appendWorkspaceActivity } from '../config/workspace-activity.js';
import { CliProviderInstance } from '../providers/cli-provider-instance.js';
import { AcpProviderInstance } from '../providers/acp-provider-instance.js';
import type { ProviderInstanceManager } from '../providers/provider-instance-manager.js';
import { ProviderLoader } from '../providers/provider-loader.js';
import type { CliAdapter } from '../cli-adapter-types.js';
import type { SessionRegistry } from '../sessions/registry.js';
import { LOG } from '../logging/logger.js';

// ─── external dependency interface ──────────────────────────

export interface CliManagerDeps {
 /** Server connection — injected into adapter */
    getServerConn(): any | null;
 /** P2P — PTY output transmit */
    getP2p(): { broadcastPtyOutput(key: string, data: string): void } | null;
 /** StatusReporter callback */
    onStatusChange(): void;
    removeAgentTracking(key: string): void;
 /** InstanceManager — register in CLI unified status */
    getInstanceManager(): ProviderInstanceManager | null;
    getSessionRegistry?(): SessionRegistry | null;
}

type CommandResult = { success: boolean;[key: string]: unknown };

// ─── DaemonCliManager ────────────────────────────

export class DaemonCliManager {
    readonly adapters = new Map<string, CliAdapter>();
    private deps: CliManagerDeps;
    private providerLoader: ProviderLoader;

    constructor(deps: CliManagerDeps, providerLoader: ProviderLoader) {
        this.deps = deps;
        this.providerLoader = providerLoader;
    }

 // ─── Key create ─────────────────────────────────

    getCliKey(cliType: string, dir: string): string {
        const hash = require('crypto').createHash('md5').update(require('path').resolve(dir)).digest('hex').slice(0, 8);
        return `${cliType}_${hash}`;
    }

    private persistRecentDir(cliType: string, dir: string): void {
        try {
            const normalizedType = this.providerLoader.resolveAlias(cliType);
            const provider = this.providerLoader.getByAlias(cliType);
            const actKind = provider?.category === 'acp' ? 'acp' : 'cli';
            let next = loadConfig();
            console.log(chalk.cyan(`  📂 Saving recent workspace: ${dir}`));
            const recent = next.recentCliWorkspaces || [];
            if (!recent.includes(dir)) {
                next = { ...next, recentCliWorkspaces: [dir, ...recent].slice(0, 10) };
            }
            next = appendWorkspaceActivity(next, dir, { kind: actKind, agentType: normalizedType });
            saveConfig(next);
            console.log(chalk.green(`  ✓ Recent workspace saved: ${dir}`));
        } catch (e) {
            console.error(chalk.red(`  ✗ Failed to save recent workspace: ${e}`));
        }
    }

    private createAdapter(cliType: string, workingDir: string, cliArgs?: string[]): CliAdapter {
 // cliType normalize (Resolve alias)
        const normalizedType = this.providerLoader.resolveAlias(cliType);

 // Load CLI config from provider.js
        const provider = this.providerLoader.getMeta(normalizedType);
        if (provider && provider.category === 'cli' && provider.patterns && provider.spawn) {
            console.log(chalk.cyan(`  📦 Using provider: ${provider.name} (${provider.type})`));
            const resolvedProvider = this.providerLoader.resolve(normalizedType) || provider;
            return new ProviderCliAdapter(resolvedProvider as any, workingDir, cliArgs);
        }

        throw new Error(`No CLI provider found for '${cliType}'. Create a provider.js in providers/cli/${cliType}/`);
    }

 // ─── Session start/management ──────────────────────────────

    async startSession(cliType: string, workingDir: string, cliArgs?: string[], initialModel?: string): Promise<void> {
        const trimmed = (workingDir || '').trim();
        if (!trimmed) throw new Error('working directory required');
        const resolvedDir = trimmed.startsWith('~')
            ? trimmed.replace(/^~/, os.homedir())
            : path.resolve(trimmed);

 // cliType normalize (Resolve alias)
        const normalizedType = this.providerLoader.resolveAlias(cliType);
        const provider = this.providerLoader.getByAlias(cliType);

 // Create UUID-based key (allows separate instances even for same type+dir)
        const key = crypto.randomUUID();
        const sessionRegistry = this.deps.getSessionRegistry?.() || null;

 // ─── ACP category handle ───
        if (provider && provider.category === 'acp') {
            const instanceManager = this.deps.getInstanceManager();
            if (!instanceManager) throw new Error('InstanceManager not available');

 // Check if command is installed
            const spawnCmd = provider.spawn?.command;
            if (spawnCmd) {
                try {
                    const { execSync } = require('child_process');
                    execSync(`which ${spawnCmd}`, { stdio: 'ignore' });
                } catch {
                    const installInfo = provider.install || `Install: check ${provider.displayName || provider.name} documentation`;
                    throw new Error(
                        `${provider.displayName || provider.name} is not installed.\n` +
                        `Command '${spawnCmd}' not found in PATH.\n\n` +
                        `${installInfo}`
                    );
                }
            }

            console.log(chalk.cyan(`  🔌 Starting ACP agent: ${provider.name} (${provider.type}) in ${resolvedDir}`));

            const acpInstance = new AcpProviderInstance(provider, resolvedDir, cliArgs);
            await instanceManager.addInstance(key, acpInstance, {
                settings: this.providerLoader.getSettings(normalizedType),
            });
            const sessionId = acpInstance.getInstanceId();
            sessionRegistry?.register({
                sessionId,
                parentSessionId: null,
                providerType: normalizedType,
                providerCategory: 'acp',
                transport: 'acp',
                adapterKey: key,
                instanceKey: key,
            });

 // Register ACP entry in adapter map (getStatus queries from acpInstance in real-time)
            this.adapters.set(key, {
                cliType: normalizedType,
                workingDir: resolvedDir,
                _acpInstance: acpInstance,
                spawn: async () => {},
                shutdown: () => { instanceManager.removeInstance(key); },
                sendMessage: async (text: string) => { acpInstance.onEvent('send_message', { text }); },
                getStatus: () => {
                    const state = acpInstance.getState();
                    return {
                        status: state.status,
                        messages: state.activeChat?.messages || [],
                        activeModal: state.activeChat?.activeModal || null,
                    };
                },
                setOnStatusChange: () => {},
                setOnPtyData: () => {},
            } as any);

            console.log(chalk.green(`  ✓ ACP agent started: ${provider.name} in ${resolvedDir}`));

 // If initialModel exists, change model after session start
            if (initialModel) {
                try {
                    await acpInstance.setConfigOption('model', initialModel);
                    console.log(chalk.green(`  🤖 Initial model set: ${initialModel}`));
                } catch (e: any) {
                    LOG.warn('CLI', `[ACP] Initial model set failed: ${e?.message}`);
                }
            }

            try { addCliHistory({ category: 'acp', cliType: normalizedType, dir: resolvedDir, workspace: resolvedDir, cliArgs, model: initialModel }); } catch (e) { LOG.warn('CLI', `ACP history save failed: ${(e as Error)?.message}`); }
            this.deps.onStatusChange();
            return;
        }

 // ─── CLI category handling (existing) ───
        const cliInfo = await detectCLI(cliType, this.providerLoader);
        if (!cliInfo) throw new Error(`${cliType} not found`);

        console.log(chalk.yellow(`  ⚡ Starting CLI ${cliType} in ${resolvedDir}...`));
        if (provider) {
            console.log(chalk.cyan(`  📦 Using provider: ${provider.name} (${provider.type})`));
        }

 // If InstanceManager exists, manage as CliProviderInstance unified
        const instanceManager = this.deps.getInstanceManager();
        if (provider && instanceManager) {
            const resolvedProvider = this.providerLoader.resolve(cliType, { version: cliInfo.version }) || provider;
            const cliInstance = new CliProviderInstance(resolvedProvider, resolvedDir, cliArgs, key);
            try {
                await instanceManager.addInstance(key, cliInstance, {
                    serverConn: this.deps.getServerConn(),
                    settings: {},
                    onPtyData: (data: string) => {
                        this.deps.getP2p()?.broadcastPtyOutput(cliInstance.instanceId, data);
                    },
                });
                sessionRegistry?.register({
                    sessionId: cliInstance.instanceId,
                    parentSessionId: null,
                    providerType: normalizedType,
                    providerCategory: 'cli',
                    transport: 'pty',
                    adapterKey: key,
                    instanceKey: key,
                });
            } catch (spawnErr: any) {
                // Spawn failed — cleanup and propagate error
                LOG.error('CLI', `[${cliType}] Spawn failed: ${spawnErr?.message}`);
                instanceManager.removeInstance(key);
                throw new Error(`Failed to start ${cliInfo.displayName}: ${spawnErr?.message}`);
            }

 // Keep adapter ref too (backward compat — write, resize etc)
            this.adapters.set(key, cliInstance.getAdapter() as any);
            console.log(chalk.green(`  ✓ CLI started: ${cliInfo.displayName} v${cliInfo.version || 'unknown'} in ${resolvedDir}`));

            // Monitor for stopped/error → auto-cleanup
            const checkStopped = setInterval(() => {
                try {
                    const adapter = this.adapters.get(key);
                    if (!adapter) { clearInterval(checkStopped); return; }
                    const status = adapter.getStatus?.();
                    if (status?.status === 'stopped' || status?.status === 'error') {
                        clearInterval(checkStopped);
                        setTimeout(() => {
                            if (this.adapters.has(key)) {
                                this.adapters.delete(key);
                                this.deps.removeAgentTracking(key);
                                sessionRegistry?.unregisterByInstanceKey(key);
                                instanceManager.removeInstance(key);
                                LOG.info('CLI', `🧹 Auto-cleaned ${status.status} CLI: ${cliType}`);
                                this.deps.onStatusChange();
                            }
                        }, 5000);
                    }
                } catch { /* ignore */ }
            }, 3000);
        } else {
 // Fallback: InstanceManager without directly adapter manage
            const adapter = this.createAdapter(cliType, resolvedDir, cliArgs);
            try {
                await adapter.spawn();
            } catch (spawnErr: any) {
                LOG.error('CLI', `[${cliType}] Spawn failed: ${spawnErr?.message}`);
                throw new Error(`Failed to start ${cliInfo.displayName}: ${spawnErr?.message}`);
            }

            const serverConn = this.deps.getServerConn();
            if (serverConn && typeof adapter.setServerConn === 'function') {
                adapter.setServerConn(serverConn);
            }
            adapter.setOnStatusChange(() => {
                this.deps.onStatusChange();
                const status = adapter.getStatus?.();
                if (status?.status === 'stopped' || status?.status === 'error') {
                    setTimeout(() => {
                        if (this.adapters.get(key) === adapter) {
                            this.adapters.delete(key);
                            this.deps.removeAgentTracking(key);
                            LOG.info('CLI', `🧹 Auto-cleaned ${status.status} CLI: ${adapter.cliType}`);
                            this.deps.onStatusChange();
                        }
                    }, 3000);
                }
            });

            if (typeof adapter.setOnPtyData === 'function') {
                adapter.setOnPtyData((data: string) => {
                    this.deps.getP2p()?.broadcastPtyOutput(key, data);
                });
            }

            this.adapters.set(key, adapter);
            console.log(chalk.green(`  ✓ CLI started: ${cliInfo.displayName} v${cliInfo.version || 'unknown'} in ${resolvedDir}`));
        }

        try { addCliHistory({ category: 'cli', cliType, dir: resolvedDir, workspace: resolvedDir, cliArgs, model: initialModel }); } catch (e) { LOG.warn('CLI', `CLI history save failed: ${(e as Error)?.message}`); }

        this.deps.onStatusChange();
    }

    async stopSession(key: string): Promise<void> {
        const adapter = this.adapters.get(key);
        if (adapter) {
            try {
                adapter.shutdown();
            } catch (e: any) {
                LOG.warn('CLI', `Shutdown error for ${adapter.cliType}: ${e?.message} (force-cleaning)`);
            }
            // Always cleanup regardless of shutdown success
            this.adapters.delete(key);
            this.deps.removeAgentTracking(key);
            this.deps.getSessionRegistry?.()?.unregisterByInstanceKey(key);
            this.deps.getInstanceManager()?.removeInstance(key);
            LOG.info('CLI', `🛑 Agent stopped: ${adapter.cliType} in ${adapter.workingDir}`);
            this.deps.onStatusChange();
        } else {
            // Adapter not found — try InstanceManager direct removal
            const im = this.deps.getInstanceManager();
            if (im) {
                this.deps.getSessionRegistry?.()?.unregisterByInstanceKey(key);
                im.removeInstance(key);
                this.deps.removeAgentTracking(key);
                LOG.warn('CLI', `🧹 Force-removed orphan entry: ${key}`);
                this.deps.onStatusChange();
            }
        }
    }

    shutdownAll(): void {
        for (const adapter of this.adapters.values()) adapter.shutdown();
        this.adapters.clear();
    }

 // ─── Adapter search ─────────────────────────────

 /**
 * Search for CLI adapter. Priority order:
 * 0. sessionId (UUID direct match)
 * 1. agentType + dir (iteration match)
 * 2. agentType fuzzy match (⚠ returns first match when multiple sessions exist)
 */
    findAdapter(agentType: string, opts?: { dir?: string; instanceKey?: string }): { adapter: CliAdapter; key: string } | null {
 // 0. UUID direct match (most accurate)
        if (opts?.instanceKey) {
            let ik = opts.instanceKey;
 // Strip composite prefix: 'doId:cli:uuid' → 'uuid' or 'doId:uuid' → 'uuid'
            const colonIdx = ik.lastIndexOf(':');
            if (colonIdx >= 0) ik = ik.substring(colonIdx + 1);
            const adapter = this.adapters.get(ik);
            if (adapter) return { adapter, key: ik };
        }
 // 1. agentType + dir match
        if (opts?.dir) {
            for (const [k, a] of this.adapters) {
                if (a.cliType === agentType && a.workingDir === opts.dir) {
                    return { adapter: a, key: k };
                }
            }
        }
 // 2. Fuzzy match (returns first of multiple sessions — may be inaccurate)
        for (const [k, a] of this.adapters) {
            if (a.cliType === agentType) {
                return { adapter: a, key: k };
            }
        }
        return null;
    }

 // ─── CLI command handling ────────────────────────────

    async handleCliCommand(cmd: string, args: any): Promise<CommandResult | null> {
        switch (cmd) {
            case 'launch_cli': {
                const cliType = args?.cliType;
                const config = loadConfig();
                const resolved = resolveLaunchDirectory(
                    {
                        dir: args?.dir,
                        workspaceId: args?.workspaceId,
                        useDefaultWorkspace: args?.useDefaultWorkspace === true,
                        useHome: args?.useHome === true,
                    },
                    config,
                );
                if (!resolved.ok) {
                    const ws = getWorkspaceState(config);
                    return {
                        success: false,
                        error: resolved.message,
                        code: resolved.code,
                        workspaces: ws.workspaces,
                        defaultWorkspacePath: ws.defaultWorkspacePath,
                    };
                }
                const dir = resolved.path;
                const launchSource = resolved.source;
                if (!cliType) throw new Error('cliType required');

                await this.startSession(cliType, dir, args?.cliArgs, args?.initialModel);

 // On startSession success, new UUID key exists in adapters (last added item)
                let newKey: string | null = null;
                for (const [k, adapter] of this.adapters) {
                    if (adapter.cliType === cliType && adapter.workingDir === dir) {
                        newKey = k; // Last match = just added item
                    }
                }

                this.persistRecentDir(cliType, dir);

                return { success: true, cliType, dir, id: newKey, launchSource };
            }
            case 'stop_cli': {
                const cliType = args?.cliType;
                const dir = args?.dir || '';
                if (!cliType) throw new Error('cliType required');
 // UUID session target based search priority
                const found = this.findAdapter(cliType, { instanceKey: args?.targetSessionId, dir });
                if (found) {
                    await this.stopSession(found.key);
                } else {
                    console.log(chalk.yellow(`  ⚠ No adapter found for ${cliType}`));
                }
                return { success: true, cliType, dir, stopped: true };
            }
            case 'restart_session': {
                const cliType = args?.cliType || args?.agentType || args?.ideType;
                const cfg = loadConfig();
                const rdir = resolveLaunchDirectory(
                    {
                        dir: args?.dir,
                        workspaceId: args?.workspaceId,
                        useDefaultWorkspace: args?.useDefaultWorkspace === true,
                        useHome: args?.useHome === true,
                    },
                    cfg,
                );
                if (!rdir.ok) {
                    const ws = getWorkspaceState(cfg);
                    return {
                        success: false,
                        error: rdir.message,
                        code: rdir.code,
                        workspaces: ws.workspaces,
                        defaultWorkspacePath: ws.defaultWorkspacePath,
                    };
                }
                const dir = rdir.path;
                if (!cliType) throw new Error('cliType required');
                const found = this.findAdapter(cliType, { instanceKey: args?.targetSessionId, dir });
                if (found) await this.stopSession(found.key);
                await this.startSession(cliType, dir);
                this.persistRecentDir(cliType, dir);
                return { success: true, restarted: true };
            }
            case 'agent_command': {
                const agentType = args?.agentType || args?.cliType;
                const action = args?.action;
                if (!agentType || !action) throw new Error('agentType and action required');

                const found = this.findAdapter(agentType, {
                    dir: args?.dir,
                    instanceKey: args?.targetSessionId,
                });
                if (!found) throw new Error(`CLI agent not running: ${agentType}`);
                const { adapter, key } = found;

                if (action === 'send_chat') {
                    const message = args.message || args.text;
                    if (!message) throw new Error('message required for send_chat');
                    await adapter.sendMessage(message);
                    return { success: true, status: 'generating' };
                } else if (action === 'clear_history') {
                    if (typeof (adapter as any).clearHistory === 'function') (adapter as any).clearHistory();
                    return { success: true, cleared: true };
                } else if (action === 'stop') {
                    await this.stopSession(key);
                    return { success: true, stopped: true };
                }
                throw new Error(`Unknown action: ${action}`);
            }
        }
        return null; // Not a CLI command
    }
}
