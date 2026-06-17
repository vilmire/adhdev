/**
 * Declarative tool-bubble extraction for the JSONL executor.
 *
 * Before `message_map.tools`, a transcript turn that was purely a tool call or
 * tool result (no prose) was dropped, so the restored chat lost every tool
 * interaction. These tests cover the two on-disk shapes the executor must
 * generalize over:
 *   - block-nested (claude-cli): tool_use / tool_result blocks inside
 *     message.content[]
 *   - record-level (codex-cli): each function_call / function_call_output is
 *     its own jsonl record
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeNativeHistory } from '../../../src/providers/spec/native-history-executor.js';

let tmpDir = '';

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-history-tools-'));
});

afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('executeJsonl — claude block-nested tool bubbles', () => {
    function writeClaude(lines: object[]): string {
        const file = path.join(tmpDir, 'session.jsonl');
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

    it('drops tool turns without `tools`, surfaces them with `tools: {}`', () => {
        const file = writeClaude([
            { type: 'user', timestamp: '2026-06-17T00:00:00Z', message: { role: 'user', content: 'run ls' } },
            { type: 'assistant', timestamp: '2026-06-17T00:00:01Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la' } }] } },
            { type: 'user', timestamp: '2026-06-17T00:00:02Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file-a\nfile-b' }] } },
            { type: 'assistant', timestamp: '2026-06-17T00:00:03Z', message: { role: 'assistant', content: 'done' } },
        ]);

        // Without tools: only the two prose turns survive.
        const noTools = JSON.parse(JSON.stringify(claudeCfg(file)));
        delete noTools.source.message_map.tools;
        const before = executeNativeHistory(noTools, { workspace: tmpDir, sessionStartedAtMs: 0 });
        expect(before?.messages.map(m => m.kind)).toEqual(['standard', 'standard']);

        // With tools: the tool_use + tool_result turns appear as kind:'tool'.
        const after = executeNativeHistory(claudeCfg(file), { workspace: tmpDir, sessionStartedAtMs: 0 });
        const kinds = after?.messages.map(m => m.kind);
        expect(kinds).toEqual(['standard', 'tool', 'tool', 'standard']);

        const call = after!.messages[1];
        expect(call.role).toBe('assistant');
        expect(call.content).toContain('Bash');
        expect(call.content).toContain('ls -la');

        const result = after!.messages[2];
        expect(result.role).toBe('assistant'); // results always render assistant-side
        expect(result.content).toContain('file-a');
    });

    it('keeps prose AND tool block from a mixed content array, prose first', () => {
        const file = writeClaude([
            { type: 'assistant', timestamp: '2026-06-17T00:00:00Z', message: { role: 'assistant', content: [
                { type: 'text', text: 'let me check' },
                { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } },
            ] } },
        ]);
        const res = executeNativeHistory(claudeCfg(file), { workspace: tmpDir, sessionStartedAtMs: 0 });
        expect(res?.messages.map(m => m.kind)).toEqual(['standard', 'tool']);
        expect(res!.messages[0].content).toBe('let me check');
        expect(res!.messages[1].receivedAt).toBeGreaterThan(res!.messages[0].receivedAt);
    });
});

describe('executeJsonl — codex record-level tool bubbles', () => {
    function writeCodex(lines: object[]): string {
        const file = path.join(tmpDir, 'rollout-2026-06-17T00-00-00-019ea15f-85ab-7133-8347-920def0c7906.jsonl');
        fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
        return file;
    }

    const codexCfg = (file: string) => ({
        source: {
            kind: 'jsonl' as const,
            path: file,
            session_id_from: 'filename_uuid' as const,
            message_filter: {
                where: "$.type == 'response_item' && $.payload.type == 'message' || $.type == 'response_item' && $.payload.type == 'function_call' || $.type == 'response_item' && $.payload.type == 'function_call_output'",
            },
            message_map: {
                role: '$.payload.role',
                content: '$.payload.content[0].text',
                timestamp_ms: '$.timestamp',
                tools: {
                    block_type: '$.payload.type',
                    call_name: '$.payload.name',
                    call_args: '$.payload.arguments',
                    result_content: '$.payload.output',
                },
            },
        },
    });

    it('surfaces function_call / function_call_output records as kind:tool', () => {
        const file = writeCodex([
            { type: 'session_meta', timestamp: '2026-06-17T00:00:00Z', payload: { id: '019ea15f-85ab-7133-8347-920def0c7906', cwd: tmpDir } },
            { type: 'response_item', timestamp: '2026-06-17T00:00:01Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list files' }] } },
            { type: 'response_item', timestamp: '2026-06-17T00:00:02Z', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"ls"}' } },
            { type: 'response_item', timestamp: '2026-06-17T00:00:03Z', payload: { type: 'function_call_output', call_id: 'c1', output: 'a\nb' } },
            { type: 'response_item', timestamp: '2026-06-17T00:00:04Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'two files' }] } },
        ]);
        const res = executeNativeHistory(codexCfg(file), { workspace: tmpDir, sessionStartedAtMs: 0 });
        expect(res?.messages.map(m => `${m.role}/${m.kind}`)).toEqual([
            'user/standard',
            'assistant/tool',
            'assistant/tool',
            'assistant/standard',
        ]);
        expect(res!.messages[1].content).toContain('exec_command');
        expect(res!.messages[1].content).toContain('ls');
        expect(res!.messages[2].content).toContain('a b');
    });
});
