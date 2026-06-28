/**
 * Repo-shared declarative mesh config — `.adhdev/mesh.json`
 *
 * A repo-committed, machine-independent file carrying ONLY the repo-shared
 * coordinator-prompt config and operating notes:
 *
 *   - coordinator       — systemPromptOverride (local wins, else repo) and
 *                         systemPromptAppend (repo append + local append BOTH
 *                         stack, repo first).
 *   - operatingNotes    — repo-declared baseline notes merged with the runtime
 *                         ledger notes; on duplicate text the ledger note wins.
 *   - limits            — advisory-only (`maxNoteChars`, `maxNotes`,
 *                         `coordinator.maxPromptChars`); recorded, never enforced in v1.
 *
 * POLICY IS NOT HERE. RepoMeshPolicy (the 15 scheduling/approval fields) is
 * MACHINE-LOCAL only — it lives in meshes.json and is never sourced from, merged
 * with, or overlaid by a repo file. There is no `policy` zone and no
 * `policy.scheduling` overlay in mesh.json; the scheduler reads the stored
 * machine-local policy directly. The repo file shapes the coordinator prompt and
 * operating notes, nothing else.
 *
 * The coordinator/operatingNotes merge is **in-memory only**: the on-disk
 * machine-local `meshes.json` is never mutated by this module.
 *
 * FILE SEPARATION: refine / worktree-bootstrap / change-impact configs live in
 * their OWN `.adhdev/*` files with their own loaders — they are NOT inlined into
 * mesh.json. `loadRepoSettings` (config/repo-settings.ts) assembles all of them
 * into one object for consumers.
 *
 * SECURITY: declarative only. JSON/YAML is parsed; arbitrary JS (.js) is NOT
 * supported, so loading a config can never execute code.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import * as yaml from 'js-yaml';
import type {
    RepoMeshCoordinatorConfig,
    LocalMeshEntry,
} from '../repo-mesh-types.js';
import type { CoordinatorOperatingNote } from '../mesh/coordinator-prompt.js';

// ─── Types (declarative config zones) ───────────

export interface RepoMeshDeclarativeCoordinatorConfig {
    /** Full mesh-level system prompt override. Same semantics as
     *  RepoMeshCoordinatorConfig.systemPromptOverride; LOCAL-WINS. */
    systemPromptOverride?: string;
    /** Mesh-level append stacked after the base prompt. Both the repo append
     *  and the machine-local append apply; the repo append comes first. */
    systemPromptAppend?: string;
    /** Advisory only in v1 — recorded but never enforced. */
    maxPromptChars?: number;
}

export interface RepoMeshDeclarativeLimits {
    /** Advisory only in v1 — recorded but never enforced. */
    maxNoteChars?: number;
    /** Advisory only in v1 — recorded but never enforced. */
    maxNotes?: number;
}

/**
 * Parsed + normalized `.adhdev/mesh.json` shape. Every field is optional except
 * version so a repo can declare only the zone(s) it cares about. Policy is NOT a
 * zone here — it is machine-local (meshes.json) only.
 */
export interface RepoMeshDeclarativeConfig {
    version: 1;
    coordinator?: RepoMeshDeclarativeCoordinatorConfig;
    operatingNotes?: CoordinatorOperatingNote[];
    limits?: RepoMeshDeclarativeLimits;
}

export interface RepoMeshJsonConfigLoadResult {
    config?: RepoMeshDeclarativeConfig;
    /** Relative location matched, or 'unavailable'/'invalid' marker. */
    source: string;
    sourceType: 'repo_file' | 'unavailable' | 'invalid';
    /** Absolute path of the matched file, when one was read. */
    path?: string;
    error?: string;
}

// MESH_JSON_CONFIG_LOCATIONS is retained for backward compatibility: it is the
// shared list of `.adhdev/mesh.*` filenames the loader probes (and other modules
// reference for diagnostics). The file now carries only coordinator + operating
// notes; there is no scheduling overlay.
export const MESH_JSON_CONFIG_LOCATIONS = [
    '.adhdev/mesh.json',
    '.adhdev/mesh.yaml',
    '.adhdev/mesh.yml',
];

export const MESH_JSON_CONFIG_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'ADHDev Repo Mesh Declarative Config',
    type: 'object',
    additionalProperties: false,
    required: ['version'],
    properties: {
        version: { const: 1 },
        coordinator: {
            type: 'object',
            additionalProperties: false,
            properties: {
                systemPromptOverride: { type: 'string' },
                systemPromptAppend: { type: 'string' },
                maxPromptChars: { type: 'number', minimum: 1 },
            },
        },
        operatingNotes: {
            type: 'array',
            maxItems: 200,
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['text'],
                properties: {
                    text: { type: 'string', minLength: 1 },
                    category: { enum: ['provider_quirk', 'pattern_to_avoid', 'recovery_lesson'] },
                    createdAt: { type: 'string' },
                    sourceCoordinator: { type: 'string' },
                },
            },
        },
        limits: {
            type: 'object',
            additionalProperties: false,
            properties: {
                maxNoteChars: { type: 'number', minimum: 1 },
                maxNotes: { type: 'number', minimum: 1 },
            },
        },
    },
} as const;

// ─── Shared helpers ─────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseConfigText(path: string, text: string): unknown {
    if (/\.json$/i.test(path)) return JSON.parse(text);
    return yaml.load(text);
}

// ─── Declarative config: Parse / Normalize ──────

function normalizeOperatingNote(value: unknown): CoordinatorOperatingNote | null {
    if (!isRecord(value)) return null;
    const text = typeof value.text === 'string' ? value.text.trim() : '';
    if (!text) return null;
    const category = value.category === 'provider_quirk' || value.category === 'pattern_to_avoid' || value.category === 'recovery_lesson'
        ? value.category
        : undefined;
    return {
        text,
        ...(category ? { category } : {}),
        ...(typeof value.createdAt === 'string' ? { createdAt: value.createdAt } : {}),
        ...(typeof value.sourceCoordinator === 'string' ? { sourceCoordinator: value.sourceCoordinator } : {}),
    };
}

/**
 * Validate + normalize a parsed `.adhdev/mesh.json` object into a typed
 * RepoMeshDeclarativeConfig. Returns the config plus any non-fatal warnings;
 * `valid` is false only when the document is structurally unusable (not an
 * object / wrong version). Unknown top-level keys are tolerated (dropped) so a
 * newer repo file authored against a future schema still loads its known zones.
 */
export function normalizeRepoMeshDeclarativeConfig(parsed: unknown): {
    valid: boolean;
    config?: RepoMeshDeclarativeConfig;
    errors: string[];
} {
    const errors: string[] = [];
    if (!isRecord(parsed)) return { valid: false, errors: ['config must be an object'] };
    if (parsed.version !== 1) {
        return { valid: false, errors: [`version must be 1 (got ${JSON.stringify(parsed.version)})`] };
    }

    const config: RepoMeshDeclarativeConfig = { version: 1 };

    if (parsed.coordinator !== undefined) {
        if (isRecord(parsed.coordinator)) {
            const coord: RepoMeshDeclarativeCoordinatorConfig = {};
            const c = parsed.coordinator;
            if (typeof c.systemPromptOverride === 'string') coord.systemPromptOverride = c.systemPromptOverride;
            if (typeof c.systemPromptAppend === 'string') coord.systemPromptAppend = c.systemPromptAppend;
            if (Number.isFinite(Number(c.maxPromptChars))) coord.maxPromptChars = Number(c.maxPromptChars);
            config.coordinator = coord;
        } else {
            errors.push('coordinator must be an object when provided');
        }
    }

    if (parsed.operatingNotes !== undefined) {
        if (Array.isArray(parsed.operatingNotes)) {
            const notes = parsed.operatingNotes
                .map(normalizeOperatingNote)
                .filter((n): n is CoordinatorOperatingNote => n !== null);
            if (notes.length) config.operatingNotes = notes;
        } else {
            errors.push('operatingNotes must be an array when provided');
        }
    }

    if (parsed.limits !== undefined) {
        if (isRecord(parsed.limits)) {
            const limits: RepoMeshDeclarativeLimits = {};
            if (Number.isFinite(Number(parsed.limits.maxNoteChars))) limits.maxNoteChars = Number(parsed.limits.maxNoteChars);
            if (Number.isFinite(Number(parsed.limits.maxNotes))) limits.maxNotes = Number(parsed.limits.maxNotes);
            if (Object.keys(limits).length) config.limits = limits;
        } else {
            errors.push('limits must be an object when provided');
        }
    }

    return { valid: true, config, errors };
}

// ─── Declarative config: Loader ─────────────────

/**
 * Load the repo-shared declarative mesh config for a coordinator workspace.
 *
 * Resolution: the coordinator node workspace is checked first; if it carries no
 * `.adhdev/mesh.json`, the calling process cwd is tried as a fallback (per the
 * design: "workspace path = coordinator node workspace's .adhdev/mesh.json,
 * else calling cwd"). The first existing file across both bases (and the
 * json/yaml/yml variants) wins.
 *
 * Read/parse errors never throw — they resolve to a sourceType:'invalid'
 * result so a broken repo file degrades to "no repo base" instead of blocking
 * coordinator launch.
 */
export function loadRepoMeshJsonConfig(workspace?: string): RepoMeshJsonConfigLoadResult {
    const bases: string[] = [];
    const ws = typeof workspace === 'string' ? workspace.trim() : '';
    if (ws) bases.push(ws);
    let cwd = '';
    try { cwd = process.cwd(); } catch { /* cwd unavailable in some sandboxes */ }
    if (cwd && cwd !== ws) bases.push(cwd);

    for (const base of bases) {
        for (const relative of MESH_JSON_CONFIG_LOCATIONS) {
            const configPath = join(base, relative);
            if (!existsSync(configPath)) continue;
            try {
                const parsed = parseConfigText(configPath, readFileSync(configPath, 'utf-8'));
                const result = normalizeRepoMeshDeclarativeConfig(parsed);
                if (!result.valid || !result.config) {
                    return { source: relative, sourceType: 'invalid', path: configPath, error: result.errors.join('; ') };
                }
                return { config: result.config, source: relative, sourceType: 'repo_file', path: configPath };
            } catch (error: any) {
                return { source: relative, sourceType: 'invalid', path: configPath, error: error?.message || String(error) };
            }
        }
    }
    return {
        source: 'unavailable',
        sourceType: 'unavailable',
        error: `No repo mesh config found. Checked: ${MESH_JSON_CONFIG_LOCATIONS.join(', ')}`,
    };
}

// ─── Declarative config: Merge (coordinator + operating notes) ─────

/**
 * Effective coordinator config. systemPromptOverride: local wins, else repo.
 * systemPromptAppend: repo append + local append BOTH stack (repo first). Other
 * coordinator fields (providerType, preferredNodeId, …) are carried from the
 * machine-local config unchanged.
 */
export function mergeEffectiveCoordinatorConfig(
    repoCoord: RepoMeshDeclarativeCoordinatorConfig | undefined,
    localCoord: RepoMeshCoordinatorConfig | undefined,
): RepoMeshCoordinatorConfig {
    const out: RepoMeshCoordinatorConfig = { ...(localCoord || {}) };

    const localOverride = localCoord?.systemPromptOverride?.trim();
    const repoOverride = repoCoord?.systemPromptOverride?.trim();
    if (localOverride) {
        out.systemPromptOverride = localCoord!.systemPromptOverride;
    } else if (repoOverride) {
        out.systemPromptOverride = repoCoord!.systemPromptOverride;
    } else {
        delete out.systemPromptOverride;
    }

    const repoAppend = repoCoord?.systemPromptAppend?.trim() ? repoCoord!.systemPromptAppend!.trim() : '';
    // The machine-local append may live on the new field or the legacy alias.
    const localAppendRaw = (localCoord?.systemPromptAppend ?? localCoord?.systemPromptSuffix);
    const localAppend = localAppendRaw?.trim() ? localAppendRaw.trim() : '';
    const stacked = [repoAppend, localAppend].filter(Boolean).join('\n\n');
    if (stacked) {
        out.systemPromptAppend = stacked;
        // The stacked value already folds in any legacy suffix; drop the alias so
        // buildCoordinatorSystemPrompt doesn't risk double-applying it.
        delete out.systemPromptSuffix;
    }

    return out;
}

/**
 * Effective operating notes = repo-declared baseline ⊕ runtime ledger notes.
 * Dedup by trimmed text with the LEDGER note winning (repo duplicates dropped),
 * so a runtime note's freshest wording/category survives. Order: repo baseline
 * first, then ledger notes. Returns undefined when nothing usable remains so the
 * prompt's "## Operating Notes" section is omitted exactly as before.
 */
export function mergeEffectiveOperatingNotes(
    repoNotes: CoordinatorOperatingNote[] | undefined,
    ledgerNotes: CoordinatorOperatingNote[] | undefined,
): CoordinatorOperatingNote[] | undefined {
    const usable = (notes: CoordinatorOperatingNote[] | undefined): CoordinatorOperatingNote[] =>
        Array.isArray(notes) ? notes.filter(n => n && typeof n.text === 'string' && n.text.trim()) : [];
    const repo = usable(repoNotes);
    const ledger = usable(ledgerNotes);
    const ledgerTexts = new Set(ledger.map(n => n.text.trim()));
    const repoKept = repo.filter(n => !ledgerTexts.has(n.text.trim()));
    const merged = [...repoKept, ...ledger];
    return merged.length ? merged : undefined;
}

/**
 * Produce an in-memory effective mesh by layering the repo declarative config
 * UNDER the machine-local mesh entry — coordinator zone ONLY. Policy is
 * machine-local and is left exactly as the stored mesh carries it (never sourced
 * from the repo file). Returns a new object; the input mesh and on-disk
 * meshes.json are never mutated. operatingNotes are merged separately at launch
 * (they ride the prompt context, not the mesh).
 */
export function applyRepoMeshConfig<T extends Pick<LocalMeshEntry, 'coordinator'>>(
    mesh: T,
    repoConfig: RepoMeshDeclarativeConfig | null | undefined,
): T {
    if (!repoConfig) return mesh;
    return {
        ...mesh,
        coordinator: mergeEffectiveCoordinatorConfig(repoConfig.coordinator, mesh.coordinator),
    };
}

// ─── Declarative config: Export scaffold ────────

/**
 * Build a `.adhdev/mesh.json` DRAFT from a machine-local mesh entry. This is a
 * scaffold for the operator to review and commit — NOT an automatic migration.
 * It captures the coordinator prompt override/append so a repo can adopt the
 * current machine's prompt customization as the shared base. Policy is NOT
 * exported — it is machine-local only and has no place in mesh.json. Operating
 * notes are intentionally NOT exported either: those are runtime ledger lessons,
 * and a repo should declare baseline notes deliberately.
 */
export function buildMeshJsonConfigScaffold(
    mesh: Pick<LocalMeshEntry, 'coordinator'>,
): RepoMeshDeclarativeConfig {
    const scaffold: RepoMeshDeclarativeConfig = { version: 1 };
    const coord: RepoMeshDeclarativeCoordinatorConfig = {};
    const override = mesh.coordinator?.systemPromptOverride;
    if (typeof override === 'string' && override.trim()) coord.systemPromptOverride = override;
    const append = mesh.coordinator?.systemPromptAppend ?? mesh.coordinator?.systemPromptSuffix;
    if (typeof append === 'string' && append.trim()) coord.systemPromptAppend = append;
    if (Object.keys(coord).length) scaffold.coordinator = coord;
    return scaffold;
}

/** Serialize a scaffold to the canonical 2-space JSON draft text. */
export function serializeMeshJsonConfigScaffold(config: RepoMeshDeclarativeConfig): string {
    return JSON.stringify(config, null, 2);
}
