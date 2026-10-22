import { describe, expect, it, vi } from 'vitest';

// loops.ts starts every S8 loop; only its pure analyzer is under test here, so
// the loop modules (whose import graphs reach the whole mesh runtime) are stubbed.
vi.mock('../../src/mesh/mesh-queue-assignment.js', () => ({ getMeshWithCache: () => undefined }));
vi.mock('../../src/mesh/mesh-auto-fast-forward.js', () => ({ startContinuousAutoFastForwardScheduler: () => ({ stop() {} }) }));
vi.mock('../../src/mesh/mesh-housekeeping-tick.js', () => ({ claimPendingQueues: async () => {}, startMeshHousekeeping: () => ({ stop() {} }) }));
vi.mock('../../src/quota/refresh.js', () => ({ hydrateQuotaCacheFromDisk: () => {}, quotaProviderEnabledFromLoader: () => () => false,}));
vi.mock('../../src/quota/refresh-triggers.js', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  refreshQuotaCacheOnBoot: () => {},
}))
vi.mock('../../src/models/registry.js', () => ({ hydrateModelCache: () => {}, refreshDueModelDiscovery: async () => {} }));

import { analyzeProbeTranscript } from '../../src/boot/stages/loops.js';
import { createComponentsProbeReader, probeEvidence } from '../../src/mesh/turn-ledger/probe.js';
import { admitTranscriptFinal } from '../../src/mesh/turn-ledger/admission.js';
import { DEFAULT_TURN_POLICY as policy } from '../../src/mesh/turn-ledger/policy.js';
import { buildReadChatCommandResult } from '../../src/commands/read-chat-presentation.js';
import { reduce } from '../../src/mesh/turn-ledger/reducer.js';
import { makeAttempt } from './fixtures.js';

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

describe('production read_chat → loops analyzer → probe → admission', () => {
    it.each([
        { stale: true },
        { unavailableReason: 'native_history_loading' },
    ])('holds a cached final with no visible trailing tools while the tail is unread: %j', async metadata => {
        const attempt = makeAttempt('generating', { generation: 0, acceptedAt: T, consumedAt: T, lastActivityAt: T });
        const messages = [msg('assistant', T + 1_000, 'Done: implemented the change.')];
        const sample = async (extra: Record<string, unknown>) => {
            const reader = createComponentsProbeReader({
                sessionRegistry: { get: () => ({ instanceKey: 's1', transport: 'pty' }) },
                instanceManager: { getInstance: () => ({ getState: () => ({ status: 'idle' }) }) },
                commandHandler: { handle: async () => buildReadChatCommandResult({
                    messages, status: 'idle', ...extra,
                }, { includeActivity: true }) },
            } as any, { analyzer: analyzeProbeTranscript });
            const read = await reader.read(attempt, { kind: 'local' }, []);
            const events = probeEvidence(attempt, read, { nowMs: T + 120_000, observedBy: 'dc', policy });
            const final = events.find(e => e.kind === 'transcript_final');
            expect(final?.kind).toBe('transcript_final');
            const admission = admitTranscriptFinal(final!, policy);
            if (admission.kind === 'hold') {
                const result = reduce({ attempt, holds: [], evidence: final!, policy, nowMs: T + 120_000 });
                expect(result.rule).toBe('R16');
                expect(result.attempt!.terminal).toBeNull();
            }
            return admission;
        };
        expect(await sample(metadata)).toMatchObject({ kind: 'hold', holdReason: 'live_pending' });
        // A fresh sample of this same quiet final can be admitted again.
        expect(await sample({})).toEqual({ kind: 'weak' });
        // Once the unread tail arrives, its tool-use remains a veto.
        messages.push(msg('assistant', T + 2_000, '', { kind: 'tool' }));
        expect(await sample({})).toMatchObject({ kind: 'hold', holdReason: 'live_pending' });
    });

    it('holds cold loading without a final and never acts on a stale failed native marker', () => {
        const attempt = makeAttempt('generating', { generation: 0, acceptedAt: T, consumedAt: T });
        for (const extra of [{}, { turnTerminalMarkers: [{ outcome: 'failed', receivedAt: T + 1_000 }] }]) {
            const transcript = analyzeProbeTranscript({ status: 'idle', messages: [],
                unavailableReason: 'native_history_loading', ...extra }, { turnStartedAtMs: T, providerType: 'codex-cli' });
            const events = probeEvidence(attempt, { presence: 'present', transcript }, { nowMs: T + 900_000, observedBy: 'dc', policy });
            expect(events.some(e => e.kind === 'turn_end' || e.kind === 'no_progress')).toBe(false);
            const final = events.find(e => e.kind === 'transcript_final');
            expect(final?.kind).toBe('transcript_final');
            expect(admitTranscriptFinal(final!, policy))
                .toMatchObject({ kind: 'hold', holdReason: 'live_pending' });
        }
    });
});
