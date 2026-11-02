// ---------------------------------------------------------------------------
// turn-ledger/notice-stats — how many coordinator wakes the notice path spent
// ---------------------------------------------------------------------------
// Every notice typed into a PTY coordinator costs it a whole turn (the model
// re-reads its context). The owner could see the waste in transcripts but not
// measure it: this is the counter. Per mesh, in memory (a restart starts a new
// `since`), compact enough to ride on `mesh_status` / `get_pending_mesh_events`.
//
//   delivered   — notices that reached the coordinator, by notify kind
//                 (a coalesced extra counts here too: it WAS delivered)
//   suppressed  — notices claimed without a submit, by `kind:reason`
//   coalesced   — notices that rode inside another notice's message
//   wakes       — messages actually submitted (one per coordinator turn spent)
//
// `delivered − wakes` is therefore the number of turns coalescing saved.
// ---------------------------------------------------------------------------

export interface NoticeStatsSnapshot {
    /** Epoch ms the counters started (process start). */
    since: number;
    /** Messages submitted to a coordinator (turns spent). */
    wakes: number;
    delivered: Record<string, number>;
    /** `kind:reason` → count. */
    suppressed: Record<string, number>;
    coalesced: number;
}

export interface NoticeStats {
    recordDelivered(meshId: string, kind: string): void;
    recordSuppressed(meshId: string, kind: string, reason: string): void;
    /** One submitted message (a wake), carrying `extras` additional coalesced notices. */
    recordWake(meshId: string, extras: number): void;
    /** Compact snapshot, or null when nothing has been counted for the mesh. */
    snapshot(meshId: string): NoticeStatsSnapshot | null;
}

const MAX_KEYS_PER_MAP = 64;

export function createNoticeStats(now: () => number = () => Date.now()): NoticeStats {
    const since = now();
    const meshes = new Map<string, { wakes: number; delivered: Map<string, number>; suppressed: Map<string, number>; coalesced: number }>();
    const of = (meshId: string) => {
        let m = meshes.get(meshId);
        if (!m) { m = { wakes: 0, delivered: new Map(), suppressed: new Map(), coalesced: 0 }; meshes.set(meshId, m); }
        return m;
    };
    const bump = (map: Map<string, number>, key: string) => {
        // Kinds and reasons are closed vocabularies; the cap is a guard against an unexpected key flood.
        if (!map.has(key) && map.size >= MAX_KEYS_PER_MAP) key = 'other';
        map.set(key, (map.get(key) ?? 0) + 1);
    };
    return {
        recordDelivered(meshId, kind) { bump(of(meshId).delivered, kind); },
        recordSuppressed(meshId, kind, reason) { bump(of(meshId).suppressed, `${kind}:${reason}`); },
        recordWake(meshId, extras) {
            const m = of(meshId);
            m.wakes += 1;
            m.coalesced += Math.max(0, extras);
        },
        snapshot(meshId) {
            const m = meshes.get(meshId);
            if (!m || (m.wakes === 0 && m.delivered.size === 0 && m.suppressed.size === 0)) return null;
            return {
                since,
                wakes: m.wakes,
                delivered: Object.fromEntries(m.delivered),
                suppressed: Object.fromEntries(m.suppressed),
                coalesced: m.coalesced,
            };
        },
    };
}
