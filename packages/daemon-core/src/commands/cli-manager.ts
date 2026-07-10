/**
 * DaemonCliManager — CLI session creation, management, and command handling
 *
 * Separated from adhdev-daemon.ts.
 * CLI cases of createAdapter, startCliSession, stopCliSession, executeDaemonCommand extracted to independent module extract.
 */

import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import chalk from 'chalk';
import { ProviderCliAdapter } from '../cli-adapters/provider-cli-adapter.js';
import type { CliProviderModule } from '../cli-adapters/provider-cli-adapter.js';
import { detectCLI } from '../detection/cli-detector.js';
import { loadConfig } from '../config/config.js';
import { loadState, saveState } from '../config/state-store.js';
import { getWorkspaceState, resolveLaunchDirectory } from '../config/workspaces.js';
import { appendRecentActivity } from '../config/recent-activity.js';
import { shortHash } from '../system/hash.js';
import { unregisterMeshCoordinator, getCoordinatorForSession, listCoordinatorsForWorkspace } from '../mesh/coordinator-registry.js';
import { upsertSavedProviderSession } from '../config/saved-sessions.js';
import { buildLegacyModelModeSummaryMetadata, normalizeProviderSummaryMetadata } from '../providers/summary-metadata.js';
import { CliProviderInstance } from '../providers/cli-provider-instance.js';
import { AcpProviderInstance } from '../providers/acp-provider-instance.js';
import type { ProviderInstanceManager } from '../providers/provider-instance-manager.js';
import { ProviderLoader } from '../providers/provider-loader.js';
import { normalizeInputEnvelope, type MeshCoordinatorDelegatedWorkerIsolation, type ProviderModule, type ProviderResumeCapability } from '../providers/contracts.js';
import { assertProviderSupportsDeclaredInput, assertTextOnlyInput } from '../providers/provider-input-support.js';
import type { CliAdapter } from '../cli-adapter-types.js';
import type { PtyTransportFactory } from '../cli-adapters/pty-transport.js';
import type { SessionRegistry } from '../sessions/registry.js';
import type { ProviderInstance } from '../providers/provider-instance.js';
import { LOG } from '../logging/logger.js';
import { shouldRestoreHostedRuntime } from './hosted-runtime-restore.js';

// ─── external dependency interface ──────────────────────────

function isExplicitCommand(command: string): boolean {
    const trimmed = command.trim();
    return path.isAbsolute(trimmed) || trimmed.includes('/') || trimmed.includes('\\') || trimmed.startsWith('~');
}

function expandExecutable(command: string): string {
    const trimmed = command.trim();
    return trimmed.startsWith('~') ? path.join(os.homedir(), trimmed.slice(1)) : trimmed;
}

function commandExists(command: string): boolean {
    const trimmed = command.trim();
    if (!trimmed) return false;
    if (isExplicitCommand(trimmed)) {
        return existsSync(expandExecutable(trimmed));
    }
    try {
        execFileSync(process.platform === 'win32' ? 'where' : 'which', [trimmed], {
            stdio: 'ignore',
            ...(process.platform === 'win32' ? { windowsHide: true } : {}),
        });
        return true;
    } catch {
        return false;
    }
}

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
    hostedRuntimeManagerTag?: string;
}

type CommandResult = { success: boolean;[key: string]: unknown };

const BUSY_AGENT_STATUSES = new Set(['generating', 'running', 'streaming', 'starting', 'busy', 'waiting', 'waiting_approval', 'no_progress', 'long_generating']);
const ZERO_MESSAGE_STARTING_SEND_WAIT_MS = 2_000;

function normalizeAgentStatus(value: unknown): string {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function hasNonEmptyModalButtons(activeModal: unknown): boolean {
    const buttons = (activeModal as any)?.buttons;
    return Array.isArray(buttons) && buttons.some((button) => String(button || '').trim().length > 0);
}

function hasAdapterPendingResponse(adapter: any): boolean {
    if (adapter?.isWaitingForResponse === true) return true;
    if (adapter?.currentTurnScope) return true;
    try {
        if (typeof adapter?.isProcessing === 'function' && adapter.isProcessing()) return true;
    } catch { /* defensive: send guard should not fail on diagnostics */ }
    try {
        const partial = typeof adapter?.getPartialResponse === 'function' ? adapter.getPartialResponse() : '';
        if (typeof partial === 'string' && partial.trim()) return true;
    } catch { /* defensive: missing partial means no pending evidence */ }
    return false;
}

function countMessages(value: unknown): number {
    return Array.isArray(value) ? value.length : 0;
}

function hasFinalAssistantMessage(value: unknown): boolean {
    const messages = Array.isArray(value) ? value : [];
    const last = messages[messages.length - 1] as any;
    if (!last || last.role !== 'assistant') return false;
    if (last.bubbleState === 'streaming') return false;
    if (last.meta?.streaming === true) return false;
    return typeof last.content === 'string' && last.content.trim().length > 0;
}

function hasZeroMessageStartingLaunch(adapter: any): boolean {
    const adapterStatus = adapter?.getStatus?.({ allowParse: false }) ?? adapter?.getStatus?.() ?? {};
    const parsedStatus = typeof adapter?.getScriptParsedStatus === 'function'
        ? adapter.getScriptParsedStatus()
        : {};
    const adapterRawStatus = normalizeAgentStatus(adapterStatus?.status);
    const parsedRawStatus = normalizeAgentStatus(parsedStatus?.status);
    if (adapterRawStatus !== 'starting') return false;
    if (parsedRawStatus && parsedRawStatus !== 'starting' && parsedRawStatus !== 'generating') return false;
    if (hasNonEmptyModalButtons(adapterStatus?.activeModal ?? adapterStatus?.modal ?? parsedStatus?.activeModal ?? parsedStatus?.modal)) return false;
    if (countMessages(adapterStatus?.messages) > 0 || countMessages(parsedStatus?.messages) > 0) return false;
    return !hasAdapterPendingResponse(adapter);
}

function hasCompletedStartingLaunch(adapter: any): boolean {
    const adapterStatus = adapter?.getStatus?.({ allowParse: false }) ?? adapter?.getStatus?.() ?? {};
    const adapterRawStatus = normalizeAgentStatus(adapterStatus?.status);
    if (adapterRawStatus !== 'starting') return false;
    if (hasAdapterPendingResponse(adapter)) return false;

    const parsedStatus = typeof adapter?.getScriptParsedStatus === 'function'
        ? adapter.getScriptParsedStatus()
        : {};
    const parsedRawStatus = normalizeAgentStatus(parsedStatus?.status);
    if (parsedRawStatus !== 'idle') return false;
    if (hasNonEmptyModalButtons(adapterStatus?.activeModal ?? adapterStatus?.modal ?? parsedStatus?.activeModal ?? parsedStatus?.modal)) return false;
    return hasFinalAssistantMessage(parsedStatus?.messages);
}

/**
 * WTCLAIM (B): compare two workspace paths for node scoping. Normalizes separator
 * style, trailing slashes, and case (Windows paths are case-insensitive; the
 * coordinator-supplied node.workspace and the adapter's launch workingDir can
 * differ only in those) so a base node and a worktree clone are still told apart
 * by their distinct workspace roots.
 */
function normalizeDirForCompare(dir?: string): string {
    if (typeof dir !== 'string') return '';
    return dir.trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
}

function shouldSuppressStaleParsedBusyStatus(adapterStatus: string, parsedStatus: any, adapter: any): boolean {
    const parsedRawStatus = normalizeAgentStatus(parsedStatus?.status);
    if (!BUSY_AGENT_STATUSES.has(parsedRawStatus)) return false;
    if (adapterStatus !== 'idle') return false;
    if (hasNonEmptyModalButtons(parsedStatus?.activeModal ?? parsedStatus?.modal)) return false;
    return !hasAdapterPendingResponse(adapter);
}

function getEffectiveAgentSendStatus(adapter: any): string {
    const adapterStatus = normalizeAgentStatus(adapter?.getStatus?.({ allowParse: false })?.status ?? adapter?.getStatus?.()?.status);
    if (adapterStatus === 'starting' && hasCompletedStartingLaunch(adapter)) return 'idle';
    if (adapterStatus && adapterStatus !== 'idle') return adapterStatus;
    if (adapterStatus !== 'idle') return adapterStatus;

    if (typeof adapter?.getScriptParsedStatus !== 'function') return adapterStatus;
    try {
        const parsedStatus = adapter.getScriptParsedStatus();
        const parsedRawStatus = normalizeAgentStatus(parsedStatus?.status);
        if (BUSY_AGENT_STATUSES.has(parsedRawStatus) && !shouldSuppressStaleParsedBusyStatus(adapterStatus, parsedStatus, adapter)) {
            return parsedRawStatus;
        }
    } catch {
        return adapterStatus;
    }
    return adapterStatus;
}

async function waitForZeroMessageStartingLaunch(adapter: any): Promise<boolean> {
    try {
        if (!hasZeroMessageStartingLaunch(adapter)) return false;
    } catch {
        return false;
    }
    await new Promise(resolve => setTimeout(resolve, ZERO_MESSAGE_STARTING_SEND_WAIT_MS));
    try {
        return hasZeroMessageStartingLaunch(adapter);
    } catch {
        return false;
    }
}

export interface CliTransportFactoryParams {
    runtimeId: string;
    providerType: string;
    workspace: string;
    cliArgs?: string[];
    providerSessionId?: string;
    attachExisting?: boolean;
    /**
     * Launch-time record meta (meshNodeId / meshNodeFor / launchedByCoordinator /
     * autoLaunchedForQueueTaskId). Defense-in-depth for SESSION-ACCUMULATION-LEAK:
     * a session-host factory impl SHOULD seed the create_session record with this
     * so the node binding is present the instant the record exists, rather than
     * relying solely on the post-spawn updateRuntimeMeta round-trip. Optional and
     * additive — factory impls that ignore it keep the prior behavior; the
     * post-spawn WTDISPATCH stamp in register() still runs as the primary path.
     */
    initialMeta?: Record<string, unknown>;
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
    managedBy?: string;
    /**
     * Real spawn time (ms epoch) of the underlying session-host runtime — a PAST
     * timestamp recorded when the runtime first started. Threaded through so an
     * attach can restore the native-history session-floor to the runtime's actual
     * birth instead of collapsing spawnedAtMs to 0. Undefined when unrecoverable
     * (genuine post-restart-unknown), in which case the caller keeps the 0 fallback.
     */
    startedAtMs?: number;
}

type CliPresentationInstance = ProviderInstance & {
    getPresentationMode?(): 'terminal' | 'chat';
};

type ChalkColorFn = (text: string) => string;
type ChalkLike = Partial<Record<'red' | 'green' | 'yellow' | 'cyan', ChalkColorFn>>;

const chalkModule = chalk as unknown as ChalkLike & { default?: ChalkLike };
const chalkApi: ChalkLike | null = typeof chalkModule.yellow === 'function'
    ? chalkModule
    : chalkModule.default || null;

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

type CliAdapterWithExtraArgs = CliAdapter & {
    extraArgs?: string[];
};

type CliStartOptions = {
    resumeSessionId?: string;
    settingsOverride?: Record<string, any>;
    extraEnv?: Record<string, string>;
    /** BRAIN-ROUTING thinking axis: standard level ('low'|'medium'|'high') applied
     *  at launch via the provider's thinkingLaunchArgs (CLI) or setConfigOption
     *  ('thought_level', ACP). Best-effort — ignored by providers with no support. */
    initialThinkingLevel?: string;
};

const DEFAULT_COORDINATOR_DELEGATED_ENV_UNSETS = [
    'ADHDEV_INLINE_MESH',
    'ADHDEV_MCP_TRANSPORT',
    'ADHDEV_MESH_ID',
    'HERMES_EPHEMERAL_SYSTEM_PROMPT',
] as const;

export interface CoordinatorDelegatedCliLaunchOptionsInput {
    cliType: string;
    workspace: string;
    cliArgs?: string[];
    env?: Record<string, string>;
    isolation?: MeshCoordinatorDelegatedWorkerIsolation;
}

export interface CoordinatorDelegatedCliLaunchOptions {
    cliArgs: string[];
    env: Record<string, string>;
}

function hasCliArg(args: string[], flag: string): boolean {
    return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

/**
 * Decide the session-registry spawnedAtMs (the native-history session-floor) for a
 * newly registered CLI instance.
 *
 * - Fresh launch (attachExisting=false): now (nowMs). A real live spawn floor
 *   isolates a fresh session's own store and holds prior-session leak protection.
 * - Attach WITH a recoverable record startedAt (a PAST timestamp): that startedAt.
 *   Restoring a hosted runtime (coordinator / MAGI replica / hermes / claude /
 *   codex) after a daemon restart, the real spawn time is in the past. Using it
 *   restores each session's per-session birth-floor so co-located antigravity
 *   runtimes resolve their OWN conversation (ownerConfirmed) instead of the
 *   floor-less newest-by-mtime path that let a replica claim the coordinator's conv.
 * - Attach with NO recoverable startedAt: 0 — disables the floor for this session
 *   (recent_window_ms still bounds the look-back). NEVER use nowMs here: nowMs is in
 *   the FUTURE relative to existing transcripts and would push the floor past every
 *   transcript file, losing them (the ANTIGRAVITY-FINAL-MESSAGE-TAIL-GAP regression).
 */
export function resolveHostedSpawnedAtMs(
    attachExisting: boolean,
    attachStartedAtMs: number | undefined,
    nowMs: number,
): number {
    if (!attachExisting) return nowMs;
    if (typeof attachStartedAtMs === 'number' && attachStartedAtMs > 0) return attachStartedAtMs;
    return 0;
}

function hasConfigOverride(args: string[], key: string): boolean {
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        const next = args[index + 1];
        if ((arg === '-c' || arg === '--config') && typeof next === 'string') {
            if (next === key || next.startsWith(`${key}=`) || next.startsWith(`${key}.`)) return true;
        }
        if (arg.startsWith('--config=')) {
            const value = arg.slice('--config='.length);
            if (value === key || value.startsWith(`${key}=`) || value.startsWith(`${key}.`)) return true;
        }
    }
    return false;
}

function ensureEmptyDelegatedMcpConfig(workspace: string): string {
    const baseDir = path.join(os.tmpdir(), 'adhdev-delegated-agent-empty-mcp');
    mkdirSync(baseDir, { recursive: true });
    const workspaceHash = shortHash(path.resolve(workspace || os.tmpdir()));
    const filePath = path.join(baseDir, `${workspaceHash}.json`);
    writeFileSync(filePath, JSON.stringify({ mcpServers: {} }, null, 2), 'utf-8');
    return filePath;
}

export function buildCoordinatorDelegatedCliLaunchOptions(
    input: CoordinatorDelegatedCliLaunchOptionsInput,
): CoordinatorDelegatedCliLaunchOptions {
    const cliArgs = Array.isArray(input.cliArgs) ? [...input.cliArgs] : [];
    const env: Record<string, string> = { ...(input.env || {}) };
    const envUnsets = new Set<string>(DEFAULT_COORDINATOR_DELEGATED_ENV_UNSETS);
    for (const key of input.isolation?.env?.unset || []) {
        if (typeof key === 'string' && key.trim()) envUnsets.add(key.trim());
    }
    for (const key of envUnsets) env[key] = '';

    for (const rule of input.isolation?.args || []) {
        if (!rule || typeof rule !== 'object') continue;
        if (rule.mode === 'empty_mcp_config') {
            if (rule.flag && !hasCliArg(cliArgs, rule.flag)) {
                cliArgs.unshift(rule.flag, ensureEmptyDelegatedMcpConfig(input.workspace));
            }
            if (rule.strictFlag && !hasCliArg(cliArgs, rule.strictFlag)) {
                cliArgs.unshift(rule.strictFlag);
            }
            continue;
        }
        if (rule.mode === 'config_override') {
            const key = String(rule.dedupeKey || rule.key || '').trim();
            const flag = String(rule.flag || '').trim();
            if (!key || !flag || hasConfigOverride(cliArgs, key)) continue;
            cliArgs.unshift(flag, `${rule.key}=${rule.value}`);
        }
    }

    return { cliArgs, env };
}

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

/**
 * Expand a provider's `modelLaunchArgs` template with the requested model, mirroring
 * expandResumeArgs. `{{model}}` → the trimmed model string. Returns undefined when
 * there is no template or no model (a model request without a template is a no-op —
 * see startSession, where the caller logs the skip). MAGI kind-panel model axis.
 */
export function expandModelLaunchArgs(template: string[] | undefined, model: string | undefined): string[] | undefined {
    const m = typeof model === 'string' ? model.trim() : '';
    if (!m || !Array.isArray(template) || template.length === 0) return undefined;
    // Substitute {{model}} anywhere in a token, not only when it is the whole token,
    // so templates like ['-c', 'model={{model}}'] (codex) expand as well as the
    // standalone ['--model', '{{model}}'] (claude) form.
    return template.map((part) => part.includes('{{model}}') ? part.split('{{model}}').join(m) : part);
}

/**
 * Expand a provider's `thinkingLaunchArgs` template with the requested thinking
 * level, parallel to expandModelLaunchArgs. The standard level ('low'|'medium'|
 * 'high') is first mapped through the provider's `thinkingLevelMap` (a level absent
 * from the map passes through unchanged), then substituted into every `{{level}}`
 * token. Returns undefined when there is no template or no level (best-effort; a
 * thinking request without a template is a no-op). BRAIN-ROUTING thinking axis.
 */
export function expandThinkingLaunchArgs(
    template: string[] | undefined,
    level: string | undefined,
    levelMap: Partial<Record<string, string>> | undefined,
): string[] | undefined {
    const raw = typeof level === 'string' ? level.trim() : '';
    if (!raw || !Array.isArray(template) || template.length === 0) return undefined;
    const mapped = (levelMap && typeof levelMap[raw] === 'string' && levelMap[raw]!.trim()) ? levelMap[raw]!.trim() : raw;
    return template.map((part) => part.includes('{{level}}') ? part.replace('{{level}}', mapped) : part);
}

function readSubcommandSessionId(args: string[], subcommands: string[]): string | undefined {
    const resumeIndex = args.findIndex((arg) => subcommands.includes(arg));
    if (resumeIndex < 0) return undefined;
    const candidate = args[resumeIndex + 1];
    if (!candidate || candidate.startsWith('-')) return undefined;
    return candidate;
}

function detectExplicitProviderSessionId(
    provider: ProviderModule | undefined,
    args: string[],
): { providerSessionId?: string; launchMode: CliLaunchMode } {
    const resume = provider?.resume;

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
        if (resume?.sessionIdIsNewByDefault && !hasArg(args, ['--resume', '-r'])) {
            return { launchMode: 'manual' };
        }
        const isResume = resume?.sessionIdIsNewByDefault
            ? hasArg(args, ['--resume', '-r'])
            : (hasArg(args, ['--continue']) || hasArg(args, ['--resume', '-r']));
        return {
            providerSessionId: explicitSessionId,
            launchMode: isResume ? 'resume' : 'new',
        };
    }

    const subcommands = resume?.sessionIdFromSubcommand;
    if (Array.isArray(subcommands) && subcommands.length > 0) {
        const hasResumeSubcommand = args.some((arg) => subcommands.includes(arg));
        const subcommandSessionId = readSubcommandSessionId(args, subcommands);
        if (subcommandSessionId) {
            return { providerSessionId: subcommandSessionId, launchMode: 'resume' };
        }
        if (hasResumeSubcommand) {
            return { launchMode: 'resume' };
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

export function resolveCliSessionBinding(
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

    const explicit = detectExplicitProviderSessionId(provider, baseArgs || []);
    if (explicit.providerSessionId) {
        return {
            cliArgs: baseArgs,
            providerSessionId: explicit.providerSessionId,
            launchMode: explicit.launchMode,
        };
    }
    if (explicit.launchMode === 'resume') {
        return {
            cliArgs: baseArgs,
            launchMode: 'resume',
        };
    }
    if (explicit.launchMode === 'manual' && hasArg(baseArgs || [], ['--session-id'])) {
        return {
            cliArgs: baseArgs,
            launchMode: 'manual',
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
        return { cliArgs: baseArgs, launchMode: 'new' };
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
        const instance = this.deps.getInstanceManager()?.getInstance(sessionId) as CliPresentationInstance | undefined;
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
        summaryMetadata?: unknown;
        sessionId?: string;
        title?: string;
    }): void {
        try {
            const summaryMetadata = normalizeProviderSummaryMetadata(entry.summaryMetadata as any);
            let nextState = appendRecentActivity(loadState(), {
                ...entry,
                summaryMetadata,
            });
            if (entry.providerSessionId && (entry.kind === 'cli' || entry.kind === 'acp')) {
                nextState = upsertSavedProviderSession(nextState, {
                    kind: entry.kind,
                    providerType: entry.providerType,
                    providerName: entry.providerName,
                    providerSessionId: entry.providerSessionId,
                    workspace: entry.workspace,
                    summaryMetadata,
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
        initialMeta?: Record<string, unknown>,
    ): PtyTransportFactory | undefined {
        return this.deps.createPtyTransportFactory?.({
            runtimeId,
            providerType,
            workspace,
            cliArgs,
            providerSessionId,
            attachExisting,
            ...(initialMeta && Object.keys(initialMeta).length ? { initialMeta } : {}),
        }) || undefined;
    }

    private createAdapter(
        cliType: string,
        workingDir: string,
        cliArgs: string[] | undefined,
        runtimeId: string,
        providerSessionId?: string,
        attachExisting = false,
        extraEnv?: Record<string, string>,
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
            const adapter = new ProviderCliAdapter(resolvedProvider as CliProviderModule, workingDir, cliArgs, extraEnv || {}, transportFactory);
            if (providerSessionId) adapter.updateRuntimeMeta({ providerSessionId });
            return adapter;
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
                            unregisterMeshCoordinator(key);
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
            extraEnv?: Record<string, string>;
            /** BRAIN-ROUTING: post-launch thinking level for runtime-control providers
             *  (e.g. hermes reasoning). Passed through to the instance. */
            initialThinkingLevel?: string;
            /**
             * On an attach (attachExisting=true), the real spawn time (ms epoch) of the
             * session-host runtime being restored — a PAST timestamp. Used to restore the
             * native-history session-floor to the runtime's actual birth instead of 0.
             * See the spawnedAtMs computation below. Ignored for fresh launches.
             */
            attachStartedAtMs?: number;
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

        // Launch-time record meta (mesh node binding) — computed BEFORE the
        // transport factory so the session-host record can be seeded with the
        // binding at create_session time (Fix ②, defense-in-depth for
        // SESSION-ACCUMULATION-LEAK), not only via the post-spawn WTDISPATCH
        // updateRuntimeMeta round-trip below. See CliTransportFactoryParams.initialMeta.
        const launchMeshNodeId = typeof settings?.meshNodeId === 'string' ? settings.meshNodeId.trim() : '';
        const launchMeshNodeFor = typeof settings?.meshNodeFor === 'string' ? settings.meshNodeFor.trim() : '';
        const launchAutoLaunchedForQueueTaskId = typeof settings?.autoLaunchedForQueueTaskId === 'string'
            ? settings.autoLaunchedForQueueTaskId.trim()
            : '';
        const launchRecordMeta: Record<string, unknown> = {
            ...(launchMeshNodeId ? { meshNodeId: launchMeshNodeId } : {}),
            ...(launchMeshNodeFor ? { meshNodeFor: launchMeshNodeFor } : {}),
            ...(settings?.launchedByCoordinator === true ? { launchedByCoordinator: true } : {}),
            ...(launchAutoLaunchedForQueueTaskId ? { autoLaunchedForQueueTaskId: launchAutoLaunchedForQueueTaskId } : {}),
        };

        const transportFactory = this.getTransportFactory(
            key,
            normalizedType,
            resolvedDir,
            cliArgs,
            options?.providerSessionId,
            attachExisting,
            // Only seed at create time for fresh launches — an attach restores an
            // existing record whose meta is already stamped; re-seeding could clobber.
            attachExisting ? undefined : launchRecordMeta,
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
                workspace: resolvedDir,
                // attachExisting === true means we're restoring an already-spawned
                // hosted runtime after a daemon restart, not starting a fresh PTY.
                //
                // NEVER use Date.now() for the attach case: the real spawn time is in
                // the PAST, and pinning the floor to now would push the native-history
                // session-floor cutoff past every existing transcript file, so the
                // agy/hermes/claude reader would return null even though the transcript
                // on disk is fresh (the ANTIGRAVITY-FINAL-MESSAGE-TAIL-GAP regression).
                //
                // But collapsing to 0 for EVERY attach is also wrong: with the mesh
                // coordinator + MAGI replicas all running as hosted runtimes sharing one
                // workspace and attached with attachExisting=true, spawnedAtMs=0 disables
                // the per-session native-history birth-floor for all of them. Without a
                // floor, resolveAntigravityPath takes the floor-less newest-by-mtime
                // branch (ownerConfirmed:false) and a replica's read can claim the
                // coordinator's OWN conversation, which then reads as claimedByOther —
                // regressing the coordinator chat to the pty-parser (user-only) path.
                //
                // So when the session-host record's REAL startedAt (a PAST timestamp) is
                // recoverable, use it: the floor lands at the runtime's actual birth, the
                // transcript is still found, AND each session's floor isolates its own
                // conversation. Fall back to 0 ONLY when startedAt is unrecoverable (the
                // genuine post-restart-unknown case) — that preserves the tail-gap
                // protection. Fresh launches still get Date.now() so prior-session leak
                // protection holds.
                spawnedAtMs: resolveHostedSpawnedAtMs(attachExisting, options?.attachStartedAtMs, Date.now()),
            });
        } catch (spawnErr: any) {
            LOG.error('CLI', `[${cliType}] Spawn failed: ${spawnErr?.message}`);
            instanceManager.removeInstance(key);
            throw new Error(`Failed to start ${provider.displayName || provider.name || cliType}: ${spawnErr?.message}`);
        }

        this.adapters.set(key, cliInstance.getAdapter());

        // WTDISPATCH (no_node_binding): a coordinator-launched worker carries its mesh node
        // binding on the CLI-instance settings, but the session-host RECORD meta was never
        // stamped with it — `updateRuntimeSettings` only mutates in-memory runtime settings and
        // `updateRuntimeMeta` was only ever called with providerSessionId. So mesh_cleanup_sessions
        // matched these worker sessions to a node by workspace ALONE
        // (`live_session_matched_by_workspace_only_no_node_binding`), which on a daemon hosting
        // sibling worktree nodes cannot tell two co-located clones apart. Push the launch-time node
        // binding to the record meta so the record is 1:1 bound to its node (the spawned pty exists
        // by now, so updateMeta reaches the session-host store). Best-effort; guarded.
        //
        // With the spec-CLI updateRuntimeMeta fix (SpecCliAdapter now forwards the FULL
        // meta down to the transport, not just providerSessionId), this stamp finally
        // reaches the session-host record for spec-backed providers too — previously it
        // was silently dropped, which is what let orphans accumulate. launchRecordMeta
        // is hoisted above and also seeds the create_session record via initialMeta.
        if (Object.keys(launchRecordMeta).length) {
            try {
                cliInstance.getAdapter().updateRuntimeMeta?.({ ...launchRecordMeta });
            } catch { /* best-effort — record-meta stamp is cleanup hygiene, not on the dispatch path */ }
        }

        this.startCliExitMonitor(key, cliType);
    }

 // ─── Session start/management ──────────────────────────────

    async startSession(
        cliType: string,
        workingDir: string,
        cliArgs?: string[],
        initialModel?: string,
        options?: CliStartOptions,
    ): Promise<{ runtimeSessionId: string; providerSessionId?: string }> {
        const trimmed = (workingDir || '').trim();
        if (!trimmed) throw new Error('working directory required');
        const resolvedDir = trimmed.startsWith('~')
            ? trimmed.replace(/^~/, os.homedir())
            : path.resolve(trimmed);

 // cliType normalize (Resolve alias)
        const normalizedType = this.providerLoader.resolveAlias(cliType);
        const rawProvider = this.providerLoader.getByAlias(cliType);
        const provider = rawProvider ? (this.providerLoader.resolve(normalizedType) || rawProvider) : undefined;
        if (provider && (provider.category === 'cli' || provider.category === 'acp') && !this.providerLoader.isMachineProviderEnabled(normalizedType)) {
            const displayName = provider.displayName || provider.name || normalizedType;
            throw new Error(
                `${displayName} is disabled on this machine.\n` +
                `Enable and detect this provider from the Machine Providers page before starting a runtime.`
            );
        }

 // Create UUID-based key (allows separate instances even for same type+dir)
        const key = crypto.randomUUID();

        // (3) Session-anchored mesh routing: when launching a mesh COORDINATOR session
        // (settings.meshCoordinatorFor set), expose this session's OWN runtime id to its MCP
        // server via env. The MCP server is spawned by the CLI as a child and inherits this
        // env, so the MCP layer can stamp ADHDEV_COORDINATOR_SESSION_ID as the originating
        // coordinator on every dispatch (→ MeshContext.coordinatorSessionId → worker
        // meshCoordinatorSessionId → completion targetCoordinatorSessionId → strict route).
        // `key` IS the instance id findLiveCoordinators matches on, so the stamp and the live
        // session agree. Re-applied on every (re)launch, so it always reflects the current id;
        // a stale value only survives if the CLI process outlives a daemon restart, in which
        // case routing falls back to the daemon level (no wedge — see mesh-reconcile-loop).
        {
            const coordinatorMeshId = (options?.settingsOverride as Record<string, unknown> | undefined)?.meshCoordinatorFor;
            if (typeof coordinatorMeshId === 'string' && coordinatorMeshId.trim()) {
                options = { ...options, extraEnv: { ...(options?.extraEnv || {}), ADHDEV_COORDINATOR_SESSION_ID: key } };
            }
        }

        const sessionRegistry = this.deps.getSessionRegistry?.() || null;

 // ─── ACP category handle ───
        if (provider && provider.category === 'acp') {
            const instanceManager = this.deps.getInstanceManager();
            if (!instanceManager) throw new Error('InstanceManager not available');
            const resolvedProvider = this.providerLoader.resolve(normalizedType) || provider;

 // Check if command is installed
            const spawnCmd = resolvedProvider.spawn?.command;
            if (spawnCmd && !commandExists(spawnCmd)) {
                const installInfo = provider.install || `Install: check ${provider.displayName || provider.name} documentation`;
                throw new Error(
                    `${provider.displayName || provider.name} is not installed.\n` +
                    `Command '${spawnCmd}' not found.\n\n` +
                    `${installInfo}`
                );
            }

            console.log(colorize('cyan', `  🔌 Starting ACP agent: ${provider.name} (${provider.type}) in ${resolvedDir}`));

            const acpInstance = new AcpProviderInstance(resolvedProvider, resolvedDir, cliArgs);
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
                workspace: resolvedDir,
            });

 // Register ACP entry in adapter map (getStatus queries from acpInstance in real-time)
            this.adapters.set(key, {
                cliType: normalizedType,
                cliName: provider.name,
                workingDir: resolvedDir,
                _acpInstance: acpInstance,
                spawn: async () => {},
                shutdown: () => { instanceManager.removeInstance(key); },
                sendMessage: async (text: string) => {
                    const input = normalizeInputEnvelope(text);
                    acpInstance.onEvent('send_message', { input });
                },
                getStatus: () => {
                    const state = acpInstance.getState();
                    return {
                        status: state.status,
                        messages: state.activeChat?.messages || [],
                        activeModal: state.activeChat?.activeModal || null,
                    };
                },
                getPartialResponse: () => '',
                cancel: () => { instanceManager.removeInstance(key); },
                isProcessing: () => false,
                isReady: () => true,
                setOnStatusChange: () => {},
                setOnPtyData: () => {},
            });

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

 // Brain routing thinking axis for ACP: route the standard level through the
 // agent's thought_level config option. Best-effort — throws if the agent declares
 // no thought_level category (see setConfigOption), so we swallow and warn.
            if (options?.initialThinkingLevel) {
                const lvl = options.initialThinkingLevel;
                try {
                    await acpInstance.setConfigOption('thought_level', lvl);
                    console.log(colorize('green', `  🧠 Initial thinking level set: ${lvl}`));
                } catch (e: any) {
                    LOG.warn('CLI', `[ACP] Initial thinking level set failed (provider may not support thought_level): ${e?.message}`);
                }
            }

            this.persistRecentActivity({
                kind: 'acp',
                providerType: normalizedType,
                providerName: provider.displayName || provider.name || normalizedType,
                workspace: resolvedDir,
                summaryMetadata: buildLegacyModelModeSummaryMetadata({ model: initialModel }),
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
            const spawnCmd = this.providerLoader.getSpawnCommand(normalizedType, provider?.spawn?.command || cliType);
            throw new Error(
                `${displayName} is not installed.\n` +
                `Command '${spawnCmd}' is not available.\n` +
                (installHint ? `\n${installHint}\n` : '') +
                `\nRun 'adhdev doctor' for detailed diagnostics.`
            );
        }

        console.log(colorize('yellow', `  ⚡ Starting CLI ${cliType} in ${resolvedDir}...`));
        if (provider) {
            console.log(colorize('cyan', `  📦 Using provider: ${provider.name} (${provider.type})`));
        }

 // ─── Model axis (MAGI kind-panel): expand initialModel → launch args ───
 // For a plain CLI provider the model is selected at spawn time via the manifest's
 // modelLaunchArgs template ('{{model}}' → the requested model). ACP providers took
 // the setConfigOption path above and never reach here. A provider with no template,
 // or no requested model, is a no-op — model selection is best-effort and must never
 // fail a launch. The model args are prepended so a caller's explicit cliArgs (e.g. a
 // resume flag) still win positionally where order matters.
        const modelLaunchArgs = expandModelLaunchArgs(provider?.modelLaunchArgs, initialModel);
        const cliArgsWithModel = modelLaunchArgs
            ? [...modelLaunchArgs, ...(cliArgs || [])]
            : cliArgs;
        if (initialModel && !modelLaunchArgs) {
            LOG.warn('CLI', `[${normalizedType}] initialModel='${initialModel}' requested but provider declares no modelLaunchArgs template — launching without model selection.`);
        }

 // ─── Thinking axis (brain routing): expand initialThinkingLevel → launch args ───
 // Parallel to the model axis: a plain CLI provider selects reasoning effort at spawn
 // via the manifest's thinkingLaunchArgs template ('{{level}}' → the mapped level).
 // Best-effort; a provider with no template (or no requested level) is a no-op. ACP
 // providers route thinking through setConfigOption('thought_level') above.
        const initialThinkingLevel = options?.initialThinkingLevel;
        const thinkingLaunchArgs = expandThinkingLaunchArgs(provider?.thinkingLaunchArgs, initialThinkingLevel, provider?.thinkingLevelMap);
        const cliArgsWithBrain = thinkingLaunchArgs
            ? [...thinkingLaunchArgs, ...(cliArgsWithModel || [])]
            : cliArgsWithModel;
        if (initialThinkingLevel && !thinkingLaunchArgs) {
            LOG.warn('CLI', `[${normalizedType}] initialThinkingLevel='${initialThinkingLevel}' requested but provider declares no thinkingLaunchArgs template — launching without thinking-level selection.`);
        }

 // ─── Resolve launch options → provider session binding ───
        const sessionBinding = resolveCliSessionBinding(provider, normalizedType, cliArgsWithBrain, options?.resumeSessionId);
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
                { ...this.providerLoader.getSettings(normalizedType), ...(options?.settingsOverride || {}) },
                false,
                {
                    providerSessionId: sessionBinding.providerSessionId,
                    launchMode: sessionBinding.launchMode,
                    extraEnv: options?.extraEnv,
                    // BRAIN-ROUTING: for a provider with no thinkingLaunchArgs but a
                    // runtime reasoning control (hermes), apply the level post-launch.
                    // The launch-arg providers (claude/codex) already consumed it at spawn.
                    ...(options?.initialThinkingLevel && !provider?.thinkingLaunchArgs ? { initialThinkingLevel: options.initialThinkingLevel } : {}),
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
                options?.extraEnv,
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
            summaryMetadata: buildLegacyModelModeSummaryMetadata({ model: initialModel }),
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
            unregisterMeshCoordinator(key);
            LOG.info('CLI', `🛑 Agent stopped: ${adapter.cliType} in ${adapter.workingDir}`);
            this.deps.onStatusChange();
        } else {
            // Adapter not found — try InstanceManager direct removal
            const im = this.deps.getInstanceManager();
            if (im) {
                this.deps.getSessionRegistry?.()?.unregisterByInstanceKey(key);
                im.removeInstance(key);
                this.deps.removeAgentTracking(key);
                unregisterMeshCoordinator(key);
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
        const restoredBindings = new Set<string>();
        const managerTag = this.deps.hostedRuntimeManagerTag;

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

        for (const record of sessions) {
            if (!record?.runtimeId || !record?.cliType || !record?.workspace) continue;
            if (!shouldRestoreHostedRuntime(record, managerTag)) {
                LOG.info(
                    'CLI',
                    `↷ Skipping hosted runtime restore owned by ${record.managedBy}: ${record.runtimeKey || record.runtimeId}`
                );
                continue;
            }
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
            const restoredSettings: Record<string, any> = { ...this.providerLoader.getSettings(normalizedType) };
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
                }
            }
            if (coordinatorEntry?.meshId) {
                restoredSettings.meshCoordinatorFor = coordinatorEntry.meshId;
            }
            try {
                await this.registerCliInstance(
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
                        // and let MAGI replicas claim the coordinator's own conversation).
                        // Undefined → registerCliInstance keeps the 0 fallback.
                        attachStartedAtMs: record.startedAtMs,
                    },
                );
                restoredBindings.add(bindingKey);
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
 // 1. agentType + dir match.
 //    FAIL-CLOSED when an explicit instanceKey/targetSessionId was named (step 0) but
 //    did not resolve: the caller pinned a SPECIFIC session, so healing by workspace must
 //    not silently redirect the command into a co-located SIBLING worktree session. The
 //    remote mesh relay (ipcDispatchToRemoteAgent) carries `dir: node.workspace` alongside
 //    targetSessionId for the sessionless-scope case; when a session WAS named, that dir
 //    fallback is the WTDISPATCH-FANOUT (a) leak — a stale/relaunched session_id would
 //    dir-match whatever session lives in that workspace instead of failing. The sessionless
 //    node-scoped path uses findMeshNodeAdapter, not this fallback, so gating dir on
 //    !instanceKey loses no legitimate routing. Mirror step 2's fail-closed rule.
        if (opts?.dir && !opts?.instanceKey) {
            for (const [k, a] of this.adapters) {
                if (a.cliType === agentType && a.workingDir === opts.dir) {
                    return { adapter: a, key: k };
                }
            }
        }
 // 2. Fuzzy match (returns first of multiple sessions — may be inaccurate).
 //    FAIL-CLOSED: only when NO explicit instanceKey/targetSessionId was requested.
 //    When a specific session WAS named (step 0) but is not hosted on this daemon,
 //    falling back to the first same-cliType adapter silently redirects the command
 //    into an UNRELATED session — e.g. a relayed/misrouted mesh send_chat lands in the
 //    coordinator's own CLI session, echoing the dispatched task body back to the
 //    coordinator (TASKECHO self-inject). Returning null instead makes the caller
 //    surface an explicit "not running" error rather than mis-delivering the message.
        if (!opts?.instanceKey) {
            for (const [k, a] of this.adapters) {
                if (a.cliType === agentType) {
                    return { adapter: a, key: k };
                }
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

    /**
     * WTCLAIM (B): resolve the adapter for a mesh dispatch that named a node
     * (meshContext.nodeId) but carried no explicit session. Matches by the
     * instance's bound mesh node id (settings.meshNodeId, falling back to the
     * sticky meshLastNodeId) first, then by the node workspace (workingDir).
     *
     * Unlike findAdapter's step-2 fuzzy fallback, this NEVER degrades to a
     * provider-only first-match: on a daemon hosting BOTH a base node and a
     * cloned worktree node (same daemonId), that fuzzy match could land a
     * worktree-targeted task on the base session. Returns null when no session
     * is bound to this node so the caller fails closed.
     */
    private findMeshNodeAdapter(agentType: string, nodeId: string, dir?: string): { adapter: CliAdapter; key: string } | null {
        const instanceManager = this.deps.getInstanceManager();
        const targetDir = normalizeDirForCompare(dir);
        let workspaceMatch: { adapter: CliAdapter; key: string } | null = null;
        for (const [k, a] of this.adapters) {
            if (a.cliType !== agentType) continue;
            const settings = (instanceManager?.getInstance(k) as any)?.getState?.()?.settings as Record<string, unknown> | undefined;
            const boundNodeId = (typeof settings?.meshNodeId === 'string' && settings.meshNodeId.trim())
                ? settings.meshNodeId.trim()
                : (typeof settings?.meshLastNodeId === 'string' ? settings.meshLastNodeId.trim() : '');
            // Exact node binding wins immediately (most precise).
            if (boundNodeId && boundNodeId === nodeId) return { adapter: a, key: k };
            // Workspace identity is the secondary signal for a session not (yet)
            // stamped with a node id — a base node and a worktree clone always have
            // distinct workspaces, so this still separates them.
            if (!workspaceMatch && targetDir && normalizeDirForCompare(a.workingDir) === targetDir) {
                workspaceMatch = { adapter: a, key: k };
            }
        }
        return workspaceMatch;
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

                const providerType = this.providerLoader.resolveAlias(cliType);
                const provLookup = this.providerLoader.getMeta(providerType) as ProviderModule | undefined;
                const settingsOverride = args?.settings && typeof args.settings === 'object' ? args.settings : undefined;
                const delegatedLaunch = settingsOverride?.launchedByCoordinator === true
                    ? buildCoordinatorDelegatedCliLaunchOptions({
                        cliType,
                        workspace: dir,
                        cliArgs: args?.cliArgs,
                        env: args?.env,
                        isolation: provLookup?.meshCoordinator?.delegatedWorkerIsolation,
                    })
                    : null;
                // Untrusted-provider gate: an external source that ships JS
                // hooks needs explicit user confirmation before its first
                // launch. Dashboards add `confirmExternalUntrusted: true` to
                // the launch args after showing the trust modal. Without
                // that ack we refuse to spawn and tell the caller why.
                const provMeta = provLookup as any;
                const provTrust = provMeta?._sourceTrust;
                if (provTrust === 'external-untrusted' && args?.confirmExternalUntrusted !== true) {
                    return {
                        success: false,
                        error: 'untrusted_external_provider',
                        provider: {
                            type: provLookup?.type ?? cliType,
                            sourceName: provMeta?._sourceName ?? null,
                            trust: provTrust,
                        },
                        hint: 'Resend launch_cli with confirmExternalUntrusted=true after the user explicitly approves running JavaScript from this 3rd-party source.',
                    };
                }
                const started = await this.startSession(
                    cliType,
                    dir,
                    delegatedLaunch ? delegatedLaunch.cliArgs : args?.cliArgs,
                    args?.initialModel,
                    {
                        resumeSessionId: args?.resumeSessionId,
                        settingsOverride,
                        extraEnv: delegatedLaunch ? delegatedLaunch.env : args?.env,
                        ...(typeof args?.initialThinkingLevel === 'string' && args.initialThinkingLevel.trim() ? { initialThinkingLevel: args.initialThinkingLevel.trim() } : {}),
                    },
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
 // If we got here via fuzzy match (no targetSessionId, no dir), check for ambiguity.
 // If multiple sessions of the same type exist, refuse to stop without a targetSessionId.
                    if (!args?.targetSessionId && !dir) {
                        const matchCount = [...this.adapters.values()].filter((a) => a.cliType === cliType).length;
                        if (matchCount > 1) {
                            return {
                                success: false,
                                error: `Multiple ${cliType} sessions running — provide targetSessionId to stop a specific session`,
                                code: 'AMBIGUOUS_SESSION',
                            };
                        }
                    }
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
            case 'record_provider_pty': {
                const cliType = args?.type || args?.cliType;
                if (!cliType) {
                    return { success: false, error: '`type` (provider type) is required', code: 'MISSING_TYPE' };
                }
                const targetSessionId = typeof args?.targetSessionId === 'string' ? args.targetSessionId : '';
                const dir = args?.dir || '';
                const found = (targetSessionId ? this.findAdapterBySessionId(targetSessionId) : null)
                    || this.findAdapter(cliType, { instanceKey: targetSessionId, dir });
                if (!found) {
                    return {
                        success: false,
                        error: `No running ${cliType} session. Launch one first (adhdev launch ${cliType}) or pass --target-session-id.`,
                        code: 'NO_RUNNING_SESSION',
                    };
                }
                const instance = this.deps.getInstanceManager()?.getInstance(found.key);
                if (!(instance instanceof CliProviderInstance)) {
                    return { success: false, error: 'CLI instance not available', code: 'CLI_INSTANCE_NOT_FOUND' };
                }
                const adapter = instance.getAdapter();
                if (!adapter || typeof (adapter as any).getAccumulatedRawBuffer !== 'function') {
                    return { success: false, error: 'Adapter does not expose PTY buffer', code: 'ADAPTER_NOT_RECORDABLE' };
                }
                const buffer = (adapter as any).getAccumulatedRawBuffer() as { text: string; droppedChars: number };
                const maxBytes = Number(args?.maxBytes) > 0 ? Number(args.maxBytes) : 262144;
                const truncated = buffer.text.length > maxBytes;
                const ptyBytes = truncated ? buffer.text.slice(-maxBytes) : buffer.text;
                return {
                    success: true,
                    cliType,
                    sessionId: found.key,
                    ptyBytes,
                    bytes: ptyBytes.length,
                    truncated,
                    droppedChars: buffer.droppedChars,
                    capturedAt: Date.now(),
                };
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
                const prevCliArgs = found ? (found.adapter as CliAdapterWithExtraArgs).extraArgs : undefined;
                if (found) await this.stopSession(found.key);
                await this.startSession(cliType, dir, args?.cliArgs || prevCliArgs, args?.initialModel);
                return { success: true, restarted: true };
            }
            case 'agent_command': {
                const agentType = args?.agentType || args?.cliType;
                const action = args?.action;
                if (!agentType || !action) throw new Error('agentType and action required');

                // WTCLAIM (B): a mesh dispatch that named a node (meshContext.nodeId)
                // but resolved no explicit session must be scoped to THAT node's
                // session — never routed by findAdapter's provider-only fuzzy fallback,
                // which on a daemon hosting both a base node and a cloned worktree node
                // (same daemonId) could land a worktree task on the base session. Fail
                // closed when no session is bound to the node so the coordinator
                // launches/retries instead of mis-landing the work.
                const meshScopeNodeId = (() => {
                    const mc = (args as any)?.meshContext;
                    return mc && typeof mc === 'object' && typeof mc.nodeId === 'string' ? mc.nodeId.trim() : '';
                })();
                let found: { adapter: CliAdapter; key: string } | null;
                if (meshScopeNodeId && !args?.targetSessionId) {
                    found = this.findMeshNodeAdapter(agentType, meshScopeNodeId, args?.dir);
                    if (!found) {
                        throw new Error(`No mesh worker session bound to node '${meshScopeNodeId}' for agent '${agentType}' on this daemon; refusing provider-only fuzzy match to avoid cross-node dispatch`);
                    }
                } else {
                    found = this.findAdapter(agentType, {
                        dir: args?.dir,
                        instanceKey: args?.targetSessionId,
                    });
                }
                if (!found) throw new Error(`CLI agent not running: ${agentType}`);
                const { adapter, key } = found;

                if (action === 'send_chat') {
                    let currentStatus = getEffectiveAgentSendStatus(adapter);
                    if (currentStatus === 'starting' && await waitForZeroMessageStartingLaunch(adapter)) {
                        currentStatus = 'idle';
                    } else if (currentStatus === 'starting') {
                        currentStatus = getEffectiveAgentSendStatus(adapter);
                    }
                    // Stamp mesh direct-dispatch assignment on the target
                    // instance BEFORE sending the prompt so the completion
                    // event has a routing marker by the time it fires.
                    // mesh_send_task --direct ships meshContext for plain CLI
                    // sessions that were never launched as mesh delegates.
                    const meshContext = (args as any)?.meshContext;
                    if (meshContext && typeof meshContext === 'object' && typeof meshContext.meshId === 'string' && meshContext.meshId) {
                        const targetInstanceId = key;
                        let stampResult: { stamped: boolean; reason?: string } | undefined;
                        try {
                            stampResult = this.deps.getInstanceManager()?.attachMeshAssignmentToInstance(targetInstanceId, {
                                meshId: meshContext.meshId,
                                ...(typeof meshContext.nodeId === 'string' && meshContext.nodeId ? { nodeId: meshContext.nodeId } : {}),
                                ...(typeof meshContext.taskId === 'string' && meshContext.taskId ? { taskId: meshContext.taskId } : {}),
                                // REDRIVE-DUP: carry the dispatch nonce onto the worker session so
                                // its generating_started event echoes it back for the coordinator's
                                // stale-nonce guard.
                                ...(typeof meshContext.dispatchNonce === 'number' ? { dispatchNonce: meshContext.dispatchNonce } : {}),
                                ...(typeof meshContext.coordinatorDaemonId === 'string' && meshContext.coordinatorDaemonId ? { coordinatorDaemonId: meshContext.coordinatorDaemonId } : {}),
                            });
                        } catch { /* best-effort — stamping is a routing aid, not a hard requirement */ }
                        // DOUBLE-DISPATCH stamp guard: the instance manager refused this stamp because
                        // the SAME task is already running on another live session on this daemon.
                        // Sending the prompt anyway would double-execute the task — fail closed so the
                        // coordinator does not duplicate the work onto a second session.
                        if (stampResult && stampResult.stamped === false && stampResult.reason === 'task_already_stamped_on_live_instance') {
                            throw new Error(`Refusing duplicate mesh dispatch: task ${meshContext.taskId} is already being worked by a live session on this daemon`);
                        }
                    }
                    const input = normalizeInputEnvelope(args?.input ? { input: args.input } : args);
                    const provider = this.providerLoader.resolve(agentType) || this.providerLoader.getMeta(agentType);
                    if (provider?.category === 'acp') {
                        assertProviderSupportsDeclaredInput(provider, input);
                    } else {
                        assertTextOnlyInput(provider, input);
                    }
                    const message = input.textFallback;
                    if (!message) throw new Error('message required for send_chat');
                    // ARCH-REFACTOR R1: thread the dispatched task's id into the turn so the
                    // worker's completion event is bound to THIS task (per-turn identity),
                    // not the last-write-wins session scalar. Carried for both local and
                    // remote (P2P-echoed meshContext) dispatch; absent for plain ad-hoc chat.
                    const meshTaskId = (meshContext && typeof meshContext === 'object'
                        && typeof (meshContext as any).taskId === 'string' && (meshContext as any).taskId.trim())
                        ? (meshContext as any).taskId as string
                        : undefined;
                    const forceSend = args?.force === true || args?.forceSend === true;
                    // Preserve the exact prior call shape when there is no taskId (plain
                    // ad-hoc chat / non-mesh dispatch); only thread the per-turn taskId when
                    // present, so existing non-mesh callers and their contracts are unchanged.
                    if (forceSend && typeof (adapter as any).forceSendMessage === 'function') {
                        if (meshTaskId) await (adapter as any).forceSendMessage(message, meshTaskId);
                        else await (adapter as any).forceSendMessage(message);
                    } else if (forceSend) {
                        await adapter.sendMessage(message, meshTaskId ? { force: true, meshTaskId } : { force: true });
                    } else if (meshTaskId) {
                        await adapter.sendMessage(message, { meshTaskId });
                    } else {
                        await adapter.sendMessage(message);
                    }
                    const targetInstance = this.deps.getInstanceManager()?.getInstance(key) as
                        | { recordAcknowledgedUserInput?: (input: unknown) => void }
                        | undefined;
                    targetInstance?.recordAcknowledgedUserInput?.(input);
                    return {
                        success: true,
                        status: BUSY_AGENT_STATUSES.has(currentStatus) ? currentStatus : 'generating',
                        ...(BUSY_AGENT_STATUSES.has(currentStatus) ? { queued: true, queuedReason: 'agent_runtime_busy' } : {}),
                        ...(forceSend ? { forceSent: true, queued: false } : {}),
                    };
                } else if (action === 'clear_history') {
                    if (typeof adapter.clearHistory === 'function') adapter.clearHistory();
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
