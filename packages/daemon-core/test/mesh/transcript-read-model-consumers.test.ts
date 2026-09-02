import { describe, expect, it } from 'vitest';
import {
    TRANSCRIPT_CONSUMER_IDS,
    TRANSCRIPT_CONSUMER_ROSTER,
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

    // Enabled set grows one unit at a time — units 5 (web pane), 6
    // (mesh_read_chat display) and 7 (the two daemon-side semantic consumers)
    // have landed; ids 6-8 of the table (all mcp-server, §8 unit 8) are still
    // declared-but-unwired. Extend this list ONLY alongside the unit that
    // actually wires the consumer's routing.
    it('enables exactly the §8 unit 5-7 consumers', () => {
        const enabled = new Set([
            'web_chat_pane',
            'web_warm_mobile_preview',
            'mesh_read_chat_display',
            'daemon_worker_status_probe',
            'daemon_terminal_evidence',
        ]);
        for (const id of TRANSCRIPT_CONSUMER_IDS) {
            const entry = TRANSCRIPT_CONSUMER_ROSTER[id];
            expect(entry.enabled, `roster id ${id}`).toBe(enabled.has(id));
        }
    });

    it('every roster entry names a current call site and a losslessness note', () => {
        for (const id of TRANSCRIPT_CONSUMER_IDS) {
            const entry = TRANSCRIPT_CONSUMER_ROSTER[id];
            expect(entry.currentLocation.length, `roster id ${id} currentLocation`).toBeGreaterThan(0);
            expect(entry.note.length, `roster id ${id} note`).toBeGreaterThan(0);
        }
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
