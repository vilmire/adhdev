/**
 * Query-time classifier for synthetic mesh artifacts that leaked into a live
 * mesh-runtime.db when tests ran without config-dir isolation.
 *
 * The rows are AUDIT HISTORY of the pollution itself — do not delete them from
 * a live ledger. Aggregations (adoption signals, graph counts, "output_needed"
 * tallies) must call this instead of trusting every mesh_id / coordinator
 * session in the store. Remembering a filter by hand is how the 2026-08-23
 * coordinator misread 8 fixture `output_needed` rows as a product signal.
 *
 * Identifiers are the fixtures' own hard-coded labels:
 *   - coordinatorSessionId `sess-coord` (mcp-server graph tests)
 *   - mesh id prefixes `mesh_adopt_` / `mesh_graph_e_` / `mesh_graph_g_` / `mesh_g4dup_`
 */

const SYNTHETIC_MESH_ID_RE = /^mesh_(adopt_|g4dup_|graph_[eg]_)/;
const SYNTHETIC_COORDINATOR_SESSIONS = new Set(['sess-coord', 'sess-A']);

export function isSyntheticTestMeshId(meshId: string | null | undefined): boolean {
    if (!meshId) return false;
    return SYNTHETIC_MESH_ID_RE.test(meshId);
}

export function isSyntheticTestCoordinatorSession(sessionId: string | null | undefined): boolean {
    if (!sessionId) return false;
    return SYNTHETIC_COORDINATOR_SESSIONS.has(sessionId);
}

export function isMeshTestPollution(args: {
    meshId?: string | null;
    coordinatorSessionId?: string | null;
}): boolean {
    return isSyntheticTestMeshId(args.meshId)
        || isSyntheticTestCoordinatorSession(args.coordinatorSessionId);
}
