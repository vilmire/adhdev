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

    // Coordinator operating-note CRUD, exposed over P2P so the dashboard mesh
    // graph dialog can list / record / forget notes (previously stdio-MCP only).
    list_mesh_notes: async (_ctx: LowFamilyContext, args: any) => {
        const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        if (!meshId) return { success: false, error: 'meshId required' };
        try {
            const { readOperatingNotes } = await import('../../mesh/mesh-ledger.js');
            const tail = typeof args?.tail === 'number' ? args.tail : 100;
            const entries = readOperatingNotes(meshId, { tail });
            // Flatten to the shape the notes tab renders: id + note payload fields.
            const notes = entries.map(e => {
                const p = (e.payload || {}) as Record<string, unknown>;
                return {
                    id: e.id,
                    text: typeof p.text === 'string' ? p.text : '',
                    category: typeof p.category === 'string' ? p.category : undefined,
                    createdAt: typeof p.createdAt === 'string' ? p.createdAt : e.timestamp,
                    sourceCoordinator: typeof p.sourceCoordinator === 'string' ? p.sourceCoordinator : undefined,
                };
            });
            return { success: true, notes };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    record_mesh_note: async (_ctx: LowFamilyContext, args: any) => {
        const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        if (!meshId) return { success: false, error: 'meshId required' };
        const text = typeof args?.text === 'string' ? args.text.trim() : '';
        if (!text) return { success: false, error: 'text required' };
        try {
            const { appendLedgerEntry } = await import('../../mesh/mesh-ledger.js');
            const category = typeof args?.category === 'string' ? args.category : undefined;
            // appendLedgerEntry de-dupes identical note text within its recent window.
            const entry = appendLedgerEntry(meshId, {
                kind: 'coordinator_operating_note',
                payload: {
                    text,
                    ...(category ? { category } : {}),
                    createdAt: new Date().toISOString(),
                    sourceCoordinator: 'dashboard',
                },
            });
            return { success: true, id: entry.id };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    forget_mesh_note: async (_ctx: LowFamilyContext, args: any) => {
        const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        if (!meshId) return { success: false, error: 'meshId required' };
        const noteId = typeof args?.noteId === 'string' ? args.noteId.trim() : '';
        const text = typeof args?.text === 'string' ? args.text.trim() : '';
        if (!noteId && !text) return { success: false, error: 'noteId or text required' };
        try {
            const { tombstoneOperatingNote } = await import('../../mesh/mesh-ledger.js');
            const reason = typeof args?.reason === 'string' && args.reason.trim()
                ? args.reason.trim()
                : 'dashboard_manual';
            const result = tombstoneOperatingNote(meshId, {
                ...(noteId ? { noteId } : {}),
                ...(text ? { text } : {}),
                reason,
            });
            return { success: true, matched: result.matched };
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
