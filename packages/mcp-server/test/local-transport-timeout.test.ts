import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { LocalTransport } from '../src/transports/local.js';
import { getTimeoutMs } from '../src/transports/ipc.js';

/**
 * D2#3 — LocalTransport had no fetch deadline at all. A standalone daemon that
 * ACCEPTS the connection but never responds (wedged event loop, mid-restart, hung
 * handler) left the MCP tool call pending forever, and an stdio MCP client cannot
 * cancel an in-flight call — so the coordinator hung with no error.
 *
 * These tests stand up a real HTTP server that accepts and never replies, which is
 * exactly the failure mode: a closed port produces ECONNREFUSED and would pass even
 * on the unfixed code, so it would prove nothing. Deadlines are shortened via the
 * IPC default-timeout env knob so the suite stays fast.
 */

/** A server that accepts every request and never writes a response. */
function blackHoleServer(): Promise<{ server: Server; port: number }> {
    return new Promise(resolve => {
        const server = createServer(() => { /* never respond, never end */ });
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, port: (server.address() as AddressInfo).port });
        });
    });
}

/** A server that sends headers then stalls mid-body — the response never completes. */
function stalledBodyServer(): Promise<{ server: Server; port: number }> {
    return new Promise(resolve => {
        const server = createServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '64' });
            res.write('{"success":true,');   // partial body, then hang forever
        });
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, port: (server.address() as AddressInfo).port });
        });
    });
}

async function withEnv<T>(key: string, value: string, fn: () => Promise<T>): Promise<T> {
    const prior = process.env[key];
    process.env[key] = value;
    try {
        return await fn();
    } finally {
        if (prior === undefined) delete process.env[key];
        else process.env[key] = prior;
    }
}

function closeServer(server: Server): Promise<void> {
    return new Promise(resolve => {
        server.closeAllConnections?.();
        server.close(() => resolve());
    });
}

test('D2#3: command() against an accepting-but-silent daemon rejects instead of hanging forever', async () => {
    const { server, port } = await blackHoleServer();
    try {
        await withEnv('ADHDEV_IPC_COMMAND_TIMEOUT_MS', '700', async () => {
            const transport = new LocalTransport({ port });
            const started = Date.now();
            // get_status_metadata has no per-command tier, so it takes the env-overridden
            // default — this asserts the timeout FIRES, which is the whole fix.
            await assert.rejects(
                transport.command('get_status_metadata'),
                /timed out after .*standalone daemon did not respond/,
                'an unanswered command must reject, not hang',
            );
            // Bounded: it gave up near its deadline rather than at some unrelated
            // socket/OS timeout minutes later.
            assert.ok(Date.now() - started < 5_000, 'should reject near its own deadline');
        });
    } finally {
        await closeServer(server);
    }
});

test('D2#3: the deadline also covers a STALLED RESPONSE BODY, not just silent headers', async () => {
    // res.json() awaits the body stream. A deadline that only covered headers would
    // leave this case hanging exactly as before the fix.
    const { server, port } = await stalledBodyServer();
    try {
        await withEnv('ADHDEV_IPC_COMMAND_TIMEOUT_MS', '700', async () => {
            const transport = new LocalTransport({ port });
            await assert.rejects(
                transport.command('get_status_metadata'),
                (e: Error) => /timed out|aborted|terminated/i.test(e.message),
                'a half-written response body must not hang the call',
            );
        });
    } finally {
        await closeServer(server);
    }
});

test('D2#3: getStatus()/ping() fail fast against a silent daemon (liveness must not hang)', async () => {
    const { server, port } = await blackHoleServer();
    try {
        const transport = new LocalTransport({ port });
        const started = Date.now();
        // ping() swallows the error by design — the point is that it RETURNS.
        assert.equal(await transport.ping(), false);
        const elapsed = Date.now() - started;
        assert.ok(elapsed < 15_000, `ping must fail fast, took ${elapsed}ms`);
    } finally {
        await closeServer(server);
    }
});

test('D2#3: per-verb budgets are the IPC tiers, not a second table that can drift', () => {
    // LocalTransport reuses getTimeoutMs, so heavy verbs keep their real budgets
    // instead of false-timing-out on the bare default.
    assert.equal(getTimeoutMs('clone_mesh_node', ''), 120_000);
    assert.equal(getTimeoutMs('git_status', ''), 45_000);
    // Nested/relayed verb resolution: the budget follows the verb being executed.
    assert.equal(getTimeoutMs('mesh_relay_command', 'get_mesh'), 120_000);
});
