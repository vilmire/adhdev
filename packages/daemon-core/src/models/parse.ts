/**
 * Model-list parsers — pure functions from a CLI's raw output to a model list.
 *
 * Three formats cover all six discoverable providers (verified against live
 * output on 2026-09-23, samples in `test/models/parse.test.ts`):
 *
 *   json            — `codex debug models` (one JSON object, `models[]`, with
 *                     `visibility` / `priority` / `supported_in_api`)
 *   lines           — `grok models`, `cursor-agent models`, `agy models`,
 *                     `opencode models` (one model per line, provider-specific
 *                     separators, each preceded by banner text)
 *   toml-table-keys — `~/.kimi-code/config.toml` (`[models."<slug>"]` headers)
 *
 * ★These are deliberately TOTAL: every function returns a list, never throws.
 * A parse that understands nothing returns `[]`, and the caller turns that into
 * a `parse` failure which falls back to the manifest. Parsing is the step most
 * likely to meet an output shape nobody anticipated, so it must degrade to
 * "we learned nothing" and never to a crashed refresh.
 */
'use strict';

import type { DiscoveredModel, ModelDiscoveryParse } from './types.js';

/**
 * Strip zero-width and bidi control characters.
 *
 * ★Not hypothetical: `cursor-agent models` emits two U+200B after
 * `grok-4.7-low-fast`, measured 2026-09-23. Passing that through would produce
 * a slug that looks identical to the real one in every UI and log but does not
 * match it, and would be handed to the CLI as a model name that cannot resolve.
 */
function stripInvisible(value: string): string {
    return value.replace(/[​-‏‪-‮⁠﻿]/g, '');
}

function cleanToken(value: unknown): string {
    return typeof value === 'string' ? stripInvisible(value).trim() : '';
}

/** Dedupe by slug, first occurrence wins (source order carries the provider's own ranking). */
function dedupe(models: DiscoveredModel[]): DiscoveredModel[] {
    const seen = new Set<string>();
    const out: DiscoveredModel[] = [];
    for (const model of models) {
        if (!model.slug || seen.has(model.slug)) continue;
        seen.add(model.slug);
        out.push(model);
    }
    return out;
}

/** Walk a dot path (`models`, `data.models`). Returns undefined on any miss. */
function resolvePath(root: unknown, path: string | undefined): unknown {
    if (!path) return root;
    let current: unknown = root;
    for (const segment of path.split('.')) {
        if (!current || typeof current !== 'object') return undefined;
        current = (current as Record<string, unknown>)[segment];
    }
    return current;
}

/**
 * Does a record pass the declared filter?
 *
 * ★Fail closed: a record MISSING a filtered field does not pass. codex's filter
 * is `visibility: 'list'`, and a future record without a `visibility` field is
 * one we know nothing about — admitting it could surface an internal or
 * deprecated model in the user's picker, which is exactly the defect this whole
 * change exists to remove.
 */
function passesFilter(record: Record<string, unknown>, filter: Record<string, string | number | boolean> | undefined): boolean {
    if (!filter) return true;
    for (const [field, expected] of Object.entries(filter)) {
        if (record[field] !== expected) return false;
    }
    return true;
}

/**
 * Parse a JSON document into a model list.
 *
 * ★codex prints ONE object whose `model_messages.persistent_instructions` runs
 * to hundreds of KB of prose — the parse must not be line-oriented, and the
 * caller must not cap stdout so low that the JSON is truncated. See
 * MODEL_DISCOVERY_MAX_OUTPUT_BYTES.
 */
export function parseJsonModels(raw: string, parse: ModelDiscoveryParse): DiscoveredModel[] {
    let root: unknown;
    try {
        root = JSON.parse(raw);
    } catch {
        return [];
    }
    const items = resolvePath(root, parse.itemsPath);
    if (!Array.isArray(items)) return [];

    const slugField = parse.slugField || 'slug';
    const rows: Array<{ model: DiscoveredModel; priority: number; index: number }> = [];

    items.forEach((item, index) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return;
        const record = item as Record<string, unknown>;
        if (!passesFilter(record, parse.filter)) return;
        const slug = cleanToken(record[slugField]);
        if (!slug) return;
        const label = parse.labelField ? cleanToken(record[parse.labelField]) : '';
        const rawPriority = parse.priorityField ? record[parse.priorityField] : undefined;
        // Unranked entries sort after ranked ones, keeping their source order.
        const priority = typeof rawPriority === 'number' && Number.isFinite(rawPriority)
            ? rawPriority
            : Number.MAX_SAFE_INTEGER;
        rows.push({ model: label ? { slug, label } : { slug }, priority, index });
    });

    // Stable sort: priority first, source order as the tiebreak.
    rows.sort((a, b) => (a.priority - b.priority) || (a.index - b.index));
    return dedupe(rows.map((row) => row.model));
}

/**
 * Parse line-oriented output.
 *
 * Every provider here prints banner lines before the list (`Fetching available
 * models...`, `You are logged in with grok.com.`, `Available models`). Rather
 * than a per-provider skip list, a line simply has to MATCH the declared
 * pattern to count — banners do not, so they are excluded structurally.
 */
export function parseLineModels(raw: string, parse: ModelDiscoveryParse): DiscoveredModel[] {
    if (!parse.linePattern) return [];
    let pattern: RegExp;
    try {
        // ★No implicit flags. A pattern's ^/$ must anchor the LINE, and this
        // matches one line at a time — see the FSM-spec `matches` trap where an
        // absent `m` silently changed what an anchor meant.
        pattern = new RegExp(parse.linePattern, parse.lineFlags || '');
    } catch {
        return [];
    }
    const defaultMarker = parse.defaultMarker
        ? (() => { try { return new RegExp(parse.defaultMarker!); } catch { return undefined; } })()
        : undefined;

    const ranked: DiscoveredModel[] = [];
    const rest: DiscoveredModel[] = [];

    for (const rawLine of raw.split(/\r?\n/)) {
        const line = stripInvisible(rawLine);
        if (!line.trim()) continue;
        const match = pattern.exec(line);
        if (!match) continue;
        const slug = cleanToken(match.groups?.slug);
        if (!slug) continue;
        const label = cleanToken(match.groups?.label);
        const model: DiscoveredModel = label ? { slug, label } : { slug };
        // The provider's own default leads the list — see the ordering note in
        // `overlay.ts`: a hand-written array approximates this, the CLI states it.
        if (defaultMarker?.test(line)) ranked.push(model);
        else rest.push(model);
    }
    return dedupe([...ranked, ...rest]);
}

/**
 * Parse TOML table headers into a model list (kimi).
 *
 * Deliberately a header scan, not a TOML parse: we need the keys and their
 * order, and pulling in a TOML dependency to read four header lines would be
 * out of proportion. Values are never read, so a malformed table body cannot
 * affect the result.
 */
export function parseTomlTableKeyModels(raw: string, parse: ModelDiscoveryParse): DiscoveredModel[] {
    if (!parse.tableHeaderPattern) return [];
    let pattern: RegExp;
    try {
        pattern = new RegExp(parse.tableHeaderPattern);
    } catch {
        return [];
    }
    const models: DiscoveredModel[] = [];
    for (const rawLine of raw.split(/\r?\n/)) {
        const line = stripInvisible(rawLine).trim();
        if (!line.startsWith('[')) continue;
        const match = pattern.exec(line);
        const slug = cleanToken(match?.groups?.slug);
        if (slug) models.push({ slug });
    }
    return dedupe(models);
}

/** Dispatch on the declared format. An unknown format yields `[]` (→ `parse` failure → manifest fallback). */
export function parseModels(raw: string, parse: ModelDiscoveryParse): DiscoveredModel[] {
    switch (parse.format) {
        case 'json': return parseJsonModels(raw, parse);
        case 'lines': return parseLineModels(raw, parse);
        case 'toml-table-keys': return parseTomlTableKeyModels(raw, parse);
        default: return [];
    }
}
