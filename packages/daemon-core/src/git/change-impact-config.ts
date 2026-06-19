import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import * as yaml from 'js-yaml';

/**
 * "Change Impact" — config-driven classification of which git changes between the
 * live daemon's build commit and the workspace HEAD actually require a daemon
 * rebuild/restart (vs. a web-only redeploy, vs. nothing).
 *
 * The daemon-core git surface only knows the FACTS (which files / packages changed
 * between buildCommit..HEAD). The POLICY — which packages are daemon-runtime, which
 * are web-only, which root files are non-runtime, and what command to recommend —
 * is declarative config injected from outside. This keeps git-status.ts repo-agnostic
 * while preserving ADHDev's exact built-in behavior when no config is present.
 *
 * SECURITY: config is declarative only. JSON/YAML are parsed; arbitrary JS config
 * (.js) is intentionally NOT supported, so loading a config can never execute code.
 */

/** A change-impact classification bucket. */
export type ChangeImpactKind = 'daemon' | 'web' | 'none';

/**
 * Recommended action for a given impact classification. `recommendedAction` is the
 * stable classification key (always one of daemon|web|none, NOT config-overridable);
 * config customizes only the human-facing `recommendedCommand` recipe.
 */
export interface ChangeImpactTarget {
    /** Human-facing command/recipe to act on the impact (e.g. deploy + restart). */
    recommendedCommand: string;
}

export interface ChangeImpactConfig {
    /**
     * Package names (the `<name>` in `packages/<name>/`) whose change means the
     * daemon runtime is stale and must be rebuilt/redeployed + restarted. When
     * provided, this REPLACES the built-in daemon-runtime set.
     */
    daemonRuntimePackages?: string[];
    /**
     * Package names that are web-only — a change to one does not require a daemon
     * restart, only a web redeploy. When provided, this REPLACES the built-in
     * web-only set.
     */
    webOnlyPackages?: string[];
    /**
     * Glob patterns for root-level (non-package) files that demonstrably cannot
     * change what the daemon runtime executes (markers, docs, license text). These
     * are added on top of the built-in non-runtime root-file detection.
     */
    nonRuntimeRootFilePatterns?: string[];
    /** Recommended action/command per impact classification. Missing keys fall back to built-in defaults. */
    impactTargets?: Partial<Record<ChangeImpactKind, ChangeImpactTarget>>;
}

export interface ChangeImpactConfigLoadResult {
    config?: ChangeImpactConfig;
    source: string;
    sourceType: 'repo_file' | 'unavailable' | 'invalid';
    path?: string;
    error?: string;
    /**
     * Stable identity of the config SOURCE, used as part of a cache key so a config
     * edit invalidates any cached impact evaluation. Combines the resolved path and
     * its mtime (or the path for the unavailable/invalid case).
     */
    sourceKey: string;
}

export const CHANGE_IMPACT_CONFIG_LOCATIONS = [
    '.adhdev/change-impact.json',
    '.adhdev/change-impact.yaml',
    '.adhdev/change-impact.yml',
    '.adhdev/repo-mesh-change-impact.json',
    '.adhdev/repo-mesh-change-impact.yaml',
    '.adhdev/repo-mesh-change-impact.yml',
];

export const CHANGE_IMPACT_CONFIG_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'ADHDev Change Impact Config',
    type: 'object',
    additionalProperties: false,
    properties: {
        daemonRuntimePackages: { type: 'array', items: { type: 'string', minLength: 1 } },
        webOnlyPackages: { type: 'array', items: { type: 'string', minLength: 1 } },
        nonRuntimeRootFilePatterns: { type: 'array', items: { type: 'string', minLength: 1 } },
        impactTargets: {
            type: 'object',
            additionalProperties: false,
            properties: {
                daemon: { $ref: '#/$defs/target' },
                web: { $ref: '#/$defs/target' },
                none: { $ref: '#/$defs/target' },
            },
        },
    },
    $defs: {
        target: {
            type: 'object',
            additionalProperties: false,
            required: ['recommendedCommand'],
            properties: {
                recommendedCommand: { type: 'string', minLength: 1 },
            },
        },
    },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(v => typeof v === 'string' && v.length > 0);
}

function validateTarget(value: unknown, key: string, errors: string[]): ChangeImpactTarget | undefined {
    if (!isRecord(value)) {
        errors.push(`impactTargets.${key} must be an object`);
        return undefined;
    }
    const { recommendedCommand } = value;
    if (typeof recommendedCommand !== 'string' || !recommendedCommand.length) {
        errors.push(`impactTargets.${key}.recommendedCommand must be a non-empty string`);
        return undefined;
    }
    // recommendedAction is the fixed classification key; config supplies only the command.
    for (const k of Object.keys(value)) {
        if (k !== 'recommendedCommand') errors.push(`impactTargets.${key}.${k} is not a recognized field (only recommendedCommand)`);
    }
    return { recommendedCommand };
}

export function validateChangeImpactConfig(raw: unknown, source = 'inline'): { valid: boolean; errors: string[]; config?: ChangeImpactConfig } {
    const errors: string[] = [];
    if (!isRecord(raw)) {
        return { valid: false, errors: [`${source}: config must be an object`] };
    }
    const config: ChangeImpactConfig = {};

    if (raw.daemonRuntimePackages !== undefined) {
        if (isStringArray(raw.daemonRuntimePackages)) config.daemonRuntimePackages = [...raw.daemonRuntimePackages];
        else errors.push('daemonRuntimePackages must be an array of non-empty strings');
    }
    if (raw.webOnlyPackages !== undefined) {
        if (isStringArray(raw.webOnlyPackages)) config.webOnlyPackages = [...raw.webOnlyPackages];
        else errors.push('webOnlyPackages must be an array of non-empty strings');
    }
    if (raw.nonRuntimeRootFilePatterns !== undefined) {
        if (isStringArray(raw.nonRuntimeRootFilePatterns)) config.nonRuntimeRootFilePatterns = [...raw.nonRuntimeRootFilePatterns];
        else errors.push('nonRuntimeRootFilePatterns must be an array of non-empty strings');
    }
    if (raw.impactTargets !== undefined) {
        if (!isRecord(raw.impactTargets)) {
            errors.push('impactTargets must be an object');
        } else {
            const targets: Partial<Record<ChangeImpactKind, ChangeImpactTarget>> = {};
            for (const key of Object.keys(raw.impactTargets)) {
                if (key !== 'daemon' && key !== 'web' && key !== 'none') {
                    errors.push(`impactTargets.${key} is not a recognized impact kind (daemon|web|none)`);
                    continue;
                }
                const target = validateTarget(raw.impactTargets[key], key, errors);
                if (target) targets[key as ChangeImpactKind] = target;
            }
            if (Object.keys(targets).length) config.impactTargets = targets;
        }
    }
    // Reject unknown top-level keys to catch typos early (mirrors additionalProperties:false).
    for (const key of Object.keys(raw)) {
        if (!['daemonRuntimePackages', 'webOnlyPackages', 'nonRuntimeRootFilePatterns', 'impactTargets'].includes(key)) {
            errors.push(`unknown config key '${key}'`);
        }
    }

    return { valid: errors.length === 0, errors, config: errors.length === 0 ? config : undefined };
}

function parseConfigText(path: string, text: string): unknown {
    if (/\.json$/i.test(path)) return JSON.parse(text);
    return yaml.load(text);
}

/**
 * Locate and load the Change Impact config for a repo root. Declarative only —
 * never executes config. Returns a sourceKey suitable for cache invalidation:
 * config path + mtime, or the sentinel for the missing/invalid case.
 */
export function loadChangeImpactConfig(repoRoot: string): ChangeImpactConfigLoadResult {
    for (const relative of CHANGE_IMPACT_CONFIG_LOCATIONS) {
        const configPath = join(repoRoot, relative);
        if (!existsSync(configPath)) continue;
        try {
            const text = readFileSync(configPath, 'utf-8');
            let mtimeMs = 0;
            try {
                mtimeMs = statSync(configPath).mtimeMs;
            } catch {
                // Best-effort; fall back to content length so edits still perturb the key.
                mtimeMs = text.length;
            }
            const parsed = parseConfigText(configPath, text);
            const validation = validateChangeImpactConfig(parsed, relative);
            if (!validation.valid) {
                return {
                    source: relative,
                    sourceType: 'invalid',
                    path: configPath,
                    error: validation.errors.join('; '),
                    sourceKey: `invalid:${configPath}:${mtimeMs}`,
                };
            }
            return {
                config: validation.config,
                source: relative,
                sourceType: 'repo_file',
                path: configPath,
                sourceKey: `file:${configPath}:${mtimeMs}`,
            };
        } catch (error: any) {
            return {
                source: relative,
                sourceType: 'invalid',
                path: configPath,
                error: error?.message || String(error),
                sourceKey: `error:${configPath}`,
            };
        }
    }
    return {
        source: 'unavailable',
        sourceType: 'unavailable',
        error: `No change-impact config found. Checked: ${CHANGE_IMPACT_CONFIG_LOCATIONS.join(', ')}`,
        sourceKey: 'unavailable',
    };
}

/**
 * Translate a config glob pattern into a RegExp matched against a forward-slash
 * file path. Supports `**` (any path segments), `*` (any chars except `/`), and
 * `?` (single non-slash char). No brace/character-class expansion — declarative,
 * minimal, predictable. All other characters are matched literally.
 */
export function globToRegExp(pattern: string): RegExp {
    let out = '';
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i];
        if (ch === '*') {
            if (pattern[i + 1] === '*') {
                // `**` → any sequence of characters including path separators.
                out += '.*';
                i++;
                // Swallow a trailing slash after `**/` so `**/x` also matches `x`.
                if (pattern[i + 1] === '/') i++;
            } else {
                out += '[^/]*';
            }
        } else if (ch === '?') {
            out += '[^/]';
        } else if ('.+^${}()|[]\\'.includes(ch)) {
            out += '\\' + ch;
        } else {
            out += ch;
        }
    }
    return new RegExp(`^${out}$`);
}
