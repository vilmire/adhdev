/**
 * RF-ROUTER LOW family — mesh record read / slice commands + operating notes.
 *
 * `get_mesh_ledger` / `get_mesh_ledger_slice` keep their wire names (dashboard,
 * refine job handles' `evidence.ledgerCommand`, remote coordinators over P2P)
 * but read this daemon's `mesh_local_records` + turn outcomes since C-W9a
 * (mesh-local-records.ts). `import_mesh_ledger_slice` is gone with the event
 * ledger: a peer's records are read from the peer (its slice) or the fleet
 * index, never copied into this daemon's local store.
 */
import type { LowFamilyContext, LowFamilyHandler } from './types.js';
import { defineCommandSpecs } from '../command-registry.js';

export const meshLedgerHandlers: Record<string, LowFamilyHandler> = {
    get_mesh_ledger: async (_ctx: LowFamilyContext, args: any) => {
        const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        if (!meshId) return { success: false, error: 'meshId required' };
        try {
            const { readLocalRecords, getLocalRecordSummary } = await import('../../mesh/mesh-local-records.js');
            const tail = typeof args?.tail === 'number' ? args.tail : 20;
            const since = typeof args?.since === 'string' ? args.since : undefined;
            const kind = Array.isArray(args?.kind) ? args.kind.filter((k: any) => typeof k === 'string') : undefined;
            const entries = readLocalRecords(meshId, { tail, since, kind });
            const summary = getLocalRecordSummary(meshId);
            return { success: true, entries, summary };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    get_mesh_ledger_slice: async (_ctx: LowFamilyContext, args: any) => {
        const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        if (!meshId) return { success: false, error: 'meshId required' };
        try {
            const { readLocalRecordSlice } = await import('../../mesh/mesh-local-records.js');
            const kind = Array.isArray(args?.kind) ? args.kind.filter((k: any) => typeof k === 'string') : undefined;
            const slice = readLocalRecordSlice(meshId, {
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
            const { readOperatingNotes, resolveNoteExpiry } = await import('../../mesh/mesh-operating-notes.js');
            const tail = typeof args?.tail === 'number' ? args.tail : 100;
            const entries = readOperatingNotes(meshId, { tail });
            /* Flatten to the shape the notes tab renders: id + note payload fields.
             *
             * `pinned` and the expiry axis were MISSING here (2026-09-02): the tab
             * rendered a "pinned" badge that could never appear, and a note due to
             * expire tonight looked identical to a durable one. Both drive real
             * behaviour — isNoteExpired() drops unpinned notes from every future
             * coordinator prompt — so the dashboard was hiding the one property
             * that decides whether a note survives.
             *
             * effectiveExpiresAt is resolved HERE rather than in the UI because
             * the rule lives here: an explicit expiresAt wins, otherwise the
             * category TTL applies, and some categories are durable. Recomputing
             * that in the browser would mean two copies of the policy. */
            const nowMs = Date.now();
            const notes = entries.map(e => {
                const p = (e.payload || {}) as Record<string, unknown>;
                const createdAt = typeof p.createdAt === 'string' ? p.createdAt : e.timestamp;
                const pinned = p.pinned === true;
                const category = typeof p.category === 'string' ? p.category : undefined;
                const explicitExpiry = typeof p.expiresAt === 'string' ? p.expiresAt : undefined;
                // Policy lives in mesh-ledger; this only projects it.
                const lifetime = resolveNoteExpiry({ category, pinned, createdAt, ...(explicitExpiry ? { expiresAt: explicitExpiry } : {}) }, nowMs);
                return {
                    id: e.id,
                    text: typeof p.text === 'string' ? p.text : '',
                    category,
                    createdAt,
                    sourceCoordinator: typeof p.sourceCoordinator === 'string' ? p.sourceCoordinator : undefined,
                    pinned,
                    ...(explicitExpiry ? { expiresAt: explicitExpiry } : {}),
                    ...(lifetime.effectiveExpiresAt ? { effectiveExpiresAt: lifetime.effectiveExpiresAt } : {}),
                    expired: lifetime.expired,
                    ...(typeof p.subjectKey === 'string' ? { subjectKey: p.subjectKey } : {}),
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
            const { recordOperatingNote } = await import('../../mesh/mesh-operating-notes.js');
            const category = typeof args?.category === 'string' ? args.category : undefined;
            // recordOperatingNote de-dupes identical note text within its recent window.
            const entry = recordOperatingNote(meshId, {
                text,
                ...(category ? { category } : {}),
                sourceCoordinator: 'dashboard',
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
            const { forgetOperatingNote } = await import('../../mesh/mesh-operating-notes.js');
            const reason = typeof args?.reason === 'string' && args.reason.trim()
                ? args.reason.trim()
                : 'dashboard_manual';
            const result = forgetOperatingNote(meshId, {
                ...(noteId ? { noteId } : {}),
                ...(text ? { text } : {}),
                reason,
            });
            return { success: true, matched: result.matched };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },
};

export const meshLedgerSpecs = defineCommandSpecs('low', meshLedgerHandlers, {}, { meshSender: 'authenticated_peer' });
