/**
 * A remote node's presence (`machineStatus`) from its mesh link, when the link
 * is authoritative for it.
 *
 * mesh_status renders a node served by another daemon from what the
 * coordinator HOLDS: its `machineStatus` is 'online' while the member's last
 * push is younger than MESH_NODE_STATE_STALE_MS (2 × the 5-minute push
 * heartbeat). That window is right for a demand-dialed transport (cloud
 * WebRTC), whose link state says nothing about whether the member runs. It is
 * wrong for the standalone direct WebSocket link: the member holds exactly one
 * persistent link to its host for as long as it runs, so a killed member left
 * the node 'online' for up to ten minutes while its link already read
 * `closed` / `connecting` — and the dashboard reads machineStatus first.
 *
 * A transport whose link IS presence marks its peer snapshot `linkIsPresence`
 * (WsMeshTransport.getPeerConnectionStatus). For those nodes the link decides:
 * `connected` → 'online', anything else (closed / failed / disconnected, or a
 * `connecting` peer that only holds queued requests) → 'offline', with health
 * 'offline' and the node not launch-ready. Nodes without the mark keep the held
 * derivation unchanged.
 *
 * Timing (no timer here — it follows the transport's own edges, and the router
 * invalidates the aggregate mesh_status on every peer open / close):
 *   - process killed / exited: the OS closes its socket → offline on the host's
 *     'close' event (immediately);
 *   - silent network loss: the transport's ws ping (WS_MESH_PING_INTERVAL_MS,
 *     20 s) terminates a socket after WS_MESH_MAX_MISSED_PONGS (2) unanswered
 *     pings → offline within ≤ 60 s;
 *   - reconnect: the member redials (first retry 4 s), the socket attaches →
 *     'online' on the open edge. A socket superseded by a newer one (member
 *     reconnect before the old socket closed) swaps peers synchronously, so it
 *     never shows offline.
 */
import { readRecord } from '@adhdev/mesh-shared';

export type MeshNodeLinkPresence = 'online' | 'offline';

/** 'online' / 'offline' when `connection` is an authoritative presence link, else null. */
export function readMeshNodeLinkPresence(connection: unknown): MeshNodeLinkPresence | null {
    const record = readRecord(connection);
    if (record.linkIsPresence !== true || record.source !== 'mesh_peer_status') return null;
    return record.state === 'connected' ? 'online' : 'offline';
}

/**
 * Make a rendered node status agree with its presence link (in place). Returns
 * the presence applied, or null when the link is not authoritative (nothing
 * changed). Idempotent.
 */
export function applyMeshNodeLinkPresence(status: Record<string, unknown>): MeshNodeLinkPresence | null {
    const presence = readMeshNodeLinkPresence(status.connection);
    if (!presence) return null;
    status.machineStatus = presence;
    if (presence === 'offline') {
        status.health = 'offline';
        status.launchReady = false;
    }
    return presence;
}
