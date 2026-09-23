import { describe, expect, it, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { startLocalIpcServer, type LocalIpcServerHandle } from '../../src/ipc/local-ipc-server.js';
import {
    IPC_BUSY_ERROR_CODE,
    IPC_MAX_INFLIGHT_PER_CONNECTION,
    IPC_PROBE_RATE_LIMIT_MAX_CALLS,
    IPC_RATE_LIMITED_ERROR_CODE,
} from '../../src/ipc-protocol.js';

// Audit #12 (IPC load audit, 2026-09-23): end-to-end coverage over the REAL WS
// server — local-ipc-response-logging.test.ts already covers the response-write
// diagnostics; this file covers the new load caps: maxPayload, the per-connection
// in-flight cap, and the probe-verb rate limit, exercised through actual WS frames
// rather than by calling internals directly.

interface ClientWithBuffer {
    ws: WebSocket;
    messages: any[];
}

function waitForMessage(client: ClientWithBuffer, predicate: (msg: any) => boolean, timeoutMs = 3000): Promise<any> {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const poll = () => {
            const found = client.messages.find(predicate);
            if (found) { resolve(found); return; }
            if (Date.now() >= deadline) { reject(new Error('timed out waiting for message')); return; }
            setTimeout(poll, 10);
        };
        poll();
    });
}

function connectClient(port: number): Promise<ClientWithBuffer> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ipc`);
        const messages: any[] = [];
        ws.on('message', (data) => {
            try { messages.push(JSON.parse(data.toString())); } catch { /* ignore */ }
        });
        ws.once('open', () => resolve({ ws, messages }));
        ws.once('error', reject);
    });
}

function sendCommand(client: ClientWithBuffer, command: string, requestId: string, args: Record<string, unknown> = {}) {
    client.ws.send(JSON.stringify({ type: 'ext:command', payload: { command, args, requestId } }));
}

describe('local-ipc-server load caps (audit #12)', () => {
    let handle: LocalIpcServerHandle | null = null;

    afterEach(async () => {
        if (handle) {
            await handle.close();
            handle = null;
        }
    });

    it('rejects a frame larger than the maxPayload with a WS close, not a hang', async () => {
        const port = 19_701;
        handle = await startLocalIpcServer({
            port,
            buildStatusPayload: () => null,
            buildWelcomePayload: () => ({ ok: true }),
            handleCommand: async () => ({ success: true }),
            logCategory: 'IPC-Test-MaxPayload',
        });

        const client = await connectClient(port);
        await waitForMessage(client, (msg) => msg.type === 'daemon:welcome');

        const closed = new Promise<{ code: number }>((resolve) => {
            client.ws.once('close', (code) => resolve({ code }));
        });

        // 40 MiB of args text — over the 32 MiB maxPayload.
        const oversized = 'x'.repeat(40 * 1024 * 1024);
        client.ws.send(JSON.stringify({
            type: 'ext:command',
            payload: { command: 'get_status_metadata', args: { blob: oversized }, requestId: 'req-oversized' },
        }));

        const result = await closed;
        // `ws` closes the connection with 1009 (message too big) when a frame
        // exceeds maxPayload — this is the library's own enforcement, which the
        // maxPayload option (now 32 MiB, was the 100 MiB default) now catches at
        // a much smaller size than before.
        expect(result.code).toBe(1009);
    }, 10_000);

    it('rejects the (N+1)th concurrent command on one connection with a structured ipc_busy error', async () => {
        const port = 19_702;
        // A handler that never resolves on its own — lets us hold N commands
        // "in flight" deterministically and observe the (N+1)th rejected while
        // the first N are still pending.
        const pending: Array<() => void> = [];
        handle = await startLocalIpcServer({
            port,
            buildStatusPayload: () => null,
            buildWelcomePayload: () => ({ ok: true }),
            handleCommand: () => new Promise((resolve) => {
                pending.push(() => resolve({ success: true }));
            }),
            logCategory: 'IPC-Test-InFlight',
        });

        const client = await connectClient(port);
        await waitForMessage(client, (msg) => msg.type === 'daemon:welcome');

        for (let i = 0; i < IPC_MAX_INFLIGHT_PER_CONNECTION; i++) {
            sendCommand(client, 'slow_command', `req-fill-${i}`);
        }
        // Give the server a tick to have accepted all N into "in flight" state.
        await new Promise((r) => setTimeout(r, 50));

        sendCommand(client, 'slow_command', 'req-overflow');
        const overflow = await waitForMessage(client, (msg) => msg.payload?.requestId === 'req-overflow');
        expect(overflow.payload.success).toBe(false);
        expect(overflow.payload.code).toBe(IPC_BUSY_ERROR_CODE);

        // Drain the held handlers so the server can shut down cleanly.
        for (const resolveOne of pending) resolveOne();
        client.ws.close();
    }, 10_000);

    it('rejects the (N+1)th get_status_metadata within the window with a structured rate_limited error carrying retryAfterMs', async () => {
        const port = 19_703;
        handle = await startLocalIpcServer({
            port,
            buildStatusPayload: () => null,
            buildWelcomePayload: () => ({ ok: true }),
            handleCommand: async () => ({ success: true, result: { ok: true } }),
            logCategory: 'IPC-Test-RateLimit',
        });

        const client = await connectClient(port);
        await waitForMessage(client, (msg) => msg.type === 'daemon:welcome');

        for (let i = 0; i < IPC_PROBE_RATE_LIMIT_MAX_CALLS; i++) {
            sendCommand(client, 'get_status_metadata', `req-probe-${i}`);
            await waitForMessage(client, (msg) => msg.payload?.requestId === `req-probe-${i}`);
        }

        sendCommand(client, 'get_status_metadata', 'req-probe-overflow');
        const overflow = await waitForMessage(client, (msg) => msg.payload?.requestId === 'req-probe-overflow');
        expect(overflow.payload.success).toBe(false);
        expect(overflow.payload.code).toBe(IPC_RATE_LIMITED_ERROR_CODE);
        expect(typeof overflow.payload.retryAfterMs).toBe('number');
        expect(overflow.payload.retryAfterMs).toBeGreaterThan(0);

        client.ws.close();
    }, 10_000);

    it('a fresh connection gets its own clean budget — one connection being rate-limited does not affect another', async () => {
        const port = 19_704;
        handle = await startLocalIpcServer({
            port,
            buildStatusPayload: () => null,
            buildWelcomePayload: () => ({ ok: true }),
            handleCommand: async () => ({ success: true, result: { ok: true } }),
            logCategory: 'IPC-Test-PerConnection',
        });

        const clientA = await connectClient(port);
        await waitForMessage(clientA, (msg) => msg.type === 'daemon:welcome');
        for (let i = 0; i < IPC_PROBE_RATE_LIMIT_MAX_CALLS; i++) {
            sendCommand(clientA, 'get_status_metadata', `a-${i}`);
            await waitForMessage(clientA, (msg) => msg.payload?.requestId === `a-${i}`);
        }
        sendCommand(clientA, 'get_status_metadata', 'a-overflow');
        const aOverflow = await waitForMessage(clientA, (msg) => msg.payload?.requestId === 'a-overflow');
        expect(aOverflow.payload.code).toBe(IPC_RATE_LIMITED_ERROR_CODE);

        // A second, independent connection is unaffected.
        const clientB = await connectClient(port);
        await waitForMessage(clientB, (msg) => msg.type === 'daemon:welcome');
        sendCommand(clientB, 'get_status_metadata', 'b-1');
        const bResult = await waitForMessage(clientB, (msg) => msg.payload?.requestId === 'b-1');
        expect(bResult.payload.success).toBe(true);

        clientA.ws.close();
        clientB.ws.close();
    }, 10_000);
});
