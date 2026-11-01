/**
 * Read-side views the project verbs add from the memory archive
 * (docs/design/2026-11-01-assistant-memory.md §3.5): a COUNT of project-scoped
 * entries so the assistant knows a project has memory worth `memory_search`ing.
 * Counts only — never the text — and only when there is something to say.
 */

import type { CommandRouterResult } from '../../commands/router.js';
import type { HighFamilyHandler } from '../../commands/high-family/types.js';
import { getAssistantServices } from '../assistant-services.js';

function counts(): Map<string, number> {
    try {
        return getAssistantServices().memory.archive?.projectCounts() ?? new Map();
    } catch {
        return new Map();
    }
}

function asRecord(v: unknown): Record<string, unknown> | null {
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

/** `projects`: each row with project-scoped memory gets `memoryCount`. */
export function withProjectsMemoryCount(handler: HighFamilyHandler): HighFamilyHandler {
    return async (ctx, args) => {
        const out = await handler(ctx, args) as CommandRouterResult & Record<string, unknown>;
        if (!out || out.success !== true || !Array.isArray(out.projects)) return out;
        const c = counts();
        if (!c.size) return out;
        return {
            ...out,
            projects: out.projects.map((row: unknown) => {
                const r = asRecord(row);
                const n = r && typeof r.meshId === 'string' ? c.get(r.meshId) : undefined;
                return r && n ? { ...r, memoryCount: n } : row;
            }),
        };
    };
}

/** `project_status`: `result.memoryCount` when the project has project-scoped memory. */
export function withStatusMemoryCount(handler: HighFamilyHandler): HighFamilyHandler {
    return async (ctx, args) => {
        const out = await handler(ctx, args) as CommandRouterResult & Record<string, unknown>;
        const body = asRecord(out?.result);
        if (!out || out.success !== true || !body || typeof out.meshId !== 'string') return out;
        const n = counts().get(out.meshId);
        return n ? { ...out, result: { ...body, memoryCount: n } } : out;
    };
}
