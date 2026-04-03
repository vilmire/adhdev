/**
 * Saved workspaces — shared by IDE launch, CLI, ACP (daemon-local).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { ADHDevConfig } from './config.js';

export interface WorkspaceEntry {
    id: string;
    path: string;
    label?: string;
    addedAt: number;
}

const MAX_WORKSPACES = 50;

export function expandPath(p: string): string {
    const t = (p || '').trim();
    if (!t) return '';
    if (t.startsWith('~')) return path.join(os.homedir(), t.slice(1).replace(/^\//, ''));
    return path.resolve(t);
}

export function validateWorkspacePath(absPath: string): { ok: true } | { ok: false; error: string } {
    try {
        if (!absPath) return { ok: false, error: 'Path required' };
        if (!fs.existsSync(absPath)) return { ok: false, error: 'Path does not exist' };
        const st = fs.statSync(absPath);
        if (!st.isDirectory()) return { ok: false, error: 'Not a directory' };
        return { ok: true };
    } catch (e: any) {
        return { ok: false, error: e?.message || 'Invalid path' };
    }
}

/** Default workspace label from path */
export function defaultWorkspaceLabel(absPath: string): string {
    const base = path.basename(absPath) || absPath;
    return base;
}

export function getDefaultWorkspacePath(config: ADHDevConfig): string | null {
    const id = config.defaultWorkspaceId;
    if (!id) return null;
    const w = (config.workspaces || []).find(x => x.id === id);
    if (!w) return null;
    const abs = expandPath(w.path);
    if (validateWorkspacePath(abs).ok !== true) return null;
    return abs;
}

export function getWorkspaceState(config: ADHDevConfig): {
    workspaces: WorkspaceEntry[];
    defaultWorkspaceId: string | null;
    defaultWorkspacePath: string | null;
} {
    const workspaces = [...(config.workspaces || [])].sort((a, b) => b.addedAt - a.addedAt);
    const defaultWorkspacePath = getDefaultWorkspacePath(config);
    return {
        workspaces,
        defaultWorkspaceId: config.defaultWorkspaceId ?? null,
        defaultWorkspacePath,
    };
}

export type LaunchDirectorySource = 'dir' | 'workspaceId' | 'defaultWorkspace' | 'home';

export type ResolveLaunchDirectoryResult =
    | { ok: true; path: string; source: LaunchDirectorySource }
    | { ok: false; code: 'WORKSPACE_LAUNCH_CONTEXT_REQUIRED'; message: string };

/**
 * Resolve cwd for CLI/ACP. No implicit default workspace or home — caller must pass
 * useDefaultWorkspace or useHome (or an explicit dir / workspaceId).
 */
export function resolveLaunchDirectory(
    args: {
        dir?: string;
        workspaceId?: string;
        useDefaultWorkspace?: boolean;
        useHome?: boolean;
    } | undefined,
    config: ADHDevConfig,
): ResolveLaunchDirectoryResult {
    const a = args || {};
    if (a.dir != null && String(a.dir).trim()) {
        const abs = expandPath(String(a.dir).trim());
        if (abs && validateWorkspacePath(abs).ok === true) {
            return { ok: true, path: abs, source: 'dir' };
        }
        return {
            ok: false,
            code: 'WORKSPACE_LAUNCH_CONTEXT_REQUIRED',
            message: abs ? 'Directory path is not valid or does not exist' : 'Invalid directory path',
        };
    }
    if (a.workspaceId) {
        const w = (config.workspaces || []).find(x => x.id === a.workspaceId);
        if (w) {
            const abs = expandPath(w.path);
            if (validateWorkspacePath(abs).ok === true) {
                return { ok: true, path: abs, source: 'workspaceId' };
            }
        }
        return {
            ok: false,
            code: 'WORKSPACE_LAUNCH_CONTEXT_REQUIRED',
            message: 'Saved workspace not found or path is no longer valid',
        };
    }
    if (a.useDefaultWorkspace === true) {
        const d = getDefaultWorkspacePath(config);
        if (d) return { ok: true, path: d, source: 'defaultWorkspace' };
        return {
            ok: false,
            code: 'WORKSPACE_LAUNCH_CONTEXT_REQUIRED',
            message: 'No default workspace is set',
        };
    }
    if (a.useHome === true) {
        return { ok: true, path: os.homedir(), source: 'home' };
    }
    return {
        ok: false,
        code: 'WORKSPACE_LAUNCH_CONTEXT_REQUIRED',
        message: 'Choose a directory, saved workspace, default workspace, or home before launching.',
    };
}

/**
 * IDE folder from explicit args only (`workspace`, `workspaceId`, or `useDefaultWorkspace: true`).
 */
export function resolveIdeWorkspaceFromArgs(
    args: {
        workspace?: string;
        workspaceId?: string;
        useDefaultWorkspace?: boolean;
    } | undefined,
    config: ADHDevConfig,
): string | undefined {
    const ar = args || {};
    if (ar.workspace) {
        const abs = expandPath(ar.workspace);
        if (abs && validateWorkspacePath(abs).ok === true) return abs;
    }
    if (ar.workspaceId) {
        const w = (config.workspaces || []).find(x => x.id === ar.workspaceId);
        if (w) {
            const abs = expandPath(w.path);
            if (validateWorkspacePath(abs).ok === true) return abs;
        }
    }
    if (ar.useDefaultWorkspace === true) {
        return getDefaultWorkspacePath(config) || undefined;
    }
    return undefined;
}

/**
 * IDE launch folder — same saved workspaces + default as CLI/ACP.
 * After explicit `workspace` / `workspaceId` / `useDefaultWorkspace: true`, falls back to
 * config default workspace when set. Pass `useDefaultWorkspace: false` to open IDE without that folder.
 */
export function resolveIdeLaunchWorkspace(
    args: {
        workspace?: string;
        workspaceId?: string;
        useDefaultWorkspace?: boolean;
    } | undefined,
    config: ADHDevConfig,
): string | undefined {
    const direct = resolveIdeWorkspaceFromArgs(args, config);
    if (direct) return direct;
    if (args?.useDefaultWorkspace === false) return undefined;
    return getDefaultWorkspacePath(config) || undefined;
}

export function findWorkspaceByPath(config: ADHDevConfig, rawPath: string): WorkspaceEntry | undefined {
    const abs = path.resolve(expandPath(rawPath));
    if (!abs) return undefined;
    return (config.workspaces || []).find(w => path.resolve(expandPath(w.path)) === abs);
}

export function addWorkspaceEntry(
    config: ADHDevConfig,
    rawPath: string,
    label?: string,
    options?: { createIfMissing?: boolean },
): { config: ADHDevConfig; entry: WorkspaceEntry } | { error: string } {
    const abs = expandPath(rawPath);
    const createIfMissing = options?.createIfMissing === true;
    if (!abs) return { error: 'Path required' };
    if (!fs.existsSync(abs) && createIfMissing) {
        try {
            fs.mkdirSync(abs, { recursive: true });
        } catch (e: any) {
            return { error: e?.message || 'Could not create directory' };
        }
    }
    const v = validateWorkspacePath(abs);
    if (!v.ok) return { error: v.error };

    const list = [...(config.workspaces || [])];
    if (list.some(w => path.resolve(w.path) === abs)) {
        return { error: 'Workspace already in list' };
    }
    if (list.length >= MAX_WORKSPACES) {
        return { error: `Maximum ${MAX_WORKSPACES} workspaces` };
    }
    const entry: WorkspaceEntry = {
        id: randomUUID(),
        path: abs,
        label: (label || '').trim() || defaultWorkspaceLabel(abs),
        addedAt: Date.now(),
    };
    list.push(entry);
    return { config: { ...config, workspaces: list }, entry };
}

export function removeWorkspaceEntry(config: ADHDevConfig, id: string): { config: ADHDevConfig } | { error: string } {
    const list = (config.workspaces || []).filter(w => w.id !== id);
    if (list.length === (config.workspaces || []).length) return { error: 'Workspace not found' };
    let defaultWorkspaceId = config.defaultWorkspaceId;
    if (defaultWorkspaceId === id) defaultWorkspaceId = null;
    return { config: { ...config, workspaces: list, defaultWorkspaceId } };
}

export function setDefaultWorkspaceId(config: ADHDevConfig, id: string | null): { config: ADHDevConfig } | { error: string } {
    if (id === null) {
        return { config: { ...config, defaultWorkspaceId: null } };
    }
    const w = (config.workspaces || []).find(x => x.id === id);
    if (!w) return { error: 'Workspace not found' };
    const abs = expandPath(w.path);
    if (validateWorkspacePath(abs).ok !== true) return { error: 'Workspace path is no longer valid' };
    return { config: { ...config, defaultWorkspaceId: id } };
}
