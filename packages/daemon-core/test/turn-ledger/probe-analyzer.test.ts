import { describe, expect, it, vi } from 'vitest';

// loops.ts starts every S8 loop; only its pure analyzer is under test here, so
// the loop modules (whose import graphs reach the whole mesh runtime) are stubbed.
vi.mock('../../src/mesh/mesh-queue-assignment.js', () => ({ getMeshWithCache: () => undefined }));
vi.mock('../../src/mesh/mesh-auto-fast-forward.js', () => ({ startContinuousAutoFastForwardScheduler: () => ({ stop() {} }) }));
vi.mock('../../src/mesh/mesh-housekeeping-tick.js', () => ({ claimPendingQueues: async () => {}, startMeshHousekeeping: () => ({ stop() {} }) }));
vi.mock('../../src/quota/refresh.js', () => ({ hydrateQuotaCacheFromDisk: () => {}, quotaProviderEnabledFromLoader: () => () => false, refreshQuotaCacheOnBoot: () => {} }));
vi.mock('../../src/models/registry.js', () => ({ hydrateModelCache: () => {}, refreshDueModelDiscovery: async () => {} }));

import { analyzeProbeTranscript } from '../../src/boot/stages/loops.js';

// C4 (C-W4): the boot-layer transcript analyzer the probe is injected with
// (mesh/** may not import providers/**). Same extractors the deleted PHASE-4
// synth / assigned-row poll used.

const T = 1_750_000_000_000;
const msg = (role: string, at: number, content: string, extra: Record<string, unknown> = {}) => ({ role, content, timestamp: at, ...extra });

describe('analyzeProbeTranscript', () => {
    it('selects the final assistant bubble of THIS turn, the newest bubble and the newest agent bubble', () => {
        const out = analyzeProbeTranscript({
            status: 'idle', providerObservedStatus: 'idle',
            messages: [msg('user', T + 1_000, 'do it'), msg('assistant', T + 5_000, 'Done: implemented the change.')],
        }, { turnStartedAtMs: T });
        expect(out).toMatchObject({ providerObservedStatus: 'idle', activeModal: false, finalAssistantAt: T + 5_000, newestActivityAt: T + 5_000, newestAgentActivityAt: T + 5_000, trailingActivity: 0, nativeRead: false });
        expect(out.finalSummary).toContain('implemented');
    });

    it('a user prompt alone is not agent activity (the redrive-blindspot bar)', () => {
        const out = analyzeProbeTranscript({ status: 'idle', messages: [msg('user', T + 1_000, 'do it')] }, { turnStartedAtMs: T });
        expect(out.newestAgentActivityAt).toBeUndefined();
        expect(out.finalAssistantAt).toBeUndefined();
    });

    it('a worker-result JSON summary is self-attributing; a parked modal with buttons is reported', () => {
        const out = analyzeProbeTranscript({
            status: 'idle',
            activeModal: { buttons: ['Approve', 'Reject'] },
            messages: [msg('assistant', T + 5_000, '```json\n{"status":"completed","summary":"ok","changedFiles":[]}\n```')],
        }, { turnStartedAtMs: T });
        expect(out.selfAttributing).toBe(true);
        expect(out.activeModal).toBe(true);
    });
});
