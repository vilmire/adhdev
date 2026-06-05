/**
 * MeshCoordinatorRegistry — Persisted record of active mesh coordinator sessions.
 *
 * Survives daemon restarts: when a CLI coordinator session is re-attached after
 * a daemon restart the in-memory `settings.meshCoordinatorFor` on the provider
 * instance is gone, so the registry file fills the gap.
 *
 * Keyed by sessionId (the CLI instance key / runtimeKey).
 */

import { join } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { getDaemonDataDir } from '../config/config.js';

export interface CoordinatorRegistryEntry {
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
    injection?: { mode: string; target?: string };
    /** Path of the MCP config file the daemon wrote for this session. */
    mcpConfigPath?: string;
}

const _registry = new Map<string, CoordinatorRegistryEntry>();

function getRegistryPath(): string {
    return join(getDaemonDataDir(), 'mesh-coordinators.json');
}

/** Load persisted coordinator registry from disk into in-memory map. Called once on daemon boot. */
export function loadMeshCoordinatorRegistry(): void {
    const path = getRegistryPath();
    if (!existsSync(path)) return;
    try {
        const raw = JSON.parse(readFileSync(path, 'utf-8'));
        if (!Array.isArray(raw)) return;
        _registry.clear();
        for (const entry of raw) {
            if (typeof entry?.sessionId === 'string' && typeof entry?.meshId === 'string') {
                _registry.set(entry.sessionId, entry as CoordinatorRegistryEntry);
            }
        }
    } catch { /* ignore corrupt file */ }
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

/** Register a coordinator session. Persists to disk immediately. */
export function registerMeshCoordinator(entry: CoordinatorRegistryEntry): void {
    _registry.set(entry.sessionId, entry);
    saveRegistry();
}

/** Remove a coordinator session by sessionId. Persists to disk. */
export function unregisterMeshCoordinator(sessionId: string): void {
    if (_registry.delete(sessionId)) {
        saveRegistry();
    }
}

/** Look up a coordinator entry by session ID. Returns undefined if not registered. */
export function getCoordinatorForSession(sessionId: string): CoordinatorRegistryEntry | undefined {
    return _registry.get(sessionId);
}

/** List all coordinator entries for a given workspace path. */
export function listCoordinatorsForWorkspace(workspace: string): CoordinatorRegistryEntry[] {
    return [..._registry.values()].filter(e => e.workspace === workspace);
}
