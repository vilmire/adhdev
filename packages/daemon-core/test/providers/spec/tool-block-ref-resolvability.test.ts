/**
 * (TOOL-EXPAND) The spec parser must not stamp an unresolvable ref.
 *
 * `safeMtimeMs` returns 0 when the stat fails, and nothing downstream rejects
 * it: `isToolBlockRef` (dispatcher) and `toolBlockRefField` (wire encoder) both
 * accept any finite number, so a `sourceMtimeMs: 0` ref rode all the way to the
 * dashboard, rendered a ToolExpandControl, and then failed on every click —
 * both expand resolvers compare the seal with a strict `!==` against the file's
 * real mtime, which 0 can never match.
 *
 * The built-in readers already guarded this (`claude-cli-transcript.ts`
 * `stampToolBlockRef` requires `sourceMtimeMs > 0`); the spec path did not, so
 * the same transcript produced resolvable refs through one reader and
 * permanently broken ones through the other.
 *
 * Context worth keeping: live `claude-cli` DOES run this spec path. Its
 * `specs/4.0.json` (selected by `compatibility: [{ideVersion:'>=2.1.0'}]`)
 * carries `message_map.tools: {}`, which routes it through `projectToolBlock`
 * and is why claude bubbles render in the `↗`/`↘` form rather than the built-in
 * reader's `Bash: {args}`. The older `specs/3.0.json` has no `tools` key at all
 * and therefore emits zero tool bubbles.
 */

import { describe, it, expect } from 'vitest';
import {
    projectToolBlock,
    oneLine,
    TOOL_CALL_SUMMARY_MAX,
    TOOL_RESULT_SUMMARY_MAX,
} from '../../../src/providers/spec/native-history-tool-blocks.js';

const deps = {
    jsonPathGet: (record: any, expr: string): unknown => record?.[expr.replace(/^\$\./, '')],
    stringifyContent: (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v ?? '')),
};

/** `tools: {}` — exactly what claude-cli's specs/4.0.json ships. */
const TOOLS_DEFAULTS: any = {};

const longCall = { command: `V=${'x'.repeat(900)}` };
const longResult = `Warning: Permanently added ${'z'.repeat(900)}`;
const callBlock = { type: 'tool_use', name: 'Bash', input: longCall };
const resultBlock = { type: 'tool_result', content: longResult };

const project = (block: any, ref?: any) =>
    projectToolBlock(block, 'assistant', TOOLS_DEFAULTS, deps, ref) as any;

describe('(TOOL-EXPAND) spec parser stamps only resolvable refs', () => {
    it('stamps the ref when the source mtime seal is usable', () => {
        const ref = { sourceMtimeMs: 1789317186088, recordIndex: 12, blockIndex: 3 };

        expect(project(callBlock, ref).toolBlockRef).toEqual(ref);
        expect(project(resultBlock, ref).toolBlockRef).toEqual(ref);
    });

    it('omits the ref when the mtime seal is 0 (safeMtimeMs stat failure)', () => {
        // The bubble must still render — it just degrades to local truncation
        // instead of advertising an expand that can only ever fail.
        const call = project(callBlock, { sourceMtimeMs: 0, recordIndex: 12, blockIndex: 3 });
        const result = project(resultBlock, { sourceMtimeMs: 0, recordIndex: 12, blockIndex: 3 });

        expect(call.toolBlockRef).toBeUndefined();
        expect(result.toolBlockRef).toBeUndefined();
        expect(call.kind).toBe('tool');
        expect(result.kind).toBe('tool');
    });

    it('omits the ref for a negative recordIndex or an out-of-range blockIndex', () => {
        const base = { sourceMtimeMs: 1789317186088, recordIndex: 12, blockIndex: 3 };

        expect(project(callBlock, { ...base, recordIndex: -1 }).toolBlockRef).toBeUndefined();
        expect(project(callBlock, { ...base, blockIndex: -2 }).toolBlockRef).toBeUndefined();
        // blockIndex -1 is legal: the record itself is the tool block.
        expect(project(callBlock, { ...base, blockIndex: -1 }).toolBlockRef).toEqual({ ...base, blockIndex: -1 });
    });

    it('omits the ref for a non-integer index', () => {
        const base = { sourceMtimeMs: 1789317186088, recordIndex: 12, blockIndex: 3 };

        expect(project(callBlock, { ...base, recordIndex: 1.5 }).toolBlockRef).toBeUndefined();
        expect(project(callBlock, { ...base, blockIndex: 2.5 }).toolBlockRef).toBeUndefined();
    });

    it('never stamps a ref on a bubble the caps did not truncate', () => {
        const ref = { sourceMtimeMs: 1789317186088, recordIndex: 1, blockIndex: 0 };
        const short = project({ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }, ref);

        expect(short.toolBlockRef).toBeUndefined();
    });

    it('reproduces the live 248/602 summary lengths with a resolvable ref', () => {
        // 248 = '↗ Bash: '.length (8) + TOOL_CALL_SUMMARY_MAX (240)
        // 602 = '↘ '.length (2)      + TOOL_RESULT_SUMMARY_MAX (600)
        const ref = { sourceMtimeMs: 1789317186088, recordIndex: 12, blockIndex: 3 };
        const call = project(callBlock, ref);
        const result = project(resultBlock, ref);

        expect(call.content).toHaveLength('↗ Bash: '.length + TOOL_CALL_SUMMARY_MAX);
        expect(result.content).toHaveLength('↘ '.length + TOOL_RESULT_SUMMARY_MAX);
        expect(call.toolBlockRef).toBeDefined();
        expect(result.toolBlockRef).toBeDefined();
    });

    it('holds the content boundary — the stamped ref is exactly three integers', () => {
        const ref = { sourceMtimeMs: 1789317186088, recordIndex: 12, blockIndex: 3 };
        const stamped = project(callBlock, ref).toolBlockRef;

        expect(Object.keys(stamped).sort()).toEqual(['blockIndex', 'recordIndex', 'sourceMtimeMs']);
        for (const value of Object.values(stamped)) expect(typeof value).toBe('number');
    });

    it('keeps truncation judged on the whitespace-flattened text', () => {
        // Guards the cap contract the expand resolver re-derives independently.
        expect(oneLine('a'.repeat(TOOL_CALL_SUMMARY_MAX), TOOL_CALL_SUMMARY_MAX).truncated).toBe(false);
        expect(oneLine('a'.repeat(TOOL_CALL_SUMMARY_MAX + 1), TOOL_CALL_SUMMARY_MAX).truncated).toBe(true);
    });
});
