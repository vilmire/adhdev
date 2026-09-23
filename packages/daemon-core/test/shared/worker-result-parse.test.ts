import { describe, expect, it } from 'vitest';
import { extractJsonObjectFromSummary } from '../../src/shared/worker-result-parse.js';

// GRAPH-ORCHESTRATION — the completion envelope's worker_result.
//
//   Design SoT: docs/design/2026-08-18-graph-orchestration-full.md
//     :149-163  output envelope shape (final_summary / worker_result)
//
// Moved out of `mesh/mesh-event-forwarding.ts`'s (deleted, C-W5c)
// `resolveGraphEnvelopeWorkerResult` — the relay-alias precedence
// (workerResult / meshWorkerResult / structuredResult winning over the
// parse) lived ONLY in that deleted evidence builder and has no live caller
// today (a relayed `agent:generating_completed` no longer builds evidence at
// all — see mesh-event-forwarding.ts's "1. Evidence builder — DELETED" note
// and mesh-forwarding-evidence.test.ts). What survives, and is pinned here
// directly at its new home (`shared/worker-result-parse.ts`, used by
// `providers/completion/completion-flush.ts` — see
// completion-flush-turn-evidence.test.ts for the producer-side wiring), is
// the pure trailing-JSON-in-a-final-summary parse itself.

/** A worker's trailing report block, as the report format asks for it. */
const WORKER_REPORT = {
    status: 'completed',
    changedFiles: ['src/mesh/mesh-graph-workspace-saga.ts'],
    gitStatus: 'committed',
    validationResults: 'typecheck clean; 10 tests passed',
    errors: [],
    nextAction: 'merge',
};

describe('extractJsonObjectFromSummary (graph envelope worker_result, design :149-163)', () => {
    it('parses a fenced final summary into the worker report object', () => {
        const resolved = extractJsonObjectFromSummary(
            `Done — base revision now derives from the source node.\n\n\`\`\`json\n${JSON.stringify(WORKER_REPORT)}\n\`\`\``,
        );
        expect(resolved).toEqual(WORKER_REPORT);
    });

    it('exposes exactly the report\'s own key names, unnormalized', () => {
        const resolved = extractJsonObjectFromSummary(`wrapped up\n\`\`\`json\n${JSON.stringify(WORKER_REPORT)}\n\`\`\``)!;
        expect(resolved.status).toBe('completed');
        expect(resolved.validationResults).toBe('typecheck clean; 10 tests passed');
        expect(resolved.nextAction).toBe('merge');
    });

    it('parses an unfenced summary that is itself the report object', () => {
        expect(extractJsonObjectFromSummary(JSON.stringify(WORKER_REPORT))).toEqual(WORKER_REPORT);
    });

    // ── The parse must not INVENT a result where the worker reported none ──

    it('ignores a stray JSON blob that is not worker-result shaped', () => {
        // Tool output / a log line that happens to be JSON. Treating this as a
        // result would feed a downstream task fabricated evidence — worse than
        // an empty envelope.
        expect(extractJsonObjectFromSummary('ran the probe\n```json\n{"latencyMs": 12, "ok": true}\n```')).toBeUndefined();
    });

    it('returns undefined for prose-only, empty and absent summaries', () => {
        expect(extractJsonObjectFromSummary('all done, nothing to report')).toBeUndefined();
        expect(extractJsonObjectFromSummary('')).toBeUndefined();
        expect(extractJsonObjectFromSummary(undefined)).toBeUndefined();
    });

    it('returns undefined for malformed JSON rather than throwing', () => {
        expect(() => extractJsonObjectFromSummary('```json\n{"status": "completed", "changedFiles": [\n```')).not.toThrow();
        expect(extractJsonObjectFromSummary('```json\n{"status": "completed", "changedFiles": [\n```')).toBeUndefined();
    });
});
