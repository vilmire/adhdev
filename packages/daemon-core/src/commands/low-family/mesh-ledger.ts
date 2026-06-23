/**
 * RF-ROUTER LOW family — mesh ledger read / slice / import commands.
 *
 * Extracted verbatim from DaemonCommandRouter.executeDaemonCommand. Each handler
 * touches only the on-disk mesh ledger (dynamically imported mesh-ledger module)
 * keyed by meshId — no router instance state — and returns the same
 * CommandRouterResult the inlined cases did.
 */
import type { LowFamilyContext, LowFamilyHandler } from './types.js';

export const meshLedgerHandlers: Record<string, LowFamilyHandler> = {
    get_mesh_ledger: async (_ctx: LowFamilyContext, args: any) => {
        const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        if (!meshId) return { success: false, error: 'meshId required' };
        try {
            const { readLedgerEntries, getLedgerSummary } = await import('../../mesh/mesh-ledger.js');
            const tail = typeof args?.tail === 'number' ? args.tail : 20;
            const since = typeof args?.since === 'string' ? args.since : undefined;
            const kind = Array.isArray(args?.kind) ? args.kind.filter((k: any) => typeof k === 'string') : undefined;
            const entries = readLedgerEntries(meshId, { tail, since, kind });
            const summary = getLedgerSummary(meshId);
            return { success: true, entries, summary };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    get_mesh_ledger_slice: async (_ctx: LowFamilyContext, args: any) => {
        const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        if (!meshId) return { success: false, error: 'meshId required' };
        try {
            const { readLedgerSlice } = await import('../../mesh/mesh-ledger.js');
            const kind = Array.isArray(args?.kind) ? args.kind.filter((k: any) => typeof k === 'string') : undefined;
            const slice = readLedgerSlice(meshId, {
                afterId: typeof args?.afterId === 'string' ? args.afterId : undefined,
                since: typeof args?.since === 'string' ? args.since : undefined,
                kind,
                limit: typeof args?.limit === 'number' ? args.limit : undefined,
            });
            return { success: true, slice };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    import_mesh_ledger_slice: async (_ctx: LowFamilyContext, args: any) => {
        const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        if (!meshId) return { success: false, error: 'meshId required' };
        try {
            const { appendRemoteLedgerEntries, getLedgerSummary } = await import('../../mesh/mesh-ledger.js');
            const entries = Array.isArray(args?.entries)
                ? args.entries as any[]
                : Array.isArray(args?.slice?.entries)
                    ? args.slice.entries as any[]
                    : [];
            const result = appendRemoteLedgerEntries(meshId, entries as any);
            return { success: true, result, summary: getLedgerSummary(meshId) };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },
};
