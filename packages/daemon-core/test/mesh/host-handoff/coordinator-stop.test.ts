import { describe, expect, it, vi } from 'vitest';
import { stopProjectCoordinators, type StopCensusRow } from '../../../src/mesh/host-handoff/coordinator-stop.js';

describe('source coordinator stop proof', () => {
    it('waits for terminal census evidence after an ACK and never stops another project', async () => {
        let calls = 0;
        const stop = vi.fn(async () => ({ success: true }));
        const proof = await stopProjectCoordinators('project', {
            list: async () => [{ sessionId: 'old', providerType: 'test', meta: { meshCoordinatorFor: 'project' },
                lifecycle: ++calls > 2 ? 'stopped' : 'stopping' },
            { sessionId: 'other', lifecycle: 'running', meta: { meshCoordinatorFor: 'unrelated' } }],
            registered: () => [{ sessionId: 'old', cliType: 'test' }], stop, wait: async () => {},
        });
        expect(proof).toMatchObject({ sessionIds: ['old'], censusComplete: true });
        expect(proof.checkedAt).toBeGreaterThan(0);
        expect(stop.mock.calls).toEqual([['old', 'test']]);
        expect(calls).toBe(3);
    });

    it('refuses an alive but unresponsive runtime census', async () => {
        const stop = vi.fn();
        await expect(stopProjectCoordinators('project', {
            list: () => new Promise<StopCensusRow[]>(() => {}), registered: () => [], stop, timeoutMs: 5,
        })).rejects.toThrow('census timed out');
        expect(stop).not.toHaveBeenCalled();
    });

    it('refuses a stop ACK whose process never exits', async () => {
        let clock = 0;
        await expect(stopProjectCoordinators('project', {
            list: async () => [{ sessionId: 'old', lifecycle: 'stopping' }],
            registered: () => [{ sessionId: 'old', cliType: 'test' }],
            stop: async () => ({ success: true }), now: () => clock,
            wait: async () => { clock += 10; }, timeoutMs: 20,
        })).rejects.toThrow('exit unconfirmed');
    });

    it('refuses rejected stops and malformed censuses', async () => {
        await expect(stopProjectCoordinators('project', {
            list: async () => [{ sessionId: 'old', lifecycle: 'running' }],
            registered: () => [{ sessionId: 'old', cliType: 'test' }], stop: async () => ({ success: false }),
        })).rejects.toThrow('stop refused');
        await expect(stopProjectCoordinators('project', {
            list: async () => null as never, registered: () => [], stop: vi.fn(),
        })).rejects.toThrow('census invalid');
    });

    it('bounds an unresponsive stop RPC without stopping any other session', async () => {
        await expect(stopProjectCoordinators('project', {
            list: async () => [{ sessionId: 'old', lifecycle: 'running' }],
            registered: () => [{ sessionId: 'old', cliType: 'test' }],
            stop: () => new Promise(() => {}), timeoutMs: 5,
        })).rejects.toThrow('coordinator stop timed out');
    });

    it('refuses stale registry identity that conflicts with the trusted census', async () => {
        const stop = vi.fn();
        await expect(stopProjectCoordinators('project', {
            list: async () => [{ sessionId: 'old', lifecycle: 'running', meta: { meshCoordinatorFor: 'unrelated' } }],
            registered: () => [{ sessionId: 'old', cliType: 'test' }], stop,
        })).rejects.toThrow('project identity conflict');
        expect(stop).not.toHaveBeenCalled();
    });
});
