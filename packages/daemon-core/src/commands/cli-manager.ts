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
import { loadConfig } from '../config/config.js';
import { loadState, saveState } from '../config/state-store.js';
import { getWorkspaceState, resolveLaunchDirectory } from '../config/workspaces.js';
import { appendRecentActivity } from '../config/recent-activity.js';
import { upsertSavedProviderSession } from '../config/saved-sessions.js';
import { CliProviderInstance } from '../providers/cli-provider-instance.js';
import { AcpProviderInstance } from '../providers/acp-provider-instance.js';
import type { ProviderInstanceManager } from '../providers/provider-instance-manager.js';
import { ProviderLoader } from '../providers/provider-loader.js';
import type { ProviderModule, ProviderResumeCapability } from '../providers/contracts.js';
import type { CliAdapter } from '../cli-adapter-types.js';
import type { PtyTransportFactory } from '../cli-adapters/pty-transport.js';
import type { SessionRegistry } from '../sessions/registry.js';
import { LOG } from '../logging/logger.js';

// ─── external dependency interface ──────────────────────────

export interface CliManagerDeps {
 /** Server connection — injected into adapter */
    getServerConn(): any | null;
 /** P2P — PTY output transmit */
    getP2p(): { broadcastSessionOutput(key: string, data: string): void } | null;
 /** StatusReporter callback */
    onStatusChange(): void;
    removeAgentTracking(key: string): void;
 /** InstanceManager — register in CLI unified status */
    getInstanceManager(): ProviderInstanceManager | null;
    getSessionRegistry?(): SessionRegistry | null;
    createPtyTransportFactory?: (params: CliTransportFactoryParams) => PtyTransportFactory | null;
    listHostedCliRuntimes?: () => Promise<HostedCliRuntimeDescriptor[]>;
}

type CommandResult = { success: boolean;[key: string]: unknown };

export interface CliTransportFactoryParams {
    runtimeId: string;
    providerType: string;
    workspace: string;
    cliArgs?: string[];
    providerSessionId?: string;
    attachExisting?: boolean;
}

export interface HostedCliRuntimeDescriptor {
    runtimeId: string;
    runtimeKey?: string;
    displayName?: string;
    workspaceLabel?: string;
    lifecycle?: 'starting' | 'running' | 'stopping' | 'stopped' | 'failed' | 'interrupted';
    recoveryState?: string | null;
    cliType: string;
    workspace: string;
    cliArgs?: string[];
    providerSessionId?: string;
}

const chalkApi: any = (chalk as any)?.yellow
    ? (chalk as any)
    : (chalk as any)?.default || null;

function colorize(color: 'red' | 'green' | 'yellow' | 'cyan', text: string): string {
    const fn = chalkApi?.[color];
    return typeof fn === 'function' ? fn(text) : text;
}

type CliLaunchMode = 'new' | 'resume' | 'manual';

type CliSessionBinding = {
    cliArgs?: string[];
    providerSessionId?: string;
    launchMode: CliLaunchMode;
};

function isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function readArgValue(args: string[], flags: string[]): string | undefined {
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        for (const flag of flags) {
            if (arg === flag) {
                const next = args[index + 1];
                if (next && !next.startsWith('-')) return next;
            }
            const prefix = `${flag}=`;
            if (arg.startsWith(prefix)) return arg.slice(prefix.length);
        }
    }
    return undefined;
}

function hasArg(args: string[], flags: string[]): boolean {
    return args.some((arg) => flags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
}

function expandResumeArgs(template: string[] | undefined, sessionId: string): string[] | undefined {
    if (!Array.isArray(template) || template.length === 0) return undefined;
    return template.map((part) => part === '{{id}}' ? sessionId : part);
}

function readCodexResumeSessionId(args: string[]): string | undefined {
    const resumeIndex = args.findIndex((arg) => arg === 'resume' || arg === 'fork');
    if (resumeIndex < 0) return undefined;
    const candidate = args[resumeIndex + 1];
    if (!candidate || candidate.startsWith('-')) return undefined;
    return candidate;
}

function detectExplicitProviderSessionId(
    normalizedType: string,
    args: string[],
): { providerSessionId?: string; launchMode: CliLaunchMode } {
    const explicitResumeId = readArgValue(args, ['--resume', '-r']);
    if (explicitResumeId) {
        return { providerSessionId: explicitResumeId, launchMode: 'resume' };
    }

    const explicitSessionFlagId = readArgValue(args, ['--session']);
    if (explicitSessionFlagId) {
        return {
            providerSessionId: explicitSessionFlagId,
            launchMode: 'resume',
        };
    }

    const explicitSessionId = readArgValue(args, ['--session-id']);
    if (explicitSessionId) {
        if (normalizedType === 'goose-cli' && !hasArg(args, ['--resume', '-r'])) {
            return { launchMode: 'manual' };
        }
        const isResume = normalizedType === 'goose-cli'
            ? hasArg(args, ['--resume', '-r'])
            : (hasArg(args, ['--continue']) || hasArg(args, ['--resume', '-r']));
        return {
            providerSessionId: explicitSessionId,
            launchMode: isResume ? 'resume' : 'new',
        };
    }

    if (normalizedType === 'codex-cli') {
        const codexSessionId = readCodexResumeSessionId(args);
        if (codexSessionId) {
            return { providerSessionId: codexSessionId, launchMode: 'resume' };
        }
    }

    return { launchMode: 'manual' };
}

export function supportsExplicitSessionResume(resume?: ProviderResumeCapability): boolean {
    return !!(resume?.supported && Array.isArray(resume.resumeSessionArgs) && resume.resumeSessionArgs.length > 0);
}

function supportsExplicitSessionStart(resume?: ProviderResumeCapability): boolean {
    return !!(resume?.supported && Array.isArray(resume.newSessionArgs) && resume.newSessionArgs.length > 0);
}

function resolveCliSessionBinding(
    provider: ProviderModule | undefined,
    normalizedType: string,
    cliArgs?: string[],
    requestedResumeSessionId?: string,
): CliSessionBinding {
    const baseArgs = Array.isArray(cliArgs) ? [...cliArgs] : undefined;
    const resume = provider?.resume;
    if (!resume?.supported) {
        return { cliArgs: baseArgs, launchMode: 'manual' };
    }

    const explicit = detectExplicitProviderSessionId(normalizedType, baseArgs || []);
    if (explicit.providerSessionId) {
        return {
            cliArgs: baseArgs,
            providerSessionId: explicit.providerSessionId,
            launchMode: explicit.launchMode,
        };
    }

    if (requestedResumeSessionId) {
        if (resume.sessionIdFormat === 'uuid' && !isUuid(requestedResumeSessionId)) {
            throw new Error(`Invalid ${provider?.displayName || provider?.name || normalizedType} session ID: ${requestedResumeSessionId}`);
        }
        const resumeSessionArgs = expandResumeArgs(resume.resumeSessionArgs, requestedResumeSessionId);
        if (!resumeSessionArgs) {
            return { cliArgs: baseArgs, launchMode: 'manual' };
        }
        return {
            cliArgs: [...(baseArgs || []), ...resumeSessionArgs],
            providerSessionId: requestedResumeSessionId,
            launchMode: 'resume',
        };
    }

    if (!supportsExplicitSessionStart(resume)) {
        return { cliArgs: baseArgs, launchMode: 'manual' };
    }

    const providerSessionId = crypto.randomUUID();
    const newSessionArgs = expandResumeArgs(resume.newSessionArgs, providerSessionId);
    return {
        cliArgs: [...(baseArgs || []), ...(newSessionArgs || [])],
        providerSessionId,
        launchMode: 'new',
    };
}

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

    getSessionPresentationMode(sessionId: string): 'terminal' | 'chat' | null {
        if (!sessionId) return null;
        const instance = this.deps.getInstanceManager()?.getInstance(sessionId) as any;
        const mode = instance?.category === 'cli'
            ? instance.getPresentationMode?.()
            : null;
        return mode === 'chat' || mode === 'terminal' ? mode : null;
    }

    isTerminalSession(sessionId: string): boolean {
        return this.getSessionPresentationMode(sessionId) === 'terminal';
    }

    private persistRecentActivity(entry: {
        kind: 'ide' | 'cli' | 'acp';
        providerType: string;
        providerName: string;
        providerSessionId?: string;
        workspace?: string;
        currentModel?: string;
        sessionId?: string;
        title?: string;
    }): void {
        try {
            let nextState = appendRecentActivity(loadState(), entry);
            if (entry.providerSessionId && (entry.kind === 'cli' || entry.kind === 'acp')) {
                nextState = upsertSavedProviderSession(nextState, {
                    kind: entry.kind,
                    providerType: entry.providerType,
                    providerName: entry.providerName,
                    providerSessionId: entry.providerSessionId,
                    workspace: entry.workspace,
                    currentModel: entry.currentModel,
                    title: entry.title,
                });
            }
            saveState(nextState);
        } catch (e) {
            console.error(colorize('red', `  ✗ Failed to save recent activity: ${e}`));
        }
    }

    private getTransportFactory(
        runtimeId: string,
        providerType: string,
        workspace: string,
        cliArgs?: string[],
        providerSessionId?: string,
        attachExisting = false,
    ): PtyTransportFactory | undefined {
        return this.deps.createPtyTransportFactory?.({
            runtimeId,
            providerType,
            workspace,
            cliArgs,
            providerSessionId,
            attachExisting,
        }) || undefined;
    }

    private createAdapter(
        cliType: string,
        workingDir: string,
        cliArgs: string[] | undefined,
        runtimeId: string,
        providerSessionId?: string,
        attachExisting = false,
    ): CliAdapter {
 // cliType normalize (Resolve alias)
        const normalizedType = this.providerLoader.resolveAlias(cliType);

 // Load CLI config from provider.js
        const provider = this.providerLoader.getMeta(normalizedType);
        if (provider && provider.category === 'cli' && provider.patterns && provider.spawn) {
            console.log(colorize('cyan', `  📦 Using provider: ${provider.name} (${provider.type})`));
            const resolvedProvider = this.providerLoader.resolve(normalizedType) || provider;
            const transportFactory = this.getTransportFactory(
                runtimeId,
                normalizedType,
                workingDir,
                cliArgs,
                providerSessionId,
                attachExisting,
            );
            return new ProviderCliAdapter(resolvedProvider as any, workingDir, cliArgs, transportFactory);
        }

        throw new Error(`No CLI provider found for '${cliType}'. Create a provider.js in providers/cli/${cliType}/`);
    }

    private startCliExitMonitor(key: string, cliType: string): void {
        const sessionRegistry = this.deps.getSessionRegistry?.() || null;
        const instanceManager = this.deps.getInstanceManager();
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
                            instanceManager?.removeInstance(key);
                            LOG.info('CLI', `🧹 Auto-cleaned ${status.status} CLI: ${cliType}`);
                            this.deps.onStatusChange();
                        }
                    }, 5000);
                }
            } catch { /* ignore */ }
        }, 3000);
    }

    private async registerCliInstance(
        key: string,
        normalizedType: string,
        cliType: string,
        resolvedDir: string,
        cliArgs: string[] | undefined,
        provider: any,
        settings: Record<string, any>,
        attachExisting = false,
        options?: {
            providerSessionId?: string;
            launchMode?: CliLaunchMode;
            onProviderSessionResolved?: (info: {
                instanceId: string;
                providerType: string;
                providerName: string;
                workspace: string;
                providerSessionId: string;
                previousProviderSessionId?: string;
            }) => void;
        },
    ): Promise<void> {
        const instanceManager = this.deps.getInstanceManager();
        const sessionRegistry = this.deps.getSessionRegistry?.() || null;
        if (!instanceManager) throw new Error('InstanceManager not available');
        const transportFactory = this.getTransportFactory(
            key,
            normalizedType,
            resolvedDir,
            cliArgs,
            options?.providerSessionId,
            attachExisting,
        );
        const cliInstance = new CliProviderInstance(provider, resolvedDir, cliArgs, key, transportFactory, options);
        try {
            await instanceManager.addInstance(key, cliInstance, {
                serverConn: this.deps.getServerConn(),
                settings,
                onPtyData: (data: string) => {
                    this.deps.getP2p()?.broadcastSessionOutput(cliInstance.instanceId, data);
                },
            });
            sessionRegistry?.register({
                sessionId: cliInstance.instanceId,
                parentSessionId: null,
                providerType: normalizedType,
                transport: 'pty',
                adapterKey: key,
                instanceKey: key,
            });
        } catch (spawnErr: any) {
            LOG.error('CLI', `[${cliType}] Spawn failed: ${spawnErr?.message}`);
            instanceManager.removeInstance(key);
            throw new Error(`Failed to start ${provider.displayName || provider.name || cliType}: ${spawnErr?.message}`);
        }

        this.adapters.set(key, cliInstance.getAdapter() as any);
        this.startCliExitMonitor(key, cliType);
    }

 // ─── Session start/management ──────────────────────────────

    async startSession(
        cliType: string,
        workingDir: string,
        cliArgs?: string[],
        initialModel?: string,
        options?: { resumeSessionId?: string },
    ): Promise<{ runtimeSessionId: string; providerSessionId?: string }> {
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

            console.log(colorize('cyan', `  🔌 Starting ACP agent: ${provider.name} (${provider.type}) in ${resolvedDir}`));

            const acpInstance = new AcpProviderInstance(provider, resolvedDir, cliArgs);
            await instanceManager.addInstance(key, acpInstance, {
                settings: this.providerLoader.getSettings(normalizedType),
            });
            const sessionId = acpInstance.getInstanceId();
            sessionRegistry?.register({
                sessionId,
                parentSessionId: null,
                providerType: normalizedType,
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

            console.log(colorize('green', `  ✓ ACP agent started: ${provider.name} in ${resolvedDir}`));

 // If initialModel exists, change model after session start
            if (initialModel) {
                try {
                    await acpInstance.setConfigOption('model', initialModel);
                    console.log(colorize('green', `  🤖 Initial model set: ${initialModel}`));
                } catch (e: any) {
                    LOG.warn('CLI', `[ACP] Initial model set failed: ${e?.message}`);
                }
            }

            this.persistRecentActivity({
                kind: 'acp',
                providerType: normalizedType,
                providerName: provider.displayName || provider.name || normalizedType,
                workspace: resolvedDir,
                currentModel: initialModel,
                sessionId,
                title: provider.displayName || provider.name || normalizedType,
            });
            this.deps.onStatusChange();
            return { runtimeSessionId: sessionId };
        }

 // ─── CLI category handling (existing) ───
        const cliInfo = await detectCLI(cliType, this.providerLoader);
        if (!cliInfo) {
            const installHint = provider?.install || '';
            const displayName = provider?.displayName || provider?.name || cliType;
            const spawnCmd = provider?.spawn?.command || cliType;
            throw new Error(
                `${displayName} is not installed.\n` +
                `Command '${spawnCmd}' not found on PATH.\n` +
                (installHint ? `\n${installHint}\n` : '') +
                `\nRun 'adhdev doctor' for detailed diagnostics.`
            );
        }

        console.log(colorize('yellow', `  ⚡ Starting CLI ${cliType} in ${resolvedDir}...`));
        if (provider) {
            console.log(colorize('cyan', `  📦 Using provider: ${provider.name} (${provider.type})`));
        }

 // ─── Resolve launch options → provider session binding ───
        const sessionBinding = resolveCliSessionBinding(provider, normalizedType, cliArgs, options?.resumeSessionId);
        const resolvedCliArgs = sessionBinding.cliArgs;

 // If InstanceManager exists, manage as CliProviderInstance unified
        const instanceManager = this.deps.getInstanceManager();
        if (provider && instanceManager) {
            const resolvedProvider = this.providerLoader.resolve(cliType, { version: cliInfo.version }) || provider;
            await this.registerCliInstance(
                key,
                normalizedType,
                cliType,
                resolvedDir,
                resolvedCliArgs,
                resolvedProvider,
                {},
                false,
                {
                    providerSessionId: sessionBinding.providerSessionId,
                    launchMode: sessionBinding.launchMode,
                    onProviderSessionResolved: ({ providerSessionId, providerName, providerType, workspace }) => {
                        this.persistRecentActivity({
                            kind: 'cli',
                            providerType,
                            providerName,
                            providerSessionId,
                            workspace,
                            title: providerName,
                        });
                    },
                },
            );
            console.log(colorize('green', `  ✓ CLI started: ${cliInfo.displayName} v${cliInfo.version || 'unknown'} in ${resolvedDir}`));
        } else {
 // Fallback: InstanceManager without directly adapter manage
            const adapter = this.createAdapter(
                cliType,
                resolvedDir,
                resolvedCliArgs,
                key,
                sessionBinding.providerSessionId,
                false,
            );
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
                    this.deps.getP2p()?.broadcastSessionOutput(key, data);
                });
            }

            this.adapters.set(key, adapter);
            console.log(colorize('green', `  ✓ CLI started: ${cliInfo.displayName} v${cliInfo.version || 'unknown'} in ${resolvedDir}`));
        }

        this.persistRecentActivity({
            kind: 'cli',
            providerType: normalizedType,
            providerName: provider?.displayName || provider?.name || normalizedType,
            providerSessionId: sessionBinding.providerSessionId,
            workspace: resolvedDir,
            currentModel: initialModel,
            sessionId: key,
            title: provider?.displayName || provider?.name || normalizedType,
        });

        this.deps.onStatusChange();
        return {
            runtimeSessionId: key,
            providerSessionId: sessionBinding.providerSessionId,
        };
    }

    async stopSession(key: string): Promise<void> {
        return this.stopSessionWithMode(key, 'hard');
    }

    async stopSessionWithMode(key: string, mode: 'hard' | 'save'): Promise<void> {
        const adapter = this.adapters.get(key);
        if (adapter) {
            try {
                if (mode === 'save' && typeof adapter.saveAndStop === 'function') {
                    await adapter.saveAndStop();
                } else {
                    adapter.shutdown();
                }
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

    detachAll(): void {
        for (const adapter of this.adapters.values()) {
            if (typeof adapter.detach === 'function') adapter.detach();
            else adapter.shutdown();
        }
        this.adapters.clear();
    }

    async restoreHostedSessions(records?: HostedCliRuntimeDescriptor[]): Promise<number> {
        const instanceManager = this.deps.getInstanceManager();
        if (!instanceManager) return 0;
        const sessions = records || await this.deps.listHostedCliRuntimes?.() || [];
        let restored = 0;

        for (const record of sessions) {
            if (!record?.runtimeId || !record?.cliType || !record?.workspace) continue;
            if (this.adapters.has(record.runtimeId) || instanceManager.getInstance(record.runtimeId)) continue;
            const normalizedType = this.providerLoader.resolveAlias(record.cliType);
            const providerMeta = this.providerLoader.getMeta(normalizedType);
            if (!providerMeta || providerMeta.category !== 'cli') continue;

            const resolvedProvider = this.providerLoader.resolve(normalizedType) || providerMeta;
            const sessionBinding = resolveCliSessionBinding(
                resolvedProvider,
                normalizedType,
                record.cliArgs,
                record.providerSessionId,
            );
            try {
                await this.registerCliInstance(
                    record.runtimeId,
                    normalizedType,
                    record.cliType,
                    record.workspace,
                    record.cliArgs,
                    resolvedProvider,
                    {},
                    true,
                    {
                        providerSessionId: sessionBinding.providerSessionId,
                        launchMode: 'manual',
                    },
                );
                restored += 1;
                LOG.info('CLI', `♻ Restored hosted runtime: ${record.runtimeKey || record.runtimeId} (${record.displayName || record.workspace})`);
            } catch (error: any) {
                LOG.warn('CLI', `Failed to restore hosted runtime ${record.runtimeId}: ${error?.message || error}`);
            }
        }

        if (restored > 0) {
            this.deps.onStatusChange();
        }
        return restored;
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

    private findAdapterBySessionId(instanceKey?: string): { adapter: CliAdapter; key: string } | null {
        if (!instanceKey) return null;
        let ik = instanceKey;
        const colonIdx = ik.lastIndexOf(':');
        if (colonIdx >= 0) ik = ik.substring(colonIdx + 1);
        const adapter = this.adapters.get(ik);
        return adapter ? { adapter, key: ik } : null;
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

                const started = await this.startSession(
                    cliType,
                    dir,
                    args?.cliArgs,
                    args?.initialModel,
                    { resumeSessionId: args?.resumeSessionId },
                );

                return {
                    success: true,
                    cliType,
                    dir,
                    id: started.runtimeSessionId,
                    sessionId: started.runtimeSessionId,
                    providerSessionId: started.providerSessionId,
                    launchSource,
                };
            }
            case 'stop_cli': {
                const cliType = args?.cliType;
                const dir = args?.dir || '';
                const mode = args?.mode === 'save' ? 'save' : 'hard';
                if (!cliType) throw new Error('cliType required');
 // UUID session target based search priority
                const found = this.findAdapter(cliType, { instanceKey: args?.targetSessionId, dir });
                if (found) {
                    await this.stopSessionWithMode(found.key, mode);
                } else {
                    console.log(colorize('yellow', `  ⚠ No adapter found for ${cliType}`));
                }
                return { success: true, cliType, dir, stopped: true, mode };
            }
            case 'set_cli_view_mode': {
                const mode = args?.mode === 'chat' ? 'chat' : 'terminal';
                const targetSessionId = typeof args?.targetSessionId === 'string' ? args.targetSessionId : '';
                const cliType = args?.cliType || args?.agentType || '';
                const dir = args?.dir || '';
                const found = this.findAdapterBySessionId(targetSessionId)
                    || (cliType ? this.findAdapter(cliType, { instanceKey: targetSessionId, dir }) : null);
                if (!found) {
                    return { success: false, error: 'CLI session not found', code: 'CLI_SESSION_NOT_FOUND' };
                }
                const instance = this.deps.getInstanceManager()?.getInstance(found.key);
                if (!(instance instanceof CliProviderInstance)) {
                    return { success: false, error: 'CLI instance not found', code: 'CLI_INSTANCE_NOT_FOUND' };
                }
                instance.setPresentationMode(mode);
                this.deps.onStatusChange();
                return { success: true, id: found.key, mode };
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
                const prevCliArgs = found ? (found.adapter as any).extraArgs : undefined;
                if (found) await this.stopSession(found.key);
                await this.startSession(cliType, dir, args?.cliArgs || prevCliArgs, args?.initialModel);
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
