/**
 * Mission-change notifier. Every structured mission write (coordinator upsert, worker-report
 * hook, late report, refinery merge evidence, answered-decision ack) calls
 * `notifyMissionChanged(meshId)` AFTER its transaction commits. The command router registers
 * a listener bound to `invalidateAggregateMeshStatus`, which drops the aggregate mesh-status
 * cache and fires onMeshStateChange → the `mesh.status` flush — so an open dashboard updates
 * live instead of waiting for a manual refresh.
 *
 * Module-level (not LowFamilyContext) because the writers are also reached from paths that
 * have no router context (worker reports, late reports, refine jobs). Single slot: the last
 * router constructed wins, which is the live daemon; no listener = no-op (unit tests, CLI).
 */
type MissionChangeListener = (meshId: string) => void;

let listener: MissionChangeListener | null = null;

export function setMissionChangeListener(fn: MissionChangeListener | null): void {
    listener = fn;
}

export function notifyMissionChanged(meshId: string): void {
    if (!listener) return;
    try { listener(meshId); } catch { /* a dashboard refresh must never fail a mission write */ }
}
