/**
 * CliScriptRunner — wall-clock budget enforcement
 *
 * Verifies the runner flags slow invocations in its trace ring so an
 * operator can identify a buggy provider script that's hanging the
 * settle loop. The flag is observation-only: Node CJS can't interrupt
 * a synchronous script without a worker thread, so the budget never
 * aborts the call — it only records and (throttled) warns.
 *
 * Cases:
 *  - Fast invocation under budget → no `timedOut` flag on the trace
 *  - Slow invocation over budget → `timedOut: true` recorded
 *  - Repeated slow invocations within the throttle window emit only one
 *    WARN (throttle Map only stores one timestamp per scriptName)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CliScriptRunner } from '../../src/cli-adapters/cli-script-runner.js';
import { LOG } from '../../src/logging/logger.js';

function spinFor(ms: number): void {
    // Busy-loop using hrtime so we exercise the same clock the runner uses
    // and don't rely on Math.sqrt(1e7) timing on faster machines.
    const start = process.hrtime.bigint();
    const ns = BigInt(Math.max(1, Math.floor(ms))) * 1_000_000n;
    // eslint-disable-next-line no-empty
    while (process.hrtime.bigint() - start < ns) { }
}

describe('CliScriptRunner script call budget', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        warnSpy = vi.spyOn(LOG, 'warn').mockImplementation(() => { });
    });

    afterEach(() => {
        warnSpy.mockRestore();
    });

    it('does not flag invocations that finish under budget', () => {
        const runner = new CliScriptRunner('fake');
        runner.setScripts({
            detectStatus: ((_state: unknown, _input: any) => 'idle') as any,
        });
        runner.setScriptCallBudget(50);

        runner.detectStatus({ screenText: '', rawBuffer: '', tail: '' } as any);

        const trace = runner.getInvocationTrace();
        expect(trace).toHaveLength(1);
        expect(trace[0].scriptName).toBe('detectStatus');
        expect(trace[0].ok).toBe(true);
        expect(trace[0].timedOut).toBeUndefined();
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it('flags trace entry as timedOut when budget exceeded', () => {
        const runner = new CliScriptRunner('fake');
        runner.setScripts({
            // Stateful arity-2 signature so the runner picks the
            // (state, input) call shape; the body busy-loops for >budget.
            detectStatus: ((_state: unknown, _input: any) => {
                spinFor(80);
                return 'idle';
            }) as any,
        });
        runner.setScriptCallBudget(20);

        runner.detectStatus({ screenText: '', rawBuffer: '', tail: '' } as any);

        const trace = runner.getInvocationTrace();
        expect(trace).toHaveLength(1);
        expect(trace[0].timedOut).toBe(true);
        // elapsedUs is recorded in microseconds; should comfortably exceed budgetUs.
        expect(trace[0].elapsedUs).toBeGreaterThan(20_000);

        // One WARN emitted naming the script and the budget.
        expect(warnSpy).toHaveBeenCalledTimes(1);
        const [scope, msg] = warnSpy.mock.calls[0];
        expect(scope).toBe('CLI');
        expect(String(msg)).toContain('detectStatus');
        expect(String(msg)).toContain('budget');
    });

    it('throttles repeat WARNs within the 30s window', () => {
        const runner = new CliScriptRunner('fake');
        runner.setScripts({
            detectStatus: ((_state: unknown, _input: any) => {
                spinFor(60);
                return 'idle';
            }) as any,
        });
        runner.setScriptCallBudget(10);

        runner.detectStatus({ screenText: '', rawBuffer: '', tail: '' } as any);
        runner.detectStatus({ screenText: '', rawBuffer: '', tail: '' } as any);
        runner.detectStatus({ screenText: '', rawBuffer: '', tail: '' } as any);

        const trace = runner.getInvocationTrace();
        // All three are flagged…
        expect(trace.every((entry) => entry.timedOut === true)).toBe(true);
        // …but only the first one logs (within the 30s throttle window).
        expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('clamps out-of-range budgets to the supported window', () => {
        const runner = new CliScriptRunner('fake');
        runner.setScriptCallBudget(-100);
        expect(runner.getScriptCallBudgetMs()).toBe(1);
        runner.setScriptCallBudget(99_999);
        expect(runner.getScriptCallBudgetMs()).toBe(5000);
        runner.setScriptCallBudget(Number.NaN);
        expect(runner.getScriptCallBudgetMs()).toBe(50);
    });
});
