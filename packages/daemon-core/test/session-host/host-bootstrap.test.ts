/**
 * bootSessionHost — one session-host bring-up for both hosts
 * (wiring-unification B5, D7: the cloud shape wins).
 */
import { describe, expect, it, vi } from 'vitest';
import { bootSessionHost } from '../../src/session-host/host-bootstrap.js';

const ENDPOINT_A = { kind: 'unix', path: '/tmp/a.sock' } as any;
const ENDPOINT_B = { kind: 'unix', path: '/tmp/b.sock' } as any;

function fakeController() {
    return { start: vi.fn(async () => {}), stop: vi.fn(async () => {}), getDiagnostics: vi.fn() } as any;
}

describe('bootSessionHost', () => {
    it('starts ONE persistent controller and forwards host events', async () => {
        const controller = fakeController();
        let onEvent: ((e: any) => void) | null = null;
        const seen: any[] = [];
        const handle = await bootSessionHost({
            ensureReady: async () => ENDPOINT_A,
            clientId: 'standalone_mach_1',
            managedBy: 'adhdev-standalone',
            onHostEvent: (e) => seen.push(e),
            createController: (endpoint, cb) => { expect(endpoint).toBe(ENDPOINT_A); onEvent = cb; return controller; },
        });
        expect(controller.start).toHaveBeenCalledTimes(1);
        onEvent!({ type: 'runtime_transition' });
        expect(seen).toEqual([{ type: 'runtime_transition' }]);
        await handle.stop();
        expect(controller.stop).toHaveBeenCalledTimes(1);
    });

    it('the PTY factory carries a STABLE client id (not per-pid), managedBy, and seeds launch meta', async () => {
        const handle = await bootSessionHost({
            ensureReady: async () => ENDPOINT_A,
            clientId: 'standalone_mach_1',
            managedBy: 'adhdev-standalone',
            createController: () => fakeController(),
        });
        const factory = handle.ptyFactory({
            runtimeId: 'rt-1',
            providerType: 'claude-cli',
            workspace: '/repo',
            providerSessionId: 'psid',
            initialMeta: { meshNodeId: 'node-1', managedBy: 'spoofed' },
        }) as any;
        expect(factory.options).toMatchObject({
            clientId: 'standalone_mach_1',
            runtimeId: 'rt-1',
            providerType: 'claude-cli',
            workspace: '/repo',
            meta: { meshNodeId: 'node-1', cliArgs: [], providerSessionId: 'psid', managedBy: 'adhdev-standalone' },
        });
        expect(factory.options.clientId).not.toMatch(/daemon-\d+/);
    });

    it('re-resolves the endpoint through ensureReady and exposes the boot config', async () => {
        const endpoints = [ENDPOINT_A, ENDPOINT_B];
        const list = vi.fn(async () => []);
        const handle = await bootSessionHost({
            ensureReady: async () => endpoints.shift() ?? ENDPOINT_B,
            clientId: 'daemon_mach_1',
            managedBy: 'adhdev-cloud',
            appName: 'adhdev-app',
            listHostedRuntimes: list,
            createController: () => fakeController(),
        });
        expect(handle.endpoint()).toBe(ENDPOINT_A);
        await handle.ensure();
        expect(handle.endpoint()).toBe(ENDPOINT_B);
        await handle.listHostedRuntimes();
        expect(list).toHaveBeenCalledWith(ENDPOINT_B);
        const cfg = handle.bootConfig();
        expect(cfg.managedByTag).toBe('adhdev-cloud');
        expect(cfg.control).toBe(handle.control);
        expect((handle.ptyFactory({ runtimeId: 'r', providerType: 'p', workspace: '/w' }) as any).options.appName).toBe('adhdev-app');
    });
});
