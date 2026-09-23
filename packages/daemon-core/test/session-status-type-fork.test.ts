import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
    RECENT_SESSION_BUCKETS,
    SESSION_STATUSES,
    SESSION_STATUS_ALIASES,
    classifySessionStatus,
    isBusyStatus,
    isDeadStatus,
    isReadyStatus,
    isWorkingStatus,
    type SessionStatus,
} from '@adhdev/mesh-shared';

import { resolveDeliveryDecision } from '../src/mesh/mesh-delivery-policy.js';
import { isIdleSessionState, sessionStateLooksActive } from '../src/mesh/mesh-candidacy-predicates.js';
import { BUSY_AGENT_STATUSES } from '../src/commands/cli-manager-agent-status.js';
import { waitForIdleAfterInterrupt } from '../src/commands/interrupt-and-deliver.js';
import { isCliGeneratingLikeStatus } from '../src/providers/cli-provider-status-helpers.js';
import type { ManagedStatus } from '../src/status/normalize.js';

/**
 * SESSIONSTATUS-TYPE-FORK regression suite.
 *
 * Root cause: `SessionStatus` was declared twice — canonically in
 * `shared-types-extra.ts` and again as a hand-copied alias in `index.ts` (which
 * rollup-dts forces, since it cannot bundle re-exported type aliases). The copy
 * drifted: it was missing `waiting_choice` and `finalizing`.
 *
 * That drift was not cosmetic. `web-core/src/types.ts` re-exported `SessionStatus`
 * from the PACKAGE ROOT, so every web surface saw a union in which
 * `waiting_choice` did not exist. Authors who tried to handle the state got a
 * type error and escaped into single-string comparisons
 * (`=== 'waiting_approval'`), which is why the same omission appeared in half a
 * dozen unrelated modules.
 *
 * Wiring-unification A1 moved the ONE declaration to mesh-shared
 * (`session-status.ts`): `SESSION_STATUSES` is the runtime list, the type is
 * derived from it, and every "busy" set in daemon-core is a derivation of the
 * per-status class map. What this suite pins now:
 *
 *   - the unavoidable hand copy in `index.ts` equals `SESSION_STATUSES` exactly;
 *   - `shared-types-extra.ts` and `status/normalize.ts` carry no literal union of
 *     their own any more (they re-export / alias the mesh-shared type);
 *   - every rewired busy/idle/dead predicate agrees with `classifySessionStatus`
 *     over every canonical member AND every alias key — so a set can no longer
 *     disagree with the class map by construction.
 */

function readDaemonCoreSource(relativePath: string): string {
    return readFileSync(resolve(__dirname, '../src', relativePath), 'utf8');
}

/** Extract the members of a `export type <Name> = 'a' | 'b' | ...;` declaration. */
function parseStringUnion(source: string, typeName: string, file: string): string[] {
    const match = source.match(new RegExp(`export type ${typeName}\\s*=\\s*([^;]+);`));
    if (!match) throw new Error(`No 'export type ${typeName}' declaration found in ${file}`);
    const members = match[1]
        .split('|')
        .map((part) => part.trim().replace(/^'(.*)'$/, '$1'))
        .filter(Boolean);
    if (members.length === 0) throw new Error(`${typeName} in ${file} parsed to an empty union`);
    return members;
}

/** Every spelling the vocabulary classifies: canonical members plus alias keys. */
const EVERY_CLASSIFIED_SPELLING: readonly string[] = [
    ...SESSION_STATUSES,
    ...Object.keys(SESSION_STATUS_ALIASES),
];

/** Compile-time proof that two types are identical (not merely assignable). */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

describe('SessionStatus type fork', () => {
    // ── #3 ROOT: the hand copy must equal the mesh-shared declaration ──────
    describe('the index.ts hand copy equals SESSION_STATUSES', () => {
        it('index.ts declares exactly the SESSION_STATUSES members', () => {
            const reExported = parseStringUnion(readDaemonCoreSource('index.ts'), 'SessionStatus', 'index.ts');

            // Order-insensitive: the alias is hand-maintained, so what matters is
            // membership, not the order someone happened to type it in.
            expect([...reExported].sort()).toEqual([...SESSION_STATUSES].sort());
        });

        it('index.ts declares exactly the RECENT_SESSION_BUCKETS members', () => {
            const reExported = parseStringUnion(readDaemonCoreSource('index.ts'), 'RecentSessionBucket', 'index.ts');

            expect([...reExported].sort()).toEqual([...RECENT_SESSION_BUCKETS].sort());
        });

        it('the hand copy carries the states the fork had dropped', () => {
            // Guards the specific drift this suite exists for.
            const members = parseStringUnion(readDaemonCoreSource('index.ts'), 'SessionStatus', 'index.ts');
            expect(members).toContain('waiting_choice');
            expect(members).toContain('finalizing');
        });

        it('shared-types-extra.ts re-exports the mesh-shared type instead of redeclaring it', () => {
            const source = readDaemonCoreSource('shared-types-extra.ts');

            expect(source).toMatch(/export type \{[^}]*\bSessionStatus\b[^}]*\} from '@adhdev\/mesh-shared'/);
            expect(source).toMatch(/export type \{[^}]*\bRecentSessionBucket\b[^}]*\} from '@adhdev\/mesh-shared'/);
            expect(source).not.toMatch(/export type SessionStatus\s*=/);
            expect(source).not.toMatch(/export type RecentSessionBucket\s*=/);
        });
    });

    // ── ManagedStatus is the same union, not a third copy ──────────────────
    describe('ManagedStatus is an alias of SessionStatus', () => {
        it('status/normalize.ts aliases the mesh-shared type and lists no members of its own', () => {
            const source = readDaemonCoreSource('status/normalize.ts');

            expect(source).toMatch(/export type ManagedStatus = SessionStatus;/);
            // No literal member list may survive: the alias is the whole declaration.
            expect(source).not.toMatch(/export type ManagedStatus\s*=\s*\|?\s*'/);
            // And no hand-rolled working set either — folding is the alias table's job.
            expect(source).not.toMatch(/WORKING_STATUSES/);
        });

        it('is identical at the type level', () => {
            // Type-level assertion — a compile error here (under tsc) is the gate;
            // the runtime expect only keeps vitest from flagging an empty test.
            const managedIsSessionStatus: Equals<ManagedStatus, SessionStatus> = true;
            expect(managedIsSessionStatus).toBe(true);
        });
    });

    // ── Every busy set is a derivation of the class map ───────────────────
    describe('busy predicates agree with classifySessionStatus over every spelling', () => {
        it('covers a non-trivial vocabulary', () => {
            // Sanity: if mesh-shared ever shipped an empty alias table the loops
            // below would pass vacuously.
            expect(SESSION_STATUSES.length).toBeGreaterThanOrEqual(11);
            expect(Object.keys(SESSION_STATUS_ALIASES).length).toBeGreaterThan(0);
        });

        it.each(EVERY_CLASSIFIED_SPELLING)('BUSY_AGENT_STATUSES.has(%s) === isBusyStatus', (spelling) => {
            expect(BUSY_AGENT_STATUSES.has(spelling)).toBe(isBusyStatus(spelling));
        });

        it('BUSY_AGENT_STATUSES contains nothing the class map does not call busy', () => {
            for (const member of BUSY_AGENT_STATUSES) {
                expect(isBusyStatus(member), `${member} is in BUSY_AGENT_STATUSES but not busy`).toBe(true);
            }
        });

        it.each(EVERY_CLASSIFIED_SPELLING)('sessionStateLooksActive({status: %s}) === isBusyStatus', (spelling) => {
            expect(sessionStateLooksActive({ status: spelling })).toBe(isBusyStatus(spelling));
            expect(sessionStateLooksActive({ activeChat: { status: spelling } })).toBe(isBusyStatus(spelling));
        });

        it.each(EVERY_CLASSIFIED_SPELLING)('isIdleSessionState({status: %s}) === isReadyStatus', (spelling) => {
            expect(isIdleSessionState({ status: spelling })).toBe(isReadyStatus(spelling));
        });

        it.each(EVERY_CLASSIFIED_SPELLING)('isCliGeneratingLikeStatus(%s) === isWorkingStatus', (spelling) => {
            expect(isCliGeneratingLikeStatus(spelling)).toBe(isWorkingStatus(spelling));
        });

        it.each(EVERY_CLASSIFIED_SPELLING)('waitForIdleAfterInterrupt on %s: idle iff neither busy nor dead, terminal iff dead', async (spelling) => {
            const terminalSeen: string[] = [];
            const adapter = {
                cliType: 'test',
                getStatus: () => ({ status: spelling }),
                sendMessage: async () => ({ status: 'delivered' as const }),
            };

            // timeoutMs 0: a busy status returns false on the first sample, so the
            // wait never actually sleeps.
            const idle = await waitForIdleAfterInterrupt(adapter, 0, 1, {
                onTerminalStatus: (status) => { terminalSeen.push(status); },
            });

            const cls = classifySessionStatus(spelling);
            expect(idle).toBe(cls !== 'working' && cls !== 'blocked' && cls !== 'dead');
            // Dead is never "successfully interrupted" — see the 10:25 trace note.
            expect(terminalSeen).toEqual(isDeadStatus(spelling) ? [spelling] : []);
        });
    });

    // ── A: mesh delivery policy must not fail-closed on waiting_choice ─────
    describe('A — mesh delivery policy recognises waiting_choice', () => {
        it('queues rather than rejecting a session parked on a question picker', () => {
            const result = resolveDeliveryDecision('waiting_choice');

            // The drift made this fall through every Set to the fail-closed tail,
            // so mesh_send_task was REFUSED outright for a picker-parked session
            // while the identical waiting_approval case queued normally.
            expect(result.decision).toBe('queued');
            expect(result.reason).not.toBe('unrecognized_session_status');
        });

        it('classifies waiting_choice the same way as waiting_approval', () => {
            expect(resolveDeliveryDecision('waiting_choice').decision)
                .toBe(resolveDeliveryDecision('waiting_approval').decision);
        });

        it('delivers an approval-kind answer immediately instead of queueing it', () => {
            // Queueing would deadlock: the session only leaves waiting_choice once
            // someone answers, so "deliver when idle" means "never deliver".
            const result = resolveDeliveryDecision('waiting_choice', { kind: 'approval' });

            expect(result.decision).toBe('immediate');
            expect(result.reason).toBe('session_waiting_choice_approval_message');
        });

        it('still fails closed on a genuinely unknown status', () => {
            // The fix widens the allow-list; it must not have weakened the tail.
            const result = resolveDeliveryDecision('no_such_status');

            expect(result.decision).toBe('rejected');
            expect(result.reason).toBe('unrecognized_session_status');
        });
    });

    // ── B (daemon layer): inbox bucketing ──────────────────────────────────
    describe('B — the inbox buckets waiting_choice as needs_attention', () => {
        // getUnreadState is module-private, so assert on the source shape of the
        // branch that produces the bucket. The web-side twin of this assertion
        // lives in web-core's own suite.
        const snapshot = readDaemonCoreSource('status/snapshot.ts');

        it('the needs_attention branch tests both human-decision parks', () => {
            const branch = snapshot.match(
                /if \(status === 'waiting_approval'[^)]*\) \{\s*return \{ unread: false, inboxBucket: 'needs_attention' \};/,
            );

            expect(branch, 'needs_attention branch not found in status/snapshot.ts').not.toBeNull();
            expect(branch![0]).toContain("status === 'waiting_choice'");
        });

        it('does not let waiting_choice fall through to the working bucket', () => {
            // The drift dropped it past needs_attention AND past working, landing it
            // in idle/task_complete — i.e. invisible in the attention list.
            const workingBranch = snapshot.match(/if \(status === 'generating'[^)]*\)/);

            expect(workingBranch).not.toBeNull();
            expect(workingBranch![0]).not.toContain('waiting_choice');
        });
    });

    // ── D: status resolution priority ──────────────────────────────────────
    describe('D — waiting_choice outranks a stale generating', () => {
        const builders = readDaemonCoreSource('status/builders.ts');

        function priorityOf(status: string): number {
            const body = builders.match(
                /function resolveSessionStatus\([\s\S]*?\n\}/,
            );
            expect(body, 'resolveSessionStatus not found in status/builders.ts').not.toBeNull();
            const lines = body![0].split('\n');
            const index = lines.findIndex((line) => line.includes(`return '${status}'`));
            expect(index, `no return row for '${status}' in resolveSessionStatus`).toBeGreaterThan(-1);
            return index;
        }

        it('has a dedicated return row for waiting_choice', () => {
            expect(() => priorityOf('waiting_choice')).not.toThrow();
        });

        it('checks waiting_choice BEFORE generating', () => {
            // A picker-parked session commonly still carries a stale top-level
            // `generating` (the provider FSM has not observed the park yet). With
            // no row of its own, the generating row won and the picker vanished
            // from every downstream consumer.
            expect(priorityOf('waiting_choice')).toBeLessThan(priorityOf('generating'));
        });

        it('leaves waiting_approval ahead of waiting_choice', () => {
            // Ordering between the two parks is unchanged by this fix.
            expect(priorityOf('waiting_approval')).toBeLessThan(priorityOf('waiting_choice'));
        });
    });

    // ── F: busy/active predicates ──────────────────────────────────────────
    describe('F — a picker-parked node does not read as free', () => {
        it('sessionStateLooksActive treats waiting_choice as active', () => {
            // Reading it as free lets the active-work gate pass and a SECOND
            // session gets claimed for work already running on the node.
            expect(sessionStateLooksActive({ status: 'waiting_choice' })).toBe(true);
        });

        it('treats waiting_choice on the chat lane as active too', () => {
            expect(sessionStateLooksActive({ activeChat: { status: 'waiting_choice' } })).toBe(true);
        });

        it('BUSY_AGENT_STATUSES contains waiting_choice alongside waiting_approval', () => {
            expect(BUSY_AGENT_STATUSES.has('waiting_choice')).toBe(true);
            expect(BUSY_AGENT_STATUSES.has('waiting_approval')).toBe(true);
        });

        it('still reports a genuinely idle session as inactive', () => {
            expect(sessionStateLooksActive({ status: 'idle' })).toBe(false);
        });

        it('an unclassified spelling is neither busy nor idle for dispatch', () => {
            // `unknown` class: the candidacy predicates must fail safe — not a
            // launch candidate, and not evidence of active work either.
            expect(sessionStateLooksActive({ status: 'no_such_status' })).toBe(false);
            expect(isIdleSessionState({ status: 'no_such_status' })).toBe(false);
        });
    });
});
