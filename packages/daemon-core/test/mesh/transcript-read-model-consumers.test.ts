/**
 * ★ THE ROSTER ENABLEMENT AUTHORITY.
 *
 * This suite is the ONLY place that asserts which roster ids are enabled, and
 * it asserts the set in full. Per-unit suites assert their OWN ids (derived via
 * `rosterIdsForUnit`) and nothing else — see the roster module header's "Test
 * authority" note for why, and `guards no suite asserts another unit's ids`
 * below for the check that keeps it that way.
 *
 * A future unit that flips an id on updates EXACTLY this file's `ENABLED` set
 * plus its own suite. No other test should need touching.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
    rosterIdsForUnit,
    TRANSCRIPT_CONSUMER_IDS,
    TRANSCRIPT_CONSUMER_ROSTER,
    withRosterEntryDisabled,
    type TranscriptConsumerFallbackReason,
    type TranscriptConsumerId,
} from '../../src/mesh/transcript-read-model-consumers.js';

// Design §4's roster table, in consumer integration order (§8's commit
// numbering). If a future edit renames/reorders a roster id without updating
// this list, the exhaustiveness check below (not just this literal) catches
// the drift.
const EXPECTED_ROSTER_ORDER: readonly TranscriptConsumerId[] = [
    'web_chat_pane',
    'web_warm_mobile_preview',
    'mesh_read_chat_display',
    'daemon_worker_status_probe',
    'daemon_terminal_evidence',
    'mcp_mesh_status_reconciliation',
    'magi_approval_probe',
    'magi_result_collect',
];

describe('transcript-read-model-consumers roster', () => {
    it('enumerates exactly the 8 design §4 roster ids', () => {
        expect(TRANSCRIPT_CONSUMER_IDS).toEqual(EXPECTED_ROSTER_ORDER);
        expect(Object.keys(TRANSCRIPT_CONSUMER_ROSTER).sort()).toEqual(
            [...EXPECTED_ROSTER_ORDER].sort(),
        );
    });

    // ★ The authoritative enabled set. Enablement grew one unit at a time — 5
    // (web pane), 6 (mesh_read_chat display), 7 (the two daemon-side semantic
    // consumers), 8 (the three mcp-server semantic consumers) — and with 7 and
    // 8 both landed the roster is fully enabled. A future id added to the table
    // fails here until it is added to this set by its own unit, which is the
    // point: the decision is recorded in one place.
    const ENABLED: ReadonlySet<string> = new Set([
        'web_chat_pane',
        'web_warm_mobile_preview',
        'mesh_read_chat_display',
        'daemon_worker_status_probe',
        'daemon_terminal_evidence',
        'mcp_mesh_status_reconciliation',
        'magi_approval_probe',
        'magi_result_collect',
    ]);

    it('pins the complete enabled set — every roster consumer is enabled after units 5-8', () => {
        for (const id of TRANSCRIPT_CONSUMER_IDS) {
            const entry = TRANSCRIPT_CONSUMER_ROSTER[id];
            expect(entry.enabled, `roster id ${id}`).toBe(ENABLED.has(id));
        }
        // Guards the direction the loop above cannot: a stale name left in
        // ENABLED after an id is renamed or dropped from the table.
        for (const id of ENABLED) {
            expect(TRANSCRIPT_CONSUMER_IDS, `ENABLED lists unknown id ${id}`).toContain(id);
        }
    });

    it('assigns every id to the §8 unit that cut it over', () => {
        // Ownership drives `rosterIdsForUnit`, which per-unit suites use to
        // scope their assertions — so a wrong number here silently widens or
        // empties another suite's coverage.
        expect(
            Object.fromEntries(TRANSCRIPT_CONSUMER_IDS.map((id) => [id, TRANSCRIPT_CONSUMER_ROSTER[id].unit])),
        ).toEqual({
            web_chat_pane: 5,
            web_warm_mobile_preview: 5,
            mesh_read_chat_display: 6,
            daemon_worker_status_probe: 7,
            daemon_terminal_evidence: 7,
            mcp_mesh_status_reconciliation: 8,
            magi_approval_probe: 8,
            magi_result_collect: 8,
        });
    });

    it('rosterIdsForUnit partitions the roster and returns nothing for an unclaimed unit', () => {
        const partitioned = [5, 6, 7, 8].flatMap((u) => [...rosterIdsForUnit(u)]);
        expect(partitioned.sort()).toEqual([...TRANSCRIPT_CONSUMER_IDS].sort());
        // A per-unit suite asserts its ids are non-empty precisely because this
        // is what a renumbered entry looks like: zero checks, silently green.
        expect(rosterIdsForUnit(9)).toEqual([]);
    });

    it('withRosterEntryDisabled flips one id without mutating the real roster', () => {
        const patched = withRosterEntryDisabled('magi_result_collect');
        expect(patched.magi_result_collect.enabled).toBe(false);
        expect(patched.magi_approval_probe.enabled).toBe(true);
        expect(TRANSCRIPT_CONSUMER_ROSTER.magi_result_collect.enabled).toBe(true);
    });

    it('every roster entry names a current call site and a losslessness note', () => {
        for (const id of TRANSCRIPT_CONSUMER_IDS) {
            const entry = TRANSCRIPT_CONSUMER_ROSTER[id];
            expect(entry.currentLocation.length, `roster id ${id} currentLocation`).toBeGreaterThan(0);
            expect(entry.note.length, `roster id ${id} note`).toBeGreaterThan(0);
        }
    });

    // ── the recurrence guard ────────────────────────────────────────────────
    // The failure this whole restructure exists to stop: a per-unit suite
    // asserting `TRANSCRIPT_CONSUMER_ROSTER.<someone-elses-id>.enabled`. It is
    // green when written and goes red the day that id's unit lands — twice
    // already (oss f8704493, then a bootstrap branch). A comment did not stop
    // it, so this checks mechanically.
    //
    // Deliberately a source scan, not a type/lint rule: the mistake is textual
    // (naming a foreign id in an assertion), it spans two packages with two
    // different test runners, and the alternative — a custom ESLint rule — is
    // far more machinery than one readdir. Scoped to `enabled` assertions only,
    // so a suite may still MENTION a foreign id (in an injected roster literal,
    // a comment, or a fixture) without tripping the guard.
    const PER_UNIT_SUITES: readonly { readonly file: string; readonly unit: number }[] = [
        { file: join(dirname(fileURLToPath(import.meta.url)), 'transcript-daemon-consumer-read.test.ts'), unit: 7 },
        {
            file: join(
                dirname(fileURLToPath(import.meta.url)),
                '../../../mcp-server/test/mesh-semantic-transcript-cutover.test.ts',
            ),
            unit: 8,
        },
    ];

    it('guards that no per-unit suite asserts another unit\'s enabled state', () => {
        for (const { file, unit } of PER_UNIT_SUITES) {
            const source = readFileSync(file, 'utf8');
            const owned = new Set(rosterIdsForUnit(unit));
            expect(owned.size, `unit ${unit} owns no roster ids — renumbered?`).toBeGreaterThan(0);

            // Matches `TRANSCRIPT_CONSUMER_ROSTER.<id>.enabled` and the
            // `['<id>']` form, i.e. exactly the shape of an enablement claim.
            const claims = [...source.matchAll(/TRANSCRIPT_CONSUMER_ROSTER(?:\.(\w+)|\['(\w+)'\])\.enabled/g)]
                .map((m) => m[1] ?? m[2])
                .filter((id) => !owned.has(id as TranscriptConsumerId));

            expect(
                [...new Set(claims)],
                `${file} asserts .enabled on roster ids it does not own (unit ${unit}). `
                    + 'Assert only rosterIdsForUnit(unit); the complete set is this suite\'s job.',
            ).toEqual([]);
        }
    });

    it('the guard actually catches a foreign-id assertion', () => {
        // Injection check for the guard itself: the regex must match the shape
        // a real offender takes. Unit 7's suite asserting a unit-8 id is the
        // literal text of the bug that shipped.
        const offender = 'expect(TRANSCRIPT_CONSUMER_ROSTER.magi_result_collect.enabled).toBe(false);';
        const owned = new Set(rosterIdsForUnit(7));
        const claims = [...offender.matchAll(/TRANSCRIPT_CONSUMER_ROSTER(?:\.(\w+)|\['(\w+)'\])\.enabled/g)]
            .map((m) => m[1] ?? m[2])
            .filter((id) => !owned.has(id as TranscriptConsumerId));
        expect(claims).toEqual(['magi_result_collect']);
    });

    it('exposes a TranscriptConsumerFallbackReason that matches the design §4 closed union', () => {
        // Type-level exhaustiveness: this array must accept every literal of
        // TranscriptConsumerFallbackReason and nothing else. A member added or
        // removed from the union without updating this list fails to compile.
        const reasons: readonly TranscriptConsumerFallbackReason[] = [
            'mode_not_primary',
            'consumer_not_enabled',
            'no_node',
            'authority_unavailable',
            'topic_undefined',
            'topic_not_granted',
            'owner_mismatch',
            'no_complete_revision',
            'revision_invalid',
            'projection_oversize',
            'coverage_insufficient',
            'stale_active_session',
            'quarantined',
            'parity_mismatch',
            'ipc_unavailable',
            'stats_error',
        ];
        expect(new Set(reasons).size).toBe(reasons.length);
        expect(reasons.length).toBe(16);
    });
});
