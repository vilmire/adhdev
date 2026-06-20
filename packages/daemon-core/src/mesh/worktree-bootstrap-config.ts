import { existsSync, readFileSync } from 'fs';
import { join, resolve as pathResolve } from 'path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import * as yaml from 'js-yaml';
import { resolveWin32Executable } from '../cli-adapters/resolve-executable.js';
import {
    isMeshConfigRecord,
    normalizeMeshCommandConfig,
    type MeshRefineValidationCommandPlan,
    type RepoMeshRefineValidationCommandConfig,
} from './refine-config.js';
import type { MeshAsyncJobLifecycle } from '../repo-mesh-types.js';

export type WorktreeBootstrapStatus = 'ready' | 'running' | 'failed' | 'not_configured' | 'disabled' | 'stale';

export interface RepoMeshWorktreeBootstrapConfig {
    version: 1;
    enabled?: boolean;
    runOnClone?: boolean;
    required?: boolean;
    commands?: RepoMeshRefineValidationCommandConfig[];
    staleInputs?: string[];
}

export interface WorktreeBootstrapState extends MeshAsyncJobLifecycle {
    status: WorktreeBootstrapStatus;
    required: boolean;
    configSource?: string;
    configSourceType?: 'repo_file' | 'mesh_policy' | 'unavailable' | 'invalid';
    lastCommand?: string;
    exitCode?: number | null;
    commandsRun?: Array<Record<string, unknown>>;
    staleInputs?: string[];
    /**
     * M2-1: sha256 per staleInputs path recorded when the bootstrap reached
     * 'ready'. evaluateWorktreeBootstrapState compares current file hashes
     * against this to detect staleness (e.g. base merge changed a lockfile).
     * Missing files hash to the literal 'absent'.
     */
    staleInputsDigest?: Record<string, string>;
    /** M2-1: why an evaluated state resolved to stale (digest_mismatch | never_ran). */
    staleReason?: string;
}

export interface WorktreeBootstrapConfigLoadResult {
    config?: RepoMeshWorktreeBootstrapConfig;
    source: string;
    sourceType: 'repo_file' | 'mesh_policy' | 'unavailable' | 'invalid';
    path?: string;
    error?: string;
}

export const MESH_WORKTREE_BOOTSTRAP_CONFIG_LOCATIONS = [
    '.adhdev/worktree_bootstrap.json',
    '.adhdev/worktree_bootstrap.yaml',
    '.adhdev/worktree_bootstrap.yml',
    '.adhdev/worktree-bootstrap.json',
    '.adhdev/worktree-bootstrap.yaml',
    '.adhdev/worktree-bootstrap.yml',
];

export const MESH_WORKTREE_BOOTSTRAP_CONFIG_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'ADHDev Repo Mesh Worktree Bootstrap Config',
    type: 'object',
    additionalProperties: false,
    required: ['version'],
    properties: {
        version: { const: 1 },
        enabled: { type: 'boolean', default: true },
        runOnClone: { type: 'boolean', default: true },
        required: { type: 'boolean', default: true },
        staleInputs: { type: 'array', maxItems: 16, items: { type: 'string', minLength: 1 } },
        commands: {
            type: 'array',
            minItems: 1,
            maxItems: 4,
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['command'],
                properties: {
                    command: { type: 'string', minLength: 1 },
                    args: { type: 'array', items: { type: 'string' } },
                    category: { enum: ['typecheck', 'test', 'lint', 'build', 'custom'] },
                    cwd: { type: 'string' },
                    timeoutMs: { type: 'number', minimum: 1000, maximum: 600000 },
                    outputLimitBytes: { type: 'number', minimum: 1024, maximum: 1048576 },
                    env: { type: 'object', additionalProperties: { type: 'string' } },
                },
            },
        },
    },
} as const;

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 128 * 1024;
const OUTPUT_SUMMARY_CHARS = 2_000;

function parseConfigText(path: string, text: string): unknown {
    if (/\.json$/i.test(path)) return JSON.parse(text);
    return yaml.load(text);
}

function truncateOutput(value: unknown): string {
    const text = typeof value === 'string' ? value : value == null ? '' : String(value);
    if (text.length <= OUTPUT_SUMMARY_CHARS) return text;
    return `${text.slice(0, OUTPUT_SUMMARY_CHARS)}\n[truncated ${text.length - OUTPUT_SUMMARY_CHARS} chars]`;
}

export function validateMeshWorktreeBootstrapConfig(config: unknown, source = 'inline'): {
    valid: boolean;
    errors: string[];
    commands: MeshRefineValidationCommandPlan[];
    rejectedCommands: Array<Record<string, unknown>>;
} {
    const errors: string[] = [];
    const commands: MeshRefineValidationCommandPlan[] = [];
    const rejectedCommands: Array<Record<string, unknown>> = [];
    if (!isMeshConfigRecord(config)) return { valid: false, errors: ['config must be an object'], commands, rejectedCommands };
    if (config.version !== 1) errors.push('version must be 1');
    if (config.enabled !== undefined && typeof config.enabled !== 'boolean') errors.push('enabled must be a boolean when provided');
    if (config.runOnClone !== undefined && typeof config.runOnClone !== 'boolean') errors.push('runOnClone must be a boolean when provided');
    if (config.required !== undefined && typeof config.required !== 'boolean') errors.push('required must be a boolean when provided');
    if (config.staleInputs !== undefined && (!Array.isArray(config.staleInputs) || !config.staleInputs.every(input => typeof input === 'string' && input.trim()))) {
        errors.push('staleInputs must be an array of non-empty strings when provided');
    }
    if (config.commands !== undefined && !Array.isArray(config.commands)) errors.push('commands must be an array');
    if (Array.isArray(config.commands)) {
        config.commands.forEach((entry, index) => {
            const normalized = normalizeMeshCommandConfig(entry, `${source}:commands[${index}]`);
            if (normalized.command) commands.push(normalized.command);
            if (normalized.rejected) rejectedCommands.push(normalized.rejected);
        });
    }
    if (config.enabled !== false && config.runOnClone !== false && commands.length === 0) errors.push('commands must contain at least one command when bootstrap is enabled');
    if (rejectedCommands.length) errors.push('one or more bootstrap commands are invalid');
    return { valid: errors.length === 0, errors, commands, rejectedCommands };
}

export function loadMeshWorktreeBootstrapConfig(mesh: any, workspace: string): WorktreeBootstrapConfigLoadResult {
    const inline = mesh?.worktreeBootstrapConfig || mesh?.policy?.worktreeBootstrapConfig || mesh?.policy?.worktreeBootstrap;
    if (inline !== undefined) {
        const validation = validateMeshWorktreeBootstrapConfig(inline, 'mesh.policy.worktreeBootstrapConfig');
        if (!validation.valid) return { source: 'mesh.policy.worktreeBootstrapConfig', sourceType: 'invalid', error: String(validation.rejectedCommands[0]?.reason || validation.errors.join('; ')) };
        return { config: inline as RepoMeshWorktreeBootstrapConfig, source: 'mesh.policy.worktreeBootstrapConfig', sourceType: 'mesh_policy' };
    }
    for (const relative of MESH_WORKTREE_BOOTSTRAP_CONFIG_LOCATIONS) {
        const configPath = join(workspace, relative);
        if (!existsSync(configPath)) continue;
        try {
            const parsed = parseConfigText(configPath, readFileSync(configPath, 'utf-8'));
            const validation = validateMeshWorktreeBootstrapConfig(parsed, relative);
            if (!validation.valid) return { source: relative, sourceType: 'invalid', path: configPath, error: String(validation.rejectedCommands[0]?.reason || validation.errors.join('; ')) };
            return { config: parsed as RepoMeshWorktreeBootstrapConfig, source: relative, sourceType: 'repo_file', path: configPath };
        } catch (error: any) {
            return { source: relative, sourceType: 'invalid', path: configPath, error: error?.message || String(error) };
        }
    }
    return { source: 'unavailable', sourceType: 'unavailable', error: `No worktree bootstrap config found. Checked: ${MESH_WORKTREE_BOOTSTRAP_CONFIG_LOCATIONS.join(', ')}` };
}

/** M2-1: hash staleInputs files so 'ready' can be invalidated when they change. */
export function computeStaleInputsDigest(workspace: string, staleInputs: string[] | undefined): Record<string, string> {
    const digest: Record<string, string> = {};
    for (const relative of staleInputs ?? []) {
        const filePath = join(workspace, relative);
        try {
            digest[relative] = createHash('sha256').update(readFileSync(filePath)).digest('hex');
        } catch {
            digest[relative] = 'absent';
        }
    }
    return digest;
}

/**
 * M2-1: the official bootstrap state contract. Resolves the effective state
 * for a node workspace from config presence + the persisted last-run state +
 * a staleInputs digest comparison. Read-only — never runs commands.
 *
 *   ready          — last run succeeded and staleInputs are unchanged
 *   stale          — never ran, or a staleInputs file changed since 'ready'
 *   running/failed — persisted lifecycle state passes through
 *   not_configured / disabled / (invalid → failed) — from config resolution
 */
export function evaluateWorktreeBootstrapState(mesh: any, workspace: string, persisted?: WorktreeBootstrapState | null): WorktreeBootstrapState {
    const loaded = loadMeshWorktreeBootstrapConfig(mesh, workspace);
    if (!loaded.config) {
        return { status: 'not_configured', required: false, configSource: loaded.source, configSourceType: loaded.sourceType, error: loaded.error };
    }
    const required = loaded.config.required !== false;
    if (loaded.config.enabled === false || loaded.config.runOnClone === false) {
        return { status: 'disabled', required, configSource: loaded.path || loaded.source, configSourceType: loaded.sourceType };
    }
    if (loaded.sourceType === 'invalid') {
        return { status: 'failed', required, configSource: loaded.path || loaded.source, configSourceType: 'invalid', error: loaded.error };
    }
    if (persisted?.status === 'running') return { ...persisted, required };
    if (persisted?.status === 'failed') return { ...persisted, required };
    if (persisted?.status === 'ready') {
        const staleInputs = loaded.config.staleInputs ?? persisted.staleInputs ?? [];
        if (staleInputs.length > 0 && persisted.staleInputsDigest) {
            const current = computeStaleInputsDigest(workspace, staleInputs);
            const changed = staleInputs.filter(p => current[p] !== persisted.staleInputsDigest![p]);
            if (changed.length > 0) {
                return {
                    ...persisted,
                    status: 'stale',
                    required,
                    staleReason: `digest_mismatch: ${changed.join(', ')}`,
                };
            }
        }
        return { ...persisted, required };
    }
    return {
        status: 'stale',
        required,
        configSource: loaded.path || loaded.source,
        configSourceType: loaded.sourceType,
        staleInputs: loaded.config.staleInputs,
        staleReason: 'never_ran',
    };
}

export async function runMeshWorktreeBootstrap(mesh: any, workspace: string): Promise<WorktreeBootstrapState> {
    const loaded = loadMeshWorktreeBootstrapConfig(mesh, workspace);
    if (!loaded.config) {
        return { status: 'not_configured', required: false, configSource: loaded.source, configSourceType: loaded.sourceType, error: loaded.error };
    }
    const required = loaded.config.required !== false;
    if (loaded.config.enabled === false || loaded.config.runOnClone === false) {
        return { status: 'disabled', required, configSource: loaded.path || loaded.source, configSourceType: loaded.sourceType };
    }
    const validation = validateMeshWorktreeBootstrapConfig(loaded.config, loaded.source);
    if (!validation.valid) {
        return { status: 'failed', required, configSource: loaded.path || loaded.source, configSourceType: 'invalid', error: String(validation.rejectedCommands[0]?.reason || validation.errors.join('; ')), commandsRun: [] };
    }

    const execFileAsync = promisify(execFile);
    const state: WorktreeBootstrapState = {
        status: 'running',
        required,
        configSource: loaded.path || loaded.source,
        configSourceType: loaded.sourceType,
        startedAt: new Date().toISOString(),
        commandsRun: [],
        staleInputs: loaded.config.staleInputs,
    };
    const staleInputPaths = loaded.config.staleInputs ?? [];
    // Snapshot which staleInputs files are absent at bootstrap start.
    // Files already present before we start are not interference signals.
    const initiallyAbsent = staleInputPaths.filter(p => !existsSync(join(workspace, p)));
    for (const command of validation.commands) {
        // Check if any initially-absent staleInputs files appeared since bootstrap started
        // (indicates another process modified the environment mid-run).
        if (initiallyAbsent.length > 0) {
            const appearedNow = initiallyAbsent.filter(p => existsSync(join(workspace, p)));
            if (appearedNow.length > 0) {
                state.status = 'stale';
                state.completedAt = new Date().toISOString();
                state.error = `Bootstrap interrupted: staleInputs files appeared during run: ${appearedNow.join(', ')}`;
                return state;
            }
        }
        const cwd = command.cwd ? pathResolve(workspace, command.cwd) : workspace;
        const startedAt = Date.now();
        state.lastCommand = command.displayCommand;
        // On win32 a bare npm/npx/tsc is a .cmd shim that libuv's spawn search
        // (which appends only .com/.exe) cannot resolve → spawn ENOENT. Resolve
        // to an absolute path first (no-op on non-win32 / already-absolute).
        const resolvedCommand = resolveWin32Executable(command.command);
        try {
            const result = await execFileAsync(resolvedCommand, command.args, {
                cwd,
                encoding: 'utf8',
                timeout: command.timeoutMs || DEFAULT_TIMEOUT_MS,
                maxBuffer: command.outputLimitBytes || DEFAULT_OUTPUT_LIMIT_BYTES,
                env: { ...process.env, CI: process.env.CI || '1', ...(command.env || {}) },
                windowsHide: true,
            });
            state.commandsRun?.push({
                command: command.command,
                args: command.args,
                displayCommand: command.displayCommand,
                category: command.category,
                source: command.source,
                cwd,
                passed: true,
                durationMs: Date.now() - startedAt,
                exitCode: 0,
                stdout: truncateOutput(result.stdout),
                stderr: truncateOutput(result.stderr),
            });
        } catch (error: any) {
            const exitCode = typeof error?.code === 'number' ? error.code : null;
            state.status = 'failed';
            state.exitCode = exitCode;
            state.error = error?.message || String(error);
            state.completedAt = new Date().toISOString();
            state.commandsRun?.push({
                command: command.command,
                args: command.args,
                displayCommand: command.displayCommand,
                category: command.category,
                source: command.source,
                cwd,
                passed: false,
                durationMs: Date.now() - startedAt,
                exitCode,
                signal: typeof error?.signal === 'string' ? error.signal : null,
                timedOut: error?.killed === true || /timed out/i.test(String(error?.message || '')),
                stdout: truncateOutput(error?.stdout),
                stderr: truncateOutput(error?.stderr || error?.message),
            });
            return state;
        }
    }
    state.status = 'ready';
    state.exitCode = 0;
    state.completedAt = new Date().toISOString();
    // M2-1: record staleInputs hashes so evaluateWorktreeBootstrapState can
    // invalidate this 'ready' when an input (e.g. lockfile) changes later.
    if (staleInputPaths.length > 0) {
        state.staleInputsDigest = computeStaleInputsDigest(workspace, staleInputPaths);
    }
    return state;
}
