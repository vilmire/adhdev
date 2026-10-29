import { describe, expect, it, vi } from 'vitest';
import { InMemoryAssistantRelayStore } from '../../src/assistant/assistant-relay-store.js';
import { repairLateCaptures, settleLateCapture, readLateCaptureState } from '../../src/assistant/late-capture-repair.js';
function rig() {
    const store = new InMemoryAssistantRelayStore();
    const row = { attemptId: 'attempt', meshId: 'mesh', coordinatorSessionId: 'coord', committedAt: 100, kind: 'relay' as const, outcome: 'completed' };
    store.openThread('mesh', 100); store.recordCommitted(row);
    settleLateCapture(store, 'attempt', 200, { surfacedMissing: true, committedAt: 100, rendered: false });
    store.markDelivered(['attempt'], 200, ['attempt']);
    return { store, row };
}
describe('durable late capture repair crash boundaries', () => {
    it('retries the persisted report identity when a restart interrupted reopening, once', async () => {
        const { store } = rig(); const ready = vi.fn();
        const reopen = vi.spyOn(store, 'reopenUncovered').mockReturnValueOnce(false);
        const read = vi.fn(async () => ({ body: 'Verified same-attempt final', completeness: 'final_native' as const }));
        await repairLateCaptures({ store, now: 60_200, live: () => true, read, ready });
        expect(readLateCaptureState(store, 'attempt', 60_200)?.sourceComplete).toBe(true); expect(ready).not.toHaveBeenCalled();
        await repairLateCaptures({ store, now: 120_200, live: () => true, read, ready });
        expect(reopen).toHaveBeenCalledTimes(2); expect(ready).toHaveBeenCalledTimes(1);
        await repairLateCaptures({ store, now: 300_200, live: () => true, read, ready }); expect(ready).toHaveBeenCalledTimes(1);
    });
    it('rejects a changed report identity after interrupted reopening', async () => {
        const { store } = rig(); const ready = vi.fn(); vi.spyOn(store, 'reopenUncovered').mockReturnValueOnce(false);
        let body = 'Original verified report'; const read = async () => ({ body, completeness: 'final_native' as const });
        await repairLateCaptures({ store, now: 60_200, live: () => true, read, ready }); body = 'Different report';
        await repairLateCaptures({ store, now: 120_200, live: () => true, read, ready });
        expect(ready).not.toHaveBeenCalled(); expect(readLateCaptureState(store, 'attempt', 120_200)?.done).toBe(true);
    });
});
