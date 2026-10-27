import { hasTerminalBindingEvidence, resolveHostedBindingOwner, sameHostedBindingOwner, type HostedBindingOwner } from '../session-host/binding-owner.js';
/**
 * MeshCoordinatorRegistry — Persisted record of active mesh coordinator sessions.
 *
 * Survives daemon restarts: when a CLI coordinator session is re-attached after
 * a daemon restart the in-memory `settings.meshCoordinatorFor` on the provider
 * instance is gone, so the registry file fills the gap.
 *
 * Keyed by sessionId (the CLI instance key / runtimeKey).
 */

import { join, resolve } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { getDaemonDataDir } from '../config/config.js';
import {
    getRecordedWrapperSeparators,
    markAntigravityCoordinatorRegistered,
    recordContextFileWrapperSeparators,
    repointAntigravityContextFileOnCoordinatorExit,
    stripCoordinatorWrapperFile,
    type RecordedWrapperSeparators,
    type SurvivingCoordinatorDescriptor,
} from '../commands/antigravity-coordinator-rules.js';
import type { SessionLifecycleBus, Unsubscribe } from '../sessions/lifecycle-bus.js';
import { ensureMcpSessionCredential, revokeMcpSessionCredential } from '../commands/mcp-command-ingress.js';

export interface CoordinatorRegistryEntry {
    hostOwner?: HostedBindingOwner;
    meshId: string;
    sessionId: string;
    workspace?: string;
    startedAt: number;
    /** CLI type used to launch the coordinator (claude-cli / codex-cli / …). */
    cliType?: string;
    /** Final system prompt sent to the coordinator after all overrides, appends,
     *  and extraSystemPrompt have been applied. Surfaced via the session-info
     *  endpoint so users can audit exactly what prompt the agent saw. */
    systemPrompt?: string;
    /** Per-launch extraSystemPrompt the caller passed in, if any. Stored
     *  separately from `systemPrompt` so the UI can show what the user
     *  added vs. what the daemon's default template produced. */
    extraSystemPrompt?: string;
    /** How the prompt was actually injected (cli_arg / context_file / …). */
    injection?: {
        mode: string;
        target?: string;
        owned?: boolean;
        /** The context file the launch actually wrote (declared rule OR its oversize
         *  fallback), the ownership the writer settled on, and the provider's wrapper
         *  sentinels. Preferred over mode/target/owned by the unregister fallback. */
        contextFile?: {
            path: string;
            owned: boolean;
            open?: string;
            close?: string;
            additionalOwnedFiles?: string[];
            retainForSessionLifetime?: boolean;
            homeDir?: string;
            separators?: RecordedWrapperSeparators;
        };
    };
    /** Path of the MCP config file the daemon wrote for this session. */
    mcpConfigPath?: string;
}

const COORD_REGISTRY_KEY = Symbol.for('adhdev.daemon-core.meshCoordinatorRegistry');
const sharedCoordRegistry = globalThis as Record<
    symbol,
    {
        registry: Map<string, CoordinatorRegistryEntry>;
        pendingFailedCleanupBySessionId: Map<string, CoordinatorRegistryEntry>;
    } | undefined
>;
if (!sharedCoordRegistry[COORD_REGISTRY_KEY]) {
    Object.defineProperty(sharedCoordRegistry, COORD_REGISTRY_KEY, {
        value: {
            registry: new Map<string, CoordinatorRegistryEntry>(),
            pendingFailedCleanupBySessionId: new Map<string, CoordinatorRegistryEntry>(),
        },
        enumerable: false,
        configurable: false,
        writable: false,
    });
}
const _registry = sharedCoordRegistry[COORD_REGISTRY_KEY]!.registry;
const _pendingFailedCleanupBySessionId =
    sharedCoordRegistry[COORD_REGISTRY_KEY]!.pendingFailedCleanupBySessionId;

function getRegistryPath(): string {
    return join(getDaemonDataDir(), 'mesh-coordinators.json');
}

function isValidRecordedSeparators(sep: unknown): sep is RecordedWrapperSeparators {
    return Boolean(
        sep
        && typeof sep === 'object'
        && typeof (sep as RecordedWrapperSeparators).leading === 'string'
        && typeof (sep as RecordedWrapperSeparators).trailing === 'string'
        && typeof (sep as RecordedWrapperSeparators).createdFile === 'boolean',
    );
}

/** Load the persisted registry. Restore uses strict reads to reject uncertainty and stale cached bindings. */
export function loadMeshCoordinatorRegistry(options: { strict?: boolean } = {}): void {
    const path = getRegistryPath();
    if (!options.strict && !existsSync(path)) return;
    try {
        const raw = JSON.parse(readFileSync(path, 'utf-8'));
        if (!Array.isArray(raw) || (options.strict && raw.some(entry =>
            typeof entry?.sessionId !== 'string' || !entry.sessionId || typeof entry?.meshId !== 'string' || !entry.meshId))) {
            if (options.strict) throw new Error('invalid coordinator registry');
            return;
        }
        _registry.clear();
        for (const entry of raw) {
            if (typeof entry?.sessionId === 'string' && typeof entry?.meshId === 'string') {
                const typedEntry = entry as CoordinatorRegistryEntry;
                _registry.set(typedEntry.sessionId, typedEntry);
                ensureMcpSessionCredential({
                    sessionId: typedEntry.sessionId,
                    meshId: typedEntry.meshId,
                    isCoordinator: true,
                });
                const targetPath = resolveEntryContextFilePath(typedEntry);
                const sep = typedEntry.injection?.contextFile?.separators;
                if (targetPath && isValidRecordedSeparators(sep)) {
                    recordContextFileWrapperSeparators(
                        targetPath,
                        sep.leading,
                        sep.trailing,
                        sep.createdFile,
                    );
                }
            }
        }
    } catch (error) {
        if (options.strict && (error as NodeJS.ErrnoException).code === 'ENOENT') {
            _registry.clear();
            return;
        }
        if (options.strict) throw Object.assign(new Error('coordinator_identity_conflict: coordinator registry unavailable or invalid'),
            { code: 'coordinator_identity_conflict' });
    }
}

function saveRegistry(): void {
    try {
        writeFileSync(
            getRegistryPath(),
            JSON.stringify([..._registry.values()], null, 2),
            { encoding: 'utf-8', mode: 0o600 },
        );
    } catch { /* best-effort */ }
}

function resolveEntryContextFilePath(entry: CoordinatorRegistryEntry): string {
    const recordedPath = entry.injection?.contextFile?.path;
    if (typeof recordedPath === 'string' && recordedPath) return recordedPath;
    const workspace = entry.workspace;
    const target = entry.injection?.mode === 'context_file' && typeof entry.injection.target === 'string'
        ? entry.injection.target
        : '';
    if (!workspace || !target) return '';
    return `${workspace.replace(/\/$/, '')}/${target}`;
}

/** Register a coordinator session. Persists to disk immediately. */
export function registerMeshCoordinator(entry: CoordinatorRegistryEntry): void {
    _pendingFailedCleanupBySessionId.delete(entry.sessionId);
    const targetPath = resolveEntryContextFilePath(entry);
    if (targetPath) {
        const existingSep = entry.injection?.contextFile?.separators;
        if (isValidRecordedSeparators(existingSep)) {
            recordContextFileWrapperSeparators(
                targetPath,
                existingSep.leading,
                existingSep.trailing,
                existingSep.createdFile,
            );
        } else {
            const inMemorySep = getRecordedWrapperSeparators(targetPath);
            if (inMemorySep && entry.injection?.contextFile) {
                entry.injection.contextFile.separators = inMemorySep;
            }
        }
    }
    _registry.set(entry.sessionId, entry);
    ensureMcpSessionCredential({
        sessionId: entry.sessionId,
        meshId: entry.meshId,
        isCoordinator: true,
    });
    saveRegistry();
    if (targetPath && entry.workspace) {
        markAntigravityCoordinatorRegistered({
            sessionId: entry.sessionId,
            workspace: entry.workspace,
            systemPrompt: entry.systemPrompt,
            targetPath,
            additionalOwnedFiles: entry.injection?.contextFile?.additionalOwnedFiles,
        });
    }
}

export function findLiveCoordinatorsForContextFile(targetPath: string): CoordinatorRegistryEntry[] {
    if (!targetPath) return [];
    const normalizedTarget = resolve(targetPath);
    const matches: CoordinatorRegistryEntry[] = [];
    for (const remaining of _registry.values()) {
        const remainingPath = resolveEntryContextFilePath(remaining);
        if (remainingPath && resolve(remainingPath) === normalizedTarget) {
            matches.push(remaining);
        }
    }
    return matches;
}

function toSurvivorDescriptor(entry: CoordinatorRegistryEntry, targetPath: string): SurvivingCoordinatorDescriptor {
    const recorded = entry.injection?.contextFile;
    return {
        sessionId: entry.sessionId,
        workspace: entry.workspace ?? '',
        cliType: entry.cliType,
        systemPrompt: entry.systemPrompt,
        targetPath,
        openSentinel: recorded?.open,
        closeSentinel: recorded?.close,
        owned: recorded?.owned ?? entry.injection?.owned,
        additionalOwnedFiles: recorded?.additionalOwnedFiles,
        homeDir: recorded?.homeDir,
        separators: isValidRecordedSeparators(recorded?.separators) ? recorded.separators : undefined,
    };
}

function cleanupCoordinatorEntryContextFile(entry: CoordinatorRegistryEntry): boolean {
    const targetPath = resolveEntryContextFilePath(entry);
    if (!targetPath) return true;
    const recorded = entry.injection?.contextFile;
    const recordedSeparators = isValidRecordedSeparators(recorded?.separators)
        ? recorded.separators
        : undefined;
    if (recordedSeparators && !getRecordedWrapperSeparators(targetPath)) {
        recordContextFileWrapperSeparators(
            targetPath,
            recordedSeparators.leading,
            recordedSeparators.trailing,
            recordedSeparators.createdFile,
        );
    }
    const liveCoordinators = findLiveCoordinatorsForContextFile(targetPath);
    const survivingDescriptors = liveCoordinators.map((c) => toSurvivorDescriptor(c, resolveEntryContextFilePath(c) || targetPath));
    try {
        const repointResult = repointAntigravityContextFileOnCoordinatorExit(
            toSurvivorDescriptor(entry, targetPath),
            survivingDescriptors,
        );
        if (repointResult) {
            return repointResult === 'repointed';
        }
    } catch { /* best-effort */ }
    if (recorded && typeof recorded.path === 'string' && recorded.path) {
        try {
            return stripCoordinatorWrapperFile(
                recorded.path,
                recorded.owned === true,
                typeof recorded.open === 'string' ? { open: recorded.open, close: typeof recorded.close === 'string' ? recorded.close : '' } : undefined,
                Array.isArray(recorded.additionalOwnedFiles) ? recorded.additionalOwnedFiles : undefined,
                recordedSeparators,
            );
        } catch {
            return false;
        }
    }
    const owned = entry.injection?.owned === true;
    try {
        return stripCoordinatorWrapperFile(targetPath, owned, undefined, undefined, recordedSeparators);
    } catch {
        return false;
    }
}

/** Remove a coordinator session by sessionId. Persists to disk.
 *
 * Also best-effort strips any context_file wrapper block we wrote into
 * the workspace at launch time (AGENTS.md / GEMINI.md), because those
 * files are auto-loaded by their CLIs on every subsequent launch — and
 * a wrapper block surviving the coordinator session would silently
 * inject the coordinator system prompt into ordinary non-coordinator
 * sessions in the same workspace, which is exactly the bug we're
 * fixing here.
 *
 * Stripping rules:
 *   - Look for the start sentinel anywhere in the file; if absent,
 *     leave the file alone (user-authored content).
 *   - If the wrapper block was the only thing in the file, delete the
 *     file outright so we don't leave behind an empty AGENTS.md.
 *   - Otherwise drop only the block between the sentinels and trim a
 *     leading/trailing blank line so we don't leave dangling separators.
 */
export function unregisterMeshCoordinator(sessionId: string): void {
    revokeMcpSessionCredential(sessionId);
    const entry = _registry.get(sessionId);
    if (_registry.delete(sessionId)) {
        saveRegistry();
        if (!entry) return;
        if (!cleanupCoordinatorEntryContextFile(entry)) {
            _pendingFailedCleanupBySessionId.set(sessionId, entry);
        } else {
            _pendingFailedCleanupBySessionId.delete(sessionId);
        }
        return;
    }
    const pendingEntry = _pendingFailedCleanupBySessionId.get(sessionId);
    if (pendingEntry) {
        if (cleanupCoordinatorEntryContextFile(pendingEntry)) {
            _pendingFailedCleanupBySessionId.delete(sessionId);
        }
    }
}

/**
 * Drop a coordinator's entry when its session terminates (wiring-unification
 * B4). The registry is PERSISTED so a coordinator re-attaches after a daemon
 * restart — which is exactly why `daemon_shutdown` must never unregister: a
 * session torn down because the daemon is going away is not a dead coordinator.
 * Entries left by a previous daemon generation are pruned after restore instead
 * (`pruneDeadMeshCoordinators`).
 */
export function subscribeCoordinatorRegistryRemoval(bus: SessionLifecycleBus): Unsubscribe {
    return bus.on('terminated', (event) => {
        if (event.cause === 'daemon_shutdown') return;
        unregisterMeshCoordinator(event.sessionId);
    }, { name: 'mesh.coordinator-registry' });
}

/** Look up a coordinator entry by session ID. Returns undefined if not registered. */
export function getCoordinatorForSession(sessionId: string): CoordinatorRegistryEntry | undefined {
    return _registry.get(sessionId);
}

/**
 * Prune registry entries whose coordinator session is NOT among the live
 * hosted runtimes the session-host reported after a daemon restart.
 *
 * unregisterMeshCoordinator only runs on explicit stop/exit paths (auto-clean,
 * stopSessionWithMode, orphan force-remove) — a daemon upgrade/restart takes
 * none of them, so dead coordinator entries accumulate in
 * mesh-coordinators.json across boot generations. Prune them only against a
 * complete verified census from the owning host.
 *
 * Callers MUST pass the FULL live-runtime id set (the boot-time restore
 * batch), and its verified host owner — never a partial/ad-hoc restore list.
 * Foreign or unknown ownership defers pruning. Entries whose sessionId
 * appears in liveSessionIds are never removed; persisting happens once, only
 * when something was actually pruned. Returns the pruned entries so the
 * caller can audit-log what was removed and why.
 */
export function pruneDeadMeshCoordinators(liveSessionIds: ReadonlySet<string>, owner?: HostedBindingOwner): CoordinatorRegistryEntry[] {
    // Refresh before any destructive write; other host instances share this file.
    loadMeshCoordinatorRegistry();
    const pruned: CoordinatorRegistryEntry[] = [];
    let migrated = false;
    for (const entry of [..._registry.values()]) {
        if (!sameHostedBindingOwner(resolveHostedBindingOwner(entry.sessionId, entry.hostOwner, owner, liveSessionIds), owner)) continue;
        if (!entry.hostOwner) { entry.hostOwner = owner; migrated = true; }
        if (liveSessionIds.has(entry.sessionId)) continue;
        _registry.delete(entry.sessionId);
        revokeMcpSessionCredential(entry.sessionId);
        pruned.push(entry);
    }
    if (pruned.length > 0 || migrated) {
        saveRegistry();
        for (const entry of pruned) {
            if (!cleanupCoordinatorEntryContextFile(entry)) {
                _pendingFailedCleanupBySessionId.set(entry.sessionId, entry);
            } else {
                _pendingFailedCleanupBySessionId.delete(entry.sessionId);
            }
        }
    }
    for (const [pendingSessionId, pendingEntry] of [..._pendingFailedCleanupBySessionId.entries()]) {
        if (!sameHostedBindingOwner(pendingEntry.hostOwner, owner) || liveSessionIds.has(pendingSessionId)) continue;
        if (pruned.some((p) => p.sessionId === pendingSessionId)) continue;
        if (cleanupCoordinatorEntryContextFile(pendingEntry)) {
            _pendingFailedCleanupBySessionId.delete(pendingSessionId);
        }
    }
    return pruned;
}

/** List all coordinator entries for a given workspace path. */
export function listCoordinatorsForWorkspace(workspace: string): CoordinatorRegistryEntry[] {
    return [..._registry.values()].filter(e => e.workspace === workspace && !hasTerminalBindingEvidence(e.sessionId));
}

/** Coordinator entries for a mesh, newest started first — the inverse join a
 *  WORKER session needs to answer "who spawned me?" (get_session_info's
 *  meshWorker block). Newest-first because a mesh occasionally carries a
 *  stale entry from a coordinator that died without unregistering; the most
 *  recently started one is the live owner. */
export function listCoordinatorsForMesh(meshId: string): CoordinatorRegistryEntry[] {
    return [..._registry.values()]
        .filter(e => e.meshId === meshId && !hasTerminalBindingEvidence(e.sessionId))
        .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}
