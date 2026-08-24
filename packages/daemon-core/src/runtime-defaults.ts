export const DEFAULT_CDP_SCAN_INTERVAL_MS = 30_000;
export const DEFAULT_CDP_DISCOVERY_INTERVAL_MS = 30_000;

export const DEFAULT_STATUS_INITIAL_REPORT_DELAY_MS = 2_000;
export const DEFAULT_STATUS_SERVER_REPORT_INTERVAL_MS = 30_000;
export const DEFAULT_STATUS_P2P_REPORT_INTERVAL_MS = 5_000;

export const MIN_MACHINE_RUNTIME_SUBSCRIPTION_INTERVAL_MS = 5_000;
export const DEFAULT_MACHINE_RUNTIME_SUBSCRIPTION_INTERVAL_MS = 15_000;

export const MIN_SESSION_HOST_DIAGNOSTICS_SUBSCRIPTION_INTERVAL_MS = 5_000;
export const DEFAULT_SESSION_HOST_DIAGNOSTICS_SUBSCRIPTION_INTERVAL_MS = 10_000;

export const DEFAULT_SESSION_HOST_READY_TIMEOUT_MS = 15_000;

export const STANDALONE_CDP_SCAN_INTERVAL_MS = 15_000;

// Default HTTP/WS port of the standalone daemon (localhost:3847). Single source
// of truth for every client that dials the standalone surface (daemon-standalone
// itself, the MCP server's local transport, dashboards).
export const DEFAULT_STANDALONE_PORT = 3847;

// ---------------------------------------------------------------------------
// Mesh P2P timeout windows (env-overridable)
// ---------------------------------------------------------------------------

// Reads a mesh timeout (ms) from the first non-empty env var in `names`, clamped
// to [1_000, 120_000]; falls back to `defaultMs` when none is set or the value is
// out of range. The clamp lets a slow real link be tuned up (TURN-relayed peers
// whose RTT is many seconds) and lets the test harness shrink the window to its
// 1s minimum, without ever degenerating to 0 or an absurd value. Multiple names
// are accepted so a renamed constant can keep honoring a legacy alias.
export function readMeshTimeoutEnvMs(names: string | string[], defaultMs: number): number {
    const candidates = Array.isArray(names) ? names : [names];
    for (const name of candidates) {
        const raw = process.env[name]?.trim();
        if (!raw) continue;
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed) && parsed >= 1_000 && parsed <= 120_000) return parsed;
        return defaultMs;
    }
    return defaultMs;
}

// SINGLE source of truth for the mesh cold-open *connect* budget — the time a
// caller grants a peer whose mesh DataChannel is not open yet to drive the
// cross-machine (often TURN-relayed) ICE/DTLS handshake before the response
// deadline takes over. Two call sites share this so an env override tunes BOTH:
//   - commands/router.ts direct-peer git_status probe (requireDirectPeerTruth)
//   - mesh/mesh-events-coordinator.ts remote task-dispatch (deliverTaskToSession)
// Before unification the coordinator hard-coded 45_000 while the router was
// env-overridable, so setting the env tuned the probe path but silently left the
// dispatch path at 45s — the same nominal 45s, but divergent the moment the env
// was set. Matches the daemon-cloud DaemonMeshManager CONNECT_TIMEOUT_MS (45s).
// `MESH_DIRECT_PROBE_CONNECT_TIMEOUT_MS` is honored as a backward-compat alias so
// environments already tuned under the old name keep working.
export const MESH_CONNECT_TIMEOUT_MS = readMeshTimeoutEnvMs(
    ['MESH_CONNECT_TIMEOUT_MS', 'MESH_DIRECT_PROBE_CONNECT_TIMEOUT_MS'],
    45_000,
);
