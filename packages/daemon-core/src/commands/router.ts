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
import { supportsExplicitSessionResume } from './cli-manager.js';
import type { HostedCliRuntimeDescriptor } from './cli-manager.js';
import type { ProviderLoader } from '../providers/provider-loader.js';
import type { ProviderInstanceManager } from '../providers/provider-instance-manager.js';
import { launchWithCdp, killIdeProcess, isIdeRunning } from '../launch.js';
import { loadConfig, saveConfig, updateConfig } from '../config/config.js';
import { loadState, saveState } from '../config/state-store.js';
import { resolveIdeLaunchWorkspace } from '../config/workspaces.js';
import { appendRecentActivity, getRecentActivity, markSessionSeen, dismissSessionNotification, markSessionNotificationUnread } from '../config/recent-activity.js';
import { getSavedProviderSessions } from '../config/saved-sessions.js';
import { listProviderHistorySessions } from '../config/chat-history.js';
import { detectIDEs } from '../detection/ide-detector.js';
import { detectCLI } from '../detection/cli-detector.js';
import { getGitRepoStatus } from '../git/git-status.js';
import type { GitSubmoduleStatus } from '../git/git-types.js';
import { SessionRegistry } from '../sessions/registry.js';
import { LOG } from '../logging/logger.js';
import { logCommand } from '../logging/command-log.js';
import type { CommandLogEntry } from '../logging/command-log.js';
import * as yaml from 'js-yaml';
import { getRecentLogs, LOG_PATH } from '../logging/logger.js';
import { createInteractionId, getRecentDebugTrace, recordDebugTrace } from '../logging/debug-trace.js';
import { getSessionHostSurfaceKind, partitionSessionHostRecords } from '../session-host/runtime-surface.js';
import { createHermesManualMeshCoordinatorSetup, resolveMeshCoordinatorSetup } from './mesh-coordinator.js';
import { buildSessionEntries } from '../status/builders.js';
import { handleMeshForwardEvent, drainPendingMeshCoordinatorEvents } from '../mesh/mesh-events.js';
import { buildMachineInfo, buildStatusSnapshot } from '../status/snapshot.js';
import { getSessionCompletionMarker } from '../status/snapshot.js';
import { execNpmCommandSync, resolveCurrentGlobalInstallSurface, spawnDetachedDaemonUpgradeHelper } from './upgrade-helper.js';
import type { RepoMeshSessionCleanupMode } from '../repo-mesh-types.js';
import { homedir } from 'os';
import { join as pathJoin, resolve as pathResolve } from 'path';
import * as fs from 'fs';

type ReleaseChannel = 'stable' | 'preview';
const CHANNEL_NPM_TAG: Record<ReleaseChannel, 'latest' | 'next'> = { stable: 'latest', preview: 'next' };
const CHANNEL_SERVER_URL: Record<ReleaseChannel, string> = {
    stable: 'https://api.adhf.dev',
    preview: 'https://api-preview.adhf.dev',
};

function normalizeReleaseChannel(value: unknown): ReleaseChannel | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    if (normalized === 'stable' || normalized === 'latest') return 'stable';
    if (normalized === 'preview' || normalized === 'next') return 'preview';
    return null;
}

function resolveUpgradeChannel(args: any): ReleaseChannel {
    return normalizeReleaseChannel(args?.channel)
        || normalizeReleaseChannel(args?.updatePolicy?.channel)
        || normalizeReleaseChannel(args?.npmTag)
        || normalizeReleaseChannel(loadConfig().updateChannel)
        || 'stable';
}

function readProviderPriorityFromPolicy(policy: unknown): string[] {
    const record = policy && typeof policy === 'object' && !Array.isArray(policy)
        ? policy as Record<string, unknown>
        : {};
    const raw = record.providerPriority;
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    return raw
        .map(type => typeof type === 'string' ? type.trim() : '')
        .filter(Boolean)
        .filter(type => {
            if (seen.has(type)) return false;
            seen.add(type);
            return true;
        });
}

function readObjectRecord(value: unknown): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, any>
        : {};
}

function readStringValue(...values: unknown[]): string | undefined {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return undefined;
}

function readNumberValue(...values: unknown[]): number | undefined {
    for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return undefined;
}

function readBooleanValue(...values: unknown[]): boolean | undefined {
    for (const value of values) {
        if (typeof value === 'boolean') return value;
    }
    return undefined;
}

function readGitSubmodules(value: unknown): GitSubmoduleStatus[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const submodules = value
        .map(entry => {
            const submodule = readObjectRecord(entry);
            const path = readStringValue(submodule.path);
            const commit = readStringValue(submodule.commit);
            const repoPath = readStringValue(submodule.repoPath, submodule.repo_root);
            if (!path || !commit || !repoPath) return null;
            return {
                path,
                commit,
                repoPath,
                dirty: readBooleanValue(submodule.dirty) ?? false,
                outOfSync: readBooleanValue(submodule.outOfSync, submodule.out_of_sync) ?? false,
                lastCheckedAt: readNumberValue(submodule.lastCheckedAt, submodule.last_checked_at) ?? Date.now(),
                ...(readStringValue(submodule.error) ? { error: readStringValue(submodule.error) } : {}),
            };
        })
        .filter((entry): entry is GitSubmoduleStatus => entry !== null);
    return submodules.length > 0 ? submodules : undefined;
}

function buildCachedInlineMeshGitStatus(node: any): Record<string, unknown> | undefined {
    const cachedStatus = readObjectRecord(node?.cachedStatus);
    const cachedGit = readObjectRecord(cachedStatus.git);
    if (Object.keys(cachedGit).length) {
        const conflictFiles = Array.isArray(cachedGit.conflictFiles)
            ? cachedGit.conflictFiles.filter((value: unknown): value is string => typeof value === 'string')
            : [];
        const conflictCount = readNumberValue(cachedGit.conflicts) ?? conflictFiles.length;
        const hasConflicts = readBooleanValue(cachedGit.hasConflicts) ?? conflictCount > 0;
        const isGitRepo = readBooleanValue(cachedGit.isGitRepo);
        if (isGitRepo !== undefined) {
            const submodules = readGitSubmodules(cachedGit.submodules);
            return {
                workspace: readStringValue(cachedGit.workspace, node?.workspace) || '',
                repoRoot: readStringValue(cachedGit.repoRoot, node?.repoRoot, node?.workspace) || null,
                isGitRepo,
                branch: readStringValue(cachedGit.branch) ?? null,
                headCommit: readStringValue(cachedGit.headCommit) ?? null,
                headMessage: readStringValue(cachedGit.headMessage) ?? null,
                upstream: readStringValue(cachedGit.upstream) ?? null,
                ahead: readNumberValue(cachedGit.ahead) ?? 0,
                behind: readNumberValue(cachedGit.behind) ?? 0,
                staged: readNumberValue(cachedGit.staged) ?? 0,
                modified: readNumberValue(cachedGit.modified) ?? 0,
                untracked: readNumberValue(cachedGit.untracked) ?? 0,
                deleted: readNumberValue(cachedGit.deleted) ?? 0,
                renamed: readNumberValue(cachedGit.renamed) ?? 0,
                hasConflicts,
                conflictFiles,
                stashCount: readNumberValue(cachedGit.stashCount) ?? 0,
                lastCheckedAt: readNumberValue(cachedGit.lastCheckedAt) ?? Date.now(),
                ...(submodules ? { submodules } : {}),
            };
        }
    }

    const rawGit = readObjectRecord(node?.lastGit ?? node?.last_git);
    const gitResult = readObjectRecord(rawGit.result);
    const directStatus = readObjectRecord(rawGit.status);
    const nestedStatus = readObjectRecord(gitResult.status);
    const rawProbe = readObjectRecord(node?.lastProbe ?? node?.last_probe);
    const probeGit = readObjectRecord(rawProbe.git);
    const probeGitResult = readObjectRecord(probeGit.result);
    const probeDirectStatus = readObjectRecord(probeGit.status);
    const probeNestedStatus = readObjectRecord(probeGitResult.status);
    const status = Object.keys(directStatus).length
        ? directStatus
        : Object.keys(nestedStatus).length
            ? nestedStatus
            : Object.keys(probeDirectStatus).length
                ? probeDirectStatus
                : Object.keys(probeNestedStatus).length
                    ? probeNestedStatus
                    : {};
    const isGitRepo = readBooleanValue(status.isGitRepo);
    if (!Object.keys(status).length || isGitRepo === undefined) return undefined;
    const conflictFiles = Array.isArray(status.conflictFiles)
        ? status.conflictFiles.filter((value: unknown): value is string => typeof value === 'string')
        : [];
    const conflictCount = readNumberValue(status.conflicts) ?? conflictFiles.length;
    const hasConflicts = readBooleanValue(status.hasConflicts) ?? conflictCount > 0;
    const submodules = readGitSubmodules(status.submodules);
    return {
        workspace: readStringValue(status.workspace, node?.workspace) || '',
        repoRoot: readStringValue(status.repoRoot, node?.repoRoot, node?.workspace) || null,
        isGitRepo,
        branch: readStringValue(status.branch) ?? null,
        headCommit: readStringValue(status.headCommit) ?? null,
        headMessage: readStringValue(status.headMessage) ?? null,
        upstream: readStringValue(status.upstream) ?? null,
        ahead: readNumberValue(status.ahead) ?? 0,
        behind: readNumberValue(status.behind) ?? 0,
        staged: readNumberValue(status.staged) ?? 0,
        modified: readNumberValue(status.modified) ?? 0,
        untracked: readNumberValue(status.untracked) ?? 0,
        deleted: readNumberValue(status.deleted) ?? 0,
        renamed: readNumberValue(status.renamed) ?? 0,
        hasConflicts,
        conflictFiles,
        stashCount: readNumberValue(status.stashCount) ?? 0,
        lastCheckedAt: Date.now(),
        ...(submodules ? { submodules } : {}),
    };
}

function hasGitWorktreeChanges(git: Record<string, unknown> | null | undefined): boolean {
    if (!git) return false;
    return Number(git.staged || 0) + Number(git.modified || 0) + Number(git.untracked || 0) + Number(git.deleted || 0) + Number(git.renamed || 0) > 0;
}

function getGitSubmoduleDriftState(git: Record<string, unknown> | null | undefined): { dirty: boolean; outOfSync: boolean } {
    const submodules = Array.isArray(git?.submodules) ? git.submodules : [];
    let dirty = false;
    let outOfSync = false;
    for (const entry of submodules) {
        const submodule = readObjectRecord(entry);
        if (readBooleanValue(submodule.dirty) === true) dirty = true;
        if (readBooleanValue(submodule.outOfSync) === true || !!readStringValue(submodule.error)) outOfSync = true;
    }
    return { dirty, outOfSync };
}

function deriveMeshNodeHealthFromGit(git: Record<string, unknown> | null | undefined): 'online' | 'dirty' | 'degraded' {
    if (!git || readBooleanValue(git.isGitRepo) === false) return 'degraded';
    const branch = readStringValue(git.branch);
    if (!branch) return 'degraded';
    const submoduleDrift = getGitSubmoduleDriftState(git);
    if (submoduleDrift.outOfSync) return 'degraded';
    if (submoduleDrift.dirty || hasGitWorktreeChanges(git)) return 'dirty';
    return 'online';
}

function readCachedInlineMeshActiveSessions(node: any): string[] {
    const cachedStatus = readObjectRecord(node?.cachedStatus);
    const activeSession = readObjectRecord(cachedStatus.activeSession);
    const fallbackSession = Object.keys(activeSession).length
        ? activeSession
        : readObjectRecord(node?.activeSession ?? node?.active_session);
    const sessionId = readStringValue(fallbackSession.id, fallbackSession.sessionId, fallbackSession.session_id, node?.activeSessionId, node?.active_session_id, node?.sessionId, node?.session_id);
    return sessionId ? [sessionId] : [];
}

function readCachedInlineMeshActiveSessionDetails(node: any): Array<Record<string, unknown>> {
    const cachedStatus = readObjectRecord(node?.cachedStatus);
    const activeSession = readObjectRecord(cachedStatus.activeSession);
    const fallbackSession = Object.keys(activeSession).length
        ? activeSession
        : readObjectRecord(node?.activeSession ?? node?.active_session);
    const sessionId = readStringValue(
        fallbackSession.id,
        fallbackSession.sessionId,
        fallbackSession.session_id,
        node?.activeSessionId,
        node?.active_session_id,
        node?.sessionId,
        node?.session_id,
    );
    if (!sessionId) return [];
    return [{
        sessionId,
        providerType: readStringValue(
            fallbackSession.providerType,
            fallbackSession.provider_type,
            fallbackSession.cliType,
            fallbackSession.cli_type,
            fallbackSession.provider,
            node?.providerType,
            node?.provider_type,
        ),
        state: readStringValue(fallbackSession.status, fallbackSession.state, fallbackSession.lifecycle),
        lifecycle: readStringValue(fallbackSession.lifecycle),
        title: readStringValue(fallbackSession.title, fallbackSession.displayName, fallbackSession.display_name) ?? null,
        workspace: readStringValue(fallbackSession.workspace, node?.workspace) ?? null,
        lastActivityAt: readStringValue(fallbackSession.lastActivityAt, fallbackSession.last_activity_at) ?? null,
        recoveryState: readStringValue(fallbackSession.recoveryState, fallbackSession.recovery_state) ?? null,
        isCached: true,
    }];
}

function readLiveMeshSessionState(record: any): string | undefined {
    return readStringValue(
        record?.meta?.sessionStatus,
        record?.meta?.status,
        record?.meta?.providerStatus,
        record?.status,
        record?.state,
        record?.lifecycle,
    );
}

function toIsoTimestamp(value: unknown): string | null {
    if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
    const stringValue = readStringValue(value);
    return stringValue || null;
}

function summarizeMeshSessionRecord(record: any): Record<string, unknown> {
    return {
        sessionId: readStringValue(record?.sessionId) || 'unknown',
        providerType: readStringValue(record?.providerType),
        state: readLiveMeshSessionState(record),
        lifecycle: readStringValue(record?.lifecycle),
        surfaceKind: getSessionHostSurfaceKind(record as any),
        recoveryState: readStringValue(record?.meta?.runtimeRecoveryState) ?? null,
        workspace: readStringValue(record?.workspace) ?? null,
        title: readStringValue(record?.displayName, record?.workspaceLabel) ?? null,
        lastActivityAt: toIsoTimestamp(record?.updatedAt ?? record?.lastActivityAt ?? record?.last_activity_at),
        isCached: false,
    };
}

function applyCachedInlineMeshNodeStatus(status: Record<string, unknown>, node: any): boolean {
    const cachedStatus = readObjectRecord(node?.cachedStatus);
    const git = buildCachedInlineMeshGitStatus(node);
    const error = readStringValue(cachedStatus.error, node?.error);
    const health = readStringValue(cachedStatus.health, node?.health);
    const machineStatus = readStringValue(cachedStatus.machineStatus, node?.machineStatus);
    const lastSeenAt = toIsoTimestamp(cachedStatus.lastSeenAt ?? cachedStatus.last_seen_at ?? node?.lastSeenAt ?? node?.last_seen_at);
    const updatedAt = toIsoTimestamp(cachedStatus.updatedAt ?? cachedStatus.updated_at ?? node?.updatedAt ?? node?.updated_at);
    const activeSessions = readCachedInlineMeshActiveSessions(node);
    const activeSessionDetails = readCachedInlineMeshActiveSessionDetails(node);
    if (!git && !error && !health && !machineStatus && !lastSeenAt && !updatedAt && activeSessions.length === 0) return false;
    if (git) status.git = git;
    if (error) status.error = error;
    if (machineStatus) status.machineStatus = machineStatus;
    if (lastSeenAt) status.lastSeenAt = lastSeenAt;
    if (updatedAt) status.updatedAt = updatedAt;
    if (activeSessions.length > 0) status.activeSessions = activeSessions;
    if (activeSessionDetails.length > 0) status.activeSessionDetails = activeSessionDetails;
    if (health) {
        status.health = health;
        return true;
    }
    if (git) {
        status.health = deriveMeshNodeHealthFromGit(git);
        return true;
    }
    return activeSessions.length > 0 || !!machineStatus || !!lastSeenAt || !!updatedAt;
}

async function resolveProviderTypeFromPriority(args: {
    nodeId: string;
    providerPriority: string[];
    providerLoader: ProviderLoader;
    onStatusChange?: () => void;
}): Promise<{ providerType?: string; error?: string }> {
    if (!args.providerPriority.length) {
        return { error: `Node '${args.nodeId}' has no providerPriority policy; pass cliType explicitly or configure node.policy.providerPriority` };
    }

    const failed: string[] = [];
    for (const requestedType of args.providerPriority) {
        const normalizedType = args.providerLoader.resolveAlias(requestedType);
        if (!args.providerLoader.isMachineProviderEnabled(normalizedType)) {
            failed.push(`${requestedType}: disabled`);
            continue;
        }
        const detected = await detectCLI(normalizedType, args.providerLoader, { includeVersion: false });
        args.providerLoader.setCliDetectionResults([{
            id: normalizedType,
            installed: !!detected,
            path: detected?.path,
        }], false);
        args.onStatusChange?.();
        if (detected) return { providerType: normalizedType };
        failed.push(`${requestedType}: not detected`);
    }

    return { error: `No usable provider detected for node '${args.nodeId}' from providerPriority: ${failed.join('; ')}` };
}
type MeshCoordinatorConfigFormat = 'claude_mcp_json' | 'hermes_config_yaml';
type MeshRefineValidationStatus = 'passed' | 'failed' | 'skipped';
type MeshRefineValidationCommand = {
    command: string;
    args: string[];
    displayCommand: string;
    category: string;
    source: string;
};

type MeshRefineValidationSummary = {
    status: MeshRefineValidationStatus;
    required: true;
    commandsRun: Array<Record<string, unknown>>;
    rejectedCommands: Array<Record<string, unknown>>;
    skippedReason?: string;
    timeoutMs: number;
    outputLimitBytes: number;
};

const REFINE_VALIDATION_CATEGORIES = ['typecheck', 'test', 'lint', 'build'] as const;
const REFINE_VALIDATION_TIMEOUT_MS = 120_000;
const REFINE_VALIDATION_OUTPUT_LIMIT_BYTES = 128 * 1024;
const REFINE_VALIDATION_SUMMARY_CHARS = 2_000;
const REFINE_VALIDATION_MAX_COMMANDS = 4;

function truncateValidationOutput(value: unknown): string {
    const text = typeof value === 'string' ? value : value == null ? '' : String(value);
    if (text.length <= REFINE_VALIDATION_SUMMARY_CHARS) return text;
    return `${text.slice(0, REFINE_VALIDATION_SUMMARY_CHARS)}\n[truncated ${text.length - REFINE_VALIDATION_SUMMARY_CHARS} chars]`;
}

function readPackageScripts(workspace: string): Record<string, string> {
    try {
        const packageJsonPath = pathJoin(workspace, 'package.json');
        const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        return parsed?.scripts && typeof parsed.scripts === 'object' && !Array.isArray(parsed.scripts)
            ? parsed.scripts as Record<string, string>
            : {};
    } catch {
        return {};
    }
}

function tokenizeValidationCommand(command: string): string[] | null {
    const trimmed = command.trim();
    if (!trimmed) return null;
    // Fail closed: the gate never hands shell syntax to a shell. Package-manager
    // scripts are invoked via execFile(binary, args), and metacharacters/quotes are
    // rejected before tokenization so `npm run test && rm -rf` cannot be smuggled in.
    if (/[;&|<>`$\\\n\r'\"]/.test(trimmed)) return null;
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    if (!tokens.length) return null;
    if (tokens.some(token => !/^[A-Za-z0-9_@./:=+-]+$/.test(token))) return null;
    return tokens;
}

function scriptMatchesValidationCategory(scriptName: string, category: string): boolean {
    return scriptName === category || scriptName.startsWith(`${category}:`);
}

function parsePackageManagerValidationCommand(
    rawCommand: string,
    category: string,
    scripts: Record<string, string>,
    source: string,
): { command?: MeshRefineValidationCommand; rejected?: Record<string, unknown> } {
    const tokens = tokenizeValidationCommand(rawCommand);
    if (!tokens) {
        return { rejected: { command: rawCommand, category, source, reason: 'unsafe command string is not allowlisted' } };
    }

    const [binary, second, third, ...rest] = tokens;
    let scriptName = '';
    let command = binary;
    let args: string[] = [];

    if ((binary === 'npm' || binary === 'pnpm' || binary === 'bun') && second === 'run' && third) {
        scriptName = third;
        args = ['run', scriptName, ...rest];
    } else if (binary === 'npm' && second === 'test' && !third) {
        scriptName = 'test';
        args = ['test'];
    } else if (binary === 'yarn' && second === 'run' && third) {
        scriptName = third;
        args = ['run', scriptName, ...rest];
    } else if (binary === 'yarn' && second && !third) {
        scriptName = second;
        args = [scriptName];
    } else {
        return { rejected: { command: rawCommand, category, source, reason: 'command is not a supported package-manager script invocation' } };
    }

    if (!scriptName || !Object.prototype.hasOwnProperty.call(scripts, scriptName)) {
        return { rejected: { command: rawCommand, category, source, script: scriptName, reason: 'script is not declared in package.json' } };
    }
    if (!scriptMatchesValidationCategory(scriptName, category)) {
        return { rejected: { command: rawCommand, category, source, script: scriptName, reason: 'script name is outside the validation category allowlist' } };
    }

    return {
        command: {
            command,
            args,
            displayCommand: [command, ...args].join(' '),
            category,
            source,
        },
    };
}

function collectProjectContextValidationCandidates(mesh: any): Array<{ command: string; category: string; source: string; confidence?: string }> {
    const commands = mesh?.projectContext?.commands;
    if (!commands || typeof commands !== 'object' || Array.isArray(commands)) return [];
    const candidates: Array<{ command: string; category: string; source: string; confidence?: string }> = [];
    for (const category of REFINE_VALIDATION_CATEGORIES) {
        const entries = Array.isArray(commands[category]) ? commands[category] : [];
        for (const entry of entries) {
            if (typeof entry?.command !== 'string') continue;
            candidates.push({
                command: entry.command,
                category,
                source: typeof entry.sourcePath === 'string' ? entry.sourcePath : 'projectContext.commands',
                confidence: typeof entry.confidence === 'string' ? entry.confidence : undefined,
            });
        }
    }
    return candidates.sort((a, b) => {
        const rank = (value?: string) => value === 'high' ? 0 : value === 'medium' ? 1 : 2;
        return rank(a.confidence) - rank(b.confidence);
    });
}

function collectPolicyValidationCandidates(mesh: any): Array<{ command: string; category: string; source: string }> {
    const policy = mesh?.policy && typeof mesh.policy === 'object' && !Array.isArray(mesh.policy) ? mesh.policy : {};
    const configured = Array.isArray(policy.validationCommands)
        ? policy.validationCommands
        : Array.isArray(policy.validationGate?.commands)
            ? policy.validationGate.commands
            : [];
    return configured
        .map((entry: any) => typeof entry === 'string' ? { command: entry, category: '', source: 'mesh.policy.validationCommands' } : entry)
        .filter((entry: any) => entry && typeof entry.command === 'string')
        .map((entry: any) => {
            const commandText = entry.command.trim();
            const category = REFINE_VALIDATION_CATEGORIES.find(cat => commandText.includes(` ${cat}`)) ?? '';
            return { command: commandText, category, source: 'mesh.policy.validationCommands' };
        })
        .filter((entry: any) => !!entry.category);
}

function selectMeshRefineValidationCommands(mesh: any, workspace: string): { commands: MeshRefineValidationCommand[]; rejectedCommands: Array<Record<string, unknown>>; source: string } {
    const scripts = readPackageScripts(workspace);
    const rejectedCommands: Array<Record<string, unknown>> = [];
    const selected: MeshRefineValidationCommand[] = [];
    const seen = new Set<string>();
    const candidates = [
        ...collectPolicyValidationCandidates(mesh),
        ...collectProjectContextValidationCandidates(mesh),
    ];

    for (const candidate of candidates) {
        const parsed = parsePackageManagerValidationCommand(candidate.command, candidate.category, scripts, candidate.source);
        if (parsed.rejected) {
            rejectedCommands.push(parsed.rejected);
            continue;
        }
        if (!parsed.command || seen.has(parsed.command.displayCommand)) continue;
        selected.push(parsed.command);
        seen.add(parsed.command.displayCommand);
        if (selected.length >= REFINE_VALIDATION_MAX_COMMANDS) break;
    }

    if (!selected.length && candidates.length === 0) {
        for (const category of REFINE_VALIDATION_CATEGORIES) {
            if (!Object.prototype.hasOwnProperty.call(scripts, category)) continue;
            const fallback = parsePackageManagerValidationCommand(`npm run ${category}`, category, scripts, 'package.json:scripts');
            if (fallback.command && !seen.has(fallback.command.displayCommand)) {
                selected.push(fallback.command);
                seen.add(fallback.command.displayCommand);
            } else if (fallback.rejected) {
                rejectedCommands.push(fallback.rejected);
            }
            if (selected.length >= 2) break;
        }
    }

    return {
        commands: selected,
        rejectedCommands,
        source: selected.some(command => command.source === 'mesh.policy.validationCommands')
            ? 'mesh_policy'
            : selected.some(command => command.source !== 'package.json:scripts')
                ? 'project_context'
                : selected.length
                    ? 'package_json_scripts'
                    : 'unavailable',
    };
}

async function runMeshRefineValidationGate(mesh: any, workspace: string): Promise<MeshRefineValidationSummary> {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const selection = selectMeshRefineValidationCommands(mesh, workspace);
    const summary: MeshRefineValidationSummary = {
        status: 'skipped',
        required: true,
        commandsRun: [],
        rejectedCommands: selection.rejectedCommands,
        skippedReason: undefined,
        timeoutMs: REFINE_VALIDATION_TIMEOUT_MS,
        outputLimitBytes: REFINE_VALIDATION_OUTPUT_LIMIT_BYTES,
    };

    if (!selection.commands.length) {
        summary.skippedReason = 'validation_unavailable: no allowlisted projectContext, mesh policy, or package.json build/test/typecheck/lint command was available';
        return summary;
    }

    for (const candidate of selection.commands) {
        const startedAt = Date.now();
        try {
            const result = await execFileAsync(candidate.command, candidate.args, {
                cwd: workspace,
                encoding: 'utf8',
                timeout: REFINE_VALIDATION_TIMEOUT_MS,
                maxBuffer: REFINE_VALIDATION_OUTPUT_LIMIT_BYTES,
                env: { ...process.env, CI: process.env.CI || '1' },
            });
            summary.commandsRun.push({
                command: candidate.command,
                args: candidate.args,
                displayCommand: candidate.displayCommand,
                category: candidate.category,
                source: candidate.source,
                passed: true,
                exitCode: 0,
                durationMs: Date.now() - startedAt,
                stdout: truncateValidationOutput(result.stdout),
                stderr: truncateValidationOutput(result.stderr),
            });
        } catch (error: any) {
            summary.commandsRun.push({
                command: candidate.command,
                args: candidate.args,
                displayCommand: candidate.displayCommand,
                category: candidate.category,
                source: candidate.source,
                passed: false,
                exitCode: typeof error?.code === 'number' ? error.code : null,
                signal: typeof error?.signal === 'string' ? error.signal : null,
                timedOut: error?.killed === true || /timed out/i.test(String(error?.message || '')),
                durationMs: Date.now() - startedAt,
                stdout: truncateValidationOutput(error?.stdout),
                stderr: truncateValidationOutput(error?.stderr || error?.message),
            });
            summary.status = 'failed';
            return summary;
        }
    }

    summary.status = 'passed';
    return summary;
}

function loadYamlModule(): { load: (input: string) => any; dump: (input: any, options?: Record<string, any>) => string } {
    return yaml as { load: (input: string) => any; dump: (input: any, options?: Record<string, any>) => string };
}

function getMcpServersKey(format: MeshCoordinatorConfigFormat): 'mcpServers' | 'mcp_servers' {
    return format === 'hermes_config_yaml' ? 'mcp_servers' : 'mcpServers';
}

function parseMeshCoordinatorMcpConfig(text: string, format: MeshCoordinatorConfigFormat): Record<string, any> {
    if (!text.trim()) return {};
    if (format === 'claude_mcp_json') return JSON.parse(text);
    const parsed = loadYamlModule().load(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function serializeMeshCoordinatorMcpConfig(config: Record<string, any>, format: MeshCoordinatorConfigFormat): string {
    if (format === 'claude_mcp_json') return JSON.stringify(config, null, 2);
    return loadYamlModule().dump(config, { noRefs: true, lineWidth: 120 });
}

function resolveHermesUserHome(): string {
    const explicitHome = process.env.HERMES_HOME?.trim();
    return explicitHome || pathJoin(homedir(), '.hermes');
}

function loadHermesCoordinatorBaseConfig(targetConfigPath: string): { config: Record<string, any>; sourceHome: string; sourceConfigPath: string } {
    const sourceHome = resolveHermesUserHome();
    const sourceConfigPath = pathJoin(sourceHome, 'config.yaml');
    if (!fs.existsSync(sourceConfigPath)) return { config: {}, sourceHome, sourceConfigPath };
    if (pathResolve(sourceConfigPath) === pathResolve(targetConfigPath)) return { config: {}, sourceHome, sourceConfigPath };

    const parsed = parseMeshCoordinatorMcpConfig(fs.readFileSync(sourceConfigPath, 'utf-8'), 'hermes_config_yaml');
    const { mcp_servers: _mcpServers, ...baseConfig } = parsed;
    return { config: baseConfig, sourceHome, sourceConfigPath };
}

function stripHermesCoordinatorTempModelProviderOverrides(config: Record<string, any>): Record<string, any> {
    const {
        model: _model,
        provider: _provider,
        default_model: _defaultModel,
        defaultProvider: _defaultProvider,
        default_provider: _defaultProviderSnake,
        modelProvider: _modelProvider,
        model_provider: _modelProviderSnake,
        ...sanitized
    } = config;
    const delegation = sanitized.delegation;
    if (delegation && typeof delegation === 'object' && !Array.isArray(delegation)) {
        const {
            model: _delegationModel,
            provider: _delegationProvider,
            modelProvider: _delegationModelProvider,
            model_provider: _delegationModelProviderSnake,
            ...delegationRest
        } = delegation;
        if (Object.keys(delegationRest).length > 0) {
            sanitized.delegation = delegationRest;
        } else {
            delete sanitized.delegation;
        }
    }
    return sanitized;
}

function copyHermesCoordinatorCredentialFiles(sourceHome: string, targetHome: string) {
    if (pathResolve(sourceHome) === pathResolve(targetHome)) return;
    for (const fileName of ['.env', 'auth.json']) {
        const sourcePath = pathJoin(sourceHome, fileName);
        const targetPath = pathJoin(targetHome, fileName);
        if (!fs.existsSync(sourcePath)) continue;
        try {
            fs.copyFileSync(sourcePath, targetPath);
        } catch (error: any) {
            LOG.warn('MeshCoordinator', `Could not copy Hermes ${fileName} into isolated coordinator home: ${error?.message || error}`);
        }
    }
}

// ─── Types ───

export interface SessionHostControlPlane {
    getDiagnostics(payload?: { includeSessions?: boolean; limit?: number }): Promise<any>;
    listSessions(): Promise<any[]>;
    stopSession(sessionId: string): Promise<any>;
    deleteSession(sessionId: string, opts?: { force?: boolean }): Promise<any>;
    resumeSession(sessionId: string): Promise<any>;
    restartSession(sessionId: string): Promise<any>;
    sendSignal(sessionId: string, signal: string): Promise<any>;
    forceDetachClient(sessionId: string, clientId: string): Promise<any>;
    pruneDuplicateSessions(payload?: { providerType?: string; workspace?: string; dryRun?: boolean }): Promise<any>;
    acquireWrite(payload: { sessionId: string; clientId: string; ownerType: 'agent' | 'user'; force?: boolean }): Promise<any>;
    releaseWrite(payload: { sessionId: string; clientId: string }): Promise<any>;
}

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
    /** Canonical daemon status identity used by snapshot commands */
    statusInstanceId?: string;
    statusVersion?: string;
    /** Session host control plane */
    sessionHostControl?: SessionHostControlPlane | null;
    /** Selected-coordinator mesh peer telemetry surface for target daemons, when supported by the runtime. */
    getMeshPeerConnectionStatus?: (daemonId: string) => Record<string, unknown> | null;
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

function normalizeCommandSource(source: string): CommandLogEntry['source'] {
    switch (source) {
        case 'ws':
        case 'p2p':
        case 'ext':
        case 'api':
        case 'standalone':
            return source;
        default:
            return 'unknown';
    }
}

function normalizeCommandArgsWithInteractionId(args: any): Record<string, unknown> {
    const base = args && typeof args === 'object' ? { ...args } : {};
    if (typeof base._interactionId !== 'string' || !String(base._interactionId).trim()) {
        base._interactionId = createInteractionId();
    }
    return base;
}

function toHostedCliRuntimeDescriptor(record: any): HostedCliRuntimeDescriptor | null {
    if (!record || typeof record !== 'object') return null;
    const runtimeId = typeof record.sessionId === 'string' ? record.sessionId : '';
    const cliType = typeof record.providerType === 'string' ? record.providerType : '';
    const workspace = typeof record.workspace === 'string' ? record.workspace : '';
    if (!runtimeId || !cliType || !workspace) return null;
    return {
        runtimeId,
        runtimeKey: typeof record.runtimeKey === 'string' ? record.runtimeKey : undefined,
        displayName: typeof record.displayName === 'string' ? record.displayName : undefined,
        workspaceLabel: typeof record.workspaceLabel === 'string' ? record.workspaceLabel : undefined,
        lifecycle: typeof record.lifecycle === 'string' ? record.lifecycle as HostedCliRuntimeDescriptor['lifecycle'] : undefined,
        recoveryState: typeof record.meta?.runtimeRecoveryState === 'string'
            ? String(record.meta.runtimeRecoveryState)
            : null,
        cliType,
        workspace,
        cliArgs: Array.isArray(record.meta?.cliArgs) ? record.meta.cliArgs as string[] : [],
        providerSessionId: typeof record.meta?.providerSessionId === 'string'
            ? String(record.meta.providerSessionId)
            : undefined,
    };
}

function getWriteConflictOwnerClientId(error: unknown): string | undefined {
    const message = typeof error === 'string'
        ? error
        : error instanceof Error
            ? error.message
            : '';
    const match = /^Write owned by\s+(.+)$/.exec(message.trim());
    return match?.[1]?.trim() || undefined;
}

function summarizeSessionHostRecord(result: unknown): Record<string, unknown> {
    if (!result || typeof result !== 'object') return {};
    const record = result as Record<string, any>;
    return {
        runtimeKey: typeof record.runtimeKey === 'string' ? record.runtimeKey : undefined,
        lifecycle: typeof record.lifecycle === 'string' ? record.lifecycle : undefined,
        surfaceKind: getSessionHostSurfaceKind(record as any),
        attachedClientCount: Array.isArray(record.attachedClients) ? record.attachedClients.length : undefined,
        hasWriteOwner: !!record.writeOwner,
        writeOwnerClientId: typeof record.writeOwner?.clientId === 'string' ? record.writeOwner.clientId : undefined,
    };
}

function summarizeSessionHostRecords(result: unknown): Record<string, unknown> {
    const records = Array.isArray(result) ? result : [];
    const groups = partitionSessionHostRecords(records as any[]);
    return {
        sessionCount: records.length,
        liveRuntimeCount: groups.liveRuntimes.length,
        recoverySnapshotCount: groups.recoverySnapshots.length,
        inactiveRecordCount: groups.inactiveRecords.length,
    };
}

function summarizeSessionHostDiagnostics(result: unknown): Record<string, unknown> {
    const diagnostics = result && typeof result === 'object' ? result as Record<string, any> : {};
    const sessions = Array.isArray(diagnostics.sessions) ? diagnostics.sessions : [];
    return {
        runtimeCount: typeof diagnostics.runtimeCount === 'number' ? diagnostics.runtimeCount : undefined,
        ...summarizeSessionHostRecords(sessions),
    };
}

function summarizeSessionHostPruneResult(result: unknown): Record<string, unknown> {
    const value = result && typeof result === 'object' ? result as Record<string, any> : {};
    return {
        duplicateGroupCount: typeof value.duplicateGroupCount === 'number' ? value.duplicateGroupCount : undefined,
        prunedCount: Array.isArray(value.prunedSessionIds) ? value.prunedSessionIds.length : undefined,
        keptCount: Array.isArray(value.keptSessionIds) ? value.keptSessionIds.length : undefined,
    };
}

export class DaemonCommandRouter {
    private deps: CommandRouterDeps;
    /** In-memory cache for cloud-originating meshes passed via inlineMesh.
     *  Allows the MCP server to query mesh data via get_mesh even when
     *  the mesh doesn't exist in the local meshes.json file. */
    private inlineMeshCache = new Map<string, any>();

    constructor(deps: CommandRouterDeps) {
        this.deps = deps;
    }

    public getCachedInlineMesh(meshId: string, inlineMesh?: unknown): any | undefined {
        if (inlineMesh && typeof inlineMesh === 'object') {
            this.inlineMeshCache.set(meshId, inlineMesh as any);
            return inlineMesh as any;
        }
        return this.inlineMeshCache.get(meshId);
    }

    private async getMeshForCommand(
        meshId: string,
        inlineMesh?: unknown,
        options?: { preferInline?: boolean },
    ): Promise<{ mesh: any; inline: boolean } | null> {
        const preferInline = options?.preferInline === true;
        if (preferInline) {
            const cached = this.getCachedInlineMesh(meshId, inlineMesh);
            if (cached) return { mesh: cached, inline: true };
        }
        try {
            const { getMesh } = await import('../config/mesh-config.js');
            const mesh = getMesh(meshId);
            if (mesh) return { mesh, inline: false };
        } catch { /* fall through to inline cache */ }
        const cached = this.getCachedInlineMesh(meshId, inlineMesh);
        return cached ? { mesh: cached, inline: true } : null;
    }

    private updateInlineMeshNode(meshId: string, mesh: any, node: any): void {
        if (!mesh || !Array.isArray(mesh.nodes) || !node?.id) return;
        const idx = mesh.nodes.findIndex((entry: any) => entry?.id === node.id || entry?.nodeId === node.id);
        if (idx >= 0) mesh.nodes[idx] = node;
        else mesh.nodes.push(node);
        mesh.updatedAt = new Date().toISOString();
        this.inlineMeshCache.set(meshId, mesh);
    }

    private removeInlineMeshNode(meshId: string, mesh: any, nodeId: string): boolean {
        if (!mesh || !Array.isArray(mesh.nodes)) return false;
        const idx = mesh.nodes.findIndex((entry: any) => entry?.id === nodeId || entry?.nodeId === nodeId);
        if (idx === -1) return false;
        mesh.nodes.splice(idx, 1);
        mesh.updatedAt = new Date().toISOString();
        this.inlineMeshCache.set(meshId, mesh);
        return true;
    }

    private normalizeMeshSessionCleanupMode(value: unknown): RepoMeshSessionCleanupMode {
        return value === 'stop'
            || value === 'delete_stopped'
            || value === 'stop_and_delete'
            || value === 'preserve'
            ? value
            : 'preserve';
    }

    private sessionMatchesMeshNode(record: any, node: any, nodeId: string, sessionIds?: Set<string>): boolean {
        const sessionId = typeof record?.sessionId === 'string' ? record.sessionId : '';
        if (!sessionId) return false;
        if (sessionIds?.size) return sessionIds.has(sessionId);
        const workspace = typeof node?.workspace === 'string' ? node.workspace : '';
        if (workspace && record?.workspace === workspace) return true;
        if (record?.meta?.meshNodeId === nodeId) return true;
        return false;
    }

    private async cleanupLocalWorktreeNode(args: {
        mesh: any;
        node: any;
        nodeId: string;
    }): Promise<{ success: true; skipped?: boolean; removedPath?: string; repoRoot?: string; reason?: string; fallback?: string; forced?: boolean; convergence?: Record<string, unknown> } | { success: false; code: string; error: string; recoveryHint: string; convergence?: Record<string, unknown> }> {
        const workspace = typeof args.node?.workspace === 'string' ? args.node.workspace.trim() : '';
        if (!workspace) {
            return {
                success: false,
                code: 'mesh_worktree_cleanup_missing_workspace',
                error: `Worktree node '${args.nodeId}' is missing workspace metadata`,
                recoveryHint: 'Inspect the mesh node record before removing it, or remove stale metadata manually only after confirming no managed worktree remains.',
            };
        }

        const worktreeExists = fs.existsSync(workspace);
        const sourceNode = args.node?.clonedFromNodeId
            ? args.mesh?.nodes?.find((n: any) => n.id === args.node.clonedFromNodeId || n.nodeId === args.node.clonedFromNodeId)
            : args.mesh?.nodes?.find((n: any) => !n.isLocalWorktree);
        const repoRoot = typeof sourceNode?.repoRoot === 'string' && sourceNode.repoRoot.trim()
            ? sourceNode.repoRoot.trim()
            : typeof sourceNode?.workspace === 'string' && sourceNode.workspace.trim()
                ? sourceNode.workspace.trim()
                : '';

        if (!worktreeExists) {
            return { success: true, skipped: true, removedPath: workspace, repoRoot: repoRoot || undefined, reason: 'worktree_path_missing' };
        }
        if (!repoRoot || !fs.existsSync(repoRoot)) {
            return {
                success: false,
                code: 'mesh_worktree_cleanup_missing_source_repo',
                error: `Refusing to remove worktree '${workspace}' because the source repo root is unavailable`,
                recoveryHint: 'Run mesh_remove_node from the machine that owns the source repo, or verify the source node metadata before retrying.',
            };
        }
        if (typeof args.node?.worktreeBranch !== 'string' || !args.node.worktreeBranch.trim()) {
            return {
                success: false,
                code: 'mesh_worktree_cleanup_missing_branch',
                error: `Refusing to remove worktree '${workspace}' because worktreeBranch metadata is missing`,
                recoveryHint: 'Confirm this is an ADHDev-managed worktree before removing it manually; managed worktree nodes include worktreeBranch metadata.',
            };
        }

        const { resolveWorktreePath, listWorktrees, removeWorktree } = await import('../git/git-worktree.js');
        const normalizePath = (value: string) => {
            const resolved = pathResolve(value);
            try { return fs.realpathSync(resolved); } catch { return resolved; }
        };
        const expectedPath = normalizePath(resolveWorktreePath(repoRoot, String(args.mesh?.name || args.mesh?.id || 'mesh'), args.node.worktreeBranch));
        const actualPath = normalizePath(workspace);
        if (actualPath !== expectedPath) {
            return {
                success: false,
                code: 'mesh_worktree_cleanup_unexpected_path',
                error: `Refusing to remove worktree '${workspace}' because it is not at the expected managed path '${expectedPath}'`,
                recoveryHint: 'Use git worktree list/status to inspect the path. Retry only after confirming the mesh node metadata points to an ADHDev-managed worktree.',
            };
        }

        const entries = await listWorktrees(repoRoot);
        const managedEntry = entries.find(entry => normalizePath(entry.path) === actualPath);
        if (!managedEntry) {
            return {
                success: false,
                code: 'mesh_worktree_cleanup_not_registered',
                error: `Refusing to remove '${workspace}' because it is not registered in git worktree list for '${repoRoot}'`,
                recoveryHint: 'Inspect git worktree list --porcelain from the source repo. If the path was already removed, prune git worktrees before retrying.',
            };
        }
        if (managedEntry.branch && managedEntry.branch !== args.node.worktreeBranch) {
            return {
                success: false,
                code: 'mesh_worktree_cleanup_branch_mismatch',
                error: `Refusing to remove '${workspace}' because git reports branch '${managedEntry.branch}', expected '${args.node.worktreeBranch}'`,
                recoveryHint: 'Inspect the worktree branch and mesh metadata before retrying cleanup.',
            };
        }

        const forceFallbackConvergence = await this.getWorktreeForceCleanupConvergence({
            repoRoot,
            workspace,
            node: args.node,
        });

        try {
            const result = await removeWorktree(repoRoot, workspace, {
                requireClean: true,
                allowSubmoduleForceFallback: forceFallbackConvergence.allow,
            });
            return {
                success: true,
                removedPath: result.removedPath,
                repoRoot,
                ...(result.fallback ? {
                    fallback: result.fallback,
                    forced: result.forced,
                    reason: result.reason,
                    convergence: forceFallbackConvergence,
                } : {}),
            };
        } catch (e: any) {
            const message = String(e?.message || e || 'worktree cleanup failed');
            const dirty = message.includes('dirty worktree') || message.includes('local changes');
            const submoduleForceBlocked = /working trees containing submodules cannot be moved or removed/i.test(message) && !forceFallbackConvergence.allow;
            return {
                success: false,
                code: dirty
                    ? 'mesh_worktree_cleanup_dirty'
                    : submoduleForceBlocked
                        ? 'mesh_worktree_cleanup_force_fallback_blocked'
                        : 'mesh_worktree_cleanup_failed',
                error: submoduleForceBlocked
                    ? `${message}; refusing --force fallback because convergence could not be verified: ${forceFallbackConvergence.error || 'unknown convergence state'}`
                    : message,
                recoveryHint: dirty
                    ? 'Commit, stash, or intentionally discard the worktree changes before retrying mesh_remove_node. The mesh registry entry is preserved until cleanup is safe.'
                    : submoduleForceBlocked
                        ? 'Verify the worktree branch is merged/contained in the source default branch (for example origin/main) or mark the node with a safe branchConvergence final state before retrying. The mesh registry entry is preserved.'
                        : 'Inspect git worktree status/list from the source repo and retry after resolving the reported cleanup failure.',
                ...(submoduleForceBlocked ? { convergence: forceFallbackConvergence } : {}),
            };
        }
    }

    private async getWorktreeForceCleanupConvergence(args: {
        repoRoot: string;
        workspace: string;
        node: any;
    }): Promise<{ allow: boolean; status?: string; source?: string; ref?: string; error?: string }> {
        const metadataStatus = typeof args.node?.branchConvergence?.status === 'string'
            ? args.node.branchConvergence.status
            : '';
        if (metadataStatus === 'merged_to_main' || metadataStatus === 'cleanup_candidate') {
            return { allow: true, status: metadataStatus, source: 'node_branch_convergence' };
        }

        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);
        const runGit = async (gitArgs: string[], cwd: string): Promise<string> => {
            const { stdout } = await execFileAsync('git', gitArgs, {
                cwd,
                encoding: 'utf8',
                timeout: 30_000,
                maxBuffer: 4 * 1024 * 1024,
                windowsHide: true,
            });
            return String(stdout || '').trim();
        };

        let head = '';
        try {
            head = await runGit(['rev-parse', 'HEAD'], args.workspace);
        } catch (e: any) {
            return { allow: false, error: `could not resolve worktree HEAD: ${e?.message || e}` };
        }
        if (!head) return { allow: false, error: 'worktree HEAD is empty' };

        const candidateRefs: string[] = [];
        try {
            const defaultBranch = await runGit(['branch', '--show-current'], args.repoRoot);
            if (defaultBranch) {
                candidateRefs.push(defaultBranch, `origin/${defaultBranch}`);
            }
        } catch { /* fall through to common refs */ }
        candidateRefs.push('origin/main', 'origin/master', 'main', 'master');

        const seen = new Set<string>();
        const checkedRefs: string[] = [];
        for (const ref of candidateRefs) {
            if (!ref || seen.has(ref)) continue;
            seen.add(ref);
            let commit = '';
            try {
                commit = await runGit(['rev-parse', '--verify', `${ref}^{commit}`], args.repoRoot);
            } catch {
                continue;
            }
            checkedRefs.push(ref);
            try {
                await runGit(['merge-base', '--is-ancestor', head, commit], args.repoRoot);
                return { allow: true, status: 'merged_to_default_ref', source: 'git_merge_base', ref };
            } catch {
                // Not contained in this candidate ref; keep checking other safe refs.
            }
        }

        return {
            allow: false,
            status: metadataStatus || undefined,
            error: checkedRefs.length
                ? `worktree HEAD is not contained in checked refs: ${checkedRefs.join(', ')}`
                : 'no default/main refs were available for convergence verification',
        };
    }

    private isCompletedHostedSession(record: any): boolean {
        return record?.lifecycle === 'stopped' || record?.lifecycle === 'failed' || record?.lifecycle === 'interrupted';
    }

    private async recordIntentionalMeshSessionStop(args: {
        meshId: string;
        nodeId: string;
        node: any;
        sessionId: string;
        mode: RepoMeshSessionCleanupMode;
        source: 'mesh_cleanup_sessions' | 'mesh_remove_node';
        action: 'stop_session' | 'delete_session_force';
    }): Promise<void> {
        try {
            const { appendLedgerEntry } = await import('../mesh/mesh-ledger.js');
            appendLedgerEntry(args.meshId, {
                kind: 'session_stopped',
                nodeId: args.nodeId,
                sessionId: args.sessionId,
                payload: {
                    intentional: true,
                    reason: 'operator_cleanup',
                    intentionalStopReason: 'operator_cleanup',
                    source: args.source,
                    cleanupMode: args.mode,
                    action: args.action,
                    workspace: typeof args.node?.workspace === 'string' ? args.node.workspace : undefined,
                },
            });
        } catch (e: any) {
            LOG.warn('MeshCleanup', `Failed to record intentional cleanup stop for ${args.sessionId}: ${e?.message || e}`);
        }
    }

    private async cleanupMeshSessions(args: {
        meshId: string;
        nodeId: string;
        node: any;
        mode: RepoMeshSessionCleanupMode;
        sessionIds?: string[];
        dryRun?: boolean;
        source?: 'mesh_cleanup_sessions' | 'mesh_remove_node';
    }): Promise<{ success: boolean; [key: string]: unknown }> {
        if (args.mode === 'preserve') {
            return { success: true, mode: 'preserve', matchedCount: 0, stoppedSessionIds: [], deletedSessionIds: [], skippedSessionIds: [] };
        }
        if (!this.deps.sessionHostControl) return { success: false, error: 'Session host control unavailable' };

        const requestedSessionIds = Array.isArray(args.sessionIds)
            ? new Set(args.sessionIds.map(id => typeof id === 'string' ? id.trim() : '').filter(Boolean))
            : undefined;
        const sessions = await this.deps.sessionHostControl.listSessions();
        const matched = sessions.filter(record => this.sessionMatchesMeshNode(record, args.node, args.nodeId, requestedSessionIds));
        const hasExplicitSessionIds = !!requestedSessionIds?.size;
        const stoppedSessionIds: string[] = [];
        const deletedSessionIds: string[] = [];
        const skippedSessionIds: string[] = [];
        const skippedLiveSessionIds: string[] = [];
        const deleteUnsupportedSessionIds: string[] = [];
        const recordsRemainSessionIds: string[] = [];
        const errors: Array<{ sessionId: string; error: string }> = [];
        const cleanupSource = args.source || 'mesh_cleanup_sessions';
        const markedIntentionalStopSessionIds = new Set<string>();
        const markIntentionalStop = async (sessionId: string, action: 'stop_session' | 'delete_session_force') => {
            if (args.dryRun || markedIntentionalStopSessionIds.has(sessionId)) return;
            markedIntentionalStopSessionIds.add(sessionId);
            await this.recordIntentionalMeshSessionStop({
                meshId: args.meshId,
                nodeId: args.nodeId,
                node: args.node,
                sessionId,
                mode: args.mode,
                source: cleanupSource,
                action,
            });
        };
        const matchedBySurfaceKind = {
            live_runtime: 0,
            recovery_snapshot: 0,
            inactive_record: 0,
        };

        for (const record of matched) {
            const surfaceKind = getSessionHostSurfaceKind(record);
            matchedBySurfaceKind[surfaceKind] += 1;
        }

        for (const record of matched) {
            const sessionId = String(record.sessionId);
            const completed = this.isCompletedHostedSession(record);
            const surfaceKind = getSessionHostSurfaceKind(record);
            const liveRuntime = surfaceKind === 'live_runtime';
            if (!hasExplicitSessionIds && liveRuntime) {
                skippedSessionIds.push(sessionId);
                skippedLiveSessionIds.push(sessionId);
                continue;
            }
            try {
                if (args.mode === 'stop') {
                    if (!completed) {
                        if (!args.dryRun) {
                            await markIntentionalStop(sessionId, 'stop_session');
                            await this.deps.sessionHostControl.stopSession(sessionId);
                        }
                        stoppedSessionIds.push(sessionId);
                    } else {
                        skippedSessionIds.push(sessionId);
                    }
                    continue;
                }

                if (args.mode === 'delete_stopped') {
                    if (completed) {
                        if (!args.dryRun) await this.deps.sessionHostControl.deleteSession(sessionId, { force: false });
                        deletedSessionIds.push(sessionId);
                    } else {
                        skippedSessionIds.push(sessionId);
                    }
                    continue;
                }

                if (args.mode === 'stop_and_delete') {
                    if (!completed) await markIntentionalStop(sessionId, 'delete_session_force');
                    if (!args.dryRun) await this.deps.sessionHostControl.deleteSession(sessionId, { force: true });
                    deletedSessionIds.push(sessionId);
                    continue;
                }
            } catch (e: any) {
                const message = e?.message || String(e);
                if (message.includes('Unsupported session host request: delete_session')
                    && (args.mode === 'delete_stopped' || args.mode === 'stop_and_delete')) {
                    deleteUnsupportedSessionIds.push(sessionId);
                    recordsRemainSessionIds.push(sessionId);
                    if (args.mode === 'stop_and_delete' && !completed) {
                        try {
                            await markIntentionalStop(sessionId, 'stop_session');
                            await this.deps.sessionHostControl.stopSession(sessionId);
                            stoppedSessionIds.push(sessionId);
                        } catch (stopError: any) {
                            errors.push({ sessionId, error: stopError?.message || String(stopError) });
                            continue;
                        }
                    }
                    skippedSessionIds.push(sessionId);
                    continue;
                }
                errors.push({ sessionId, error: message });
            }
        }

        const deleteUnsupported = deleteUnsupportedSessionIds.length > 0;
        return {
            success: errors.length === 0,
            mode: args.mode,
            dryRun: args.dryRun === true,
            matchedCount: matched.length,
            matchedBySurfaceKind,
            stoppedSessionIds,
            deletedSessionIds,
            skippedSessionIds,
            skippedLiveSessionIds,
            ...(deleteUnsupported ? {
                deleteUnsupported: true,
                effectiveCleanup: args.mode === 'stop_and_delete'
                    ? 'stopped_only_records_remain'
                    : 'delete_unsupported_records_remain',
                deleteUnsupportedSessionIds,
                recordsRemainSessionIds,
            } : {}),
            ...(errors.length ? { errors } : {}),
        };
    }

    private async traceSessionHostAction<T>(
        action: string,
        args: any,
        run: () => Promise<T>,
        summarizeResult?: (result: T) => Record<string, unknown>,
    ): Promise<T> {
        const interactionId = typeof args?._interactionId === 'string' ? args._interactionId : undefined;
        const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : undefined;
        const requestedPayload: Record<string, unknown> = { action };
        if (sessionId) requestedPayload.sessionId = sessionId;
        if (typeof args?.clientId === 'string') requestedPayload.clientId = args.clientId;
        if (typeof args?.signal === 'string') requestedPayload.signal = args.signal;
        if (typeof args?.providerType === 'string') requestedPayload.providerType = args.providerType;
        if (typeof args?.workspace === 'string') requestedPayload.workspace = args.workspace;
        if (typeof args?.dryRun === 'boolean') requestedPayload.dryRun = args.dryRun;

        recordDebugTrace({
            interactionId,
            category: 'session_host',
            stage: 'action_requested',
            level: 'info',
            sessionId,
            payload: requestedPayload,
        });

        try {
            const result = await run();
            recordDebugTrace({
                interactionId,
                category: 'session_host',
                stage: 'action_result',
                level: 'info',
                sessionId,
                payload: {
                    ...requestedPayload,
                    success: true,
                    ...(summarizeResult ? summarizeResult(result) : {}),
                },
            });
            return result;
        } catch (error: any) {
            recordDebugTrace({
                interactionId,
                category: 'session_host',
                stage: 'action_failed',
                level: 'error',
                sessionId,
                payload: {
                    ...requestedPayload,
                    error: error?.message || String(error),
                    failureKind: getWriteConflictOwnerClientId(error) ? 'write_conflict' : 'request_failed',
                    conflictOwnerClientId: getWriteConflictOwnerClientId(error),
                },
            });
            throw error;
        }
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
        const logSource = normalizeCommandSource(source);
        const normalizedArgs = normalizeCommandArgsWithInteractionId(args);
        const interactionId = typeof normalizedArgs._interactionId === 'string' ? normalizedArgs._interactionId : undefined;

        recordDebugTrace({
            interactionId,
            category: 'command',
            stage: 'received',
            level: 'info',
            payload: { cmd, source: logSource },
        });

        try {
            // 1. Try daemon-level command
            const daemonResult = await this.executeDaemonCommand(cmd, normalizedArgs);
            if (daemonResult) {
                logCommand({ ts: new Date().toISOString(), cmd, source: logSource, interactionId, args: normalizedArgs, success: daemonResult.success, durationMs: Date.now() - cmdStart });
                recordDebugTrace({
                    interactionId,
                    category: 'command',
                    stage: 'completed',
                    level: daemonResult.success ? 'info' : 'warn',
                    payload: { cmd, source: logSource, success: daemonResult.success, durationMs: Date.now() - cmdStart },
                });
                return daemonResult;
            }

            // 2. Delegate to DaemonCommandHandler
            const handlerResult = await this.deps.commandHandler.handle(cmd, normalizedArgs);
            logCommand({ ts: new Date().toISOString(), cmd, source: logSource, interactionId, args: normalizedArgs, success: handlerResult.success, durationMs: Date.now() - cmdStart });
            recordDebugTrace({
                interactionId,
                category: 'command',
                stage: 'completed',
                level: handlerResult.success ? 'info' : 'warn',
                payload: { cmd, source: logSource, success: handlerResult.success, durationMs: Date.now() - cmdStart },
            });

            // 3. Post-chat command callback
            if (CHAT_COMMANDS.includes(cmd) && this.deps.onPostChatCommand) {
                this.deps.onPostChatCommand();
            }

            return handlerResult;
        } catch (e: any) {
            logCommand({ ts: new Date().toISOString(), cmd, source: logSource, interactionId, args: normalizedArgs, success: false, error: e.message, durationMs: Date.now() - cmdStart });
            recordDebugTrace({
                interactionId,
                category: 'command',
                stage: 'failed',
                level: 'error',
                payload: { cmd, source: logSource, error: e?.message || String(e), durationMs: Date.now() - cmdStart },
            });
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
            case 'mesh_forward_event': {
                return handleMeshForwardEvent({ instanceManager: this.deps.instanceManager } as any, args as Record<string, unknown>);
            }

            case 'get_pending_mesh_events': {
                const events = drainPendingMeshCoordinatorEvents();
                return { success: true, events };
            }

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
                    // Incremental polling must not fall back to unfiltered file text: the file
                    // format is not timestamp-filterable, and returning its tail makes the UI
                    // replace structured logs with old raw fallback lines when nothing new exists.
                    if (sinceTs > 0) {
                        return { success: true, logs: [], totalBuffered: 0 };
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

            case 'get_debug_trace': {
                const count = parseInt(args?.count) || parseInt(args?.limit) || 100;
                const sinceTs = Number(args?.since) || 0;
                const interactionId = typeof args?.interactionId === 'string' ? args.interactionId : undefined;
                const category = typeof args?.category === 'string' ? args.category : undefined;
                const trace = getRecentDebugTrace({ interactionId, category, limit: count })
                    .filter((entry) => !sinceTs || entry.ts > sinceTs);
                return { success: true, trace, count: trace.length };
            }

            case 'session_host_get_diagnostics': {
                if (!this.deps.sessionHostControl) return { success: false, error: 'Session host control unavailable' };
                const diagnostics = await this.traceSessionHostAction('session_host_get_diagnostics', args, () => this.deps.sessionHostControl!.getDiagnostics({
                    includeSessions: args?.includeSessions !== false,
                    limit: Number(args?.limit) || undefined,
                }), (result) => ({
                    includeSessions: args?.includeSessions !== false,
                    limit: Number(args?.limit) || undefined,
                    ...summarizeSessionHostDiagnostics(result),
                }));
                return { success: true, diagnostics };
            }

            case 'session_host_list_sessions': {
                if (!this.deps.sessionHostControl) return { success: false, error: 'Session host control unavailable' };
                const sessions = await this.traceSessionHostAction('session_host_list_sessions', args, () => this.deps.sessionHostControl!.listSessions(), (records) => summarizeSessionHostRecords(records));
                return { success: true, sessions };
            }

            case 'session_host_stop_session': {
                if (!this.deps.sessionHostControl) return { success: false, error: 'Session host control unavailable' };
                const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : '';
                if (!sessionId) return { success: false, error: 'sessionId required' };
                const record = await this.traceSessionHostAction('session_host_stop_session', args, () => this.deps.sessionHostControl!.stopSession(sessionId), (result) => summarizeSessionHostRecord(result));
                return { success: true, record };
            }

            case 'session_host_resume_session': {
                if (!this.deps.sessionHostControl) return { success: false, error: 'Session host control unavailable' };
                const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : '';
                if (!sessionId) return { success: false, error: 'sessionId required' };
                const record = await this.traceSessionHostAction('session_host_resume_session', args, async () => {
                    const nextRecord = await this.deps.sessionHostControl!.resumeSession(sessionId);
                    const hosted = toHostedCliRuntimeDescriptor(nextRecord);
                    if (hosted) {
                        await this.deps.cliManager.restoreHostedSessions([hosted]);
                    }
                    return nextRecord;
                }, (result) => ({
                    ...summarizeSessionHostRecord(result),
                    restoredHostedSession: !!toHostedCliRuntimeDescriptor(result),
                }));
                return { success: true, record };
            }

            case 'session_host_restart_session': {
                if (!this.deps.sessionHostControl) return { success: false, error: 'Session host control unavailable' };
                const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : '';
                if (!sessionId) return { success: false, error: 'sessionId required' };
                const record = await this.traceSessionHostAction('session_host_restart_session', args, async () => {
                    const nextRecord = await this.deps.sessionHostControl!.restartSession(sessionId);
                    const hosted = toHostedCliRuntimeDescriptor(nextRecord);
                    if (hosted) {
                        await this.deps.cliManager.restoreHostedSessions([hosted]);
                    }
                    return nextRecord;
                }, (result) => ({
                    ...summarizeSessionHostRecord(result),
                    restoredHostedSession: !!toHostedCliRuntimeDescriptor(result),
                }));
                return { success: true, record };
            }

            case 'session_host_send_signal': {
                if (!this.deps.sessionHostControl) return { success: false, error: 'Session host control unavailable' };
                const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : '';
                const signal = typeof args?.signal === 'string' ? args.signal : '';
                if (!sessionId) return { success: false, error: 'sessionId required' };
                if (!signal) return { success: false, error: 'signal required' };
                const record = await this.traceSessionHostAction('session_host_send_signal', args, () => this.deps.sessionHostControl!.sendSignal(sessionId, signal), (result) => summarizeSessionHostRecord(result));
                return { success: true, record };
            }

            case 'session_host_force_detach_client': {
                if (!this.deps.sessionHostControl) return { success: false, error: 'Session host control unavailable' };
                const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : '';
                const clientId = typeof args?.clientId === 'string' ? args.clientId : '';
                if (!sessionId) return { success: false, error: 'sessionId required' };
                if (!clientId) return { success: false, error: 'clientId required' };
                const record = await this.traceSessionHostAction('session_host_force_detach_client', args, () => this.deps.sessionHostControl!.forceDetachClient(sessionId, clientId), (result) => summarizeSessionHostRecord(result));
                return { success: true, record };
            }

            case 'session_host_prune_duplicate_sessions': {
                if (!this.deps.sessionHostControl) return { success: false, error: 'Session host control unavailable' };
                const result = await this.traceSessionHostAction('session_host_prune_duplicate_sessions', args, () => this.deps.sessionHostControl!.pruneDuplicateSessions({
                    providerType: typeof args?.providerType === 'string' ? args.providerType : undefined,
                    workspace: typeof args?.workspace === 'string' ? args.workspace : undefined,
                    dryRun: args?.dryRun === true,
                }), (value) => summarizeSessionHostPruneResult(value));
                return { success: true, result };
            }

            case 'session_host_acquire_write': {
                if (!this.deps.sessionHostControl) return { success: false, error: 'Session host control unavailable' };
                const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : '';
                const clientId = typeof args?.clientId === 'string' ? args.clientId : '';
                const ownerType = args?.ownerType === 'agent' ? 'agent' : 'user';
                if (!sessionId) return { success: false, error: 'sessionId required' };
                if (!clientId) return { success: false, error: 'clientId required' };
                const record = await this.traceSessionHostAction('session_host_acquire_write', args, () => this.deps.sessionHostControl!.acquireWrite({
                    sessionId,
                    clientId,
                    ownerType,
                    force: args?.force !== false,
                }), (result) => ({
                    ...summarizeSessionHostRecord(result),
                    ownerType,
                }));
                return { success: true, record };
            }

            case 'session_host_release_write': {
                if (!this.deps.sessionHostControl) return { success: false, error: 'Session host control unavailable' };
                const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : '';
                const clientId = typeof args?.clientId === 'string' ? args.clientId : '';
                if (!sessionId) return { success: false, error: 'sessionId required' };
                if (!clientId) return { success: false, error: 'clientId required' };
                const record = await this.traceSessionHostAction('session_host_release_write', args, () => this.deps.sessionHostControl!.releaseWrite({
                    sessionId,
                    clientId,
                }), (result) => summarizeSessionHostRecord(result));
                return { success: true, record };
            }

            case 'list_saved_sessions': {
                const providerType = typeof args?.providerType === 'string'
                    ? args.providerType.trim()
                    : typeof args?.agentType === 'string'
                        ? args.agentType.trim()
                        : '';
                const kind = args?.kind === 'acp' ? 'acp' : 'cli';
                if (!providerType) {
                    return { success: false, error: 'providerType required' };
                }

                const wantsAll = args?.all === true;
                const offset = wantsAll ? 0 : Math.max(0, Number(args?.offset) || 0);
                const limit = wantsAll ? Number.MAX_SAFE_INTEGER : Math.max(1, Math.min(100, Number(args?.limit) || 30));
                const requestedWorkspace = typeof args?.workspace === 'string' ? args.workspace.trim() : '';
                const requestedProviderSessionId = typeof args?.providerSessionId === 'string'
                    ? args.providerSessionId.trim()
                    : typeof args?.activeProviderSessionId === 'string'
                        ? args.activeProviderSessionId.trim()
                        : '';
                const providerMeta = this.deps.providerLoader.resolve?.(providerType) || this.deps.providerLoader.getMeta(providerType);
                const { sessions: historySessions, hasMore, source } = listProviderHistorySessions(providerType, {
                    canonicalHistory: providerMeta?.canonicalHistory,
                    offset,
                    limit,
                    historyBehavior: providerMeta?.historyBehavior,
                    scripts: providerMeta?.scripts as any,
                });
                const state = loadState();
                const savedSessions = getSavedProviderSessions(state, { providerType, kind });
                const recentSessions = getRecentActivity(state, 200)
                    .filter(entry => entry.providerType === providerType && entry.kind === kind && entry.providerSessionId);
                const savedSessionById = new Map(savedSessions.map(entry => [entry.providerSessionId, entry]));
                const recentSessionById = new Map(recentSessions.map(entry => [entry.providerSessionId!, entry]));
                const canResumeById = supportsExplicitSessionResume(providerMeta?.resume);

                return {
                    success: true,
                    sessions: historySessions.map(session => {
                        const saved = savedSessionById.get(session.historySessionId);
                        const recent = recentSessionById.get(session.historySessionId);
                        const workspace = saved?.workspace
                            || recent?.workspace
                            || session.workspace
                            || (requestedWorkspace && requestedProviderSessionId === session.historySessionId ? requestedWorkspace : undefined);
                        return {
                            id: session.historySessionId,
                            providerSessionId: session.historySessionId,
                            providerType,
                            providerName: saved?.providerName || recent?.providerName || providerType,
                            kind: saved?.kind || recent?.kind || kind,
                            title: saved?.title || recent?.title || session.sessionTitle || session.preview || providerType,
                            workspace,
                            summaryMetadata: saved?.summaryMetadata || recent?.summaryMetadata,
                            preview: session.preview,
                            messageCount: session.messageCount,
                            firstMessageAt: session.firstMessageAt,
                            lastMessageAt: session.lastMessageAt,
                            canResume: !!workspace && canResumeById,
                            historySource: session.source,
                            sourcePath: session.sourcePath,
                            sourceMtimeMs: session.sourceMtimeMs,
                        };
                    }),
                    hasMore,
                    source,
                };
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
                try {
                    const results = await detectIDEs(this.deps.providerLoader);
                    this.deps.detectedIdes.value = results;
                    this.deps.providerLoader.setIdeDetectionResults(results, true);
                } catch { /* ignore detection refresh errors */ }
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
                    const manager = new DaemonCdpManager(result.port, logFn, undefined, provider?.targetFilter);
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
                try {
                    const results = await detectIDEs(this.deps.providerLoader);
                    this.deps.detectedIdes.value = results;
                    this.deps.providerLoader.setIdeDetectionResults(results, true);
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

            // ─── Detect providers ───
            case 'detect_provider': {
                const providerType = typeof args?.providerType === 'string' ? args.providerType.trim() : '';
                if (!providerType) return { success: false, error: 'providerType is required' };
                const normalizedType = this.deps.providerLoader.resolveAlias(providerType);
                const provider = this.deps.providerLoader.getByAlias(providerType);
                if (!provider) return { success: false, error: `Provider not found: ${providerType}` };
                if (provider.category !== 'cli' && provider.category !== 'acp') {
                    return { success: false, error: `Provider detection is only supported for CLI/ACP providers: ${providerType}` };
                }
                if (!this.deps.providerLoader.isMachineProviderEnabled(normalizedType)) {
                    return { success: false, error: `Provider is disabled on this machine: ${providerType}` };
                }
                const detected = await detectCLI(normalizedType, this.deps.providerLoader, { includeVersion: false });
                this.deps.providerLoader.setCliDetectionResults([{
                    id: normalizedType,
                    installed: !!detected,
                    path: detected?.path,
                }], false);
                this.deps.onStatusChange?.();
                return {
                    success: true,
                    providerType: normalizedType,
                    detected: !!detected,
                    path: detected?.path || null,
                };
            }

            // ─── Detect IDEs ───
            case 'detect_ides': {
                const results = await detectIDEs(this.deps.providerLoader);
                this.deps.detectedIdes.value = results;
                this.deps.providerLoader.setIdeDetectionResults(results, true);
                return { success: true, detectedInfo: results };
            }

            // ─── Set User Name ───
            case 'set_user_name': {
                const name = args?.userName;
                if (!name || typeof name !== 'string') throw new Error('userName required');
                updateConfig({ userName: name });
                return { success: true, userName: name };
            }

            case 'get_status_metadata': {
                const snapshot = buildStatusSnapshot({
                    allStates: this.deps.instanceManager.collectAllStates(),
                    cdpManagers: this.deps.cdpManagers,
                    providerLoader: this.deps.providerLoader,
                    detectedIdes: this.deps.detectedIdes.value,
                    instanceId: this.deps.statusInstanceId || loadConfig().machineId || 'daemon',
                    version: this.deps.statusVersion || 'unknown',
                    profile: 'metadata',
                });
                return { success: true, status: snapshot };
            }

            case 'get_machine_runtime_stats': {
                return {
                    success: true,
                    machine: buildMachineInfo('full'),
                    timestamp: Date.now(),
                };
            }

            case 'mark_session_seen': {
                const sessionId = args?.sessionId;
                if (!sessionId || typeof sessionId !== 'string') {
                    return { success: false, error: 'sessionId is required' };
                }
                const currentState = loadState();
                const prevSeenAt = currentState.sessionReads?.[sessionId] || 0;
                const sessionEntries = buildSessionEntries(
                    this.deps.instanceManager.collectAllStates(),
                    this.deps.cdpManagers,
                );
                const targetSession = sessionEntries.find((entry) => entry.id === sessionId);
                const requestedCompletionMarker = typeof args?.completionMarker === 'string'
                    ? args.completionMarker.trim()
                    : '';
                const completionMarker = requestedCompletionMarker || (targetSession ? getSessionCompletionMarker(targetSession) : '');
                const requestedProviderSessionId = typeof args?.providerSessionId === 'string'
                    ? args.providerSessionId.trim()
                    : '';
                const providerSessionId = requestedProviderSessionId || targetSession?.providerSessionId;
                const next = markSessionSeen(
                    currentState,
                    sessionId,
                    typeof args?.seenAt === 'number' ? args.seenAt : Date.now(),
                    completionMarker,
                    providerSessionId,
                );
                if (READ_DEBUG_ENABLED) {
                    LOG.info('RecentRead', `mark_session_seen sessionId=${sessionId} seenAt=${String(args?.seenAt || '')} prevSeenAt=${String(prevSeenAt)} nextSeenAt=${String(next.sessionReads?.[sessionId] || 0)} marker=${completionMarker || '-'}`);
                }
                saveState(next);
                this.deps.onStatusChange?.();
                return {
                    success: true,
                    sessionId,
                    seenAt: next.sessionReads?.[sessionId] || Date.now(),
                    completionMarker,
                };
            }

            case 'delete_notification': {
                const sessionId = args?.sessionId;
                const notificationId = typeof args?.notificationId === 'string' ? args.notificationId.trim() : '';
                if (!sessionId || typeof sessionId !== 'string') {
                    return { success: false, error: 'sessionId is required' };
                }
                if (!notificationId) {
                    return { success: false, error: 'notificationId is required' };
                }
                const sessionEntries = buildSessionEntries(
                    this.deps.instanceManager.collectAllStates(),
                    this.deps.cdpManagers,
                );
                const targetSession = sessionEntries.find((entry) => entry.id === sessionId);
                const next = dismissSessionNotification(
                    loadState(),
                    sessionId,
                    notificationId,
                    targetSession?.providerSessionId,
                );
                saveState(next);
                this.deps.onStatusChange?.();
                return {
                    success: true,
                    sessionId,
                    notificationId,
                };
            }

            case 'mark_notification_unread': {
                const sessionId = args?.sessionId;
                const notificationId = typeof args?.notificationId === 'string' ? args.notificationId.trim() : '';
                if (!sessionId || typeof sessionId !== 'string') {
                    return { success: false, error: 'sessionId is required' };
                }
                if (!notificationId) {
                    return { success: false, error: 'notificationId is required' };
                }
                const sessionEntries = buildSessionEntries(
                    this.deps.instanceManager.collectAllStates(),
                    this.deps.cdpManagers,
                );
                const targetSession = sessionEntries.find((entry) => entry.id === sessionId);
                const next = markSessionNotificationUnread(
                    loadState(),
                    sessionId,
                    notificationId,
                    targetSession?.providerSessionId,
                );
                saveState(next);
                this.deps.onStatusChange?.();
                return {
                    success: true,
                    sessionId,
                    notificationId,
                };
            }

            // ─── Daemon Self-Upgrade ───
            case 'daemon_upgrade': {
                LOG.info('Upgrade', 'Remote upgrade requested from dashboard');
                try {
                    // Detect package name for upgrade
                    const isStandalone = this.deps.packageName === '@adhdev/daemon-standalone'
                        || process.argv[1]?.includes('daemon-standalone');
                    const pkgName = isStandalone ? '@adhdev/daemon-standalone' : 'adhdev';
                    const npmSurface = resolveCurrentGlobalInstallSurface({ packageName: pkgName });
                    const channel = resolveUpgradeChannel(args);
                    const npmTag = CHANNEL_NPM_TAG[channel];

                    // Check channel-pinned dist-tag and resolve it to a concrete install version.
                    const latest = String(execNpmCommandSync(['view', `${pkgName}@${npmTag}`, 'version'], { encoding: 'utf-8', timeout: 10000 }, npmSurface)).trim();
                    LOG.info('Upgrade', `Latest ${pkgName}@${npmTag}: v${latest}`);
                    updateConfig({ updateChannel: channel, serverUrl: CHANNEL_SERVER_URL[channel] } as any);
                    let currentInstalled: string | null = null;
                    try {
                        const currentJson = String(execNpmCommandSync(['ls', '-g', pkgName, '--depth=0', '--json'], {
                            encoding: 'utf-8',
                            timeout: 10000,
                            stdio: ['pipe', 'pipe', 'pipe'],
                        }, npmSurface)).trim();
                        const parsed = JSON.parse(currentJson);
                        currentInstalled = parsed?.dependencies?.[pkgName]?.version || null;
                    } catch {
                        // ignore ls failures; upgrade can still proceed
                    }

                    const runningVersion = typeof this.deps.statusVersion === 'string'
                        ? this.deps.statusVersion.trim().replace(/^v/, '')
                        : null;
                    if (currentInstalled === latest && runningVersion === latest) {
                        LOG.info('Upgrade', `Already on ${channel} channel version v${latest}; skipping install`);
                        return { success: true, upgraded: false, alreadyLatest: true, version: latest, channel, npmTag };
                    }
                    if (currentInstalled === latest && runningVersion && runningVersion !== latest) {
                        LOG.info('Upgrade', `Installed package is v${latest}, but running daemon is v${runningVersion}; scheduling restart`);
                    }

                    spawnDetachedDaemonUpgradeHelper({
                        packageName: pkgName,
                        targetVersion: latest,
                        parentPid: process.pid,
                        restartArgv: process.argv.slice(1),
                        cwd: process.cwd(),
                        sessionHostAppName: process.env.ADHDEV_SESSION_HOST_NAME || 'adhdev',
                    });
                    LOG.info('Upgrade', `Scheduled detached ${channel} upgrade to v${latest}`);

                    // Exit after the command response has been sent so the helper can replace the package cleanly.
                    setTimeout(() => {
                        LOG.info('Upgrade', 'Exiting daemon so detached upgrader can continue...');
                        process.exit(0);
                    }, 3000);

                    return { success: true, upgraded: true, version: latest, restarting: true, channel, npmTag };
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

            // ─── Mesh CRUD (local meshes.json) ───
            case 'list_meshes': {
                try {
                    const { listMeshes } = await import('../config/mesh-config.js');
                    return { success: true, meshes: listMeshes() };
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }

            case 'get_mesh': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                if (!meshId) return { success: false, error: 'meshId required' };
                const meshRecord = await this.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
                if (meshRecord?.mesh) return { success: true, mesh: meshRecord.mesh };
                return { success: false, error: 'Mesh not found' };
            }

            case 'create_mesh': {
                const name = typeof args?.name === 'string' ? args.name.trim() : '';
                const repoIdentity = typeof args?.repoIdentity === 'string' ? args.repoIdentity.trim() : '';
                const repoRemoteUrl = typeof args?.repoRemoteUrl === 'string' ? args.repoRemoteUrl.trim() : undefined;
                const defaultBranch = typeof args?.defaultBranch === 'string' ? args.defaultBranch.trim() : undefined;
                if (!name) return { success: false, error: 'name required' };
                try {
                    const { createMesh } = await import('../config/mesh-config.js');
                    const mesh = createMesh({ name, repoIdentity, repoRemoteUrl, defaultBranch, policy: args?.policy });
                    return { success: true, mesh };
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }

            case 'update_mesh': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                if (!meshId) return { success: false, error: 'meshId required' };
                try {
                    const { updateMesh } = await import('../config/mesh-config.js');
                    const patch: Record<string, unknown> = {};
                    if (typeof args?.name === 'string') patch.name = args.name;
                    if (typeof args?.defaultBranch === 'string') patch.defaultBranch = args.defaultBranch;
                    if (args?.policy && typeof args.policy === 'object' && !Array.isArray(args.policy)) patch.policy = args.policy;
                    if (args?.coordinator && typeof args.coordinator === 'object' && !Array.isArray(args.coordinator)) patch.coordinator = args.coordinator;
                    if (!Object.keys(patch).length) return { success: false, error: 'No updates provided' };
                    const mesh = updateMesh(meshId, patch as any);
                    if (!mesh) return { success: false, error: 'Mesh not found' };
                    this.inlineMeshCache.set(meshId, mesh);
                    return { success: true, mesh };
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }

            case 'delete_mesh': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                if (!meshId) return { success: false, error: 'meshId required' };
                try {
                    const { deleteMesh } = await import('../config/mesh-config.js');
                    const deleted = deleteMesh(meshId);
                    return { success: true, deleted };
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }

            case 'get_mesh_ledger': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                if (!meshId) return { success: false, error: 'meshId required' };
                try {
                    const { readLedgerEntries, getLedgerSummary } = await import('../mesh/mesh-ledger.js');
                    const tail = typeof args?.tail === 'number' ? args.tail : 20;
                    const since = typeof args?.since === 'string' ? args.since : undefined;
                    const kind = Array.isArray(args?.kind) ? args.kind.filter((k: any) => typeof k === 'string') : undefined;
                    const entries = readLedgerEntries(meshId, { tail, since, kind });
                    const summary = getLedgerSummary(meshId);
                    return { success: true, entries, summary };
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }

            case 'get_mesh_ledger_slice': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                if (!meshId) return { success: false, error: 'meshId required' };
                try {
                    const { readLedgerSlice } = await import('../mesh/mesh-ledger.js');
                    const kind = Array.isArray(args?.kind) ? args.kind.filter((k: any) => typeof k === 'string') : undefined;
                    const slice = readLedgerSlice(meshId, {
                        afterId: typeof args?.afterId === 'string' ? args.afterId : undefined,
                        since: typeof args?.since === 'string' ? args.since : undefined,
                        kind,
                        limit: typeof args?.limit === 'number' ? args.limit : undefined,
                    });
                    return { success: true, slice };
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }

            case 'import_mesh_ledger_slice': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                if (!meshId) return { success: false, error: 'meshId required' };
                try {
                    const { appendRemoteLedgerEntries, getLedgerSummary } = await import('../mesh/mesh-ledger.js');
                    const entries = Array.isArray(args?.entries)
                        ? args.entries as any[]
                        : Array.isArray(args?.slice?.entries)
                            ? args.slice.entries as any[]
                            : [];
                    const result = appendRemoteLedgerEntries(meshId, entries as any);
                    return { success: true, result, summary: getLedgerSummary(meshId) };
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }

            case 'get_mesh_queue': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                if (!meshId) return { success: false, error: 'meshId required' };
                try {
                    const { getMeshQueueStats, getQueue } = await import('../mesh/mesh-work-queue.js');
                    const status = Array.isArray(args?.status)
                        ? args.status.map((s: any) => typeof s === 'string' ? s.trim() : '').filter(Boolean)
                        : undefined;
                    const queue = getQueue(meshId, { status: status as any });
                    const summary = getMeshQueueStats(meshId);
                    return {
                        success: true,
                        queue,
                        summary,
                        sourceOfTruth: {
                            kind: 'mesh_work_queue_file',
                            activeStatuses: ['pending', 'assigned'],
                            historicalStatuses: ['completed', 'failed', 'cancelled'],
                            notes: 'pending/assigned are active work; completed/failed/cancelled are historical records.',
                        },
                    };
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }

            case 'cancel_mesh_queue_task': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                const taskId = typeof args?.taskId === 'string' ? args.taskId.trim() : '';
                if (!meshId || !taskId) return { success: false, error: 'meshId and taskId required' };
                try {
                    const { cancelTask } = await import('../mesh/mesh-work-queue.js');
                    const reason = typeof args?.reason === 'string' ? args.reason : undefined;
                    const task = cancelTask(meshId, taskId, { reason });
                    if (!task) return { success: false, error: `Queue task '${taskId}' not found` };
                    return { success: true, task };
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }

            case 'requeue_mesh_queue_task': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                const taskId = typeof args?.taskId === 'string' ? args.taskId.trim() : '';
                if (!meshId || !taskId) return { success: false, error: 'meshId and taskId required' };
                try {
                    const { requeueTask } = await import('../mesh/mesh-work-queue.js');
                    const task = requeueTask(meshId, taskId, {
                        reason: typeof args?.reason === 'string' ? args.reason : undefined,
                        targetNodeId: typeof args?.targetNodeId === 'string' ? args.targetNodeId.trim() : undefined,
                        targetSessionId: typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim() : undefined,
                        clearTargetNode: args?.clearTargetNode === true,
                        clearTargetSession: args?.clearTargetSession !== false,
                    });
                    if (!task) return { success: false, error: `Queue task '${taskId}' not found` };
                    return { success: true, task };
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }

            case 'add_mesh_node': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                const workspace = typeof args?.workspace === 'string' ? args.workspace.trim() : '';
                if (!meshId) return { success: false, error: 'meshId required' };
                if (!workspace) return { success: false, error: 'workspace required' };
                try {
                    const { addNode } = await import('../config/mesh-config.js');
                    const providerPriority = Array.isArray(args?.providerPriority)
                        ? args.providerPriority.map((type: any) => typeof type === 'string' ? type.trim() : '').filter(Boolean)
                        : [];
                    const readOnly = args?.readOnly === true;
                    const policy = {
                        ...(readOnly ? { readOnly: true } : {}),
                        ...(providerPriority.length ? { providerPriority } : {}),
                    };
                    const node = addNode(meshId, { workspace, ...(policy ? { policy } : {}) });
                    if (!node) return { success: false, error: 'Mesh not found' };
                    return { success: true, node };
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }

            case 'update_mesh_node': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                const nodeId = typeof args?.nodeId === 'string' ? args.nodeId.trim() : '';
                if (!meshId || !nodeId) return { success: false, error: 'meshId and nodeId required' };
                try {
                    const { updateNode } = await import('../config/mesh-config.js');
                    const policy = args?.policy && typeof args.policy === 'object' && !Array.isArray(args.policy)
                        ? { ...(args.policy as Record<string, unknown>) }
                        : {};
                    if (Array.isArray(args?.providerPriority)) {
                        const providerPriority = args.providerPriority
                            .map((type: any) => typeof type === 'string' ? type.trim() : '')
                            .filter(Boolean);
                        delete (policy as any).provider_priority;
                        if (providerPriority.length) {
                            (policy as any).providerPriority = providerPriority;
                        } else {
                            delete (policy as any).providerPriority;
                        }
                    }
                    const node = updateNode(meshId, nodeId, { policy: policy as any });
                    if (!node) return { success: false, error: 'Mesh node not found' };
                    return { success: true, node };
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }

            case 'cleanup_mesh_sessions': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                const nodeId = typeof args?.nodeId === 'string' ? args.nodeId.trim() : '';
                if (!meshId || !nodeId) return { success: false, error: 'meshId and nodeId required' };
                try {
                    const meshRecord = await this.getMeshForCommand(meshId, args?.inlineMesh);
                    const mesh = meshRecord?.mesh;
                    if (!mesh) return { success: false, error: 'Mesh not found' };
                    const node = mesh?.nodes?.find((n: any) => n.id === nodeId || n.nodeId === nodeId);
                    if (!node) return { success: false, error: `Node '${nodeId}' not found in mesh` };
                    const mode = this.normalizeMeshSessionCleanupMode(args?.mode ?? mesh?.policy?.sessionCleanupOnNodeRemove);
                    const sessionIds = Array.isArray(args?.sessionIds)
                        ? args.sessionIds.map((id: any) => typeof id === 'string' ? id.trim() : '').filter(Boolean)
                        : undefined;
                    const result = await this.cleanupMeshSessions({
                        meshId,
                        nodeId,
                        node,
                        mode,
                        sessionIds,
                        dryRun: args?.dryRun === true,
                        source: 'mesh_cleanup_sessions',
                    });
                    return result;
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }

            case 'refine_mesh_node': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                const nodeId = typeof args?.nodeId === 'string' ? args.nodeId.trim() : '';
                if (!meshId || !nodeId) return { success: false, error: 'meshId and nodeId required' };
                try {
                    const meshRecord = await this.getMeshForCommand(meshId, args?.inlineMesh);
                    const mesh = meshRecord?.mesh;
                    const node = mesh?.nodes?.find((n: any) => n.id === nodeId || n.nodeId === nodeId);
                    if (!node) return { success: false, error: `Node '${nodeId}' not found in mesh` };

                    if (!node.isLocalWorktree || !node.workspace) {
                        return { success: false, error: `Refinery requires a local worktree node` };
                    }

                    const sourceNode = node.clonedFromNodeId
                        ? mesh?.nodes.find((n: any) => n.id === node.clonedFromNodeId || n.nodeId === node.clonedFromNodeId)
                        : mesh?.nodes.find((n: any) => !n.isLocalWorktree);
                    const repoRoot = sourceNode?.repoRoot || sourceNode?.workspace;
                    if (!repoRoot) return { success: false, error: 'Source node repoRoot not found' };

                    const { execFile } = await import('node:child_process');
                    const { promisify } = await import('node:util');
                    const execFileAsync = promisify(execFile);

                    const { stdout: branchStdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd: node.workspace, encoding: 'utf8' });
                    const branch = branchStdout.trim();
                    if (!branch) return { success: false, error: 'Could not determine branch of the worktree node' };

                    const { stdout: baseBranchStdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd: repoRoot, encoding: 'utf8' });
                    const baseBranch = baseBranchStdout.trim();

                    const validationSummary = await runMeshRefineValidationGate(mesh, node.workspace);
                    if (validationSummary.status === 'failed') {
                        return {
                            success: false,
                            code: 'validation_failed',
                            convergenceStatus: 'blocked_review',
                            error: 'Refinery validation gate failed; merge/refine was not attempted.',
                            branch,
                            into: baseBranch,
                            validationSummary,
                            finalBranchConvergenceState: {
                                branch,
                                baseBranch,
                                merged: false,
                                removed: false,
                                validation: 'failed',
                                status: 'blocked_review',
                            },
                        };
                    }
                    if (validationSummary.status === 'skipped') {
                        return {
                            success: false,
                            code: 'validation_unavailable',
                            convergenceStatus: 'blocked_review',
                            error: 'Refinery validation gate is required but no allowlisted validation command was available; merge/refine was not attempted.',
                            branch,
                            into: baseBranch,
                            validationSummary,
                            finalBranchConvergenceState: {
                                branch,
                                baseBranch,
                                merged: false,
                                removed: false,
                                validation: 'unavailable',
                                status: 'blocked_review',
                            },
                        };
                    }

                    try {
                        await execFileAsync('git', ['merge', '--no-ff', branch, '-m', `Auto-merge branch '${branch}' via Refinery`], { cwd: repoRoot, encoding: 'utf8' });
                    } catch (e: any) {
                        return {
                            success: false,
                            error: `Merge failed (conflicts?): ${e.message}`,
                            validationSummary,
                            finalBranchConvergenceState: {
                                branch,
                                baseBranch,
                                merged: false,
                                removed: false,
                                validation: 'passed',
                                status: 'not_mergeable',
                            },
                        };
                    }

                    const removeResult = await this.execute('remove_mesh_node', {
                        meshId,
                        nodeId,
                        sessionCleanupMode: 'kill',
                        inlineMesh: args?.inlineMesh,
                    });

                    try {
                        const { appendLedgerEntry } = await import('../mesh/mesh-ledger.js');
                        appendLedgerEntry(meshId, {
                            kind: 'node_removed',
                            nodeId,
                            payload: { refined: true, mergedBranch: branch, into: baseBranch, validationSummary },
                        });
                    } catch {}

                    return {
                        success: true,
                        merged: true,
                        branch,
                        into: baseBranch,
                        removeResult,
                        validationSummary,
                        finalBranchConvergenceState: {
                            branch: baseBranch,
                            mergedBranch: branch,
                            baseBranch,
                            merged: true,
                            removed: removeResult?.success !== false,
                            validation: 'passed',
                            status: removeResult?.success === false ? 'merged_cleanup_failed' : 'merged',
                        },
                    };
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }

            case 'remove_mesh_node': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                const nodeId = typeof args?.nodeId === 'string' ? args.nodeId.trim() : '';
                if (!meshId || !nodeId) return { success: false, error: 'meshId and nodeId required' };
                try {
                    const meshRecord = await this.getMeshForCommand(meshId, args?.inlineMesh);
                    const mesh = meshRecord?.mesh;
                    const node = mesh?.nodes?.find((n: any) => n.id === nodeId || n.nodeId === nodeId);

                    const sessionCleanupMode = this.normalizeMeshSessionCleanupMode(
                        args?.sessionCleanupMode ?? args?.session_cleanup_mode ?? mesh?.policy?.sessionCleanupOnNodeRemove,
                    );
                    let sessionCleanup: Record<string, unknown> | undefined;
                    if (node && sessionCleanupMode !== 'preserve') {
                        sessionCleanup = await this.cleanupMeshSessions({ meshId, nodeId, node, mode: sessionCleanupMode, source: 'mesh_remove_node' });
                        if (sessionCleanup.success === false) return { success: false, removed: false, sessionCleanup };
                    }

                    let worktreeCleanup: Record<string, unknown> | undefined;
                    if (node?.isLocalWorktree) {
                        const cleanupResult = await this.cleanupLocalWorktreeNode({ mesh, node, nodeId });
                        if (cleanupResult.success === false) {
                            return {
                                success: false,
                                removed: false,
                                code: cleanupResult.code,
                                error: cleanupResult.error,
                                recoveryHint: cleanupResult.recoveryHint,
                                ...(sessionCleanup ? { sessionCleanup } : {}),
                                worktreeCleanup: cleanupResult,
                            };
                        }
                        worktreeCleanup = cleanupResult;
                    }

                    let removed = false;
                    if (meshRecord?.inline) {
                        removed = this.removeInlineMeshNode(meshId, mesh, nodeId);
                    } else {
                        const { removeNode } = await import('../config/mesh-config.js');
                        removed = removeNode(meshId, nodeId);
                    }

                    // Record in task ledger
                    if (removed) {
                        try {
                            const { appendLedgerEntry } = await import('../mesh/mesh-ledger.js');
                            appendLedgerEntry(meshId, {
                                kind: 'node_removed',
                                nodeId,
                                payload: {
                                    worktree: !!node?.isLocalWorktree,
                                    sessionCleanupMode,
                                    workspace: typeof node?.workspace === 'string' ? node.workspace : undefined,
                                    daemonId: typeof node?.daemonId === 'string' ? node.daemonId : undefined,
                                    worktreeBranch: typeof node?.worktreeBranch === 'string' ? node.worktreeBranch : undefined,
                                    worktreeCleanupFallback: typeof worktreeCleanup?.fallback === 'string' ? worktreeCleanup.fallback : undefined,
                                    forced: worktreeCleanup?.forced === true ? true : undefined,
                                    forceFallbackReason: typeof worktreeCleanup?.reason === 'string' ? worktreeCleanup.reason : undefined,
                                },
                            });
                        } catch { /* ledger append is best-effort */ }
                    }

                    return { success: true, removed, ...(sessionCleanup ? { sessionCleanup } : {}), ...(worktreeCleanup ? { worktreeCleanup } : {}) };
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }

            case 'clone_mesh_node': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                const sourceNodeId = typeof args?.sourceNodeId === 'string' ? args.sourceNodeId.trim() : '';
                const branch = typeof args?.branch === 'string' ? args.branch.trim() : '';
                const baseBranch = typeof args?.baseBranch === 'string' ? args.baseBranch.trim() : undefined;
                if (!meshId) return { success: false, error: 'meshId required' };
                if (!sourceNodeId) return { success: false, error: 'sourceNodeId required' };
                if (!branch) return { success: false, error: 'branch required' };

                try {
                    const meshRecord = await this.getMeshForCommand(meshId, args?.inlineMesh);
                    const mesh = meshRecord?.mesh;
                    if (!mesh) return { success: false, error: 'Mesh not found' };

                    const sourceNode = mesh.nodes?.find((n: any) => n.id === sourceNodeId || n.nodeId === sourceNodeId);
                    if (!sourceNode) return { success: false, error: `Source node '${sourceNodeId}' not found in mesh` };

                    const repoRoot = sourceNode.repoRoot || sourceNode.workspace;
                    const { createWorktree } = await import('../git/git-worktree.js');
                    const result = await createWorktree({
                        repoRoot,
                        branch,
                        baseBranch,
                        meshName: mesh.name,
                    });

                    let node: any;
                    if (meshRecord.inline) {
                        const { randomUUID } = await import('crypto');
                        node = {
                            id: `node_${randomUUID().replace(/-/g, '')}`,
                            workspace: result.worktreePath,
                            repoRoot: result.worktreePath,
                            daemonId: sourceNode.daemonId,
                            machineId: sourceNode.machineId ?? (sourceNode as any).machine_id,
                            userOverrides: { ...(sourceNode.userOverrides || {}) },
                            policy: { ...(sourceNode.policy || {}) },
                            isLocalWorktree: true,
                            worktreeBranch: result.branch,
                            clonedFromNodeId: sourceNodeId,
                        };
                        this.updateInlineMeshNode(meshId, mesh, node);
                    } else {
                        const { addNode } = await import('../config/mesh-config.js');
                        node = addNode(meshId, {
                            workspace: result.worktreePath,
                            repoRoot: result.worktreePath,
                            daemonId: sourceNode.daemonId,
                            machineId: sourceNode.machineId ?? (sourceNode as any).machine_id,
                            userOverrides: { ...(sourceNode.userOverrides || {}) },
                            isLocalWorktree: true,
                            worktreeBranch: result.branch,
                            clonedFromNodeId: sourceNodeId,
                            policy: { ...(sourceNode.policy || {}) },
                        });
                        if (!node) return { success: false, error: 'Failed to register worktree node' };
                    }

                    // Initialize submodules if policy allows (default: true)
                    const initSubmodules = (sourceNode.policy as any)?.initSubmodulesOnClone !== false;
                    if (initSubmodules) {
                        try {
                            const { runGit } = await import('../git/git-executor.js');
                            await runGit(
                                { workspace: result.worktreePath, repoRoot: result.worktreePath, isGitRepo: true },
                                ['submodule', 'update', '--init', '--recursive'],
                                { timeoutMs: 120000 },
                            );
                        } catch (subErr: any) {
                            // Submodule init is best-effort; don't fail the clone
                            console.warn('[mesh] Submodule init failed for worktree:', subErr.message);
                        }
                    }

                    // Record in task ledger
                    try {
                        const { appendLedgerEntry } = await import('../mesh/mesh-ledger.js');
                        appendLedgerEntry(meshId, {
                            kind: 'node_cloned',
                            nodeId: node.id,
                            payload: { sourceNodeId, branch: result.branch, worktreePath: result.worktreePath, submodulesInitialized: initSubmodules },
                        });
                    } catch { /* ledger append is best-effort */ }

                    return {
                        success: true,
                        node,
                        worktreePath: result.worktreePath,
                        branch: result.branch,
                    };
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }
            case 'trigger_mesh_queue': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                if (!meshId) return { success: false, error: 'meshId required' };
                try {
                    const { triggerMeshQueue } = await import('../mesh/mesh-events.js');
                    if (meshId) {
                        triggerMeshQueue(this.deps as any, meshId);
                    }
                    return { success: true };
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }

            // ─── Mesh Coordinator Launch ───
            case 'launch_mesh_coordinator': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                let cliType = typeof args?.cliType === 'string' ? args.cliType.trim() : '';
                if (!meshId) return { success: false, error: 'meshId required' };

                try {
                    const { buildCoordinatorSystemPrompt } = await import('../mesh/coordinator-prompt.js');

                    // Support inline mesh data from cloud (bypasses local meshes.json lookup)
                    let mesh: any;
                    if (args?.inlineMesh && typeof args.inlineMesh === 'object') {
                        mesh = args.inlineMesh;
                        // Cache cloud mesh so the MCP server can retrieve it via get_mesh
                        this.inlineMeshCache.set(meshId, mesh);
                    } else {
                        const { getMesh } = await import('../config/mesh-config.js');
                        mesh = getMesh(meshId);
                    }
                    if (!mesh) return { success: false, error: 'Mesh not found' };
                    if (!Array.isArray(mesh.nodes) || mesh.nodes.length === 0) return { success: false, error: 'No nodes in mesh' };

                    const requestedCoordinatorNodeId = typeof args?.coordinatorNodeId === 'string'
                        ? args.coordinatorNodeId.trim()
                        : '';
                    const preferredCoordinatorNodeId = requestedCoordinatorNodeId
                        || (typeof mesh.coordinator?.preferredNodeId === 'string' ? mesh.coordinator.preferredNodeId.trim() : '');
                    const coordinatorNode = preferredCoordinatorNodeId
                        ? mesh.nodes.find((node: any) => node?.id === preferredCoordinatorNodeId || node?.nodeId === preferredCoordinatorNodeId)
                        : mesh.nodes[0];
                    if (!coordinatorNode) {
                        return {
                            success: false,
                            code: 'mesh_coordinator_node_not_found',
                            error: `Coordinator node ${preferredCoordinatorNodeId} was not found in mesh`,
                            meshId,
                            cliType,
                        };
                    }
                    const workspace = typeof coordinatorNode.workspace === 'string' ? coordinatorNode.workspace.trim() : '';
                    if (!workspace) return { success: false, error: 'Coordinator node workspace required', meshId, cliType };
                    if (!cliType) {
                        const resolved = await resolveProviderTypeFromPriority({
                            nodeId: String(coordinatorNode.id || coordinatorNode.nodeId || preferredCoordinatorNodeId || 'coordinator'),
                            providerPriority: readProviderPriorityFromPolicy(coordinatorNode.policy),
                            providerLoader: this.deps.providerLoader,
                            onStatusChange: this.deps.onStatusChange,
                        });
                        if (!resolved.providerType) {
                            return {
                                success: false,
                                code: 'mesh_coordinator_provider_priority_unusable',
                                error: resolved.error || 'No usable provider found from node providerPriority',
                                meshId,
                                cliType,
                                workspace,
                            };
                        }
                        cliType = resolved.providerType;
                    }
                    const providerMeta = this.deps.providerLoader.resolve?.(cliType) || this.deps.providerLoader.getMeta(cliType);
                    const coordinatorSetup = resolveMeshCoordinatorSetup({
                        provider: providerMeta,
                        cliType,
                        meshId,
                        workspace,
                    });

                    if (coordinatorSetup.kind === 'unsupported') {
                        return {
                            success: false,
                            code: 'mesh_coordinator_unsupported',
                            error: coordinatorSetup.reason,
                            meshId,
                            cliType,
                            workspace,
                        };
                    }

                    if (coordinatorSetup.kind === 'manual') {
                        return {
                            success: false,
                            code: 'mesh_coordinator_manual_mcp_setup_required',
                            error: coordinatorSetup.instructions,
                            meshId,
                            cliType,
                            workspace,
                            meshCoordinatorSetup: coordinatorSetup,
                        };
                    }

                    // ─── CLI-command MCP registration (Codex, Gemini CLI) ───────────
                    if (coordinatorSetup.kind === 'cli_command') {
                        // Build coordinator prompt first — fail closed on errors.
                        let cliCmdSystemPrompt = '';
                        try {
                            cliCmdSystemPrompt = buildCoordinatorSystemPrompt({ mesh, coordinatorCliType: cliType });
                        } catch (error: any) {
                            const message = error?.message || String(error);
                            LOG.error('MeshCoordinator', `Failed to build coordinator prompt: ${message}`);
                            return {
                                success: false,
                                code: 'mesh_coordinator_prompt_failed',
                                error: `Failed to build Repo Mesh coordinator prompt: ${message}`,
                                meshId, cliType, workspace,
                            };
                        }

                        // Run the provider's MCP registration command.
                        try {
                            const { execFileSync: execCmdSync } = await import('node:child_process');
                            const cmdParts = coordinatorSetup.command.trim().split(/\s+/);
                            const [regCmd, ...regArgs] = cmdParts;
                            LOG.info('MeshCoordinator', `Running MCP registration: ${coordinatorSetup.command}`);
                            execCmdSync(regCmd, regArgs, { stdio: 'pipe', timeout: 15_000 });
                        } catch (error: any) {
                            // Non-fatal — server may already be registered (providers return exit 1 on duplicate).
                            LOG.warn('MeshCoordinator', `MCP registration command failed (may be pre-registered): ${error?.message || error}`);
                        }

                        // Inject system prompt using provider-native methods.
                        // Codex: -c 'instructions="..."' CLI config override
                        // Gemini: write GEMINI.md to workspace (auto-loaded as context)
                        const cliCmdArgs: string[] = [];
                        const cliCmdEnv: Record<string, string> = {};
                        if (cliCmdSystemPrompt) {
                            if (cliType === 'codex-cli') {
                                // Codex reads `developer_instructions` from config.toml as system instructions.
                                // The -c flag overrides a config key for this session only.
                                cliCmdArgs.push('-c', `developer_instructions=${JSON.stringify(cliCmdSystemPrompt)}`);
                            } else if (cliType === 'gemini-cli') {
                                // Gemini CLI auto-loads GEMINI.md from CWD as project context.
                                // Write a temporary GEMINI.md to the workspace before launch.
                                try {
                                    const { writeFileSync: wfs, existsSync: efs, readFileSync: rfs } = await import('node:fs');
                                    const geminiMdPath = `${workspace}/GEMINI.md`;
                                    const marker = '<!-- adhdev-mesh-coordinator-prompt -->';
                                    const markerEnd = '<!-- /adhdev-mesh-coordinator-prompt -->';
                                    const block = `${marker}\n${cliCmdSystemPrompt}\n${markerEnd}`;
                                    if (efs(geminiMdPath)) {
                                        const existing = rfs(geminiMdPath, 'utf-8');
                                        // Replace existing block or append
                                        const replaced = existing.replace(
                                            new RegExp(`${marker}[\\s\\S]*?${markerEnd}`, 'g'),
                                            block,
                                        );
                                        wfs(geminiMdPath, replaced.includes(marker) ? replaced : `${existing}\n\n${block}`);
                                    } else {
                                        wfs(geminiMdPath, block);
                                    }
                                    LOG.info('MeshCoordinator', `Wrote coordinator prompt to ${workspace}/GEMINI.md`);
                                } catch (e: any) {
                                    LOG.warn('MeshCoordinator', `Could not write GEMINI.md: ${e?.message || e}`);
                                }
                            }
                        }

                        const cliCmdLaunch: any = await this.deps.cliManager.handleCliCommand('launch_cli', {
                            cliType,
                            dir: workspace,
                            cliArgs: cliCmdArgs.length > 0 ? cliCmdArgs : undefined,
                            env: Object.keys(cliCmdEnv).length > 0 ? cliCmdEnv : undefined,
                            settings: { meshCoordinatorFor: meshId },
                        });

                        if (!cliCmdLaunch?.success) {
                            return { success: false, error: cliCmdLaunch?.error || 'Failed to launch CLI session' };
                        }

                        LOG.info('MeshCoordinator', `Launched ${cliType} coordinator (cli_command) for mesh ${meshId}`);
                        try {
                            const { appendLedgerEntry } = await import('../mesh/mesh-ledger.js');
                            appendLedgerEntry(meshId, {
                                kind: 'coordinator_started',
                                sessionId: cliCmdLaunch.sessionId || cliCmdLaunch.id,
                                providerType: cliType,
                                payload: { workspace },
                            });
                        } catch { /* best-effort */ }

                        return {
                            success: true,
                            meshId,
                            cliType,
                            workspace,
                            sessionId: cliCmdLaunch.sessionId || cliCmdLaunch.id,
                            mcpRegistered: true,
                        };
                    }

                    const configFormat = coordinatorSetup.configFormat as MeshCoordinatorConfigFormat;
                    if (configFormat !== 'claude_mcp_json' && configFormat !== 'hermes_config_yaml') {
                        return {
                            success: false,
                            code: 'mesh_coordinator_unsupported',
                            error: `Unsupported auto-import MCP config format: ${String(coordinatorSetup.configFormat)}`,
                            meshId,
                            cliType,
                            workspace,
                        };
                    }

                    // Build the coordinator prompt before mutating workspace config or launching.
                    // Prompt generation failures are configuration/data-shape errors; fail closed so
                    // broken mesh state is visible instead of silently launching with weaker rules.
                    let systemPrompt = '';
                    try {
                        systemPrompt = buildCoordinatorSystemPrompt({ mesh, coordinatorCliType: cliType });
                    } catch (error: any) {
                        const message = error?.message || String(error);
                        LOG.error('MeshCoordinator', `Failed to build coordinator prompt: ${message}`);
                        return {
                            success: false,
                            code: 'mesh_coordinator_prompt_failed',
                            error: `Failed to build Repo Mesh coordinator prompt: ${message}`,
                            meshId,
                            cliType,
                            workspace,
                        };
                    }

                    // 1. Write provider-declared MCP config for CLIs that auto-import it.
                    const { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } = await import('fs');
                    const { dirname } = await import('path');
                    const mcpConfigPath = coordinatorSetup.configPath;
                    const hermesManualFallback = cliType === 'hermes-cli' && configFormat === 'hermes_config_yaml'
                        ? createHermesManualMeshCoordinatorSetup(meshId, workspace)
                        : null;
                    let hermesBaseConfig: { config: Record<string, any>; sourceHome: string; sourceConfigPath: string } | null = null;
                    if (hermesManualFallback) {
                        try {
                            hermesBaseConfig = loadHermesCoordinatorBaseConfig(mcpConfigPath);
                        } catch (error: any) {
                            const message = `Failed to parse Hermes base config for automatic coordinator setup: ${error?.message || error}`;
                            LOG.error('MeshCoordinator', message);
                            return { success: false, code: 'mesh_coordinator_config_parse_failed', error: message, meshId, cliType, workspace };
                        }
                    }
                    const returnManualFallback = (message: string) => ({
                        success: false,
                        code: 'mesh_coordinator_manual_mcp_setup_required',
                        error: message,
                        meshId,
                        cliType,
                        workspace,
                        meshCoordinatorSetup: hermesManualFallback,
                    });

                    // Merge ADHDev mesh server into existing config.
                    // Pass full mesh data as env var so the MCP server can bootstrap
                    // without depending on meshes.json or a running daemon.
                    const mcpServerEntry: Record<string, any> = {
                        command: coordinatorSetup.mcpServer.command,
                        args: coordinatorSetup.mcpServer.args,
                    };
                    if (args?.inlineMesh) {
                        const modeArgIndex = coordinatorSetup.mcpServer.args.findIndex((value: string) => value === '--mode');
                        const mcpTransport = modeArgIndex >= 0 ? coordinatorSetup.mcpServer.args[modeArgIndex + 1] : 'ipc';
                        mcpServerEntry.env = {
                            ADHDEV_INLINE_MESH: JSON.stringify(mesh),
                            ADHDEV_MCP_TRANSPORT: mcpTransport === 'local' ? 'local' : 'ipc',
                        };
                    }

                    try {
                        mkdirSync(dirname(mcpConfigPath), { recursive: true });
                    } catch (error: any) {
                        const message = `Could not prepare MCP config path for automatic setup: ${error?.message || error}`;
                        LOG.error('MeshCoordinator', message);
                        if (hermesManualFallback) return returnManualFallback(message);
                        return { success: false, code: 'mesh_coordinator_config_write_failed', error: message, meshId, cliType, workspace };
                    }

                    // Backup existing MCP config if present.
                    const hadExistingMcpConfig = existsSync(mcpConfigPath);
                    let existingMcpConfig: Record<string, any> = hermesBaseConfig?.config || {};
                    if (hermesBaseConfig) {
                        copyHermesCoordinatorCredentialFiles(hermesBaseConfig.sourceHome, dirname(mcpConfigPath));
                    }
                    if (hadExistingMcpConfig) {
                        try {
                            const parsedExistingMcpConfig = parseMeshCoordinatorMcpConfig(readFileSync(mcpConfigPath, 'utf-8'), configFormat);
                            const existingCoordinatorConfig = hermesManualFallback
                                ? stripHermesCoordinatorTempModelProviderOverrides(parsedExistingMcpConfig)
                                : parsedExistingMcpConfig;
                            existingMcpConfig = { ...existingMcpConfig, ...existingCoordinatorConfig };
                            copyFileSync(mcpConfigPath, mcpConfigPath + '.backup');
                        } catch (error: any) {
                            LOG.error('MeshCoordinator', `Failed to parse existing MCP config ${mcpConfigPath}: ${error?.message || error}`);
                            return {
                                success: false,
                                code: 'mesh_coordinator_config_parse_failed',
                                error: `Failed to parse existing MCP config at ${mcpConfigPath}`,
                            };
                        }
                    }

                    const mcpServersKey = getMcpServersKey(configFormat);
                    const existingServers = existingMcpConfig[mcpServersKey];
                    const mcpConfig = {
                        ...existingMcpConfig,
                        [mcpServersKey]: {
                            ...(existingServers && typeof existingServers === 'object' && !Array.isArray(existingServers) ? existingServers : {}),
                            [coordinatorSetup.serverName]: mcpServerEntry,
                        },
                    };
                    try {
                        writeFileSync(mcpConfigPath, serializeMeshCoordinatorMcpConfig(mcpConfig, configFormat), 'utf-8');
                    } catch (error: any) {
                        const message = `Could not write MCP config for automatic setup: ${error?.message || error}`;
                        LOG.error('MeshCoordinator', message);
                        if (hermesManualFallback) return returnManualFallback(message);
                        return { success: false, code: 'mesh_coordinator_config_write_failed', error: message, meshId, cliType, workspace };
                    }
                    LOG.info('MeshCoordinator', `Wrote ${mcpConfigPath} with ${coordinatorSetup.serverName} server`);

                    const cliArgs: string[] = [];
                    const launchEnv: Record<string, string> = {};
                    if (configFormat === 'hermes_config_yaml') {
                        launchEnv.HERMES_HOME = dirname(mcpConfigPath);
                        launchEnv.HERMES_IGNORE_USER_CONFIG = '';
                    }
                    if (systemPrompt) {
                        if (configFormat === 'hermes_config_yaml') {
                            launchEnv.HERMES_EPHEMERAL_SYSTEM_PROMPT = systemPrompt;
                        } else {
                            cliArgs.push('--append-system-prompt', systemPrompt);
                        }
                    }
                    if (cliType === 'claude-cli') {
                        cliArgs.push('--mcp-config', coordinatorSetup.configPath);
                    }

                    // 3. Launch CLI session via existing cliManager.
                    // Provider-specific prompt injection remains fail-closed: Claude gets
                    // explicit CLI args, while Hermes reads HERMES_EPHEMERAL_SYSTEM_PROMPT.
                    const launchResult: any = await this.deps.cliManager.handleCliCommand('launch_cli', {
                        cliType,
                        dir: workspace,
                        cliArgs: cliArgs.length > 0 ? cliArgs : undefined,
                        env: Object.keys(launchEnv).length > 0 ? launchEnv : undefined,
                        settings: {
                            meshCoordinatorFor: meshId
                        }
                    });

                    if (!launchResult?.success) {
                        return { success: false, error: launchResult?.error || 'Failed to launch CLI session' };
                    }

                    LOG.info('MeshCoordinator', `Launched ${cliType} coordinator for mesh ${meshId} in ${workspace}`);

                    // Record coordinator launch in task ledger
                    try {
                        const { appendLedgerEntry } = await import('../mesh/mesh-ledger.js');
                        appendLedgerEntry(meshId, {
                            kind: 'coordinator_started',
                            sessionId: launchResult.sessionId || launchResult.id,
                            providerType: cliType,
                            payload: { workspace },
                        });
                    } catch { /* ledger append is best-effort */ }

                    return {
                        success: true,
                        meshId,
                        cliType,
                        workspace,
                        sessionId: launchResult.sessionId || launchResult.id,
                        mcpConfigWritten: true,
                    };
                } catch (e: any) {
                    LOG.error('MeshCoordinator', `Failed: ${e.message}`);
                    return { success: false, error: e.message };
                }
            }

            case 'mesh_status': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                if (!meshId) return { success: false, error: 'meshId required' };
                try {
                    const meshRecord = await this.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
                    const mesh = meshRecord?.mesh;
                    if (!mesh) return { success: false, error: 'Mesh not found' };

                    const { getMeshQueueStats, getQueue } = await import('../mesh/mesh-work-queue.js');
                    const queue = getQueue(meshId);
                    const queueSummary = getMeshQueueStats(meshId);

                    const { readLedgerEntries, getLedgerSummary } = await import('../mesh/mesh-ledger.js');
                    const ledgerEntries = readLedgerEntries(meshId, { tail: 20 });
                    const ledgerSummary = getLedgerSummary(meshId);
                    const sessionHostRecords = this.deps.sessionHostControl?.listSessions
                        ? await this.deps.sessionHostControl.listSessions().catch(() => [])
                        : [];
                    const liveMeshSessions = partitionSessionHostRecords(Array.isArray(sessionHostRecords) ? sessionHostRecords : []).liveRuntimes;

                    const localMachineId = loadConfig().machineId || '';
                    const inlineCoordinatorNodeId = meshRecord?.inline && Array.isArray(mesh.nodes)
                        ? readStringValue((mesh.nodes[0] as any)?.id, (mesh.nodes[0] as any)?.nodeId)
                        : undefined;
                    const refreshedAt = new Date().toISOString();
                    const nodeStatuses = [];
                    for (const [nodeIndex, node] of (mesh.nodes || []).entries()) {
                        const nodeId = String(node.id || node.nodeId || '');
                        const daemonId = readStringValue(node.daemonId);
                        const providerPriority = readProviderPriorityFromPolicy(node.policy);
                        const isSelfNode = Boolean(
                            nodeId && inlineCoordinatorNodeId && nodeId === inlineCoordinatorNodeId,
                        ) || Boolean(
                            daemonId && (daemonId === localMachineId || daemonId === this.deps.statusInstanceId),
                        ) || Boolean(meshRecord?.inline && nodeIndex === 0);
                        const status: Record<string, unknown> = {
                            nodeId,
                            machineLabel: node.machineLabel || node.id || node.nodeId,
                            workspace: node.workspace,
                            repoRoot: node.repoRoot,
                            isLocalWorktree: node.isLocalWorktree,
                            worktreeBranch: node.worktreeBranch,
                            daemonId,
                            machineId: node.machineId,
                            machineStatus: node.machineStatus,
                            health: 'unknown',
                            providers: node.providers || [],
                            providerPriority,
                            activeSessions: [],
                            activeSessionDetails: [],
                            launchReady: false,
                        };
                        if (isSelfNode) {
                            status.connection = {
                                perspective: 'selected_coordinator',
                                source: 'mesh_peer_status',
                                state: 'self',
                                transport: 'local',
                                reported: true,
                                reason: 'Selected coordinator daemon',
                                lastStateChangeAt: refreshedAt,
                            };
                        } else if (daemonId) {
                            const connection = this.deps.getMeshPeerConnectionStatus?.(daemonId);
                            status.connection = connection ?? {
                                perspective: 'selected_coordinator',
                                source: 'not_reported',
                                state: 'unknown',
                                transport: 'unknown',
                                reported: false,
                                reason: 'No live mesh peer telemetry reported by the selected coordinator yet.',
                            };
                        } else {
                            status.connection = {
                                perspective: 'selected_coordinator',
                                source: 'not_reported',
                                state: 'unknown',
                                transport: 'unknown',
                                reported: false,
                                reason: 'Node has no daemon id, so mesh transport cannot be reported from the selected coordinator.',
                            };
                        }
                        const matchedLiveSessionRecords = liveMeshSessions
                            .filter((record) => this.sessionMatchesMeshNode(record, node, nodeId));
                        if (matchedLiveSessionRecords.length > 0) {
                            const sessionIds = matchedLiveSessionRecords
                                .map((record: any) => typeof record?.sessionId === 'string' ? record.sessionId : '')
                                .filter(Boolean);
                            const providerTypes = matchedLiveSessionRecords
                                .map((record: any) => readStringValue(record?.providerType))
                                .filter(Boolean) as string[];
                            status.activeSessions = sessionIds;
                            status.activeSessionDetails = matchedLiveSessionRecords.map(summarizeMeshSessionRecord);
                            if (providerTypes.length > 0) {
                                status.providers = Array.from(new Set([...(Array.isArray(status.providers) ? status.providers as string[] : []), ...providerTypes]));
                            }
                        }
                        if (node.workspace && typeof node.workspace === 'string') {
                            if (!fs.existsSync(node.workspace as string) && applyCachedInlineMeshNodeStatus(status, node)) {
                                status.launchReady = !!daemonId && (readStringValue(status.machineStatus) === 'online' || isSelfNode);
                                nodeStatuses.push(status);
                                continue;
                            }
                            try {
                                const gitStatus = await getGitRepoStatus(node.workspace as string, { timeoutMs: 10_000, refreshUpstream: true });
                                status.git = gitStatus;
                                if (gitStatus.isGitRepo) {
                                    status.health = deriveMeshNodeHealthFromGit(gitStatus as unknown as Record<string, unknown>);
                                } else {
                                    status.health = 'degraded';
                                    if (gitStatus.error && !status.error) status.error = gitStatus.error;
                                }
                            } catch {
                                if (!applyCachedInlineMeshNodeStatus(status, node)) {
                                    status.health = 'degraded';
                                }
                            }
                        } else {
                            applyCachedInlineMeshNodeStatus(status, node);
                        }
                        status.launchReady = !!daemonId && (readStringValue(status.machineStatus) === 'online' || isSelfNode);
                        nodeStatuses.push(status);
                    }

                    return {
                        success: true,
                        meshId: mesh.id,
                        meshName: mesh.name,
                        repoIdentity: mesh.repoIdentity,
                        defaultBranch: mesh.defaultBranch,
                        refreshedAt: new Date().toISOString(),
                        nodes: nodeStatuses,
                        queue: { tasks: queue, summary: queueSummary },
                        ledger: { entries: ledgerEntries, summary: ledgerSummary },
                    };
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
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
            if (this.deps.instanceManager.getInstance(instanceKey)) {
                this.deps.instanceManager.removeInstance(instanceKey);
                LOG.info('StopIDE', `Instance removed: ${instanceKey}`);
            }
        }
        // Fallback: single instance key
        if (keysToRemove.length === 0) {
            const instanceKey = `ide:${ideType}`;
            if (this.deps.instanceManager.getInstance(instanceKey)) {
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
