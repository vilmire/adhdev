import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Override home dir to use a temp directory for ledger storage
const testTmpDir = join(tmpdir(), `adhdev-ledger-test-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

// We need to mock getConfigDir before importing the module
import { vi } from 'vitest';

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) {
            mkdirSync(testConfigDir, { recursive: true });
        }
        return testConfigDir;
    },
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
}));

import { buildTaskCompletionEvidence, buildWorkerTaskFooter } from '../../src/mesh/mesh-ledger.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';

describe('mesh-ledger', () => {
    const testMeshId = `test-mesh-${randomUUID().slice(0, 8)}`;

    beforeEach(() => {
        if (!existsSync(testConfigDir)) {
            mkdirSync(testConfigDir, { recursive: true });
        }
    });

    afterEach(() => {
        // Reset SQLite store so tests don't bleed into each other via the G2 ledger table.
        MeshRuntimeStore.resetForTests();
        try {
            rmSync(testTmpDir, { recursive: true, force: true });
        } catch { /* cleanup best-effort */ }
    });

    describe('buildTaskCompletionEvidence', () => {
        it('records deferred evidence for ordinary agent status completions', () => {
            const evidence = buildTaskCompletionEvidence({
                event: 'agent:generating_completed',
                nodeId: 'node_child_1',
                sessionId: 'runtime-session-1',
                providerType: 'hermes-cli',
                providerSessionId: 'provider-history-1',
                finalSummary: 'done',
                completedAt: '2026-05-13T13:20:47.000Z',
            });

            expect(evidence).toEqual({
                source: 'agent_status_event',
                event: 'agent:generating_completed',
                nodeId: 'node_child_1',
                sessionId: 'runtime-session-1',
                providerType: 'hermes-cli',
                completedAt: '2026-05-13T13:20:47.000Z',
                transcriptHandle: {
                    kind: 'provider_session',
                    sessionId: 'runtime-session-1',
                    providerSessionId: 'provider-history-1',
                    finalSummaryAvailable: true,
                },
                git: {
                    status: 'deferred',
                    reason: 'ordinary_completion_git_status_not_checked',
                },
                validation: {
                    status: 'deferred',
                    commandsRun: [],
                    reason: 'ordinary_completion_validation_not_run',
                },
                workerResult: {
                    status: 'unknown',
                    changedFiles: [],
                    validationResults: [],
                    processArtifacts: [],
                    errors: [],
                    requiresUserAction: false,
                    source: 'default',
                },
                checkpoint: {
                    attempted: false,
                    reason: 'not_attempted_for_ordinary_completion',
                },
            });
        });

        // FIX#2b — evidenceLevel was always 'insufficient' because resolveWorkerResult returned
        // source='default' whenever the finalSummary was not worker-result-shaped JSON — even when
        // a complete, valid (e.g. MAGI) JSON answer WAS present. resolveWorkerResult now upgrades
        // that case to source='parseable_answer' so the evidenceLevel branch (which marks ONLY
        // 'default' insufficient) resolves it to 'sufficient'.
        it("keeps source='default' for a prose-only final summary (no parseable answer)", () => {
            const evidence = buildTaskCompletionEvidence({
                event: 'agent:generating_completed',
                nodeId: 'n', sessionId: 's',
                finalSummary: 'I finished the investigation, all good.',
            });
            expect(evidence.workerResult.source).toBe('default');
        });

        it("upgrades to source='parseable_answer' when the final summary holds a parseable JSON answer that is NOT worker-result-shaped", () => {
            const magiAnswer = JSON.stringify({
                claims: [{ claim: 'X is the cause', stance: 'support', evidence: ['a.ts:1'], confidence: 0.9 }],
                top_findings: ['found X'],
                open_questions: [],
            });
            const evidence = buildTaskCompletionEvidence({
                event: 'agent:generating_completed',
                nodeId: 'n', sessionId: 's',
                finalSummary: magiAnswer,
            });
            // Not 'default' → the evidenceLevel branch will NOT mark it 'insufficient'.
            expect(evidence.workerResult.source).toBe('parseable_answer');
            expect(evidence.workerResult.source).not.toBe('default');
        });

        it("recognizes a fenced JSON answer in the final summary", () => {
            const fenced = 'Here is my answer:\n```json\n' + JSON.stringify({ answer: 42, reasoning: 'because' }) + '\n```';
            const evidence = buildTaskCompletionEvidence({
                event: 'agent:generating_completed',
                nodeId: 'n', sessionId: 's',
                finalSummary: fenced,
            });
            expect(evidence.workerResult.source).toBe('parseable_answer');
        });

        it("still prefers source='final_summary_json' when the summary IS a worker-result envelope", () => {
            const workerJson = JSON.stringify({ status: 'completed', changedFiles: ['a.ts'], nextAction: 'merge' });
            const evidence = buildTaskCompletionEvidence({
                event: 'agent:generating_completed',
                nodeId: 'n', sessionId: 's',
                finalSummary: workerJson,
            });
            // A real worker-result envelope is still 'final_summary_json' (self-attributing),
            // distinct from the weaker 'parseable_answer' tier.
            expect(evidence.workerResult.source).toBe('final_summary_json');
        });
    });

    describe('buildWorkerTaskFooter', () => {
        it('returns a string containing the structured result schema', () => {
            const footer = buildWorkerTaskFooter();
            expect(typeof footer).toBe('string');
            expect(footer.length).toBeGreaterThan(0);
            expect(footer).toContain('"status"');
            expect(footer).toContain('"changedFiles"');
            expect(footer).toContain('"gitStatus"');
            expect(footer).toContain('"validationResults"');
            expect(footer).toContain('"errors"');
            expect(footer).toContain('"nextAction"');
            expect(footer).toContain('completed');
        });
    });

    describe('extractJsonObjectFromSummary via buildTaskCompletionEvidence', () => {
        const baseOpts = {
            event: 'agent:generating_completed' as const,
            nodeId: 'n1',
            sessionId: 's1',
        };

        it('parses worker JSON with status and changedFiles', () => {
            const evidence = buildTaskCompletionEvidence({
                ...baseOpts,
                finalSummary: 'All done.\n```json\n{"status":"completed","changedFiles":["src/foo.ts"],"errors":[]}\n```',
            });
            expect(evidence.workerResult.status).toBe('completed');
            expect(evidence.workerResult.changedFiles).toEqual(['src/foo.ts']);
            expect(evidence.workerResult.errors).toEqual([]);
            expect(evidence.workerResult.source).toBe('final_summary_json');
        });

        it('does not populate worker fields from generic JSON, but marks it parseable_answer (FIX#2b)', () => {
            const evidence = buildTaskCompletionEvidence({
                ...baseOpts,
                finalSummary: 'Some summary.\n```json\n{"foo":"bar","baz":123}\n```',
            });
            // extractJsonObjectFromSummary still rejects non-worker JSON, so NO worker fields are
            // fabricated (status stays 'unknown', changedFiles empty)…
            expect(evidence.workerResult.status).toBe('unknown');
            expect(evidence.workerResult.changedFiles).toEqual([]);
            // …but a parseable JSON answer is concrete evidence, so source is upgraded off 'default'
            // (FIX#2b: the evidenceLevel branch will not label this 'insufficient').
            expect(evidence.workerResult.source).toBe('parseable_answer');
        });

        it('accepts JSON with status + errors only', () => {
            const evidence = buildTaskCompletionEvidence({
                ...baseOpts,
                finalSummary: '```json\n{"status":"failed","errors":["build failed"]}\n```',
            });
            expect(evidence.workerResult.status).toBe('failed');
            expect(evidence.workerResult.errors).toContain('build failed');
            expect(evidence.workerResult.source).toBe('final_summary_json');
        });

        it('accepts JSON with status + gitStatus', () => {
            const evidence = buildTaskCompletionEvidence({
                ...baseOpts,
                finalSummary: '```json\n{"status":"completed","gitStatus":{"branch":"feat/x","committed":true}}\n```',
            });
            expect(evidence.workerResult.status).toBe('completed');
            expect(evidence.workerResult.gitStatus).toEqual({ branch: 'feat/x', committed: true });
            expect(evidence.workerResult.source).toBe('final_summary_json');
        });

        it('does not treat status-only JSON as a worker envelope, but marks it parseable_answer (FIX#2b)', () => {
            // "status" alone plus an unrelated field is not a worker envelope — need
            // changedFiles/errors/gitStatus/nextAction/validationResults — so worker fields are
            // NOT populated from it. It is still parseable JSON, so source upgrades off 'default'.
            const evidence = buildTaskCompletionEvidence({
                ...baseOpts,
                finalSummary: '```json\n{"status":"completed","message":"hello"}\n```',
            });
            // status stays 'unknown' (not lifted from the non-worker JSON's "status" field).
            expect(evidence.workerResult.status).toBe('unknown');
            expect(evidence.workerResult.source).toBe('parseable_answer');
        });
    });
});
