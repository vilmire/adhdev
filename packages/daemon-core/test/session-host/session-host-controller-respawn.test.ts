/**
 * A dead session host must be respawned by the reconnect loop itself — not only
 * when a new session launch happens to call ensureReady (2026-10-06: Windows host
 * exited with code 1, daemon re-dialled a dead pipe for 71 minutes).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SessionHostClient } from '@adhdev/session-host-core';
import { SessionHostServer } from '@adhdev/session-host-daemon';
import { SessionHostController } from '../../src/session-host/session-host-controller.js';
import { bootSessionHost } from '../../src/session-host/host-bootstrap.js';
import { SessionHostPtyTransportFactory } from '../../src/cli-adapters/session-host-transport.js';

const deadEndpoint = () => (process.platform === 'win32'
    ? { kind: 'pipe', path: `\\\\.\\pipe\\adhdev-test-dead-${process.pid}-${Date.now()}` }
    : { kind: 'unix', path: path.join(os.tmpdir(), `adhdev-test-dead-${process.pid}-${Date.now()}.sock`) }) as any;

async function failConnects(controller: SessionHostController, times: number) {
    (controller as any).started = true;
    for (let i = 0; i < times; i += 1) await (controller as any).ensureConnected();
}

describe('SessionHostController dead-host respawn', () => {
    it('respawns after 3 consecutive failures, then every 15 more', async () => {
        const respawn = vi.fn(async () => {});
        const controller = new SessionHostController(deadEndpoint(), undefined, respawn);
        await failConnects(controller, 2);
        expect(respawn).not.toHaveBeenCalled();
        await failConnects(controller, 1);
        expect(respawn).toHaveBeenCalledTimes(1);
        await failConnects(controller, 14);
        expect(respawn).toHaveBeenCalledTimes(1);
        await failConnects(controller, 1);
        expect(respawn).toHaveBeenCalledTimes(2);
        await controller.stop();
    });

    it('never overlaps respawns and survives a failing one', async () => {
        let release!: () => void;
        const respawn = vi.fn(() => new Promise<void>((_, reject) => { release = () => reject(new Error('disk critical')); }));
        const controller = new SessionHostController(deadEndpoint(), undefined, respawn);
        await failConnects(controller, 18); // 3 and 18 both due, but the first is still running
        expect(respawn).toHaveBeenCalledTimes(1);
        release();
        await new Promise((r) => setImmediate(r));
        await failConnects(controller, 15); // 33
        expect(respawn).toHaveBeenCalledTimes(2);
        await controller.stop();
    });

    it('does nothing without a respawn hook (back-compat)', async () => {
        const controller = new SessionHostController(deadEndpoint());
        await expect(failConnects(controller, 5)).resolves.toBeUndefined();
        await controller.stop();
    });

    it('bootSessionHost wires ensureReady as the respawn hook, single-flight', async () => {
        let resolveReady!: (e: any) => void;
        const ensureReady = vi.fn()
            .mockResolvedValueOnce({ kind: 'unix', path: '/tmp/a.sock' })
            .mockImplementation(() => new Promise((r) => { resolveReady = r; }));
        let respawn!: () => Promise<unknown>;
        const handle = await bootSessionHost({
            ensureReady,
            clientId: 'daemon_mach_1',
            managedBy: 'adhdev-cloud',
            createController: (_e, _cb, hook) => { respawn = hook; return { start: async () => {}, stop: async () => {} } as any; },
        });
        const a = respawn();
        const b = handle.ensure();
        expect(ensureReady).toHaveBeenCalledTimes(2); // boot + one shared respawn
        resolveReady({ kind: 'unix', path: '/tmp/b.sock' });
        await Promise.all([a, b]);
        expect(handle.endpoint()).toEqual({ kind: 'unix', path: '/tmp/b.sock' });
    });

    it('forces client.disconnect() after 2 consecutive request failures before reconnecting', async () => {
        const controller = new SessionHostController(deadEndpoint());
        const disconnectSpy = vi.fn();
        let connectCalls = 0;
        let requestCalls = 0;
        (controller as any).client = {
            connect: vi.fn(async () => {
                connectCalls += 1;
            }),
            disconnect: disconnectSpy,
            close: vi.fn(async () => {}),
            request: vi.fn(async () => {
                requestCalls += 1;
                if (requestCalls <= 2) {
                    throw new Error('Session host request timed out after 30s (list_sessions)');
                }
                return { success: true, result: [{ sessionId: 'recovered-after-disconnect' }] };
            }),
        };

        await expect(controller.listSessions()).rejects.toThrow(/timed out/);
        expect(disconnectSpy).not.toHaveBeenCalled();

        await expect(controller.listSessions()).rejects.toThrow(/timed out/);
        expect(disconnectSpy).toHaveBeenCalled();

        const sessions = await controller.listSessions();
        expect(sessions).toEqual([{ sessionId: 'recovered-after-disconnect' }]);
        expect(connectCalls).toBe(3);
        await controller.stop();
    });

    it('H1: SessionHostPtyTransport re-attaches after disconnectClients and still receives session_output and session_exit', async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-transport-reattach-'));
        const endpoint = { kind: 'unix' as const, path: path.join(tmp, 'host.sock') };
        const server = new SessionHostServer({
            appName: `adhdev-transport-reattach-${process.pid}`,
            endpoint,
            storageRootDir: path.join(tmp, 'storage'),
        });
        await server.start();

        const record = server.registry.createSession({
            sessionId: 'sess-h1-transport',
            providerType: 'codex',
            category: 'cli',
            workspace: tmp,
            launchCommand: { command: process.execPath, args: ['-e', ''] },
        });
        server.registry.markStarted(record.sessionId, process.pid);
        (server as any).runtimes.set(record.sessionId, {
            write: (data: string) => {
                const { seq } = server.registry.appendOutput(record.sessionId, data);
                (server as any).emitEvent({
                    type: 'session_output',
                    sessionId: record.sessionId,
                    seq,
                    data,
                });
            },
            resize: () => {},
            stop: () => {},
        });

        const factory = new SessionHostPtyTransportFactory({
            endpoint,
            clientId: 'daemon-h1-client',
            runtimeId: record.sessionId,
            providerType: 'codex',
            workspace: tmp,
            attachExisting: true,
        });
        const transport = factory.spawn(process.execPath, ['-e', ''], { cwd: tmp, cols: 80, rows: 24 });
        const receivedData: string[] = [];
        const receivedExits: any[] = [];
        transport.onData((chunk) => receivedData.push(chunk));
        transport.onExit((info) => receivedExits.push(info));

        try {
            await (transport as any).ready;

            // Disconnect all clients for this endpoint (simulating timeout teardown / disconnectClients)
            SessionHostClient.disconnectClients(endpoint, new Error('simulated disconnect'));

            // Wait briefly for transport to auto-reconnect and re-attach even without a new write()
            await new Promise((resolve) => setTimeout(resolve, 80));

            // Server emits output and exit for the session; re-subscribed transport must receive both!
            const { seq } = server.registry.appendOutput(record.sessionId, 'hello-after-reconnect\n');
            (server as any).emitEvent({
                type: 'session_output',
                sessionId: record.sessionId,
                seq,
                data: 'hello-after-reconnect\n',
            });
            (server as any).emitEvent({
                type: 'session_exit',
                sessionId: record.sessionId,
                exitCode: 0,
                signal: null,
            });

            await new Promise((resolve) => setTimeout(resolve, 60));
            expect(receivedData.join('')).toContain('hello-after-reconnect');
            expect(receivedExits.length).toBe(1);
            expect(receivedExits[0].exitCode).toBe(0);
        } finally {
            transport.detach();
            await server.stop().catch(() => {});
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});
