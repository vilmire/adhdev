/**
 * External provider sources — registry + active-selection state.
 *
 * A user can register one or more 3rd-party git URLs as provider sources.
 * Each source clones into ~/.adhdev/external/<source-name>/, namespaced so
 * that two sources can disk-coexist providing the same provider type.
 *
 * When two sources expose the same type, only one is "active" at a time.
 * The active selection is persisted so a user's choice survives daemon
 * restarts. When only one source provides a type, no explicit selection
 * is needed and the loader falls through to that source.
 */
'use strict';

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getConfigDir } from '../config/config.js';

export interface ExternalSource {
    /** Unique short identifier, e.g. "@vendor-x". User-supplied or derived from the URL. */
    name: string;
    /** Full git URL (https://, git@, …). */
    url: string;
    /** Branch / tag / commit-ish to track. Defaults to `main`. */
    ref: string;
    /** ISO timestamp when first registered. */
    addedAt: string;
}

export interface ExternalSourcesFile {
    /** Schema version — bump if shape changes. */
    schema: 1;
    sources: ExternalSource[];
}

/**
 * Per-type active source selection. Only types reachable from more than
 * one source need an entry — single-source types have no ambiguity.
 *
 * Shape: { active: { "<type>": "<source-name>" } }
 */
export interface ProvidersActiveFile {
    schema: 1;
    active: Record<string, string>;
}

const SOURCES_FILENAME = 'providers-sources.json';
const ACTIVE_FILENAME = 'providers-active.json';

function adhdevDir(): string {
    // Instance config dir — external source clones and the active-selection
    // pointers are per-instance mutable state.
    return getConfigDir();
}

export function externalRoot(): string {
    return path.join(adhdevDir(), 'external');
}

export function sourcesFilePath(): string {
    return path.join(adhdevDir(), SOURCES_FILENAME);
}

export function activeFilePath(): string {
    return path.join(adhdevDir(), ACTIVE_FILENAME);
}

function ensureAdhdevDir(): void {
    const d = adhdevDir();
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

export function loadExternalSources(): ExternalSourcesFile {
    const p = sourcesFilePath();
    if (!fs.existsSync(p)) return { schema: 1, sources: [] };
    try {
        const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (!raw || typeof raw !== 'object') return { schema: 1, sources: [] };
        const sources = Array.isArray(raw.sources) ? raw.sources.filter(isValidSource) : [];
        return { schema: 1, sources };
    } catch {
        return { schema: 1, sources: [] };
    }
}

export function saveExternalSources(file: ExternalSourcesFile): void {
    ensureAdhdevDir();
    const tmp = sourcesFilePath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmp, sourcesFilePath());
}

export function loadProvidersActive(): ProvidersActiveFile {
    const p = activeFilePath();
    if (!fs.existsSync(p)) return { schema: 1, active: {} };
    try {
        const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (!raw || typeof raw !== 'object') return { schema: 1, active: {} };
        const active = raw.active && typeof raw.active === 'object' ? raw.active : {};
        return { schema: 1, active };
    } catch {
        return { schema: 1, active: {} };
    }
}

export function saveProvidersActive(file: ProvidersActiveFile): void {
    ensureAdhdevDir();
    const tmp = activeFilePath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmp, activeFilePath());
}

function isValidSource(x: unknown): x is ExternalSource {
    if (!x || typeof x !== 'object') return false;
    const s = x as Record<string, unknown>;
    return typeof s.name === 'string' && s.name.length > 0
        && typeof s.url === 'string' && s.url.length > 0
        && typeof s.ref === 'string' && s.ref.length > 0
        && typeof s.addedAt === 'string';
}

/**
 * Derive a short identifier from a git URL when the user didn't supply one.
 *   https://github.com/vendor/extra-providers.git → "@vendor-extra-providers"
 *   git@github.com:vendor/extra-providers       → "@vendor-extra-providers"
 *
 * Idempotent; safe to call before validation since it produces a string
 * regardless of input shape.
 */
export function deriveSourceName(url: string): string {
    const m = url.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/);
    if (!m) return '@source';
    const owner = m[1].toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    const repo = m[2].toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    return `@${owner}-${repo}`;
}

/**
 * Return the per-source category/type tree currently on disk under
 * ~/.adhdev/external/<source>/. Used by the conflict detector and by
 * list_provider_sources.
 */
export interface SourceInventoryEntry {
    sourceName: string;
    /** Map: category → list of provider types. */
    providers: Record<string, string[]>;
}

export function inventoryExternalSources(): SourceInventoryEntry[] {
    const root = externalRoot();
    if (!fs.existsSync(root)) return [];
    const out: SourceInventoryEntry[] = [];
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); }
    catch { return []; }
    for (const sourceEntry of entries) {
        if (!sourceEntry.isDirectory()) continue;
        const sourceName = sourceEntry.name;
        const sourceDir = path.join(root, sourceName);
        const providers: Record<string, string[]> = {};
        let categoryEntries: fs.Dirent[];
        try { categoryEntries = fs.readdirSync(sourceDir, { withFileTypes: true }); }
        catch { continue; }
        for (const categoryEntry of categoryEntries) {
            if (!categoryEntry.isDirectory()) continue;
            const category = categoryEntry.name;
            const categoryDir = path.join(sourceDir, category);
            let typeEntries: fs.Dirent[];
            try { typeEntries = fs.readdirSync(categoryDir, { withFileTypes: true }); }
            catch { continue; }
            const types: string[] = [];
            for (const typeEntry of typeEntries) {
                if (!typeEntry.isDirectory()) continue;
                // Only count it as a provider if a manifest file exists
                const typeDir = path.join(categoryDir, typeEntry.name);
                const hasV1 = fs.existsSync(path.join(typeDir, 'provider.v1.json'));
                const hasV0 = fs.existsSync(path.join(typeDir, 'provider.json'));
                if (hasV1 || hasV0) types.push(typeEntry.name);
            }
            if (types.length > 0) providers[category] = types;
        }
        out.push({ sourceName, providers });
    }
    return out;
}

/**
 * For a given category+type, list every source that currently exposes it.
 * Returns source names in disk-walk order; callers can use the first one
 * when no explicit active selection exists.
 */
export function sourcesProviding(category: string, type: string): string[] {
    const inventory = inventoryExternalSources();
    return inventory
        .filter(s => (s.providers[category] || []).includes(type))
        .map(s => s.sourceName);
}

/**
 * Resolve which source should be active for a given category+type.
 *   - If exactly one source provides it → that source.
 *   - If multiple sources provide it → the one named in providers-active.json
 *     (when present) or null (ambiguous; loader should warn and pick
 *     the first deterministically so daemon doesn't refuse to boot).
 *   - If none → null.
 */
export function resolveActiveSource(
    category: string,
    type: string,
    activeFile?: ProvidersActiveFile,
): { source: string | null; ambiguous: boolean; candidates: string[] } {
    const candidates = sourcesProviding(category, type);
    if (candidates.length === 0) return { source: null, ambiguous: false, candidates };
    if (candidates.length === 1) return { source: candidates[0], ambiguous: false, candidates };
    const explicit = (activeFile ?? loadProvidersActive()).active[type];
    if (explicit && candidates.includes(explicit)) {
        return { source: explicit, ambiguous: false, candidates };
    }
    return { source: candidates[0], ambiguous: true, candidates };
}
