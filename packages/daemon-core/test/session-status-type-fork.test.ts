import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

import { resolveDeliveryDecision } from '../src/mesh/mesh-delivery-policy.js';
import { sessionStateLooksActive } from '../src/mesh/mesh-candidacy-predicates.js';
import { BUSY_AGENT_STATUSES } from '../src/commands/cli-manager-agent-status.js';

/**
 * SESSIONSTATUS-TYPE-FORK regression suite.
 *
 * Root cause: `SessionStatus` was declared twice — canonically in
 * `shared-types-extra.ts` and again as a hand-copied alias in `index.ts` (which
 * rollup-dts forces, since it cannot bundle re-exported type aliases). The copy
 * drifted: it was missing `waiting_choice` and `finalizing`.
 *
 * That drift was not cosmetic. `web-core/src/types.ts` re-exports `SessionStatus`
 * from the PACKAGE ROOT, so every web surface saw a union in which
 * `waiting_choice` did not exist. Authors who tried to handle the state got a
 * type error and escaped into single-string comparisons
 * (`=== 'waiting_approval'`), which is why the same omission appears in half a
 * dozen unrelated modules. `providers/cli-provider-instance.ts` even documents
 * the workaround: "the SessionStatus enum is forked across modules and
 * waiting_choice is absent from some of them."
 *
 * The type is the thing that must not drift again — hence the source-shape guard
 * below, plus one behavioural test per site that the drift had silently broken.
 */

function readDaemonCoreSource(relativePath: string): string {
    return readFileSync(resolve(__dirname, '../src', relativePath), 'utf8');
}

/** Extract the members of a `export type SessionStatus = 'a' | 'b' | ...;` declaration. */
function parseSessionStatusUnion(source: string, file: string): string[] {
    const match = source.match(/export type SessionStatus\s*=\s*([^;]+);/);
    if (!match) throw new Error(`No 'export type SessionStatus' declaration found in ${file}`);
    const members = match[1]
        .split('|')
        .map((part) => part.trim().replace(/^'(.*)'$/, '$1'))
        .filter(Boolean);
    if (members.length === 0) throw new Error(`SessionStatus in ${file} parsed to an empty union`);
    return members;
}

describe('SessionStatus type fork', () => {
    // ── #3 ROOT: the two declarations must stay identical ──────────────────
    describe('the canonical and re-exported declarations agree', () => {
        it('index.ts declares exactly the same members as shared-types-extra.ts', () => {
            const canonical = parseSessionStatusUnion(
                readDaemonCoreSource('shared-types-extra.ts'),
                'shared-types-extra.ts',
            );
            const reExported = parseSessionStatusUnion(
                readDaemonCoreSource('index.ts'),
                'index.ts',
            );

            // Order-insensitive: the alias is hand-maintained, so what matters is
            // membership, not the order someone happened to type it in.
            expect([...reExported].sort()).toEqual([...canonical].sort());
        });

        it('both declarations carry the states the fork had dropped', () => {
            // Guards the specific drift this suite exists for: a future edit that
            // re-drops waiting_choice/finalizing from EITHER file fails here even
            // if it (impossibly) kept the two in sync by removing from both.
            for (const file of ['shared-types-extra.ts', 'index.ts'] as const) {
                const members = parseSessionStatusUnion(readDaemonCoreSource(file), file);
                expect(members, `${file} must include waiting_choice`).toContain('waiting_choice');
                expect(members, `${file} must include finalizing`).toContain('finalizing');
            }
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
    });
});
