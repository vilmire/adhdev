import { describe, expect, it } from 'vitest';

import {
    DEFAULT_MESH_POLICY,
    mergeAndNormalizePolicy,
    resolveMagiSessionCleanupMode,
    magiAutoLaunchedSessionCleanupDecision,
} from '../../src/repo-mesh-types.js';

// ─── Policy: magiSessionCleanup defaults ON and accepts boolean shorthand ───────

describe('magiSessionCleanup policy', () => {
    it('defaults to stop_and_delete (ON)', () => {
        expect(DEFAULT_MESH_POLICY.magiSessionCleanup).toBe('stop_and_delete');
    });

    it('resolveMagiSessionCleanupMode: unset → default ON', () => {
        expect(resolveMagiSessionCleanupMode(undefined)).toBe('stop_and_delete');
        expect(resolveMagiSessionCleanupMode(null)).toBe('stop_and_delete');
    });

    it('resolveMagiSessionCleanupMode: boolean shorthand', () => {
        expect(resolveMagiSessionCleanupMode(true)).toBe('stop_and_delete');
        expect(resolveMagiSessionCleanupMode(false)).toBe('preserve');
    });

    it('resolveMagiSessionCleanupMode: explicit strings pass through', () => {
        expect(resolveMagiSessionCleanupMode('preserve')).toBe('preserve');
        expect(resolveMagiSessionCleanupMode('stop_and_delete')).toBe('stop_and_delete');
    });

    it("resolveMagiSessionCleanupMode: unknown string falls back to default (can't silently disable)", () => {
        expect(resolveMagiSessionCleanupMode('garbage' as any)).toBe('stop_and_delete');
    });

    it('mergeAndNormalizePolicy canonicalizes magiSessionCleanup', () => {
        expect(mergeAndNormalizePolicy(undefined, { magiSessionCleanup: false } as any).magiSessionCleanup).toBe('preserve');
        expect(mergeAndNormalizePolicy(undefined, {}).magiSessionCleanup).toBe('stop_and_delete');
        expect(mergeAndNormalizePolicy(undefined, { magiSessionCleanup: 'preserve' }).magiSessionCleanup).toBe('preserve');
        // a typo can't turn cleanup off — normalizes back to the default ON
        expect(mergeAndNormalizePolicy(undefined, { magiSessionCleanup: 'nope' as any }).magiSessionCleanup).toBe('stop_and_delete');
    });
});

// ─── Marker gate: the safety core (cases a–d) ───────────────────────────────────
// MAGI passes EXPLICIT session_ids (which bypass the self-coordinator/shared-daemon
// guards), so this marker decision is the SOLE protector of reused/coordinator/skewed
// sessions. Closing the wrong session destroys the workflow, so each case is asserted.

describe('magiAutoLaunchedSessionCleanupDecision — marker gate', () => {
    it('(a) marker present and equals the expected replica task id → ALLOW (only this is cleaned)', () => {
        const d = magiAutoLaunchedSessionCleanupDecision({
            recordMarker: 'task-7',
            expectedTaskId: 'task-7',
            isCoordinatorSession: false,
        });
        expect(d.allow).toBe(true);
        expect(d.reason).toBe('auto_launch_marker_match');
    });

    it('(b) reused idle session carries NO marker → SKIP (preserve reused session)', () => {
        for (const marker of [undefined, null, '', '   ']) {
            const d = magiAutoLaunchedSessionCleanupDecision({
                recordMarker: marker,
                expectedTaskId: 'task-7',
                isCoordinatorSession: false,
            });
            expect(d.allow, `marker=${JSON.stringify(marker)} must skip`).toBe(false);
            expect(d.reason).toBe('auto_launch_marker_absent_session_not_auto_launched');
        }
    });

    it('(c) coordinator session → SKIP even if a marker/expected somehow lines up', () => {
        const d = magiAutoLaunchedSessionCleanupDecision({
            recordMarker: 'task-7',
            expectedTaskId: 'task-7',
            isCoordinatorSession: true,
        });
        expect(d.allow).toBe(false);
        expect(d.reason).toBe('auto_launch_marker_skip_coordinator_session');
    });

    it('(d) marker points at a DIFFERENT task (re-assignment skew) → SKIP', () => {
        const d = magiAutoLaunchedSessionCleanupDecision({
            recordMarker: 'task-OTHER',
            expectedTaskId: 'task-7',
            isCoordinatorSession: false,
        });
        expect(d.allow).toBe(false);
        expect(d.reason).toBe('auto_launch_marker_mismatch');
    });

    it('(d2) no expected task id supplied for this session id → SKIP', () => {
        const d = magiAutoLaunchedSessionCleanupDecision({
            recordMarker: 'task-7',
            expectedTaskId: undefined,
            isCoordinatorSession: false,
        });
        expect(d.allow).toBe(false);
        expect(d.reason).toBe('auto_launch_marker_mismatch');
    });

    it('marker comparison is whitespace-trimmed on both sides', () => {
        const d = magiAutoLaunchedSessionCleanupDecision({
            recordMarker: '  task-7 ',
            expectedTaskId: 'task-7',
            isCoordinatorSession: false,
        });
        expect(d.allow).toBe(true);
    });
});
