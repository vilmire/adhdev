import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readProviderChatHistory, readProviderChatHistoryAsync } from '../../../src/config/provider-native-history.js';
import { executeNativeHistory, executeNativeHistoryAsync, createCooperativeNativeHistoryReader } from '../../../src/providers/spec/native-history-executor.js';
import { __getParsedJsonlCacheStatsForTests, __resetParsedJsonlCacheForTests } from '../../../src/providers/spec/native-history-jsonl-cache.js';
vi.mock('node:fs', async () => ({ ...await vi.importActual('node:fs') }));
import { compileRecordShapes, compileUsageShapes, projectMessages, projectUsageRecord } from '../../../src/providers/spec/native-history-projection.js';
import { foldUsageRecords } from '../../../src/shared/usage-normalize.js';
import { readExternalCompletionMessages } from '../../../src/providers/completion/evidence.js';
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
        vi.restoreAllMocks();
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

        // Completion probes always re-stat, retaining the immutable parsed
        // prefix when metadata is unchanged. Verify through the same
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
            misses: 2,
            fileReads: 2,
            parsePasses: 2,
        });
    });

    it('benchmark: retains six 10 MiB sources across two polling rounds', () => {
        const payload = '한국어'.repeat(291_300);
        const row = JSON.stringify({ role: 'assistant', content: 'answer', receivedAt: 1_800_000_000_000, toolOutput: payload }) + '\n';
        const virtual = new Map<string, Buffer>();
        const realRead = fs.readFileSync;
        const realStat = fs.statSync;
        const realOpen = fs.openSync;
        const realReadSync = fs.readSync;
        const fds = new Map<number, Buffer>();
        vi.spyOn(fs, 'statSync').mockImplementation(((file: any, ...args: any[]) => {
            const stat = (realStat as any)(file, ...args);
            if (virtual.has(String(file))) Object.defineProperty(stat, 'size', { value: virtual.get(String(file))!.length });
            return stat;
        }) as any);
        vi.spyOn(fs, 'readFileSync').mockImplementation(((file: any, ...args: any[]) => virtual.get(String(file))?.toString('utf8') ?? (realRead as any)(file, ...args)) as any);
        vi.spyOn(fs, 'openSync').mockImplementation(((file: any, ...args: any[]) => {
            const fd = (realOpen as any)(file, ...args);
            if (virtual.has(String(file))) fds.set(fd, virtual.get(String(file))!);
            return fd;
        }) as any);
        vi.spyOn(fs, 'readSync').mockImplementation(((fd: number, buf: Buffer, offset: number, length: number, position: number) => {
            const data = fds.get(fd);
            return data ? data.copy(buf, offset, position, position + length) : (realReadSync as any)(fd, buf, offset, length, position);
        }) as any);
        const configs = Array.from({ length: 6 }, (_, i) => {
            const file = path.join(tmpDir, `session-${i}-${SESSION_ID}.jsonl`);
            fs.writeFileSync(file, '');
            virtual.set(file, Buffer.from(row.repeat(4)));
            return { source: { ...config.source, path: file } };
        });
        const poll = () => configs.forEach(cfg => executeNativeHistory(cfg, { agentType: 'cache-test-cli' }));
        const parseSpy = vi.spyOn(JSON, 'parse');
        const start = performance.now();
        poll();
        const warm = __getParsedJsonlCacheStatsForTests();
        const warmMs = performance.now() - start;
        const parses = parseSpy.mock.calls.length;
        const reads = vi.mocked(fs.readSync).mock.calls.length;
        const secondStart = performance.now();
        poll();
        const after = __getParsedJsonlCacheStatsForTests();
        process.stdout.write('six-session benchmark ' + JSON.stringify({ sourceBytes: Buffer.byteLength(row) * 4, warmMs, secondMs: performance.now() - secondStart, warm, after }) + '\n');
        expect(parseSpy.mock.calls.length).toBe(parses);
        expect(vi.mocked(fs.readSync).mock.calls.length).toBe(reads);
        expect(after.fileReads - warm.fileReads).toBe(0);
        expect(after.parsePasses - warm.parsePasses).toBe(0);
        expect(after.recordsProjected - warm.recordsProjected).toBe(0);
        expect(after.bytesRead - warm.bytesRead).toBe(0);
        expect(fs.readFileSync).toHaveBeenCalledTimes(0);
        expect(vi.mocked(fs.readSync).mock.calls.every(call => Number(call[3]) <= 256 * 1024)).toBe(true);
    });

    it('retains an unchanged 150 MiB source identity without a second parse', () => {
        append('assistant', 'large source', 1_800_000_000_000);
        const realStat = fs.statSync;
        const statSpy = vi.spyOn(fs, 'statSync').mockImplementation(((file: any, ...args: any[]) => {
            const stat = (realStat as any)(file, ...args);
            if (String(file) === transcriptPath) Object.defineProperty(stat, 'size', { value: 150 * 1024 * 1024 });
            return stat;
        }) as any);
        try {
            expect(read()!.messages[0].content).toBe('large source');
            const warm = __getParsedJsonlCacheStatsForTests();
            read();
            expect(__getParsedJsonlCacheStatsForTests().parsePasses).toBe(warm.parsePasses);
        } finally { statSpy.mockRestore(); }
    });

    it('parses only appended bytes, and rebuilds once on truncate, rotation or same-size rewrite', () => {
        append('user', '한국어 🎉 prefix', 1_800_000_000_000);
        read();
        const first = __getParsedJsonlCacheStatsForTests();
        const tail = JSON.stringify({ role: 'assistant', content: 'appended', receivedAt: 1_800_000_001_000 }) + '\n';
        fs.appendFileSync(transcriptPath, tail.repeat(3));
        const incremental = read(true)!;
        const second = __getParsedJsonlCacheStatsForTests();
        expect(second.bytesRead - first.bytesRead).toBe(3 * Buffer.byteLength(tail));
        expect(second.recordsParsed - first.recordsParsed).toBe(3);
        expect(second.fullReads).toBe(1);
        __resetParsedJsonlCacheForTests();
        expect(JSON.stringify(read())).toBe(JSON.stringify(incremental));

        for (const mode of ['truncate', 'rotate', 'rewrite']) {
            const before = __getParsedJsonlCacheStatsForTests();
            if (mode === 'rotate') {
                fs.writeFileSync(transcriptPath + '.new', tail.repeat(4));
                fs.renameSync(transcriptPath + '.new', transcriptPath);
            } else if (mode === 'rewrite') {
                const content = fs.readFileSync(transcriptPath, 'utf8').replaceAll('appended', 'rewritte');
                fs.writeFileSync(transcriptPath, content);
                const future = new Date(Date.now() + 10_000);
                fs.utimesSync(transcriptPath, future, future);
            } else fs.writeFileSync(transcriptPath, tail);
            const fresh = read();
            read();
            expect(__getParsedJsonlCacheStatsForTests().fullReads - before.fullReads).toBe(1);
            __resetParsedJsonlCacheForTests();
            expect(JSON.stringify(read())).toBe(JSON.stringify(fresh));
        }
    });

    it('replaces a partial last line and preserves UTF-8 and fallback timestamps', () => {
        fs.writeFileSync(transcriptPath, '{"role":"user","content":"한국어"}\n{"role":"assistant","content":"🎉"}');
        expect(read()!.messages).toHaveLength(2);
        fs.appendFileSync(transcriptPath, '\n{"role":"assistant","content":"tail"}\n');
        const incremental = read();
        expect(incremental!.messages).toHaveLength(3);
        __resetParsedJsonlCacheForTests();
        expect(JSON.stringify(read())).toBe(JSON.stringify(incremental));
    });

    it('cooperatively rebuilds, coalesces readers, and keeps read_chat paging byte-identical', async () => {
        for (let i = 0; i < 600; i++) append(i % 2 ? 'assistant' : 'user', `message ${i}`, 1_800_000_000_000 + i * 1000);
        const synchronous = executeNativeHistory(config, { agentType: 'cache-test-cli', providerSessionId: SESSION_ID });
        const options: any = {
            canonicalHistory: { mode: 'native-source', scripts: { readSession: 'readNativeHistory' } },
            historySessionId: SESSION_ID,
            scripts: { readNativeHistory: (input: any) => executeNativeHistory(config, input) },
        };
        const expected = [0, 10, 60, 550].map(offset => JSON.stringify(readProviderChatHistory('cache-test-cli', { ...options, offset, limit: 30 })));
        __resetParsedJsonlCacheForTests();
        const reader = createCooperativeNativeHistoryReader(config);
        expect(reader({ agentType: 'cache-test-cli', providerSessionId: SESSION_ID })).toMatchObject({ unavailableReason: 'native_history_loading' });
        let heartbeats = 0;
        const timer = setInterval(() => heartbeats++, 0);
        const [a, b] = await Promise.all([
            reader.readAsync({ agentType: 'cache-test-cli', providerSessionId: SESSION_ID }),
            reader.readAsync({ agentType: 'cache-test-cli', providerSessionId: SESSION_ID }),
        ]);
        clearInterval(timer);
        expect(a).toEqual(synchronous);
        expect(b).toBe(a);
        expect(__getParsedJsonlCacheStatsForTests().fullReads).toBe(1);
        expect(heartbeats).toBeGreaterThan(0);
        for (const [i, offset] of [0, 10, 60, 550].entries()) {
            const actual = await readProviderChatHistoryAsync('cache-test-cli', { ...options, scripts: { readNativeHistory: reader }, offset, limit: 30 });
            expect(JSON.stringify(actual)).toBe(expected[i]);
        }
        const warm = __getParsedJsonlCacheStatsForTests();
        await executeNativeHistoryAsync(config, { agentType: 'cache-test-cli', providerSessionId: SESSION_ID });
        expect(__getParsedJsonlCacheStatsForTests().recordsProjected).toBe(warm.recordsProjected);
    });

    it('matches the previous whole-file projection and paged JSON bytes including tools, usage and source addresses', () => {
        config.source = { ...config.source, message_filter: { where: "$.type == 'message'" },
            message_map: { role: '$.role', content: '$.content', timestamp_ms: '$.receivedAt', tools: {} },
            usage_records: [{ where: "$.type == 'usage'", usage_map: { input_tokens: '$.input', output_tokens: '$.output', mode: 'cumulative', timestamp_ms: '$.receivedAt' } }] };
        const records = [
            { type: 'session_meta', payload: { cwd: '/workspace' } },
            { type: 'message', role: 'user', content: 'question', receivedAt: 1_800_000_000_000 },
            { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'answer' }, { type: 'tool_use', id: 'tool', name: 'Read', input: { text: 'a'.repeat(5000) } }] },
            { type: 'usage', input: 10, output: 20 },
            { type: 'message', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'b'.repeat(5000) }] },
            { type: 'usage', input: 30, output: 40, receivedAt: 1_800_000_002_000 },
        ];
        fs.writeFileSync(transcriptPath, records.map(rec => JSON.stringify(rec)).join('\n') + '\n');
        const mtime = Math.floor(fs.statSync(transcriptPath).mtimeMs);
        // Reference is the pre-change executor's full-file projection loop.
        const shapes = compileRecordShapes(config.source);
        const pickUsage = compileUsageShapes(config.source);
        const messages = records.flatMap((rec, i) => {
            const shape = shapes.pick(rec);
            return shape ? projectMessages(rec, shape.map, i, records.length, mtime, SESSION_ID).map(msg => ({ ...msg, workspace: '/workspace' })) : [];
        });
        const usageRecords = records.flatMap(rec => {
            const map = pickUsage?.(rec);
            const usage = map && projectUsageRecord(rec, map, mtime);
            return usage ? [usage] : [];
        });
        const baseline = { messages, providerSessionId: SESSION_ID, sourcePath: transcriptPath, sourceMtimeMs: mtime,
            nativeHistoryCoverage: 'full', workspace: '/workspace', usage: foldUsageRecords(usageRecords, { providerSessionId: SESSION_ID, agent: 'cache-test-cli' }) };
        const actual = read();
        expect(JSON.stringify(actual)).toBe(JSON.stringify(baseline));
        const options = { canonicalHistory: { mode: 'native-source' as const, scripts: { readSession: 'readNativeHistory' } }, historySessionId: SESSION_ID };
        for (const offset of [0, 1, 2]) for (const excludeActivity of [false, true]) {
            const paging = { ...options, offset, limit: 2, excludeActivity };
            const before = readProviderChatHistory('cache-test-cli', { ...paging, scripts: { readNativeHistory: () => baseline } });
            const after = readProviderChatHistory('cache-test-cli', { ...paging, scripts: { readNativeHistory: () => actual } });
            expect(JSON.stringify(after)).toBe(JSON.stringify(before));
        }
    });

    it('holds completion evidence while loading and observes an appended terminal record without prefix replay', async () => {
        config.source.message_filter = { where: "$.type == 'message'" };
        const write = (rec: any) => fs.appendFileSync(transcriptPath, JSON.stringify(rec) + '\n');
        write({ type: 'message', role: 'assistant', content: 'answer', receivedAt: 1_800_000_000_000 });
        const reader = createCooperativeNativeHistoryReader(config);
        const host: any = { type: 'codex-cli', instanceId: 'runtime', workingDir: tmpDir, startedAt: 0,
            providerSessionId: SESSION_ID, adapter: { chatMessagesOwnedExternally: true },
            provider: { nativeHistory: { mode: 'native-source', scripts: { readSession: 'readNativeHistory' } }, scripts: { readNativeHistory: reader } },
            spawnedEnvOverrides: () => ({}), publishTranscriptSignalObservation: vi.fn() };
        expect(readExternalCompletionMessages(host)).toEqual([]);
        await new Promise(resolve => setImmediate(resolve));
        // Await the same source via the async boundary (the queue serializes differing caller contexts).
        await readProviderChatHistoryAsync(host.type, { canonicalHistory: host.provider.nativeHistory, scripts: host.provider.scripts, historySessionId: SESSION_ID, workspace: tmpDir, instanceId: 'runtime', sessionStartedAtMs: 0, envOverrides: {} });
        expect(readExternalCompletionMessages(host)).toHaveLength(1);
        const before = __getParsedJsonlCacheStatsForTests();
        const terminal = { type: 'event_msg', timestamp: '2027-01-15T08:00:01.000Z', payload: { type: 'task_complete', turn_id: 'turn', last_agent_message: 'done' } };
        write(terminal);
        expect(readExternalCompletionMessages(host)).toEqual([]);
        await readProviderChatHistoryAsync(host.type, { canonicalHistory: host.provider.nativeHistory, scripts: host.provider.scripts, historySessionId: SESSION_ID, workspace: tmpDir, instanceId: 'runtime', sessionStartedAtMs: 0, envOverrides: {} });
        readExternalCompletionMessages(host);
        expect(host.lastNativeTurnTerminalMarkers).toMatchObject([{ outcome: 'completed', turnId: 'turn', summary: 'done' }]);
        const after = __getParsedJsonlCacheStatsForTests();
        expect(after.fullReads).toBe(before.fullReads);
        expect(after.recordsParsed - before.recordsParsed).toBe(1);
        expect(after.bytesRead - before.bytesRead).toBe(Buffer.byteLength(JSON.stringify(terminal) + '\n'));
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
