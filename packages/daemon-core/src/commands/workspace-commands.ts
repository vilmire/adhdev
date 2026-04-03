/**
 * workspace_* commands — list/add/remove/default (config.json)
 */

import { loadConfig, saveConfig } from '../config/config.js';
import * as W from '../config/workspaces.js';

export type WorkspaceCommandResult = { success: boolean;[key: string]: unknown };

export function handleWorkspaceList(): WorkspaceCommandResult {
    const config = loadConfig();
    const state = W.getWorkspaceState(config);
    return {
        success: true,
        workspaces: state.workspaces,
        defaultWorkspaceId: state.defaultWorkspaceId,
        defaultWorkspacePath: state.defaultWorkspacePath,
    };
}

export function handleWorkspaceAdd(args: any): WorkspaceCommandResult {
    const rawPath = (args?.path || args?.dir || '').trim();
    const label = (args?.label || '').trim() || undefined;
    const createIfMissing = args?.createIfMissing === true;
    if (!rawPath) return { success: false, error: 'path required' };

    const config = loadConfig();
    const result = W.addWorkspaceEntry(config, rawPath, label, { createIfMissing });
    if ('error' in result) return { success: false, error: result.error };

    saveConfig(result.config);
    const state = W.getWorkspaceState(result.config);
    return { success: true, entry: result.entry, ...state };
}

export function handleWorkspaceRemove(args: any): WorkspaceCommandResult {
    const id = (args?.id || '').trim();
    if (!id) return { success: false, error: 'id required' };

    const config = loadConfig();
    const removed = (config.workspaces || []).find(w => w.id === id);
    const result = W.removeWorkspaceEntry(config, id);
    if ('error' in result) return { success: false, error: result.error };

    saveConfig(result.config);
    const state = W.getWorkspaceState(result.config);
    return { success: true, removedId: id, ...state };
}

export function handleWorkspaceSetDefault(args: any): WorkspaceCommandResult {
    const clear = args?.clear === true || args?.id === null || args?.id === '';
    if (clear) {
        const config = loadConfig();
        const result = W.setDefaultWorkspaceId(config, null);
        if ('error' in result) return { success: false, error: result.error };
        saveConfig(result.config);
        const state = W.getWorkspaceState(result.config);
        return {
            success: true,
            ...state,
        };
    }

    const pathArg = (args?.path != null && String(args.path).trim()) ? String(args.path).trim() : '';
    const idArg = args?.id !== undefined && args?.id !== null && String(args.id).trim()
        ? String(args.id).trim()
        : '';

    if (!pathArg && !idArg) {
        return { success: false, error: 'id or path required (or clear: true)' };
    }

    let config = loadConfig();
    let nextId: string;

    if (pathArg) {
        let w = W.findWorkspaceByPath(config, pathArg);
        if (!w) {
            const add = W.addWorkspaceEntry(config, pathArg);
            if ('error' in add) return { success: false, error: add.error };
            config = add.config;
            w = add.entry;
        }
        nextId = w.id;
    } else {
        nextId = idArg;
    }

    const result = W.setDefaultWorkspaceId(config, nextId);
    if ('error' in result) return { success: false, error: result.error };

    saveConfig(result.config);
    const state = W.getWorkspaceState(result.config);
    return { success: true, ...state };
}
