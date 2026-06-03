/**
 * sandbox-runner.test.ts — Unit tests for DirectEvalRunner (Phase 5 scaffold)
 *
 * These tests cover the no-op stub implementation only — no native
 * isolated-vm dependency is required.
 */

import { describe, expect, it } from 'vitest';
import { DirectEvalRunner } from '../../../src/providers/sdk/v1/sandbox/script-runner.js';

describe('DirectEvalRunner', () => {
    it('runs a simple expression and returns the result', async () => {
        const runner = new DirectEvalRunner();
        const result = await runner.run('1 + 2', {});
        expect(result).toBe(3);
    });

    it('throws on a syntax error', async () => {
        const runner = new DirectEvalRunner();
        await expect(runner.run('(((unclosed', {})).rejects.toThrow();
    });

    it('returns result from a function-body style script', async () => {
        const runner = new DirectEvalRunner();
        // The script is wrapped as the body of an arrow expression — it must
        // be a valid expression (not a statement block).  A comma-expression
        // or IIFE covers the "function body" case.
        const result = await runner.run('(() => { const x = 6; return x * 7; })()', {});
        expect(result).toBe(42);
    });

    it('makes context variables accessible inside the script', async () => {
        const runner = new DirectEvalRunner();
        const result = await runner.run('input.tail.length', {
            input: { tail: 'hello' },
        });
        expect(result).toBe(5);
    });

    it('can access multiple context variables simultaneously', async () => {
        const runner = new DirectEvalRunner();
        const result = await runner.run('a + b', { a: 10, b: 32 });
        expect(result).toBe(42);
    });

    it('dispose() does not throw', () => {
        const runner = new DirectEvalRunner();
        expect(() => runner.dispose()).not.toThrow();
    });

    it('dispose() can be called multiple times without throwing', () => {
        const runner = new DirectEvalRunner();
        runner.dispose();
        expect(() => runner.dispose()).not.toThrow();
    });
});
