/**
 * Read-only `project_status` fields of the session-control / host-handoff
 * features (design 2026-11-01 §7.6): identifiers and enums only. Deliberately
 * NOT part of `RoutingSessionEntry`: this never reaches the cloud status path.
 */

import { MeshRuntimeStore } from '../mesh/mesh-runtime-store.js';
import { SqliteHandoffJournal } from '../mesh/host-handoff/journal.js';
import { getStagedControlStore } from './staged-control.js';

export interface ControlStatusFields {
    hostHandoff?: { phase: string; handoffId: string; since: number; role: 'source' | 'target' };
    failover?: { state: 'proposed'; since: number };
}

export function controlStatusFields(meshId: string): ControlStatusFields {
    const out: ControlStatusFields = {};
    try {
        const journal = new SqliteHandoffJournal(MeshRuntimeStore.getInstance().db as never);
        const rec = journal.findActive(meshId, 'source') ?? journal.findActive(meshId, 'target');
        if (rec) out.hostHandoff = { phase: rec.phase, handoffId: rec.handoffId, since: rec.updatedAt, role: rec.role };
    } catch { /* no store yet: nothing to report */ }
    try {
        const card = getStagedControlStore().findOpen(r => r.meshId === meshId && r.trigger === 'quota_exhausted');
        if (card) out.failover = { state: 'proposed', since: card.createdAt };
    } catch { /* staging dir unreadable: nothing to report */ }
    return out;
}
