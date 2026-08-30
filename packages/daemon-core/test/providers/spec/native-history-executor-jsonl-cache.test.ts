import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readProviderChatHistory } from '../../../src/config/chat-history.js';
import {
    __getParsedJsonlCacheStatsForTests,
    __resetParsedJsonlCacheForTests,
    executeNativeHistory,
} from '../../../src/providers/spec/native-history-executor.js';

const SESSION_ID = '8c6cf338-ef5c-4df5-91a5-66c1e2ed4339';

describe('native JSONL parsed-result cache', () => {
    let tmpDir = '';
    let transcriptPath = '';
    let config: any;

    function append(role: 'user' | 'assistant' | 'system', content: string, receivedAt: number): void {
        fs.appendFileSync(transcriptPath, `${JSON.stringify({ role, content, receivedAt })}\n`, 'utf8');
    }

    function read(forceRefresh = false) {
        return executeNativeHistory(config, {
            agentType: 'cache-test-cli',
            providerSessionId: SESSION_ID,
            forceRefresh,
        });
    }

    beforeEach(() => {
        __resetParsedJsonlCacheForTests();
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-jsonl-cache-'));
        transcriptPath = path.join(tmpDir, `${SESSION_ID}.jsonl`);
        fs.writeFileSync(transcriptPath, '', 'utf8');
        config = {
            source: {
                kind: 'jsonl',
                path: transcriptPath,
                session_id_from: 'filename_uuid',
                message_map: {
                    role: '$.role',
                    content: '$.content',
                    timestamp_ms: '$.receivedAt',
                },
            },
        };
    });

    afterEach(() => {
        __resetParsedJsonlCacheForTests();
        if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
        tmpDir = '';
    });

    it('reuses an unchanged parse, invalidates on append, and exposes every new message', () => {
        append('assistant', 'first', 1_800_000_000_000);

        expect(read()!.messages.map(message => message.content)).toEqual(['first']);
        expect(read()!.messages.map(message => message.content)).toEqual(['first']);
        expect(__getParsedJsonlCacheStatsForTests()).toMatchObject({
            hits: 1,
            misses: 1,
            fileReads: 1,
            parsePasses: 1,
        });

        // size changes even on filesystems whose mtime resolution is coarse,
        // so an append must invalidate the parse before the next direct read.
        append('assistant', 'second', 1_800_000_001_000);
        expect(read()!.messages.map(message => message.content)).toEqual(['first', 'second']);
        expect(__getParsedJsonlCacheStatsForTests()).toMatchObject({
            hits: 1,
            misses: 2,
            fileReads: 2,
            parsePasses: 2,
        });

        // Completion-contract probes opt out of reuse even when stat metadata
        // is unchanged; verify the forceRefresh flag through the same
        // readProviderChatHistory boundary completion/evidence.ts uses.
        const completionRead = readProviderChatHistory('cache-test-cli', {
            canonicalHistory: {
                mode: 'native-source',
                scripts: { readSession: 'readNativeHistory' },
            },
            scripts: {
                readNativeHistory: (input: any) => executeNativeHistory(config, input),
            },
            historySessionId: SESSION_ID,
            offset: 0,
            limit: 20,
            forceRefresh: true,
        });
        expect(completionRead.messages.map(message => message.content)).toEqual(['first', 'second']);
        expect(__getParsedJsonlCacheStatsForTests()).toMatchObject({
            misses: 3,
            fileReads: 3,
            parsePasses: 3,
        });
    });

    it('preserves adjacent and last-turn duplicate removal after signature memoization', () => {
        append('user', 'question', 1_800_000_000_000);
        append('assistant', 'same answer', 1_800_000_001_000);
        append('assistant', 'same   answer', 1_800_000_002_000);
        append('system', 'progress', 1_800_000_003_000);
        append('assistant', 'same answer', 1_800_000_004_000);

        const canonicalHistory = {
            mode: 'native-source' as const,
            scripts: { readSession: 'readNativeHistory' },
        };
        const scripts = {
            readNativeHistory: (input: any) => executeNativeHistory(config, input),
        };
        const result = readProviderChatHistory('cache-test-cli', {
            canonicalHistory,
            scripts,
            historySessionId: SESSION_ID,
            offset: 0,
            limit: 20,
        });

        expect(result.source).toBe('provider-native');
        expect(result.messages.map(message => `${message.role}:${message.content}`)).toEqual([
            'user:question',
            'assistant:same answer',
            'system:progress',
        ]);
    });
});
