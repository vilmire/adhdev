/**
 * A dead session host must be respawned by the reconnect loop itself — not only
 * when a new session launch happens to call ensureReady (2026-10-06: Windows host
 * exited with code 1, daemon re-dialled a dead pipe for 71 minutes).
 */
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SessionHostController } from '../../src/session-host/session-host-controller.js';
import { bootSessionHost } from '../../src/session-host/host-bootstrap.js';

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
});
