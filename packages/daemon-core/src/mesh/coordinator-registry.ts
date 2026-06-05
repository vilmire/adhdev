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
    const entry = _registry.get(sessionId);
    if (!_registry.delete(sessionId)) return;
    saveRegistry();
    if (!entry) return;
    const workspace = entry.workspace;
    const target = entry.injection?.mode === 'context_file' && typeof entry.injection.target === 'string'
        ? entry.injection.target
        : '';
    if (!workspace || !target) return;
    // injection.target is workspace-relative (AGENTS.md / GEMINI.md); we don't
    // resolve absolute paths here because we never wrote one — applyMesh-
    // CoordinatorSystemPromptInjection joins via path.join(workspace, …).
    const filePath = `${workspace.replace(/\/$/, '')}/${target}`;
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { stripCoordinatorWrapperFile } = require('../commands/mesh-coordinator.js');
        stripCoordinatorWrapperFile(filePath);
    } catch { /* best-effort cleanup; never throw out of unregister */ }
}

/** Look up a coordinator entry by session ID. Returns undefined if not registered. */
export function getCoordinatorForSession(sessionId: string): CoordinatorRegistryEntry | undefined {
    return _registry.get(sessionId);
}

/** List all coordinator entries for a given workspace path. */
export function listCoordinatorsForWorkspace(workspace: string): CoordinatorRegistryEntry[] {
    return [..._registry.values()].filter(e => e.workspace === workspace);
}
