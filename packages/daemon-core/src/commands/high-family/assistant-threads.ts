/**
 * Projects the assistant is following (its open relay threads), for the
 * dashboard (2026-10-18): list them, and stop following one. The list is
 * read-only and also answers a local (`ipc`) client such as a password-less
 * standalone dashboard; stopping is owner-only (never `ipc`).
 */
import { ASSISTANT_VERB } from '@adhdev/mesh-shared';
import { defineCommandSpecs } from '../command-registry.js';
import { ASSISTANT_OWNER_SOURCES } from './assistant-store.js';
import { getAssistantServices } from '../../assistant/assistant-services.js';
import { projectSlugs } from '../../assistant/assistant-projects.js';
import type { HighFamilyHandler } from './types.js';

export interface AssistantThreadView {
    meshId: string;
    /** Project slug, or null when the project no longer exists (the relay closes it on its next tick). */
    project: string | null;
    openedAt: number;
    lastSendAt: number;
}

async function runtimeOrNull() {
    // Lazy: assistant-runtime imports the command layer (cycle).
    const { getAssistantRuntime } = await import('../../assistant/assistant-runtime.js');
    return getAssistantRuntime();
}

function slugsNow(): Map<string, string> {
    try { return projectSlugs(getAssistantServices().listMeshes()); } catch { return new Map(); }
}

const list: HighFamilyHandler = async () => {
    const runtime = await runtimeOrNull();
    if (!runtime) return { success: true, threads: [] };
    const slugs = slugsNow();
    const threads: AssistantThreadView[] = runtime.store.openThreads().map((t) => ({
        meshId: t.meshId,
        project: slugs.get(t.meshId) ?? null,
        openedAt: t.openedAt,
        lastSendAt: t.lastSendAt,
    }));
    threads.sort((a, b) => b.lastSendAt - a.lastSendAt);
    return { success: true, threads };
};

const close: HighFamilyHandler = async (_ctx, args) => {
    const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
    if (!meshId || meshId.length > 200) return { success: false, code: 'invalid_args', error: 'meshId required' };
    const runtime = await runtimeOrNull();
    if (!runtime) return { success: false, code: 'assistant_unavailable' };
    const closed = runtime.relay.closeThread(meshId);
    return { success: true, closed };
};

export const assistantThreadSpecs = defineCommandSpecs('high', {
    [ASSISTANT_VERB.threads]: list,
    [ASSISTANT_VERB.threadClose]: close,
}, {
    [ASSISTANT_VERB.threads]: { sources: [...ASSISTANT_OWNER_SOURCES, 'ipc'] },
    [ASSISTANT_VERB.threadClose]: { sources: [...ASSISTANT_OWNER_SOURCES] },
});
