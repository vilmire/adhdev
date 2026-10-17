import { readText, sessionIdsEquivalent } from '@adhdev/mesh-shared';

/**
 * Finding a local CLI session by id must not build every session's state.
 * getState() rebuilds the session's whole merged transcript, and these lookups
 * run on queue-claim / reconcile ticks over every CLI instance (2026-10-17: that
 * pattern pinned the preview daemon at 100% CPU). Match on the instance's plain
 * id field and build state only for the instance that matched.
 */

/** A provider instance's id without building its state. CLI instances carry a
 *  plain `instanceId` field; anything else falls back to getState(). */
export function readInstanceIdentity(inst: unknown): string | undefined {
    const field = (inst as { instanceId?: unknown } | null | undefined)?.instanceId;
    if (typeof field === 'string' && field) return field;
    const sid = (inst as { getState?: () => { instanceId?: unknown } } | null | undefined)?.getState?.().instanceId;
    return typeof sid === 'string' ? sid : undefined;
}

interface InstanceSource {
    instanceManager?: {
        getInstance?: (id: string) => unknown;
        getByCategory?: (category: 'cli') => unknown[];
    } | null;
}

/** The local CLI instance for `sessionId` (id-form equivalent), or undefined. */
export function findLocalCliInstance<T = any>(components: InstanceSource, sessionId: string): T | undefined {
    if (!sessionId) return undefined;
    const direct = components.instanceManager?.getInstance?.(sessionId) as { category?: unknown } | undefined;
    if (direct && direct.category === 'cli') return direct as T;
    const instances = components.instanceManager?.getByCategory?.('cli') || [];
    return instances.find((inst) => {
        const sid = readText(readInstanceIdentity(inst));
        return !!sid && sessionIdsEquivalent(sid, sessionId);
    }) as T | undefined;
}
