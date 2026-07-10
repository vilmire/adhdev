import { describe, expect, it } from 'vitest';
import { slimRefineEventResult } from '../../src/commands/router-refine.js';

// FIX #4 — the terminal refine EVENT must carry only the coordinator's decision-relevant
// fields, not the full per-command / per-entry detail that overflows the token limit. The
// full detail stays in the ledger + terminalRefineJobs for on-demand fetch.
describe('slimRefineEventResult — refine terminal event projection', () => {
    // A realistic missing_dependencies validation-failed terminal result: the full
    // validationSummary carries per-command stdout/stderr, rejectedCommands, suggestions,
    // suggestedConfig — the bloat this fix drops from the event.
    function buildBloatedFailedResult(): Record<string, unknown> {
        const bigStdout = 'x'.repeat(20_000);
        return {
            success: false,
            code: 'validation_dependencies_missing',
            error: 'Refinery validation failed: missing dependencies',
            convergenceStatus: 'blocked_review',
            blockedReason: 'missing_dependencies',
            branch: 'fix/foo',
            into: 'main',
            terminalKind: 'validation_failed',
            nextStep: 'Fix failing tests or configure validation.bootstrapCommands and retry mesh_refine_node.',
            finalBranchConvergenceState: { branch: 'fix/foo', baseBranch: 'main', merged: false, status: 'blocked_review' },
            validationSummary: {
                status: 'failed',
                failureCode: 'missing_dependencies',
                configSource: '.adhdev/refine.json',
                configSourceType: 'repo_file',
                commandsRun: [
                    { command: 'npm test', success: false, stdout: bigStdout, stderr: bigStdout },
                    { command: 'npm run typecheck', success: false, stdout: bigStdout, stderr: bigStdout },
                ],
                rejectedCommands: [{ command: 'rm -rf /', reason: 'destructive' }],
                suggestions: [{ hint: 'install deps', detail: bigStdout }],
                suggestedConfig: { validation: { commands: ['npm test'], detail: bigStdout } },
            },
            patchEquivalence: { status: 'passed', equivalent: true, expectedPatchId: 'abc', actualPatchId: 'abc', error: null },
            submoduleReachability: {
                entries: [{ path: 'oss', reachable: true, sha: 'deadbeef', detail: bigStdout }],
                unreachable: [],
            },
        };
    }

    it('keeps decision-relevant fields and reduced validationSummary', () => {
        const slim = slimRefineEventResult(buildBloatedFailedResult());
        // Top-level scalars the coordinator branches on.
        expect(slim.success).toBe(false);
        expect(slim.code).toBe('validation_dependencies_missing');
        expect(slim.error).toContain('missing dependencies');
        expect(slim.convergenceStatus).toBe('blocked_review');
        expect(slim.blockedReason).toBe('missing_dependencies');
        expect(slim.branch).toBe('fix/foo');
        expect(slim.into).toBe('main');
        expect(slim.terminalKind).toBe('validation_failed');
        expect(slim.nextStep).toContain('retry mesh_refine_node');
        expect(slim.finalBranchConvergenceState).toBeTruthy();

        // Reduced validationSummary — status/failureCode/configSource + a COUNT, no full arrays.
        expect(slim.validationSummary).toEqual({
            status: 'failed',
            failureCode: 'missing_dependencies',
            configSource: '.adhdev/refine.json',
            configSourceType: 'repo_file',
            commandsRunCount: 2,
        });
    });

    it('drops the heavy per-command / per-entry detail from the event', () => {
        const slim = slimRefineEventResult(buildBloatedFailedResult());
        const vs = slim.validationSummary as Record<string, unknown>;
        expect(vs.rejectedCommands).toBeUndefined();
        expect(vs.suggestions).toBeUndefined();
        expect(vs.suggestedConfig).toBeUndefined();
        expect(vs.commandsRun).toBeUndefined();

        // patchEquivalence reduced to verdict only.
        expect(slim.patchEquivalence).toEqual({ status: 'passed', equivalent: true });

        // submoduleReachability reduced to counts only (no entries/unreachable arrays).
        expect(slim.submoduleReachability).toEqual({ checked: 1, unreachable: 0 });
    });

    it('serialized event payload stays small (well under the token-overflow threshold)', () => {
        const slim = slimRefineEventResult(buildBloatedFailedResult());
        const size = JSON.stringify(slim).length;
        // The full result serializes to >60KB (2×20KB stdout ×2 + suggestions/config);
        // the slimmed projection must be a tiny fraction of that.
        expect(size).toBeLessThan(2_000);
    });

    it('omits absent optional sections without inventing keys', () => {
        const slim = slimRefineEventResult({
            success: true,
            code: 'converged',
            terminalKind: 'completed',
            branch: 'fix/bar',
            into: 'main',
        });
        expect(slim.success).toBe(true);
        expect(slim.terminalKind).toBe('completed');
        expect('validationSummary' in slim).toBe(false);
        expect('patchEquivalence' in slim).toBe(false);
        expect('submoduleReachability' in slim).toBe(false);
        expect('unreachableSubmoduleCommits' in slim).toBe(false);
    });

    it('maps unreachableSubmoduleCommits to a path/autoPublishAllowed subset', () => {
        const slim = slimRefineEventResult({
            success: false,
            code: 'submodule_reachability_failed',
            terminalKind: 'submodule_reachability_failed',
            unreachableSubmoduleCommits: [
                { path: 'oss', sha: 'cafebabe', autoPublishAllowed: true, extraNoise: 'x'.repeat(5000) },
            ],
        });
        expect(slim.unreachableSubmoduleCommits).toEqual([{ path: 'oss', autoPublishAllowed: true }]);
    });
});
