import { describe, expect, it } from 'vitest';

// GRAPH-ORCHESTRATION — the completion envelope's worker_result.
//
//   Design SoT: docs/design/2026-08-18-graph-orchestration-full.md
//     :149-163  output envelope shape (final_summary / worker_result)
//
// The defect these pin: envelope.worker_result was ALWAYS undefined for a
// locally-completed task, so every documented downstream pointer —
// `/worker_result/status`, `/worker_result/validationResults`, … — silently
// resolved to nothing, and a `required: true` binding on one of them
// fail-closed on evidence the worker had in fact reported.
//
// readWorkerResultMetadata reads only PRE-POPULATED event fields
// (workerResult / meshWorkerResult / structuredResult). Their sole writer in
// daemon-core is the remote-relay passthrough, so a local completion had no
// writer at all. The fix reuses the trailing-JSON parse the ledger evidence
// record has always applied to the final summary.
//
// The remote-relay path is a shared hot path, so its passthrough is pinned
// here as explicitly as the fix itself.

import { resolveGraphEnvelopeWorkerResult } from '../../src/mesh/mesh-event-forwarding.js';

/** A worker's trailing report block, as the report format asks for it. */
const WORKER_REPORT = {
    status: 'completed',
    changedFiles: ['src/mesh/mesh-graph-workspace-saga.ts'],
    gitStatus: 'committed',
    validationResults: 'typecheck clean; 10 tests passed',
    errors: [],
    nextAction: 'merge',
};

describe('graph envelope worker_result (design :149-163)', () => {
    it('parses the local completion final summary that used to yield nothing', () => {
        const resolved = resolveGraphEnvelopeWorkerResult({
            finalSummary: `Done — base revision now derives from the source node.\n\n\`\`\`json\n${JSON.stringify(WORKER_REPORT)}\n\`\`\``,
        });
        expect(resolved).toEqual(WORKER_REPORT);
    });

    it('exposes exactly the pointers inputs_from documents', () => {
        const resolved = resolveGraphEnvelopeWorkerResult({
            finalSummary: `wrapped up\n\`\`\`json\n${JSON.stringify(WORKER_REPORT)}\n\`\`\``,
        })!;
        // The parsed object is passed through UNNORMALIZED, matching how a relayed
        // workerResult is passed through — so the worker's own key names are what a
        // `/worker_result/<field>` pointer selects.
        expect(resolved.status).toBe('completed');
        expect(resolved.validationResults).toBe('typecheck clean; 10 tests passed');
        expect(resolved.nextAction).toBe('merge');
    });

    it('parses an unfenced summary that is itself the report object', () => {
        const resolved = resolveGraphEnvelopeWorkerResult({
            finalSummary: JSON.stringify(WORKER_REPORT),
        });
        expect(resolved).toEqual(WORKER_REPORT);
    });

    // ── REMOTE-RELAY SAFETY: shared hot path, must be byte-identical to before ──

    it('returns relayed workerResult as-is and never parses over it', () => {
        const relayed = { status: 'completed', changedFiles: ['relayed.ts'] };
        const resolved = resolveGraphEnvelopeWorkerResult({
            workerResult: relayed,
            // A DIFFERENT worker-shaped block in the summary must NOT win: the
            // fallback is a fallback, never an override.
            finalSummary: `\`\`\`json\n${JSON.stringify(WORKER_REPORT)}\n\`\`\``,
        });
        expect(resolved).toBe(relayed);
    });

    it('keeps the meshWorkerResult and structuredResult relay aliases ahead of the parse', () => {
        const viaMesh = { status: 'completed', errors: ['mesh alias'] };
        expect(resolveGraphEnvelopeWorkerResult({
            meshWorkerResult: viaMesh,
            finalSummary: JSON.stringify(WORKER_REPORT),
        })).toBe(viaMesh);

        const viaStructured = { status: 'failed', errors: ['structured alias'] };
        expect(resolveGraphEnvelopeWorkerResult({
            structuredResult: viaStructured,
            finalSummary: JSON.stringify(WORKER_REPORT),
        })).toBe(viaStructured);
    });

    // ── The parse must not INVENT a result where the worker reported none ──

    it('ignores a stray JSON blob that is not worker-result shaped', () => {
        // Tool output / a log line that happens to be JSON. Treating this as a
        // result would feed a downstream task fabricated evidence — worse than
        // the empty envelope this change fixes.
        expect(resolveGraphEnvelopeWorkerResult({
            finalSummary: 'ran the probe\n```json\n{"latencyMs": 12, "ok": true}\n```',
        })).toBeUndefined();
    });

    it('returns undefined for prose-only, empty and absent summaries', () => {
        expect(resolveGraphEnvelopeWorkerResult({ finalSummary: 'all done, nothing to report' })).toBeUndefined();
        expect(resolveGraphEnvelopeWorkerResult({ finalSummary: '' })).toBeUndefined();
        expect(resolveGraphEnvelopeWorkerResult({})).toBeUndefined();
    });

    it('returns undefined for malformed JSON rather than throwing into the completion path', () => {
        expect(resolveGraphEnvelopeWorkerResult({
            finalSummary: '```json\n{"status": "completed", "changedFiles": [\n```',
        })).toBeUndefined();
    });
});
