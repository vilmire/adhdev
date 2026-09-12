import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { WebSocket } from 'ws';
import { startLocalIpcServer, type LocalIpcServerHandle } from '../../src/ipc/local-ipc-server.js';
import { getLogLevel, getRecentLogs, setLogLevel } from '../../src/logging/logger.js';

// IPC TIMEOUT DIAGNOSTICS (daemon side): the response write path had zero
// logging, so a client-observed timeout could never be correlated against
// "did the daemon actually finish the handler and attempt to reply". These
// tests exercise the real WS server (not just the pure HTTP-route function
// already covered by local-ipc-status-routes.test.ts) and assert the new
// response-write log line carries requestId/command/handlerMs/payloadBytes.

// The server sends `daemon:welcome` synchronously from its 'connection'
// handler, which can race a client-side listener attached only AFTER the
// client's own 'open' promise resolves (both events derive from the same
// handshake completion, in unspecified relative order). Buffering every
// message from socket construction — instead of attaching a fresh listener
// per wait — makes waitForMessage() see messages regardless of that race.
interface ClientWithBuffer {
    ws: WebSocket;
    messages: any[];
}

function waitForMessage(client: ClientWithBuffer, predicate: (msg: any) => boolean, timeoutMs = 2000): Promise<any> {
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

describe('local-ipc-server response write logging', () => {
    let handle: LocalIpcServerHandle | null = null;
    let previousLogLevel = getLogLevel();
    const port = 19_611;

    beforeEach(() => {
        previousLogLevel = getLogLevel();
    });

    afterEach(async () => {
        setLogLevel(previousLogLevel);
        if (handle) {
            await handle.close();
            handle = null;
        }
    });

    it('logs a debug-level response-sent line with requestId, command, handlerMs, payloadBytes when debug enabled', async () => {
        setLogLevel('debug');
        handle = await startLocalIpcServer({
            port,
            buildStatusPayload: () => null,
            buildWelcomePayload: () => ({ ok: true }),
            handleCommand: async () => ({ success: true, result: { echoed: true } }),
            logCategory: 'IPC-Test',
        });

        const client = await connectClient(port);
        try {
            await waitForMessage(client, (msg) => msg.type === 'daemon:welcome');
            client.ws.send(JSON.stringify({
                type: 'ext:command',
                payload: { command: 'get_status_metadata', args: {}, requestId: 'req-debug-1' },
            }));
            const result = await waitForMessage(client, (msg) => msg.type === 'ext:command_result' && msg.payload?.requestId === 'req-debug-1');
            expect(result.payload.success).toBe(true);

            const logs = getRecentLogs(200, 'debug');
            const responseLog = logs.find(l => l.category === 'IPC-Test' && l.message.includes('response sent:'));
            expect(responseLog).toBeTruthy();
            expect(responseLog!.message).toContain(`requestId=req-debug-1`);
            expect(responseLog!.message).toContain(`command='get_status_metadata'`);
            expect(responseLog!.message).toMatch(/handlerMs=\d+/);
            expect(responseLog!.message).toMatch(/payloadBytes=\d+/);
        } finally {
            client.ws.close();
        }
    });

    it('does not emit the debug response-sent line at default (info) log level — quiet hot path', async () => {
        setLogLevel('info');
        handle = await startLocalIpcServer({
            port: port + 1,
            buildStatusPayload: () => null,
            buildWelcomePayload: () => ({ ok: true }),
            handleCommand: async () => ({ success: true, result: { echoed: true } }),
            logCategory: 'IPC-Test-Quiet',
        });

        const client = await connectClient(port + 1);
        try {
            await waitForMessage(client, (msg) => msg.type === 'daemon:welcome');
            client.ws.send(JSON.stringify({
                type: 'ext:command',
                payload: { command: 'get_status_metadata', args: {}, requestId: 'req-quiet-1' },
            }));
            await waitForMessage(client, (msg) => msg.type === 'ext:command_result' && msg.payload?.requestId === 'req-quiet-1');

            const logs = getRecentLogs(200, 'debug');
            const responseLog = logs.find(l => l.category === 'IPC-Test-Quiet' && l.message.includes('response sent:'));
            expect(responseLog).toBeFalsy();
        } finally {
            client.ws.close();
        }
    });

    it('logs a warn-level line when the response write fails (socket already closed)', async () => {
        setLogLevel('info');
        handle = await startLocalIpcServer({
            port: port + 2,
            buildStatusPayload: () => null,
            buildWelcomePayload: () => ({ ok: true }),
            handleCommand: async () => {
                // Simulate a handler that takes just long enough for the client
                // to disconnect before the response is written.
                await new Promise(resolve => setTimeout(resolve, 50));
                return { success: true, result: { echoed: true } };
            },
            logCategory: 'IPC-Test-Closed',
        });

        const client = await connectClient(port + 2);
        await waitForMessage(client, (msg) => msg.type === 'daemon:welcome');
        client.ws.send(JSON.stringify({
            type: 'ext:command',
            payload: { command: 'slow_command', args: {}, requestId: 'req-closed-1' },
        }));
        client.ws.close();

        // Give the handler time to finish and attempt (and fail) the write.
        await new Promise(resolve => setTimeout(resolve, 200));

        const logs = getRecentLogs(200, 'warn');
        const warnLog = logs.find(l => l.category === 'IPC-Test-Closed' && l.message.includes('response write skipped'));
        expect(warnLog).toBeTruthy();
        expect(warnLog!.message).toContain('req-closed-1');
        expect(warnLog!.message).toContain(`command='slow_command'`);
    });
});
