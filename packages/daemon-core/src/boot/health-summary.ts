/**
 * buildDaemonHealthSummary — the cheap liveness facts a local IPC `/health`
 * probe or a WS welcome needs (wiring-unification B4, ipc-load-audit row 16).
 *
 * Reads the session registry and the CDP manager map only. It never calls
 * `collectAllStates()` or `buildStatusSnapshot()`, which is what made every
 * `/health` hit and every IPC WS connect build a full status snapshot (twice).
 * The snapshot stays the answer for `/api/v1/status` only.
 */

import type { DaemonComponents } from './daemon-components.js';

export interface DaemonHealthSummary {
    /** Registered sessions of every transport. */
    sessionCount: number;
    /** CLI (PTY) session ids — what the IPC welcome reports as `cliAgents`. */
    cliSessionIds: string[];
    /** At least one IDE is attached over CDP. */
    cdpConnected: boolean;
}

export function buildDaemonHealthSummary(
    components: Pick<DaemonComponents, 'sessionRegistry' | 'cdpManagers'> | null | undefined,
): DaemonHealthSummary {
    if (!components) return { sessionCount: 0, cliSessionIds: [], cdpConnected: false };
    const sessions = components.sessionRegistry.list();
    return {
        sessionCount: sessions.length,
        cliSessionIds: sessions.filter((s) => s.transport === 'pty').map((s) => s.sessionId),
        cdpConnected: components.cdpManagers.size > 0,
    };
}
