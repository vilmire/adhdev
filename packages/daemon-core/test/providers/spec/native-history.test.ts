import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readNativeHistory } from '../../../src/providers/spec/native-history.js';
import type { NativeHistoryConfig } from '../../../src/providers/spec/types.js';

function tmpDir(): string {
    const p = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-nh-'));
    return p;
}

describe('native_history — jsonl_lines (claude shape)', () => {
    it('reads role+content, skips file-history-snapshot + meta entries', async () => {
        const dir = tmpDir();
        const file = path.join(dir, 'abc.jsonl');
        fs.writeFileSync(file, [
            JSON.stringify({ type: 'file-history-snapshot', x: 1 }),
            JSON.stringify({
                type: 'user', isMeta: true,
                message: { role: 'user', content: 'meta caveat' },
                uuid: 'x1', timestamp: '2026-05-12T02:17:27.955Z',
            }),
            JSON.stringify({
                type: 'user',
                message: { role: 'user', content: 'Hello' },
                uuid: 'u1', timestamp: '2026-05-12T02:18:00.000Z',
            }),
            JSON.stringify({
                type: 'assistant',
                message: { role: 'assistant', content: 'Hi there' },
                uuid: 'a1', timestamp: '2026-05-12T02:18:05.000Z',
            }),
        ].join('\n'));

        const cfg: NativeHistoryConfig = {
            format: 'jsonl_lines',
            location: { directory: dir, file_pattern: '*.jsonl', pick: 'newest_by_mtime' },
            message_extractor: {
                role_field: 'message.role',
                content_field: 'message.content',
                timestamp_field: 'timestamp',
                skip_if: [
                    { field: 'type', equals: 'file-history-snapshot' },
                    { field: 'isMeta', equals: true },
                ],
            },
        };
        const res = await readNativeHistory(cfg, { workingDir: '/Users/x/proj' });
        expect(res).not.toBeNull();
        expect(res!.messages.length).toBe(2);
        expect(res!.messages[0].role).toBe('user');
        expect(res!.messages[0].content).toBe('Hello');
        expect(res!.messages[1].role).toBe('assistant');
        expect(res!.messages[1].content).toBe('Hi there');
    });
});

describe('native_history — jsonl_lines with content array (codex shape)', () => {
    it('extracts text from content[0].text', async () => {
        const dir = tmpDir();
        const file = path.join(dir, 'codex.jsonl');
        fs.writeFileSync(file, [
            JSON.stringify({ type: 'session_meta', payload: {} }),
            JSON.stringify({
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'user',
                    content: [{ type: 'input_text', text: 'hi codex' }],
                },
            }),
        ].join('\n'));

        const cfg: NativeHistoryConfig = {
            format: 'jsonl_lines',
            location: { directory: dir, file_pattern: '*.jsonl', pick: 'newest_by_mtime' },
            message_extractor: {
                role_field: 'payload.role',
                content_field: 'payload.content',
                content_text_path: '[0].text',
                skip_if: [{ field: 'type', equals: 'session_meta' }],
            },
        };
        const res = await readNativeHistory(cfg, { workingDir: '/Users/x/proj' });
        expect(res).not.toBeNull();
        expect(res!.messages.length).toBe(1);
        expect(res!.messages[0].role).toBe('user');
        expect(res!.messages[0].content).toBe('hi codex');
    });
});

describe('native_history — json_single (hermes shape)', () => {
    it('reads container_path.messages and maps role/content', async () => {
        const dir = tmpDir();
        const file = path.join(dir, 'session_20260524_014453_0fc163.json');
        fs.writeFileSync(file, JSON.stringify({
            session_id: 'foo',
            messages: [
                { role: 'user', content: 'help me' },
                { role: 'assistant', content: 'sure' },
            ],
        }));

        const cfg: NativeHistoryConfig = {
            format: 'json_single',
            location: { directory: dir, file_pattern: 'session_*.json', pick: 'newest_by_mtime' },
            message_extractor: {
                container_path: 'messages',
                role_field: 'role',
                content_field: 'content',
            },
        };
        const res = await readNativeHistory(cfg, { workingDir: '/Users/x/proj' });
        expect(res).not.toBeNull();
        expect(res!.messages.length).toBe(2);
        expect(res!.messages[0]).toMatchObject({ role: 'user', content: 'help me' });
        expect(res!.messages[1]).toMatchObject({ role: 'assistant', content: 'sure' });
    });
});

describe('native_history — directory + cwd_slug expansion', () => {
    it('expands {cwd_slug:dashes}', async () => {
        const root = tmpDir();
        const proj = '/Users/sample/repo';
        const expandedDir = path.join(root, '-Users-sample-repo');
        fs.mkdirSync(expandedDir);
        fs.writeFileSync(path.join(expandedDir, 'a.jsonl'), JSON.stringify({
            message: { role: 'user', content: 'x' },
        }));

        const cfg: NativeHistoryConfig = {
            format: 'jsonl_lines',
            location: { directory: `${root}/{cwd_slug:dashes}`, file_pattern: '*.jsonl', pick: 'newest_by_mtime' },
            message_extractor: { role_field: 'message.role', content_field: 'message.content' },
        };
        const res = await readNativeHistory(cfg, { workingDir: proj });
        expect(res).not.toBeNull();
        expect(res!.messages[0].content).toBe('x');
    });
});
