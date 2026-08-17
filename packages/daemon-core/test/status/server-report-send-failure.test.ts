import { describe, expect, it } from 'vitest';
import { DaemonStatusReporter } from '../../src/status/reporter.js';

/**
 * A status_report the socket refused must not be recorded as delivered.
 *
 * The cloud ServerConnection.send() reports failure by RETURN VALUE, not by
 * throwing: it returns false when the WS is absent or the connection state is
 * not connected/authenticating (i.e. mid-reconnect), and it catches its own
 * serialization errors and returns false. sendMessage() forwards that boolean.
 *
 * The reporter used to store `lastServerStatusHash` *before* calling
 * sendMessage and ignored the result, so a dropped frame updated the dedup
 * state anyway. Every later report carrying the same payload then matched the
 * hash and was suppressed — the server was left believing an obsolete status.
 *
 * This was survivable only because the periodic path passed forceServer:true
 * and therefore retransmitted unconditionally every 30s. Once periodic began
 * respecting the dedup hash (the idle-dedup change), that accidental safety net
 * disappeared and a single dropped frame could strand the server's view for a
 * full keepalive window — or indefinitely, if the payload never changed again.
 */

function makeReporter(status: { value: string }, sendable: { ok: boolean }) {
    const delivered: Array<{ type: string; data: any }> = [];
    const reporter = new DaemonStatusReporter(
        {
            serverConn: {
                // The reporter's own gate believes the connection is up; the
                // socket underneath is the thing that refuses the frame.
                isConnected: () => true,
                sendMessage: (type, data) => {
                    if (!sendable.ok) return false;
                    delivered.push({ type, data });
                    return true;
                },
                getUserPlan: () => 'pro',
            },
            cdpManagers: new Map(),
            p2p: null,
            providerLoader: { resolve: () => undefined, getAll: () => [] },
            detectedIdes: [],
            instanceId: 'inst-1',
            daemonVersion: '1.0.0',
            instanceManager: {
                collectAllStates: () => ([{
                    category: 'cli',
                    type: 'claude-cli',
                    status: status.value,
                    sessions: [{
                        id: 'sess-1',
                        providerType: 'claude-cli',
                        status: status.value,
                        transport: 'pty',
                        kind: 'agent',
                    }],
                } as any]),
                collectStatesByCategory: () => [],
            },
        },
        { logFn: () => {} },
    );
    const reports = () => delivered.filter((m) => m.type === 'status_report');
    return { reporter, reports };
}

describe('status_report delivery failure', () => {
    it('retransmits a transition that the socket dropped mid-reconnect', async () => {
        const status = { value: 'idle' };
        const sendable = { ok: true };
        const { reporter, reports } = makeReporter(status, sendable);

        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        expect(reports()).toHaveLength(1);
        expect(reports()[0].data.sessions[0].status).toBe('idle');

        // The session starts generating, but the WS is mid-reconnect and the
        // frame never leaves the daemon.
        sendable.ok = false;
        status.value = 'generating';
        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        expect(reports()).toHaveLength(1);

        // Socket recovers. The very next report must carry the transition —
        // the dropped frame must not have poisoned the dedup hash.
        sendable.ok = true;
        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        expect(reports()).toHaveLength(2);
        expect(reports()[1].data.sessions[0].status).toBe('generating');
    });

    it('does not consume the keepalive budget on a failed send', async () => {
        const status = { value: 'idle' };
        const sendable = { ok: true };
        const { reporter, reports } = makeReporter(status, sendable);

        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        expect(reports()).toHaveLength(1);

        // A failed send must leave the dedup state untouched, so the next
        // successful send of the SAME payload still goes out rather than being
        // suppressed as a duplicate of a frame that never arrived.
        sendable.ok = false;
        status.value = 'generating';
        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        sendable.ok = true;

        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        expect(reports()).toHaveLength(2);
    });

    it('treats a void-returning sendMessage as success', async () => {
        // The dep interface allows implementations that return nothing
        // (standalone/test doubles). `undefined` must not be read as failure,
        // or dedup would never engage for them and the idle saving would be
        // silently lost.
        const status = { value: 'idle' };
        const delivered: any[] = [];
        const reporter = new DaemonStatusReporter(
            {
                serverConn: {
                    isConnected: () => true,
                    sendMessage: (type, data) => { delivered.push({ type, data }); },
                    getUserPlan: () => 'pro',
                },
                cdpManagers: new Map(),
                p2p: null,
                providerLoader: { resolve: () => undefined, getAll: () => [] },
                detectedIdes: [],
                instanceId: 'inst-1',
                daemonVersion: '1.0.0',
                instanceManager: {
                    collectAllStates: () => ([{
                        category: 'cli',
                        type: 'claude-cli',
                        status: status.value,
                        sessions: [{ id: 'sess-1', providerType: 'claude-cli', status: status.value, transport: 'pty', kind: 'agent' }],
                    } as any]),
                    collectStatesByCategory: () => [],
                },
            },
            { logFn: () => {} },
        );

        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        expect(delivered).toHaveLength(1);
        // Unchanged payload must now be suppressed — proving the hash was stored.
        await reporter.sendUnifiedStatusReport({ reason: 'periodic' });
        expect(delivered).toHaveLength(1);
    });
});
