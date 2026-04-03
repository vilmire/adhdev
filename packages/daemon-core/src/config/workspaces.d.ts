/**
 * Saved workspaces — shared by IDE launch, CLI, ACP (daemon-local).
 */
import type { ADHDevConfig } from './config.js';
export interface WorkspaceEntry {
    id: string;
    path: string;
    label?: string;
    addedAt: number;
}
export declare function expandPath(p: string): string;
export declare function validateWorkspacePath(absPath: string): {
    ok: true;
} | {
    ok: false;
    error: string;
};
/** Default workspace label from path */
export declare function defaultWorkspaceLabel(absPath: string): string;
/**
 * Ensure config.workspaces exists; seed from recentCliWorkspaces once (same paths).
 */
export declare function migrateWorkspacesFromRecent(config: ADHDevConfig): ADHDevConfig;
export declare function getDefaultWorkspacePath(config: ADHDevConfig): string | null;
export declare function getWorkspaceState(config: ADHDevConfig): {
    workspaces: WorkspaceEntry[];
    defaultWorkspaceId: string | null;
    defaultWorkspacePath: string | null;
};
export type LaunchDirectorySource = 'dir' | 'workspaceId' | 'defaultWorkspace' | 'home';
export type ResolveLaunchDirectoryResult = {
    ok: true;
    path: string;
    source: LaunchDirectorySource;
} | {
    ok: false;
    code: 'WORKSPACE_LAUNCH_CONTEXT_REQUIRED';
    message: string;
};
/**
 * Resolve cwd for CLI/ACP. No implicit default workspace or home — caller must pass
 * useDefaultWorkspace or useHome (or an explicit dir / workspaceId).
 */
export declare function resolveLaunchDirectory(args: {
    dir?: string;
    workspaceId?: string;
    useDefaultWorkspace?: boolean;
    useHome?: boolean;
} | undefined, config: ADHDevConfig): ResolveLaunchDirectoryResult;
/**
 * IDE folder from explicit args only (`workspace`, `workspaceId`, or `useDefaultWorkspace: true`).
 */
export declare function resolveIdeWorkspaceFromArgs(args: {
    workspace?: string;
    workspaceId?: string;
    useDefaultWorkspace?: boolean;
} | undefined, config: ADHDevConfig): string | undefined;
/**
 * IDE launch folder — same saved workspaces + default as CLI/ACP.
 * After explicit `workspace` / `workspaceId` / `useDefaultWorkspace: true`, falls back to
 * config default workspace when set. Pass `useDefaultWorkspace: false` to open IDE without that folder.
 */
export declare function resolveIdeLaunchWorkspace(args: {
    workspace?: string;
    workspaceId?: string;
    useDefaultWorkspace?: boolean;
} | undefined, config: ADHDevConfig): string | undefined;
export declare function findWorkspaceByPath(config: ADHDevConfig, rawPath: string): WorkspaceEntry | undefined;
export declare function addWorkspaceEntry(config: ADHDevConfig, rawPath: string, label?: string, options?: {
    createIfMissing?: boolean;
}): {
    config: ADHDevConfig;
    entry: WorkspaceEntry;
} | {
    error: string;
};
export declare function removeWorkspaceEntry(config: ADHDevConfig, id: string): {
    config: ADHDevConfig;
} | {
    error: string;
};
export declare function setDefaultWorkspaceId(config: ADHDevConfig, id: string | null): {
    config: ADHDevConfig;
} | {
    error: string;
};
