/**
 * ENTER-LOSS layer ③ — boot-time composer-residue sweep (2026-09-10 incident:
 * a drained notification body stranded in a session-host composer across a
 * daemon restart, invisible to redelivery because the ledger row was already
 * drained=1).
 *
 * Covered:
 *  - identification: residue is matched to the drained ledger candidate and
 *    the finding carries its mesh/event/task identity;
 *  - recovery default OFF: even a full-integrity match is NOT submitted;
 *  - recovery opt-in: full-integrity match + flag → exactly one Enter;
 *  - truncated residue (partial integrity) is NEVER submitted, flag or not;
 *  - unidentified residue is still reported (observation point);
 *  - non-idle sessions and clean composers produce no findings.
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
