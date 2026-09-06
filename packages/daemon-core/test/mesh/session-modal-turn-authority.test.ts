import { describe, expect, it, beforeEach, afterAll, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Per-file isolated config dir → per-file mesh-runtime.db (same convention as
// mesh-turn-presentation.test.ts) so this suite's turn tables stay free of
// sibling rows.
const testTmpDir = join(tmpdir(), `adhdev-session-modal-authority-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
}));

import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import {
    openTurnAttempt,
    recordTurnAck,
    proposeTurnCompletion,
    __resetTurnLedgerMetricsForTests,
} from '../../src/mesh/mesh-turn-ledger.js';
import {
    resolveSessionTurnPresentation,
    getTurnPresentationMetrics,
    __resetTurnPresentationMetricsForTests,
} from '../../src/mesh/mesh-turn-presentation.js';
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js';
import { withMinimalSpec } from '../helpers/minimal-spec.js';

const MESH = `mesh-${randomUUID().slice(0, 8)}`;
let nonceSeq = 0;

function openAttempt(args: { taskId: string; sessionId: string; providerType?: string }) {
    nonceSeq += 1;
    return openTurnAttempt({
        meshId: MESH,
        taskId: args.taskId,
        dispatchNonce: nonceSeq,
        sessionId: args.sessionId,
        providerType: args.providerType ?? 'kimi-cli',
    }).attempt;
}

/**
 * Drives the REAL `CliProviderInstance.getSessionModalState` — the seam this fix
 * changes — rather than a mirror of it, so reverting the fix turns these
 * assertions red on behavior and not merely on source text.
 *
 * A provider module with no `_resolvedSpecPath` routes createCliAdapter through
 * the non-spawning adapter, so no PTY is started at construction (same trick as
 * update-settings-preserve-auto-approve.test.ts). The adapter's sampled status
 * is then stubbed to represent the raw provider FSM.
 */
function modalLaneStatus(args: { sessionId: string; rawFsmStatus: string; providerType?: string }): string {
    const inst = new CliProviderInstance(
        withMinimalSpec({
            type: args.providerType ?? 'kimi-cli',
            category: 'cli',
            name: 'Test CLI',
            command: 'true',
        } as any) as any,
        '/repo/worktree-worker',
        [],
        args.sessionId,
    );
    // Stand in for the live PTY sample this lane used to publish verbatim.
    (inst as any).adapter.getStatus = () => ({ status: args.rawFsmStatus, activeModal: null });
    return String(inst.getSessionModalState(args.sessionId).status);
}

beforeEach(() => {
    MeshRuntimeStore.resetForTests();
    __resetTurnLedgerMetricsForTests();
    __resetTurnPresentationMetricsForTests();
});

afterAll(() => {
    MeshRuntimeStore.resetForTests();
    rmSync(testTmpDir, { recursive: true, force: true });
});

describe('session.modal lane turn authority', () => {
    // INJECTION-RED: this is the exact live case from the daemon log —
    // reducer says `starting` (stage delivered), the raw provider FSM still
    // samples `idle`. Reverting the fix (publishing the raw FSM status) makes
    // this fail with 'idle', which is what the dashboard rendered.
    it('publishes the reducer status when an attempt is mid-turn and the FSM still reads idle', () => {
        const taskId = `task-${randomUUID().slice(0, 8)}`;
        const sessionId = `sess-${randomUUID().slice(0, 8)}`;
        openAttempt({ taskId, sessionId });
        recordTurnAck({ meshId: MESH, taskId, kind: 'delivered', sessionId });

        expect(modalLaneStatus({ sessionId, rawFsmStatus: 'idle' })).toBe('starting');
    });

    // DIVERGENCE-GONE: the whole point of the fix. The modal lane now feeds the
    // SAME projection the other surfaces use, so legacy==projected and the
    // comparator records agreement instead of `legacy_idle_turn_active`.
    it('emits no shadow divergence once the lane consumes the projection', () => {
        const taskId = `task-${randomUUID().slice(0, 8)}`;
        const sessionId = `sess-${randomUUID().slice(0, 8)}`;
        openAttempt({ taskId, sessionId });
        recordTurnAck({ meshId: MESH, taskId, kind: 'delivered', sessionId });

        // First pass: the raw FSM sample is what the lane used to publish.
        const projected = modalLaneStatus({ sessionId, rawFsmStatus: 'idle' });
        __resetTurnPresentationMetricsForTests();

        // Second pass: the published value is fed back as the legacy input,
        // which is what the lane now does downstream — it must agree.
        modalLaneStatus({ sessionId, rawFsmStatus: projected });

        const metrics = getTurnPresentationMetrics();
        expect(metrics.shadowAgreements).toBe(1);
        expect(metrics.shadowDivergenceTotal).toBe(0);
        const divergenceKeys = Object.keys(metrics.shadowDivergences);
        expect(divergenceKeys.filter((k) => k.includes('legacy_idle_turn_active'))).toEqual([]);
    });

    // NEGATIVE ASSERTION (opposite direction): a genuinely idle session must
    // NOT be painted as working. Two distinct no-attempt shapes.
    it('leaves a genuinely idle session idle', () => {
        // (a) No mesh attempt at all — ordinary standalone CLI chat.
        expect(modalLaneStatus({ sessionId: `sess-${randomUUID().slice(0, 8)}`, rawFsmStatus: 'idle' })).toBe('idle');

        // (b) A committed-terminal attempt releases back to idle — the lane must
        // not keep painting a finished session as working.
        const taskId = `task-${randomUUID().slice(0, 8)}`;
        const sessionId = `sess-${randomUUID().slice(0, 8)}`;
        openAttempt({ taskId, sessionId });
        recordTurnAck({ meshId: MESH, taskId, kind: 'delivered', sessionId });
        recordTurnAck({ meshId: MESH, taskId, kind: 'consumed', sessionId });
        const decision = proposeTurnCompletion({
            meshId: MESH, taskId, sessionId, outcome: 'completed', source: 'provider_event',
        });
        expect(decision.committed).toBe(true);
        expect(modalLaneStatus({ sessionId, rawFsmStatus: 'idle' })).toBe('idle');

        // ...and a stale provider sample claiming 'generating' does NOT resurrect it.
        expect(modalLaneStatus({ sessionId, rawFsmStatus: 'generating' })).toBe('idle');
    });

    // The fallback must stay byte-for-byte unchanged for non-mesh sessions, or
    // this fix would regress ordinary local chat.
    it('passes the raw FSM status through untouched when no attempt exists', () => {
        for (const raw of ['idle', 'generating', 'starting', 'waiting_approval', 'error']) {
            const sessionId = `sess-${randomUUID().slice(0, 8)}`;
            const p = resolveSessionTurnPresentation({
                sessionId,
                legacyStatus: raw,
                providerType: 'kimi-cli',
                surface: 'session_modal',
            });
            expect(p.authority).toBe('provider_fsm_fallback');
            expect(p.status).toBe(raw);
        }
    });

    // Wiring guard: the seam this fix lives at is inside CliProviderInstance,
    // which cannot be constructed without a PTY. Pin the wiring by source so a
    // future edit cannot silently revert the lane to the raw FSM status.
    it('CliProviderInstance.getSessionModalState routes its status through the resolver', () => {
        const src = readFileSync(
            new URL('../../src/providers/cli-provider-instance.ts', import.meta.url),
            'utf8',
        );
        const body = src.slice(src.indexOf('getSessionModalState(sessionId?: string)'));
        const method = body.slice(0, body.indexOf('\n    updateSettings('));

        expect(method).toMatch(/resolveSessionTurnPresentation\(/);
        expect(method).toMatch(/surface: 'session_modal'/);
        // The raw sample must be handed over as the shadow/legacy input, not published directly.
        expect(method).toMatch(/legacyStatus: visibleStatus/);
        expect(method).toMatch(/status: presentedStatus/);
        expect(method).not.toMatch(/status: visibleStatus/);
    });
});
