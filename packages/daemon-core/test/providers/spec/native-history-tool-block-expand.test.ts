/**
 * (TOOL-EXPAND) Tool-bubble truncation and on-demand expansion.
 *
 * The existing tool-bubble tests (native-history-executor-tools.test.ts) use
 * short fixtures — `ls -la`, `file-a\nfile-b` — so they never reach the parser's
 * 240-char call / 600-char result caps, and the truncation behaviour these tests
 * cover was previously unasserted in either direction. That gap is the whole
 * reason the dashboard silently lost tool output.
 *
 * These fixtures are deliberately OVER the caps, and the assertions check the
 * caps by arithmetic against the exported constants rather than by restating
 * 240/600, so a future cap change cannot leave a test passing against a stale
 * number.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    executeNativeHistory,
    TOOL_CALL_SUMMARY_MAX,
    TOOL_RESULT_SUMMARY_MAX,
} from '../../../src/providers/spec/native-history-executor.js';
import { expandToolBlock } from '../../../src/providers/spec/tool-block-expand.js';

let tmpDir = '';

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-history-tool-expand-'));
});

afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A command string far longer than the call cap. */
const LONG_COMMAND = `rg --files-with-matches ${'--glob=!node_modules/'.repeat(40)} pattern`;
/** A result body far longer than the result cap. */
const LONG_RESULT = Array.from({ length: 200 }, (_, i) => `src/module-${i}/index.ts`).join('\n');

function writeJsonl(lines: object[], name = 'session.jsonl'): string {
    const file = path.join(tmpDir, name);
    fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
    return file;
}

const claudeCfg = (file: string) => ({
    source: {
        kind: 'jsonl' as const,
        path: file,
        session_id_from: 'filename_uuid' as const,
        message_filter: { where: "$.type == 'user' || $.type == 'assistant'" },
        message_map: {
            role: '$.message.role',
            content: '$.message.content',
            timestamp_ms: '$.timestamp',
            tools: {},
        },
    },
});

/** The claude-shaped transcript used by most cases: one long call, one long result. */
function writeLongToolTranscript(): string {
    return writeJsonl([
        { type: 'user', timestamp: '2026-09-11T00:00:00Z', message: { role: 'user', content: 'find the files' } },
        {
            type: 'assistant',
            timestamp: '2026-09-11T00:00:01Z',
            message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: LONG_COMMAND } }] },
        },
        {
            type: 'user',
            timestamp: '2026-09-11T00:00:02Z',
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: LONG_RESULT }] },
        },
    ]);
}

const INPUT = { agentType: 'claude-cli' };

describe('tool summaries — the 240/600 caps actually bite', () => {
    it('truncates a long tool CALL to the call cap and marks it expandable', () => {
        const cfg = claudeCfg(writeLongToolTranscript());
        const res = executeNativeHistory(cfg, INPUT);
        const call = res!.messages.find(m => m.kind === 'tool' && m.content.startsWith('↗'))!;

        // Fixture must genuinely exceed the cap, or this test proves nothing.
        expect(LONG_COMMAND.length).toBeGreaterThan(TOOL_CALL_SUMMARY_MAX);
        expect(call.content).toContain('…');
        // The summary is `↗ Bash: <args>`; the args portion is capped.
        const args = call.content.slice('↗ Bash: '.length);
        expect(args.length).toBe(TOOL_CALL_SUMMARY_MAX);
        expect(call.toolBlockRef).toBeDefined();
    });

    it('truncates a long tool RESULT to the result cap and marks it expandable', () => {
        const cfg = claudeCfg(writeLongToolTranscript());
        const res = executeNativeHistory(cfg, INPUT);
        const result = res!.messages.find(m => m.kind === 'tool' && m.content.startsWith('↘'))!;

        expect(LONG_RESULT.length).toBeGreaterThan(TOOL_RESULT_SUMMARY_MAX);
        expect(result.content).toContain('…');
        const body = result.content.slice('↘ '.length);
        expect(body.length).toBe(TOOL_RESULT_SUMMARY_MAX);
        expect(result.toolBlockRef).toBeDefined();
    });

    it('does NOT attach a ref to a bubble that fits — nothing to expand', () => {
        const cfg = claudeCfg(writeJsonl([
            {
                type: 'assistant',
                timestamp: '2026-09-11T00:00:01Z',
                message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la' } }] },
            },
        ]));
        const res = executeNativeHistory(cfg, INPUT);
        const call = res!.messages.find(m => m.kind === 'tool')!;
        expect(call.content).not.toContain('…');
        expect(call.toolBlockRef).toBeUndefined();
    });

    it('stamps the ref with the RAW content-array index, not the tool-bubble ordinal', () => {
        // Prose block sits at index 0, so the tool block's blockIndex must be 1
        // even though it is the FIRST tool bubble emitted.
        const cfg = claudeCfg(writeJsonl([
            {
                type: 'assistant',
                timestamp: '2026-09-11T00:00:01Z',
                message: {
                    role: 'assistant',
                    content: [
                        { type: 'text', text: 'let me look' },
                        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: LONG_COMMAND } },
                    ],
                },
            },
        ]));
        const res = executeNativeHistory(cfg, INPUT);
        const call = res!.messages.find(m => m.kind === 'tool')!;
        expect(call.toolBlockRef).toMatchObject({ recordIndex: 0, blockIndex: 1 });
    });

    it('carries only integers on the ref — no path, no text', () => {
        const cfg = claudeCfg(writeLongToolTranscript());
        const res = executeNativeHistory(cfg, INPUT);
        const call = res!.messages.find(m => m.kind === 'tool')!;
        for (const value of Object.values(call.toolBlockRef!)) {
            expect(typeof value).toBe('number');
        }
        expect(Object.keys(call.toolBlockRef!).sort()).toEqual(['blockIndex', 'recordIndex', 'sourceMtimeMs']);
    });
});

describe('expandToolBlock — on-demand full text', () => {
    it('returns the untruncated call args for a present block', () => {
        const cfg = claudeCfg(writeLongToolTranscript());
        const res = executeNativeHistory(cfg, INPUT);
        const call = res!.messages.find(m => m.kind === 'tool' && m.content.startsWith('↗'))!;

        const expanded = expandToolBlock(cfg, INPUT, call.toolBlockRef);
        expect(expanded.ok).toBe(true);
        if (!expanded.ok) throw new Error('unreachable');
        expect(expanded.toolName).toBe('Bash');
        expect(expanded.callArgs).toContain(LONG_COMMAND);
        expect(expanded.truncated).toBe(true);
        // The whole point: the expanded body is longer than what the bubble showed.
        expect(expanded.callArgs!.length).toBeGreaterThan(call.content.length);
    });

    it('returns the untruncated result body for a present block', () => {
        const cfg = claudeCfg(writeLongToolTranscript());
        const res = executeNativeHistory(cfg, INPUT);
        const result = res!.messages.find(m => m.kind === 'tool' && m.content.startsWith('↘'))!;

        const expanded = expandToolBlock(cfg, INPUT, result.toolBlockRef);
        expect(expanded.ok).toBe(true);
        if (!expanded.ok) throw new Error('unreachable');
        expect(expanded.result).toBe(LONG_RESULT);
        expect(expanded.truncated).toBe(true);
        // Every line survived — this is what the dashboard was losing.
        expect(expanded.result!.split('\n')).toHaveLength(200);
    });

    it('reports truncated:false for a block that was never capped', () => {
        const cfg = claudeCfg(writeJsonl([
            {
                type: 'assistant',
                timestamp: '2026-09-11T00:00:01Z',
                message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la' } }] },
            },
        ]));
        const expanded = expandToolBlock(cfg, INPUT, { sourceMtimeMs: statMtime(cfg), recordIndex: 0, blockIndex: 0 });
        expect(expanded.ok).toBe(true);
        if (!expanded.ok) throw new Error('unreachable');
        expect(expanded.truncated).toBe(false);
        expect(expanded.callArgs).toContain('ls -la');
    });

    it('fails closed with block_not_found for a ref past the end', () => {
        const cfg = claudeCfg(writeLongToolTranscript());
        const expanded = expandToolBlock(cfg, INPUT, { sourceMtimeMs: statMtime(cfg), recordIndex: 999, blockIndex: 0 });
        expect(expanded).toEqual({ ok: false, reason: 'block_not_found' });
    });

    it('fails closed with not_a_tool_block when the position holds prose', () => {
        const cfg = claudeCfg(writeJsonl([
            {
                type: 'assistant',
                timestamp: '2026-09-11T00:00:01Z',
                message: { role: 'assistant', content: [{ type: 'text', text: 'just prose' }] },
            },
        ]));
        const expanded = expandToolBlock(cfg, INPUT, { sourceMtimeMs: statMtime(cfg), recordIndex: 0, blockIndex: 0 });
        expect(expanded).toEqual({ ok: false, reason: 'not_a_tool_block' });
    });

    it('rejects a malformed ref rather than guessing', () => {
        const cfg = claudeCfg(writeLongToolTranscript());
        for (const bad of [null, undefined, {}, { recordIndex: 0 }, { sourceMtimeMs: 'x', recordIndex: 0, blockIndex: 0 }]) {
            expect(expandToolBlock(cfg, INPUT, bad)).toEqual({ ok: false, reason: 'block_not_found' });
        }
    });

    /**
     * ★ The reason option B was chosen over addressing by a re-derived ordinal.
     *
     * The transcript is rewritten so the SAME indices now name a DIFFERENT
     * tool's output. A position-only address would happily return the wrong
     * command's result and the reader would have no way to know. The mtime seal
     * must refuse instead.
     */
    it('fails closed with source_changed when the transcript was rewritten under the ref', () => {
        const file = writeLongToolTranscript();
        const cfg = claudeCfg(file);
        const res = executeNativeHistory(cfg, INPUT);
        const call = res!.messages.find(m => m.kind === 'tool' && m.content.startsWith('↗'))!;
        const ref = call.toolBlockRef!;

        // Rewrite: the block at the same (recordIndex, blockIndex) is now a
        // completely different command.
        fs.writeFileSync(file, [
            { type: 'user', timestamp: '2026-09-11T00:00:00Z', message: { role: 'user', content: 'different' } },
            {
                type: 'assistant',
                timestamp: '2026-09-11T00:00:01Z',
                message: { role: 'assistant', content: [{ type: 'tool_use', id: 't9', name: 'Bash', input: { command: `rm -rf ${'build/'.repeat(80)}` } }] },
            },
        ].map(l => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
        // Force a distinct mtime even on coarse-resolution filesystems.
        const future = new Date(Date.now() + 10_000);
        fs.utimesSync(file, future, future);

        const expanded = expandToolBlock(cfg, INPUT, ref);
        expect(expanded).toEqual({ ok: false, reason: 'source_changed' });
        // And emphatically NOT the other command's text.
        expect(JSON.stringify(expanded)).not.toContain('rm -rf');
    });

    it('refuses a non-jsonl source rather than resolving a positional ref', () => {
        const sqliteCfg = { source: { kind: 'sqlite' as const, path: path.join(tmpDir, 'x.db') } } as any;
        const expanded = expandToolBlock(sqliteCfg, INPUT, { sourceMtimeMs: 1, recordIndex: 0, blockIndex: 0 });
        expect(expanded).toEqual({ ok: false, reason: 'unsupported_source' });
    });
});

/** Read the mtime the executor would stamp, for refs built by hand. */
function statMtime(cfg: ReturnType<typeof claudeCfg>): number {
    return executeNativeHistory(cfg, INPUT)!.sourceMtimeMs;
}
