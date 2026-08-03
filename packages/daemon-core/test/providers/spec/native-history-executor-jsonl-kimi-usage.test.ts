/**
 * Kimi Code nativeHistory — declarative token-usage extraction (`usage_records`).
 *
 * kimi writes per-turn token accounting as standalone
 *   {type:"usage.record", model, usage:{inputOther,output,inputCacheRead,inputCacheCreation},
 *    usageScope:"turn", time}
 * records in the same wire.jsonl. They are NOT messages — the `records[]`
 * message matchers deliberately drop them — so they are matched by a separate
 * `usage_records` block and surfaced on `result.usage`.
 *
 * These tests drive the executor with the SAME `usage_records` block the
 * shipped kimi provider.v1.json ships, and assert:
 *   (a) per-turn records sum (usageScope "turn" ⇒ delta semantics),
 *   (b) a usage.record contributes NO message (the regression that matters),
 *   (c) a wire.jsonl with no usage.record still reads, with usage undefined,
 *   (d) a usage.record carrying no `usage` payload is ignored, not counted.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeNativeHistory } from '../../../src/providers/spec/native-history-executor.js';

// Mirrors adhdev-providers/cli/kimi/provider.v1.json `nativeHistory.source`
// (message shapes trimmed to the two that matter here; the usage_records block
// is verbatim).
const KIMI_SOURCE = {
    kind: 'jsonl' as const,
    path: '{SESSIONS}/*/session_*/agents/main',
    file_pattern: 'wire.jsonl',
    session_id_from: 'dir_uuid' as const,
    workspace_from_sidecar: {
        rel_path: '../../state.json',
        workspace_path: '$.workDir',
    },
    records: [
        {
            where: '$.type == "turn.prompt"',
            message_map: { role: 'user', content: '$.input', timestamp_ms: '$.time' },
        },
        {
            where: '$.type == "context.append_loop_event" && $.event.type == "content.part" && $.event.part.type == "text"',
            message_map: { role: 'assistant', content: '$.event.part.text', timestamp_ms: '$.time' },
        },
    ],
    usage_records: [
        {
            where: '$.type == "usage.record"',
            usage_map: {
                mode: 'delta' as const,
                input_tokens: '$.usage.inputOther',
                output_tokens: '$.usage.output',
                cache_read_tokens: '$.usage.inputCacheRead',
                cache_creation_tokens: '$.usage.inputCacheCreation',
                model: '$.model',
                timestamp_ms: '$.time',
            },
        },
    ],
};

const UUID = 'ba1a3c5c-0ad8-48e5-9f49-3feaa9c449b6';
const SESSION_ID = `session_${UUID}`;
const WORKSPACE = '/Users/example/Work/myrepo';

let tmpDir = '';
let sessionsDir = '';

function wdKey(ws: string, hex12: string): string {
    const last = ws.replace(/\/+$/, '').split('/').pop() || 'root';
    return `wd_${last}_${hex12}`;
}

function writeSession(lines: any[]): string {
    const sessionDir = path.join(sessionsDir, wdKey(WORKSPACE, 'aabbccddeeff'), SESSION_ID);
    const wireDir = path.join(sessionDir, 'agents', 'main');
    fs.mkdirSync(wireDir, { recursive: true });
    fs.writeFileSync(
        path.join(sessionDir, 'state.json'),
        JSON.stringify({ workDir: WORKSPACE, title: 'test' }),
        'utf8',
    );
    const wirePath = path.join(wireDir, 'wire.jsonl');
    fs.writeFileSync(wirePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
    return wirePath;
}

function run() {
    const src = { ...KIMI_SOURCE, path: KIMI_SOURCE.path.replace('{SESSIONS}', sessionsDir) };
    return executeNativeHistory(
        { source: src } as any,
        { agentType: 'kimi', workspace: WORKSPACE, providerSessionId: SESSION_ID } as any,
    );
}

/** A real kimi usage.record, matching the live on-disk shape. */
function usageLine(
    time: number,
    usage: { inputOther: number; output: number; inputCacheRead: number; inputCacheCreation: number },
): any {
    return { type: 'usage.record', model: 'kimi-code/k3', usage, usageScope: 'turn', time };
}

const BASE = 1_785_393_168_000;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-usage-'));
    sessionsDir = path.join(tmpDir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
});

afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('kimi usage_records', () => {
    it('sums per-turn usage records', () => {
        writeSession([
            { type: 'turn.prompt', input: [{ type: 'text', text: 'q1' }], time: BASE + 100 },
            { type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: 'a1' } }, time: BASE + 200 },
            usageLine(BASE + 300, { inputOther: 28351, output: 407, inputCacheRead: 11264, inputCacheCreation: 0 }),
            { type: 'turn.prompt', input: [{ type: 'text', text: 'q2' }], time: BASE + 400 },
            { type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: 'a2' } }, time: BASE + 500 },
            usageLine(BASE + 600, { inputOther: 1000, output: 93, inputCacheRead: 500, inputCacheCreation: 128 }),
        ]);

        const result = run();
        expect(result?.usage).toBeDefined();
        expect(result!.usage!.inputTokens).toBe(29351);
        expect(result!.usage!.outputTokens).toBe(500);
        expect(result!.usage!.cacheReadTokens).toBe(11764);
        expect(result!.usage!.cacheCreationTokens).toBe(128);
        expect(result!.usage!.recordCount).toBe(2);
        expect(result!.usage!.model).toBe('kimi-code/k3');
        expect(result!.usage!.agent).toBe('kimi');
    });

    it('REGRESSION: a usage.record produces no message', () => {
        writeSession([
            { type: 'turn.prompt', input: [{ type: 'text', text: 'q1' }], time: BASE + 100 },
            usageLine(BASE + 150, { inputOther: 10, output: 1, inputCacheRead: 0, inputCacheCreation: 0 }),
            { type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: 'a1' } }, time: BASE + 200 },
        ]);

        const result = run();
        expect(result!.messages.map((m) => ({ role: m.role, content: m.content }))).toEqual([
            { role: 'user', content: 'q1' },
            { role: 'assistant', content: 'a1' },
        ]);
        // Usage was still collected from the line that produced no bubble.
        expect(result!.usage!.inputTokens).toBe(10);
    });

    it('reads a transcript with no usage.record and leaves usage undefined', () => {
        writeSession([
            { type: 'turn.prompt', input: [{ type: 'text', text: 'q1' }], time: BASE + 100 },
            { type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: 'a1' } }, time: BASE + 200 },
        ]);

        const result = run();
        expect(result).not.toBeNull();
        expect(result!.messages).toHaveLength(2);
        expect(result!.usage).toBeUndefined();
    });

    it('ignores a usage.record carrying no usage payload', () => {
        // The existing kimi fixtures contain exactly this shape; a matched
        // record with no resolvable token path must not inflate recordCount.
        writeSession([
            { type: 'turn.prompt', input: [{ type: 'text', text: 'q1' }], time: BASE + 100 },
            { type: 'usage.record', time: BASE + 150 },
            { type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: 'a1' } }, time: BASE + 200 },
        ]);

        const result = run();
        expect(result!.usage).toBeUndefined();
        expect(result!.messages).toHaveLength(2);
    });
});
