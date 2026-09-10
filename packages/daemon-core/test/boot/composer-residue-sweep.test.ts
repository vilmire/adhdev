/**
 * ENTER-LOSS layer ③ — boot-time composer-residue sweep (2026-09-10 incident:
 * a drained notification body stranded in a session-host composer across a
 * daemon restart, invisible to redelivery because the ledger row was already
 * drained=1).
 *
 * Covered:
 *  - identification: residue is matched to the drained ledger candidate and
 *    the finding carries its mesh/event/task identity;
 *  - autosubmit default OFF: even a full-integrity match is NOT submitted;
 *  - autosubmit opt-in: full-integrity match + flag → exactly one Enter;
 *  - truncated residue (partial integrity) is NEVER submitted, flag or not;
 *  - unidentified residue is still reported (observation point);
 *  - non-idle sessions and clean composers produce no findings;
 *  - UNDRAIN RECOVERY: full-integrity + stable + pre-boot drain → composer is
 *    cleared FIRST, then the row is undrained (order asserted); partial /
 *    unstable / post-boot / in-flight-submit findings are never recovered;
 *    a failed undrain never falls back to pressing Enter on the (now empty)
 *    composer.
 */
import { describe, it, expect } from 'vitest';
import {
    runComposerResidueSweep,
    type ResidueSweepCandidate,
    type ResidueSweepSession,
} from '../../src/boot/composer-residue-sweep.js';

/** ≥64 chars, the incident shape (long single-paragraph notification). */
const BODY = '[System] Delegated worker task completed on node moltbot: all tests green, branch pushed, ready for refinery merge. '.repeat(4);

function candidate(overrides: Partial<ResidueSweepCandidate> = {}): ResidueSweepCandidate {
    return {
        rowId: 'row-1',
        meshId: 'mesh-1',
        event: 'mesh:task_completed',
        eventId: 'evt-abc',
        taskId: 'task-42',
        drainedAt: Date.now() - 60_000,
        coordinatorMessage: BODY,
        ...overrides,
    };
}

function session(overrides: Partial<ResidueSweepSession> = {}): ResidueSweepSession {
    return {
        key: 'sess-1',
        cliType: 'claude-cli',
        status: 'idle',
        viewportText: `┌ chat ┐\n❯ ${BODY}\n└──────┘`,
        scrollbackText: `boot noise\n❯ ${BODY}\n`,
        ...overrides,
    };
}

describe('ENTER-LOSS ③ — composer residue sweep', () => {
    it('identifies residue against the drained ledger and reports full integrity', () => {
        const findings = runComposerResidueSweep({
            sessions: [session()],
            candidates: [candidate()],
            autoRecoverEnabled: false,
        });
        expect(findings).toHaveLength(1);
        expect(findings[0].kind).toBe('identified');
        expect(findings[0].integrity).toBe('full');
        expect(findings[0].candidate).toMatchObject({
            meshId: 'mesh-1',
            eventId: 'evt-abc',
            taskId: 'task-42',
            bodyLength: BODY.length,
        });
    });

    it('recovery is OFF by default: a full match is detected but NOT submitted', () => {
        let submits = 0;
        const findings = runComposerResidueSweep({
            sessions: [session({ submitComposer: () => { submits += 1; } })],
            candidates: [candidate()],
            autoRecoverEnabled: false,
        });
        expect(findings[0].recovered).toBe(false);
        expect(submits).toBe(0);
    });

    it('opt-in recovery submits exactly once on a strict full-body match', () => {
        let submits = 0;
        const findings = runComposerResidueSweep({
            sessions: [session({ submitComposer: () => { submits += 1; } })],
            candidates: [candidate()],
            autoRecoverEnabled: true,
        });
        expect(findings[0].recovered).toBe(true);
        expect(submits).toBe(1);
    });

    it('truncated residue (partial integrity) is NEVER submitted, even opted in', () => {
        // The daemon died MID-write: only the leading 60% of the body landed.
        // Head+tail probes: put head in scrollback, and craft the composer so the
        // TAIL of the original appears (a merged fragment) but the middle is gone.
        const truncated = BODY.slice(0, Math.floor(BODY.length * 0.6));
        const tailFragment = BODY.slice(-40);
        let submits = 0;
        const findings = runComposerResidueSweep({
            sessions: [session({
                viewportText: `❯ ${truncated}…${tailFragment}`,
                scrollbackText: `❯ ${truncated}…${tailFragment}`,
                submitComposer: () => { submits += 1; },
            })],
            candidates: [candidate()],
            autoRecoverEnabled: true,
        });
        expect(findings).toHaveLength(1);
        expect(findings[0].kind).toBe('identified');
        expect(findings[0].integrity).toBe('partial');
        expect(findings[0].recovered).toBe(false);
        expect(submits).toBe(0);
    });

    it('reports unidentified residue when the composer holds unmatched text', () => {
        const findings = runComposerResidueSweep({
            sessions: [session({
                viewportText: '│ chat history │\n❯ some stranded text of unknown origin here\n',
                scrollbackText: '│ chat history │\n❯ some stranded text of unknown origin here\n',
            })],
            candidates: [candidate()], // present but does not match
            autoRecoverEnabled: true,
        });
        expect(findings).toHaveLength(1);
        expect(findings[0].kind).toBe('unidentified');
        expect(findings[0].recovered).toBe(false);
        expect(findings[0].residueLength).toBeGreaterThan(0);
    });

    it('skips non-idle sessions and clean composers', () => {
        const findings = runComposerResidueSweep({
            sessions: [
                session({ key: 'busy', status: 'generating' }),          // busy → skipped
                session({                                                 // clean composer
                    key: 'clean',
                    viewportText: '│ output │\n❯ \n? for shortcuts',
                    scrollbackText: '│ output │\n❯ \n? for shortcuts',
                }),
            ],
            candidates: [candidate()],
            autoRecoverEnabled: true,
        });
        expect(findings).toEqual([]);
    });

    it('ignores short generic bodies (ambiguous-match guard)', () => {
        const findings = runComposerResidueSweep({
            sessions: [session({ viewportText: '❯ done\n', scrollbackText: '❯ done\n' })],
            candidates: [candidate({ coordinatorMessage: 'done' })],
            autoRecoverEnabled: true,
        });
        // 'done' is below the 64-char floor → not a candidate; '❯ done' is
        // below the 8-char unidentified threshold → no finding at all.
        expect(findings).toEqual([]);
    });
});

describe('ENTER-LOSS ③ — undrain recovery (composer clear + durable requeue)', () => {
    const BOOT_AT = Date.now();
    /** Recovery-eligible baseline: full-integrity, stable, pre-boot drain. */
    function recoverySession(overrides: Partial<ResidueSweepSession> = {}): ResidueSweepSession {
        return session({ stable: true, submitInFlight: false, ...overrides });
    }

    it('full-integrity + stable + pre-boot: clears the composer THEN undrains the row (order asserted), no Enter', () => {
        const calls: string[] = [];
        let clearedCount = 0;
        const findings = runComposerResidueSweep({
            sessions: [recoverySession({
                clearComposer: (n) => { calls.push('clear'); clearedCount = n; },
                submitComposer: () => { calls.push('submit'); },
            })],
            candidates: [candidate({ drainedAt: BOOT_AT - 60_000 })],
            autoRecoverEnabled: true, // even opted-in autosubmit must be superseded
            recoveryEnabled: true,
            bootAt: BOOT_AT,
            undrainRow: (c) => { calls.push(`undrain:${c.rowId}`); return true; },
        });
        expect(findings).toHaveLength(1);
        expect(findings[0].recovered).toBe(true);
        expect(findings[0].recoveredBy).toBe('undrain');
        // Clear happens strictly BEFORE the undrain, and no submit key fires.
        expect(calls).toEqual(['clear', 'undrain:row-1']);
        // Backspace budget covers the whole body plus slack.
        expect(clearedCount).toBeGreaterThan(BODY.length);
    });

    it('partial integrity is NEVER recovered: no clear, no undrain, no submit', () => {
        const truncated = BODY.slice(0, Math.floor(BODY.length * 0.6));
        const tailFragment = BODY.slice(-40);
        const calls: string[] = [];
        const findings = runComposerResidueSweep({
            sessions: [recoverySession({
                viewportText: `❯ ${truncated}…${tailFragment}`,
                scrollbackText: `❯ ${truncated}…${tailFragment}`,
                clearComposer: () => { calls.push('clear'); },
                submitComposer: () => { calls.push('submit'); },
            })],
            candidates: [candidate({ drainedAt: BOOT_AT - 60_000 })],
            autoRecoverEnabled: true,
            recoveryEnabled: true,
            bootAt: BOOT_AT,
            undrainRow: () => { calls.push('undrain'); return true; },
        });
        expect(findings[0].integrity).toBe('partial');
        expect(findings[0].recovered).toBe(false);
        expect(findings[0].recoveredBy).toBeUndefined();
        expect(calls).toEqual([]);
    });

    it('unstable viewport (possible active typing) blocks recovery — detection only', () => {
        const calls: string[] = [];
        const findings = runComposerResidueSweep({
            sessions: [recoverySession({
                stable: false,
                clearComposer: () => { calls.push('clear'); },
            })],
            candidates: [candidate({ drainedAt: BOOT_AT - 60_000 })],
            autoRecoverEnabled: false,
            recoveryEnabled: true,
            bootAt: BOOT_AT,
            undrainRow: () => { calls.push('undrain'); return true; },
        });
        expect(findings[0].kind).toBe('identified');
        expect(findings[0].recovered).toBe(false);
        expect(calls).toEqual([]);
    });

    it('a row drained AFTER boot is live delivery, not residue — never recovered', () => {
        const calls: string[] = [];
        const findings = runComposerResidueSweep({
            sessions: [recoverySession({ clearComposer: () => { calls.push('clear'); } })],
            candidates: [candidate({ drainedAt: BOOT_AT + 5_000 })],
            autoRecoverEnabled: false,
            recoveryEnabled: true,
            bootAt: BOOT_AT,
            undrainRow: () => { calls.push('undrain'); return true; },
        });
        expect(findings[0].recovered).toBe(false);
        expect(calls).toEqual([]);
    });

    it('an in-flight submit on the adapter blocks recovery', () => {
        const calls: string[] = [];
        const findings = runComposerResidueSweep({
            sessions: [recoverySession({
                submitInFlight: true,
                clearComposer: () => { calls.push('clear'); },
            })],
            candidates: [candidate({ drainedAt: BOOT_AT - 60_000 })],
            autoRecoverEnabled: false,
            recoveryEnabled: true,
            bootAt: BOOT_AT,
            undrainRow: () => { calls.push('undrain'); return true; },
        });
        expect(findings[0].recovered).toBe(false);
        expect(calls).toEqual([]);
    });

    it('recovery disabled (kill-switch) degrades to detection / legacy autosubmit', () => {
        const calls: string[] = [];
        const findings = runComposerResidueSweep({
            sessions: [recoverySession({
                clearComposer: () => { calls.push('clear'); },
                submitComposer: () => { calls.push('submit'); },
            })],
            candidates: [candidate({ drainedAt: BOOT_AT - 60_000 })],
            autoRecoverEnabled: true,
            recoveryEnabled: false,
            bootAt: BOOT_AT,
            undrainRow: () => { calls.push('undrain'); return true; },
        });
        // Legacy opt-in path still applies; undrain machinery untouched.
        expect(findings[0].recoveredBy).toBe('autosubmit');
        expect(calls).toEqual(['submit']);
    });

    it('a failed undrain never falls back to Enter (the composer is already empty)', () => {
        const calls: string[] = [];
        const findings = runComposerResidueSweep({
            sessions: [recoverySession({
                clearComposer: () => { calls.push('clear'); },
                submitComposer: () => { calls.push('submit'); },
            })],
            candidates: [candidate({ drainedAt: BOOT_AT - 60_000 })],
            autoRecoverEnabled: true,
            recoveryEnabled: true,
            bootAt: BOOT_AT,
            undrainRow: () => { calls.push('undrain'); return false; },
        });
        expect(findings[0].recovered).toBe(false);
        expect(findings[0].recoveredBy).toBeUndefined();
        expect(calls).toEqual(['clear', 'undrain']);
    });

    it('unidentified residue is never cleared or undrained', () => {
        const calls: string[] = [];
        const findings = runComposerResidueSweep({
            sessions: [recoverySession({
                viewportText: '│ chat history │\n❯ some stranded text of unknown origin here\n',
                scrollbackText: '│ chat history │\n❯ some stranded text of unknown origin here\n',
                clearComposer: () => { calls.push('clear'); },
            })],
            candidates: [candidate({ drainedAt: BOOT_AT - 60_000 })],
            autoRecoverEnabled: true,
            recoveryEnabled: true,
            bootAt: BOOT_AT,
            undrainRow: () => { calls.push('undrain'); return true; },
        });
        expect(findings[0].kind).toBe('unidentified');
        expect(calls).toEqual([]);
    });
});
