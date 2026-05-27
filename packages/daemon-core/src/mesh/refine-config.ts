import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import * as yaml from 'js-yaml';

export const MESH_REFINE_VALIDATION_CATEGORIES = ['typecheck', 'test', 'lint', 'build'] as const;
export type MeshRefineValidationCategory = typeof MESH_REFINE_VALIDATION_CATEGORIES[number];

export interface RepoMeshRefineValidationCommandConfig {
    /** Executable name or a whitespace-tokenized command string. Never executed through a shell. */
    command: string;
    /** Optional explicit argv. Prefer this over shell-like command strings. */
    args?: string[];
    category?: MeshRefineValidationCategory;
    cwd?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
}

export interface RepoMeshRefineConfig {
    version: 1;
    /**
     * Narrow Refinery opt-in for monorepos with submodule gitlinks.
     * When true, Refinery may non-force publish unreachable submodule gitlink
     * commits to the submodule remote main branch after validation and
     * patch-equivalence pass, then verify remote-main reachability.
     */
    allowAutoPublishSubmoduleMainCommits?: boolean;
    validation?: {
        required?: boolean;
        /**
         * Optional dependency/bootstrap commands that Refinery runs before
         * validation commands. Refinery never infers installs on its own.
         */
        bootstrapCommands?: RepoMeshRefineValidationCommandConfig[];
        commands?: RepoMeshRefineValidationCommandConfig[];
    };
}

export interface MeshRefineValidationCommandPlan {
    command: string;
    args: string[];
    displayCommand: string;
    category: MeshRefineValidationCategory | 'custom';
    source: string;
    cwd?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
}

export interface MeshRefineConfigLoadResult {
    config?: RepoMeshRefineConfig;
    source: string;
    sourceType: 'mesh_policy' | 'repo_file' | 'unavailable' | 'invalid';
    path?: string;
    error?: string;
}

export interface MeshRefineValidationPlan {
    source: string;
    sourceType: MeshRefineConfigLoadResult['sourceType'];
    bootstrapCommands: MeshRefineValidationCommandPlan[];
    commands: MeshRefineValidationCommandPlan[];
    rejectedCommands: Array<Record<string, unknown>>;
    suggestions: RepoMeshRefineValidationCommandConfig[];
    suggestedConfig?: RepoMeshRefineConfig;
    unavailableReason?: string;
}

export const MESH_REFINE_CONFIG_LOCATIONS = [
    '.adhdev/refine.json',
    '.adhdev/refine.yaml',
    '.adhdev/refine.yml',
    '.adhdev/repo-mesh-refine.json',
    '.adhdev/repo-mesh-refine.yaml',
    '.adhdev/repo-mesh-refine.yml',
    'repo-mesh.refine.json',
    'repo-mesh.refine.yaml',
    'repo-mesh.refine.yml',
];

export const MESH_REFINE_CONFIG_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'ADHDev Repo Mesh Refinery Config',
    type: 'object',
    additionalProperties: false,
    required: ['version'],
    properties: {
        version: { const: 1 },
        allowAutoPublishSubmoduleMainCommits: {
            type: 'boolean',
            default: false,
            description: 'When true, Refinery may non-force publish submodule gitlink commits referenced by the refined root tree to each submodule origin/main after validation and patch-equivalence pass, then verify reachability.',
        },
        validation: {
            type: 'object',
            additionalProperties: false,
            properties: {
                required: { type: 'boolean', default: true },
                commands: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 8,
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['command'],
                        properties: {
                            command: { type: 'string', minLength: 1 },
                            args: { type: 'array', items: { type: 'string' } },
                            category: { enum: [...MESH_REFINE_VALIDATION_CATEGORIES, 'custom'] },
                            cwd: { type: 'string' },
                            timeoutMs: { type: 'number', minimum: 1000, maximum: 600000 },
                            env: { type: 'object', additionalProperties: { type: 'string' } },
                        },
                    },
                },
                bootstrapCommands: {
                    type: 'array',
                    maxItems: 4,
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['command'],
                        properties: {
                            command: { type: 'string', minLength: 1 },
                            args: { type: 'array', items: { type: 'string' } },
                            category: { enum: [...MESH_REFINE_VALIDATION_CATEGORIES, 'custom'] },
                            cwd: { type: 'string' },
                            timeoutMs: { type: 'number', minimum: 1000, maximum: 600000 },
                            env: { type: 'object', additionalProperties: { type: 'string' } },
                        },
                    },
                },
            },
        },
    },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function tokenizeCommandString(command: string): string[] | null {
    const trimmed = command.trim();
    if (!trimmed) return null;
    // Explicit config may name any executable, but the Refinery never invokes a shell.
    // Reject shell syntax, quotes and substitutions so config cannot smuggle a compound command.
    if (/[;&|<>`$\\\n\r'\"]/.test(trimmed)) return null;
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    if (!tokens.length) return null;
    if (tokens.some(token => !/^[A-Za-z0-9_@./:=+-]+$/.test(token))) return null;
    return tokens;
}

function validateCategory(value: unknown): MeshRefineValidationCategory | 'custom' {
    return typeof value === 'string' && ([...MESH_REFINE_VALIDATION_CATEGORIES, 'custom'] as string[]).includes(value)
        ? value as MeshRefineValidationCategory | 'custom'
        : 'custom';
}

function normalizeCommandConfig(entry: unknown, source: string): { command?: MeshRefineValidationCommandPlan; rejected?: Record<string, unknown> } {
    if (!isRecord(entry) || typeof entry.command !== 'string') {
        return { rejected: { source, reason: 'validation command must be an object with a command string' } };
    }

    const commandText = entry.command.trim();
    const explicitArgs = Array.isArray(entry.args) ? entry.args : undefined;
    if (explicitArgs && !explicitArgs.every(arg => typeof arg === 'string')) {
        return { rejected: { source, command: commandText, reason: 'args must be an array of strings' } };
    }

    let command = commandText;
    let args = explicitArgs ? [...explicitArgs] : [];
    if (!explicitArgs) {
        const tokens = tokenizeCommandString(commandText);
        if (!tokens) return { rejected: { source, command: commandText, reason: 'unsafe command string is not allowlisted' } };
        command = tokens[0];
        args = tokens.slice(1);
    } else if (!tokenizeCommandString(command)) {
        return { rejected: { source, command: commandText, reason: 'unsafe executable name is not allowlisted' } };
    }

    if (args.some(arg => /[\n\r\0]/.test(arg))) {
        return { rejected: { source, command: commandText, reason: 'args cannot contain control characters' } };
    }
    if (entry.cwd !== undefined && typeof entry.cwd !== 'string') {
        return { rejected: { source, command: commandText, reason: 'cwd must be a string when provided' } };
    }
    if (entry.timeoutMs !== undefined && (typeof entry.timeoutMs !== 'number' || !Number.isFinite(entry.timeoutMs) || entry.timeoutMs < 1000 || entry.timeoutMs > 600000)) {
        return { rejected: { source, command: commandText, reason: 'timeoutMs must be between 1000 and 600000' } };
    }
    if (entry.env !== undefined && (!isRecord(entry.env) || !Object.values(entry.env).every(value => typeof value === 'string'))) {
        return { rejected: { source, command: commandText, reason: 'env must be an object of string values' } };
    }

    return {
        command: {
            command,
            args,
            displayCommand: [command, ...args].join(' '),
            category: validateCategory(entry.category),
            source,
            ...(typeof entry.cwd === 'string' && entry.cwd.trim() ? { cwd: entry.cwd.trim() } : {}),
            ...(typeof entry.timeoutMs === 'number' ? { timeoutMs: entry.timeoutMs } : {}),
            ...(isRecord(entry.env) ? { env: entry.env as Record<string, string> } : {}),
        },
    };
}

export function validateMeshRefineConfig(config: unknown, source = 'inline'): { valid: boolean; errors: string[]; bootstrapCommands: MeshRefineValidationCommandPlan[]; commands: MeshRefineValidationCommandPlan[]; rejectedCommands: Array<Record<string, unknown>> } {
    const errors: string[] = [];
    const bootstrapCommands: MeshRefineValidationCommandPlan[] = [];
    const commands: MeshRefineValidationCommandPlan[] = [];
    const rejectedCommands: Array<Record<string, unknown>> = [];

    if (!isRecord(config)) return { valid: false, errors: ['config must be an object'], bootstrapCommands, commands, rejectedCommands };
    if (config.version !== 1) errors.push('version must be 1');
    if (config.allowAutoPublishSubmoduleMainCommits !== undefined && typeof config.allowAutoPublishSubmoduleMainCommits !== 'boolean') {
        errors.push('allowAutoPublishSubmoduleMainCommits must be a boolean when provided');
    }
    const validation = config.validation;
    if (validation !== undefined && !isRecord(validation)) errors.push('validation must be an object');
    const rawCommands = isRecord(validation) ? validation.commands : undefined;
    const rawBootstrapCommands = isRecord(validation) ? validation.bootstrapCommands : undefined;
    if (rawCommands !== undefined && !Array.isArray(rawCommands)) errors.push('validation.commands must be an array');
    if (rawBootstrapCommands !== undefined && !Array.isArray(rawBootstrapCommands)) errors.push('validation.bootstrapCommands must be an array');
    if (Array.isArray(rawBootstrapCommands)) {
        rawBootstrapCommands.forEach((entry, index) => {
            const normalized = normalizeCommandConfig(entry, `${source}:validation.bootstrapCommands[${index}]`);
            if (normalized.command) bootstrapCommands.push(normalized.command);
            if (normalized.rejected) rejectedCommands.push(normalized.rejected);
        });
    }
    if (Array.isArray(rawCommands)) {
        rawCommands.forEach((entry, index) => {
            const normalized = normalizeCommandConfig(entry, `${source}:validation.commands[${index}]`);
            if (normalized.command) commands.push(normalized.command);
            if (normalized.rejected) rejectedCommands.push(normalized.rejected);
        });
    }
    if (rejectedCommands.length) errors.push('one or more validation commands are invalid');
    return { valid: errors.length === 0, errors, bootstrapCommands, commands, rejectedCommands };
}

function parseConfigText(path: string, text: string): unknown {
    if (/\.json$/i.test(path)) return JSON.parse(text);
    return yaml.load(text);
}

export function loadMeshRefineConfig(mesh: any, workspace: string): MeshRefineConfigLoadResult {
    const policy = mesh?.policy && typeof mesh.policy === 'object' && !Array.isArray(mesh.policy) ? mesh.policy : {};
    const inline = mesh?.refineConfig || (policy as any).refineConfig || (policy as any).refine;
    if (inline !== undefined) {
        const validation = validateMeshRefineConfig(inline, 'mesh.policy.refineConfig');
        if (!validation.valid) return { source: 'mesh.policy.refineConfig', sourceType: 'invalid', error: String(validation.rejectedCommands[0]?.reason || validation.errors.join('; ')) };
        return { config: inline as RepoMeshRefineConfig, source: 'mesh.policy.refineConfig', sourceType: 'mesh_policy' };
    }

    for (const relative of MESH_REFINE_CONFIG_LOCATIONS) {
        const configPath = join(workspace, relative);
        if (!existsSync(configPath)) continue;
        try {
            const parsed = parseConfigText(configPath, readFileSync(configPath, 'utf-8'));
            const validation = validateMeshRefineConfig(parsed, relative);
            if (!validation.valid) return { source: relative, sourceType: 'invalid', path: configPath, error: String(validation.rejectedCommands[0]?.reason || validation.errors.join('; ')) };
            return { config: parsed as RepoMeshRefineConfig, source: relative, sourceType: 'repo_file', path: configPath };
        } catch (error: any) {
            return { source: relative, sourceType: 'invalid', path: configPath, error: error?.message || String(error) };
        }
    }

    return {
        source: 'unavailable',
        sourceType: 'unavailable',
        error: `No repo mesh/refine config found. Checked: ${MESH_REFINE_CONFIG_LOCATIONS.join(', ')}`,
    };
}

function readPackageScripts(workspace: string): Record<string, string> {
    try {
        const parsed = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf-8'));
        return isRecord(parsed?.scripts) ? parsed.scripts as Record<string, string> : {};
    } catch {
        return {};
    }
}

function collectProjectContextSuggestions(mesh: any): RepoMeshRefineValidationCommandConfig[] {
    const commands = mesh?.projectContext?.commands;
    if (!isRecord(commands)) return [];
    const suggestions: RepoMeshRefineValidationCommandConfig[] = [];
    for (const category of MESH_REFINE_VALIDATION_CATEGORIES) {
        const entries = Array.isArray(commands[category]) ? commands[category] : [];
        for (const entry of entries) {
            if (isRecord(entry) && typeof entry.command === 'string') suggestions.push({ command: entry.command, category });
        }
    }
    return suggestions;
}

function collectPackageScriptSuggestions(workspace: string): RepoMeshRefineValidationCommandConfig[] {
    const scripts = readPackageScripts(workspace);
    const suggestions: RepoMeshRefineValidationCommandConfig[] = [];
    for (const category of MESH_REFINE_VALIDATION_CATEGORIES) {
        for (const scriptName of Object.keys(scripts)) {
            if (scriptName === category || scriptName.startsWith(`${category}:`)) {
                suggestions.push({ command: 'npm', args: ['run', scriptName], category });
            }
        }
    }
    return suggestions;
}

export function suggestMeshRefineConfig(mesh: any, workspace: string): { suggestions: RepoMeshRefineValidationCommandConfig[]; suggestedConfig?: RepoMeshRefineConfig } {
    const seen = new Set<string>();
    const suggestions: RepoMeshRefineValidationCommandConfig[] = [];
    for (const entry of [...collectProjectContextSuggestions(mesh), ...collectPackageScriptSuggestions(workspace)]) {
        const key = `${entry.command} ${(entry.args || []).join(' ')}`.trim();
        if (seen.has(key)) continue;
        seen.add(key);
        suggestions.push(entry);
    }
    return {
        suggestions,
        suggestedConfig: suggestions.length ? { version: 1, validation: { required: true, commands: suggestions.slice(0, 4) } } : undefined,
    };
}

export function resolveMeshRefineValidationPlan(mesh: any, workspace: string): MeshRefineValidationPlan {
    const loaded = loadMeshRefineConfig(mesh, workspace);
    const suggestion = suggestMeshRefineConfig(mesh, workspace);
    if (!loaded.config) {
        return {
            source: loaded.source,
            sourceType: loaded.sourceType,
            bootstrapCommands: [],
            commands: [],
            rejectedCommands: loaded.error ? [{ source: loaded.source, reason: loaded.error }] : [],
            suggestions: suggestion.suggestions,
            suggestedConfig: suggestion.suggestedConfig,
            unavailableReason: loaded.error || 'validation_unavailable: repo mesh/refine config missing',
        };
    }

    const validation = validateMeshRefineConfig(loaded.config, loaded.source);
    return {
        source: loaded.path || loaded.source,
        sourceType: loaded.sourceType,
        bootstrapCommands: validation.bootstrapCommands,
        commands: validation.commands,
        rejectedCommands: validation.rejectedCommands,
        suggestions: suggestion.suggestions,
        suggestedConfig: suggestion.suggestedConfig,
        unavailableReason: validation.commands.length ? undefined : 'validation_unavailable: repo mesh/refine config has no validation.commands',
    };
}
