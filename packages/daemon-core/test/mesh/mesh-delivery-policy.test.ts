import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { vi } from 'vitest';

const testTmpDir = join(tmpdir(), `adhdev-mesh-delivery-policy-test-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
}));

import {
    resolveDeliveryDecision,
    normalizeDeliveryMode,
    DEFAULT_DELIVERY_MODE,
} from '../../src/mesh/mesh-delivery-policy.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { MESH_DELIVERY_MODES, isBusyStatus } from '@adhdev/mesh-shared';

function resetStore() {
    MeshRuntimeStore.resetForTests();
}

describe('mesh-delivery-policy', () => {
    beforeEach(() => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
    });
    afterEach(() => {
        resetStore();
        try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* cleanup */ }
    });

    // ── resolveDeliveryDecision — pure function ──────────────────────────────

    describe('resolveDeliveryDecision', () => {
        it('returns immediate for idle session', () => {
            const result = resolveDeliveryDecision('idle');
            expect(result.decision).toBe('immediate');
            expect(result.reason).toContain('idle');
        });

        it('returns immediate for waiting_input session', () => {
            const result = resolveDeliveryDecision('waiting_input');
            expect(result.decision).toBe('immediate');
        });

        it('returns immediate for ready session', () => {
            const result = resolveDeliveryDecision('ready');
            expect(result.decision).toBe('immediate');
        });

        it('returns queued for generating session', () => {
            const result = resolveDeliveryDecision('generating');
            expect(result.decision).toBe('queued');
            expect(result.reason).toContain('generating');
        });

        it('returns queued for busy session', () => {
            const result = resolveDeliveryDecision('busy');
            expect(result.decision).toBe('queued');
        });

        it('returns queued for running session', () => {
            const result = resolveDeliveryDecision('running');
            expect(result.decision).toBe('queued');
        });

        it('returns queued for streaming session', () => {
            const result = resolveDeliveryDecision('streaming');
            expect(result.decision).toBe('queued');
        });

        it('returns queued for starting session', () => {
            const result = resolveDeliveryDecision('starting');
            expect(result.decision).toBe('queued');
        });

        it('returns queued for waiting_approval with non-approval kind', () => {
            const result = resolveDeliveryDecision('waiting_approval', { kind: 'task' });
            expect(result.decision).toBe('queued');
            expect(result.reason).toContain('waiting_approval');
        });

        it('returns immediate for waiting_approval with approval kind', () => {
            const result = resolveDeliveryDecision('waiting_approval', { kind: 'approval' });
            expect(result.decision).toBe('immediate');
            expect(result.reason).toContain('approval');
        });

        it('returns rejected for stopped session', () => {
            const result = resolveDeliveryDecision('stopped');
            expect(result.decision).toBe('rejected');
            expect(result.reason).toContain('stopped');
        });

        it('returns rejected for terminated session', () => {
            const result = resolveDeliveryDecision('terminated');
            expect(result.decision).toBe('rejected');
        });

        it('returns rejected for closed session', () => {
            const result = resolveDeliveryDecision('closed');
            expect(result.decision).toBe('rejected');
        });

        it('returns rejected for empty/undefined status (fail-closed)', () => {
            const result = resolveDeliveryDecision(undefined);
            expect(result.decision).toBe('rejected');
            expect(result.reason).toBe('unknown_session_status');
        });

        it('returns rejected for unknown status (fail-closed)', () => {
            const result = resolveDeliveryDecision('some_unknown_status_xyz');
            expect(result.decision).toBe('rejected');
            expect(result.reason).toBe('unrecognized_session_status');
        });

        it('allows busy injection when allowBusyInjection=true', () => {
            const result = resolveDeliveryDecision('generating', { allowBusyInjection: true });
            expect(result.decision).toBe('immediate');
            expect(result.reason).toContain('busy_injection_allowed');
        });

        it('result always has a message string', () => {
            for (const status of ['idle', 'generating', 'stopped', 'unknown']) {
                const result = resolveDeliveryDecision(status);
                expect(typeof result.message).toBe('string');
                expect(result.message.length).toBeGreaterThan(0);
            }
        });
    });

    // ── delivery mode: interrupt (M-INPUT-DELIVERY-MODE-AND-QUEUE axis A) ──
    describe('delivery mode', () => {
        // (a) the default must not regress
        it('★ defaults to when_idle', () => {
            expect(DEFAULT_DELIVERY_MODE).toBe('when_idle');
            expect(normalizeDeliveryMode(undefined).mode).toBe('when_idle');
            expect(normalizeDeliveryMode(null).mode).toBe('when_idle');
            expect(normalizeDeliveryMode('').mode).toBe('when_idle');
        });

        it('★ a busy session with NO delivery mode still queues (default path unchanged)', () => {
            const result = resolveDeliveryDecision('generating');
            expect(result.decision).toBe('queued');
            expect(result.reason).toBe('session_generating_busy');
        });

        it('★ an unrecognized mode falls back to when_idle AND reports it', () => {
            // "immediate" is the tempting wrong name — it must never be read as
            // consent to destroy a running turn.
            const r = normalizeDeliveryMode('immediate');
            expect(r.mode).toBe('when_idle');
            expect(r.unrecognized).toBe('immediate');
        });

        it('accepts interrupt and its camelCase spelling of when_idle', () => {
            expect(normalizeDeliveryMode('interrupt').mode).toBe('interrupt');
            expect(normalizeDeliveryMode('INTERRUPT').mode).toBe('interrupt');
            expect(normalizeDeliveryMode('whenIdle').mode).toBe('when_idle');
            expect(normalizeDeliveryMode('interrupt').unrecognized).toBeUndefined();
        });

        it('returns interrupt for a busy session when the provider supports it', () => {
            const result = resolveDeliveryDecision('generating', {
                deliveryMode: 'interrupt',
                interruptSupported: true,
            });
            expect(result.decision).toBe('interrupt');
            expect(result.reason).toContain('interrupt_requested');
            // the message must state that work is discarded
            expect(result.message).toMatch(/discard/i);
        });

        // (b) no silent fallback for an unsupported provider
        it('★ REJECTS (never silently queues) when the provider cannot interrupt', () => {
            const result = resolveDeliveryDecision('generating', {
                deliveryMode: 'interrupt',
                interruptSupported: false,
                interruptUnsupportedMessage: 'hermes-cli declares an EMPTY stop key.',
            });
            expect(result.decision).toBe('rejected');
            expect(result.decision).not.toBe('queued');
            expect(result.reason).toBe('interrupt_unsupported_for_provider');
            expect(result.message).toContain('EMPTY stop key');
        });

        it('★ rejection message is present even without a provider-supplied reason', () => {
            const result = resolveDeliveryDecision('generating', {
                deliveryMode: 'interrupt',
                interruptSupported: false,
            });
            expect(result.decision).toBe('rejected');
            expect(result.message).toMatch(/when_idle/);
        });

        it('does not interrupt an idle session — it delivers immediately', () => {
            const result = resolveDeliveryDecision('idle', {
                deliveryMode: 'interrupt',
                interruptSupported: true,
            });
            expect(result.decision).toBe('immediate');
        });

        it('does not interrupt a terminal session — it stays rejected as terminal', () => {
            const result = resolveDeliveryDecision('stopped', {
                deliveryMode: 'interrupt',
                interruptSupported: true,
            });
            expect(result.decision).toBe('rejected');
            expect(result.reason).toBe('session_stopped_terminal');
        });
    });

    // (C-W8) The mesh_session_delivery CRUD suites that lived here went with the
    // table: a dispatch's delivery lifecycle is the turn-ledger attempt's evidence
    // (reducer suites: test/turn-ledger/**).

    // ── wiring-unification A3: classification derives from mesh-shared ──────
    describe('status classification derives from the shared session-status classes', () => {
        it('every busy spelling (working or blocked class, aliases included) queues', () => {
            for (const spelling of ['generating', 'running', 'streaming', 'busy', 'starting', 'initializing',
                'waiting_approval', 'waiting_choice', 'finalizing', 'working', 'loading', 'thinking', 'active',
                'no_progress', 'long_generating', 'waiting']) {
                expect(isBusyStatus(spelling), spelling).toBe(true);
                const result = resolveDeliveryDecision(spelling);
                expect(result.decision, spelling).toBe('queued');
                expect(result.reason, spelling).toBe(`session_${spelling}_busy`);
            }
        });

        it('approval-kind delivery reaches every blocked-class spelling, not just the two literals', () => {
            for (const spelling of ['waiting_approval', 'waiting_choice', 'waiting']) {
                const result = resolveDeliveryDecision(spelling, { kind: 'approval' });
                expect(result.decision, spelling).toBe('immediate');
                expect(result.reason, spelling).toBe(`session_${spelling}_approval_message`);
            }
            expect(resolveDeliveryDecision('generating', { kind: 'approval' }).decision).toBe('queued');
        });

        it('dead-class and legacy terminal spellings reject with the terminal reason', () => {
            for (const spelling of ['stopped', 'error', 'disconnected', 'failed', 'terminated', 'exited', 'closed', 'deleted']) {
                const result = resolveDeliveryDecision(spelling);
                expect(result.decision, spelling).toBe('rejected');
                expect(result.reason, spelling).toBe(`session_${spelling}_terminal`);
            }
        });

        it('only idle and the two legacy ready spellings deliver immediately; other ready-class members stay rejected', () => {
            for (const spelling of ['idle', 'IDLE', 'waiting_input', 'ready']) {
                expect(resolveDeliveryDecision(spelling).decision, spelling).toBe('immediate');
            }
            // A session nobody monitors can never report completion — deliberately NOT
            // promoted to immediate by the class map (see the mapping comment in src).
            for (const spelling of ['panel_hidden', 'not_monitored']) {
                const result = resolveDeliveryDecision(spelling);
                expect(result.decision, spelling).toBe('rejected');
                expect(result.reason, spelling).toBe('unrecognized_session_status');
            }
        });

        it('delivery mode is the mesh-shared vocabulary', () => {
            expect(MESH_DELIVERY_MODES).toContain(DEFAULT_DELIVERY_MODE);
            for (const mode of MESH_DELIVERY_MODES) {
                expect(normalizeDeliveryMode(mode)).toEqual({ mode });
                expect(normalizeDeliveryMode(mode.toUpperCase())).toEqual({ mode });
            }
        });
    });

    // MESH-COMPLEXITY-AUDIT Part 8-2: the recordCompletionConflict /
    // getRecentCompletionConflicts diagnostic (mesh_completion_conflicts table)
    // was removed — write-only, no production reader, no no-loss role — so its
    // tests were removed with it. The fingerprint-dedup DECISION it observed is
    // covered by mesh-events-pending-completion-dedup.test.ts and unchanged.
});
