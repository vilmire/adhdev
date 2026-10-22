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
import { readExternalCompletionMessages, getLiveTurnPendingEvidence } from '../../../src/providers/completion/evidence.js';
import { publishTranscriptSignalObservation, probeNativeTranscriptSignals } from '../../../src/providers/cli-provider-transcript-signals.js';
import { runMeshStallTick } from '../../../src/providers/completion/mesh-stall-watchdog.js';
import { readJsonlLines, readProjectedJsonlRecords } from '../../../src/providers/spec/native-history-jsonl-cache.js';
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

    beforeEach(async () => {
        await new Promise<void>(resolve => setImmediate(resolve));
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

    it('finishes cold and appended work synchronously across chunk boundaries within budget', () => {
        for (let i = 0; i < 600; i++) append('assistant', `message ${i}`, 1_800_000_000_000 + i);
        const reader = createCooperativeNativeHistoryReader(config);
        const input = { agentType: 'cache-test-cli', providerSessionId: SESSION_ID };
        const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
        expect(reader(input)!.messages).toHaveLength(600);
        append('assistant', 'new tail', 1_800_000_001_000);
        expect(reader(input)!.messages.at(-1)!.content).toBe('new tail');
        expect(reader(input)!.stale).toBeUndefined();
        clock.mockRestore();
    });

    it('finishes a cold rebuild under a live writer and catches up without replaying the prefix', () => {
        const row = JSON.stringify({ role: 'assistant', content: 'x'.repeat(200) }) + '\n';
        fs.writeFileSync(transcriptPath, row.repeat(60_000));
        const work = readProjectedJsonlRecords(transcriptPath, 'live-writer', rec => rec);
        let step = work.next();
        let steps = 0;
        let appends = 0;
        while (!step.done && steps < 2_000) {
            if (++steps % 5 === 0) { fs.appendFileSync(transcriptPath, row); appends++; }
            step = work.next();
        }
        expect(step.done).toBe(true);
        expect(step.value).toHaveLength(60_000 + appends);
        process.stdout.write('live-writer rebuild ' + JSON.stringify({ steps, appends, records: step.value?.length }) + '\n');
        expect(__getParsedJsonlCacheStatsForTests()).toMatchObject({ fullReads: 1, recordsParsed: 60_000 + appends });
        fs.appendFileSync(transcriptPath, row);
        const tail = readProjectedJsonlRecords(transcriptPath, 'live-writer', rec => rec).next();
        expect(tail.done).toBe(true);
        expect(tail.value).toHaveLength(60_001 + appends);
    });

    it('finishes message assembly under continuous appends, then catches up after the writer stops', async () => {
        const row = JSON.stringify({ role: 'assistant', content: 'x'.repeat(200), receivedAt: 1_800_000_000_000 }) + '\n';
        fs.writeFileSync(transcriptPath, row.repeat(60_000));
        const reader = createCooperativeNativeHistoryReader(config);
        const input = { agentType: 'cache-test-cli', providerSessionId: SESSION_ID };
        let finished = false;
        const pending = reader.readAsync(input).then(value => { finished = true; return value; });
        let turns = 0;
        let appends = 0;
        while (!finished && turns < 3_000) {
            await new Promise<void>(resolve => setImmediate(resolve));
            if (++turns % 5 === 0) { fs.appendFileSync(transcriptPath, row); appends++; }
        }
        const prefix = await pending;
        expect(turns).toBeLessThan(3_000);
        expect(prefix!.stale).toBe(true);
        expect(prefix!.messages.length).toBeGreaterThanOrEqual(60_000);
        const caughtUp = (await reader.readAsync(input))!;
        expect(caughtUp.stale).toBeUndefined();
        expect(caughtUp.messages).toHaveLength(60_000 + appends);
        expect(__getParsedJsonlCacheStatsForTests()).toMatchObject({ fullReads: 1, recordsParsed: 60_000 + appends });
        process.stdout.write('live-writer executor ' + JSON.stringify({ turns, appends, prefix: prefix!.messages.length, caughtUp: caughtUp.messages.length }) + '\n');
    });

    it.each(['rewrite', 'replacement'])('discards a prefix changed by %s while its rebuild yields', mode => {
        const row = JSON.stringify({ content: 'old'.repeat(70) }) + '\n';
        fs.writeFileSync(transcriptPath, row.repeat(2_000));
        const work = readProjectedJsonlRecords(transcriptPath, 'rewrite-race', rec => rec.content);
        expect(work.next().done).toBe(false);
        const next = row.replaceAll('old', 'new').repeat(2_001);
        if (mode === 'replacement') {
            fs.writeFileSync(transcriptPath + '.new', next);
            fs.renameSync(transcriptPath + '.new', transcriptPath);
        } else fs.writeFileSync(transcriptPath, next);
        let step = work.next();
        while (!step.done) step = work.next();
        expect(step.value).toEqual(Array(2_001).fill('new'.repeat(70)));
        expect(__getParsedJsonlCacheStatsForTests().fullReads).toBe(2);
    });

    it('shares one synchronous work budget across twenty sources in the same event-loop turn', async () => {
        const row = JSON.stringify({ role: 'assistant', content: 'answer' }) + '\n';
        const readers = Array.from({ length: 20 }, (_, i) => {
            const file = path.join(tmpDir, `source-${i}-${SESSION_ID}.jsonl`);
            fs.writeFileSync(file, row.repeat(2_000));
            return createCooperativeNativeHistoryReader({ source: { ...config.source, path: file } });
        });
        let elapsed = 0;
        const parse = JSON.parse;
        const parseSpy = vi.spyOn(JSON, 'parse').mockImplementation((...args) => { elapsed += 0.01; return parse(...args); });
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
        const input = { agentType: 'cache-test-cli', providerSessionId: SESSION_ID };
        const results = readers.map(reader => reader(input));
        const syncMs = elapsed;
        process.stdout.write('shared-turn budget ' + JSON.stringify({ sources: readers.length, modeledSyncMs: syncMs,
            syncRecordsParsed: __getParsedJsonlCacheStatsForTests().recordsParsed }) + '\n');
        clock.mockRestore();
        parseSpy.mockRestore();
        expect(results.every(result => result?.unavailableReason === 'native_history_loading')).toBe(true);
        // 8ms shared allowance plus at most one 256-record atomic step.
        expect(syncMs).toBeLessThanOrEqual(10.6);
        expect(__getParsedJsonlCacheStatsForTests().recordsParsed).toBeLessThanOrEqual(1_024);
        const completed = await Promise.all(readers.map(reader => reader.readAsync(input)));
        expect(completed.every(result => result?.messages.length === 2_000)).toBe(true);
    });

    it('serves an unchanged later-session cache hit even after another source exhausts the shared bucket', async () => {
        append('assistant', 'cached final', 1_800_000_000_000);
        const cached = createCooperativeNativeHistoryReader(config);
        const input = { agentType: 'cache-test-cli', providerSessionId: SESSION_ID };
        const previous = cached(input);
        expect(previous?.messages).toHaveLength(1);
        const otherPath = path.join(tmpDir, `cold-${SESSION_ID}.jsonl`);
        fs.writeFileSync(otherPath, (JSON.stringify({ role: 'assistant', content: 'cold' }) + '\n').repeat(2_000));
        const cold = createCooperativeNativeHistoryReader({ source: { ...config.source, path: otherPath } });
        const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(9);
        expect(cold(input)?.unavailableReason).toBe('native_history_loading');
        expect(cached({ ...input, forceRefresh: true })).toMatchObject({ messages: previous!.messages });
        expect(cached(input)?.stale).toBeUndefined();
        // A separate reader can reuse the stat/projection cache too.
        expect(createCooperativeNativeHistoryReader(config)(input)?.stale).toBeUndefined();
        expect(createCooperativeNativeHistoryReader(config)(input)?.messages).toHaveLength(1);
        // forceRefresh still checks source metadata: an append cannot use the fast hit.
        append('assistant', 'new tail', 1_800_000_000_001);
        expect(cached({ ...input, forceRefresh: true })?.stale).toBe(true);
        clock.mockRestore();
        await Promise.all([cached.readAsync(input), cold.readAsync(input)]);
    });

    it.each(['loading', 'stale'])('preserves evidence and defers the watchdog while history is %s', async mode => {
        config.source.message_map.tools = {};
        const reader = createCooperativeNativeHistoryReader(config);
        const host: any = { type: 'claude-cli', instanceId: `runtime-${mode}`, workingDir: tmpDir, startedAt: 1,
            providerSessionId: SESSION_ID, adapter: { chatMessagesOwnedExternally: true, setSignalObservation: vi.fn(),
                getLastApprovalResolvedAt: () => 0, getStatus: () => ({ lastOutputAt: 1, status: 'idle' }) },
            provider: { nativeHistory: { mode: 'native-source', scripts: { readSession: 'readNativeHistory' } }, scripts: { readNativeHistory: reader } },
            spawnedEnvOverrides: () => ({}), hasAdapterPendingResponse: () => false, isModalParked: () => false,
            completionHasFinalAssistantMessage: () => true,
            meshStallAnchorAt: 1, meshStallEmittedForAnchor: false, meshStallLastFiredAt: -1,
            meshStallTranscriptSignalSampled: true, isMeshWorkerSession: () => true,
            meshTraceCtx: () => ({}), completingTurnTaskId: () => undefined, pushEvent: vi.fn() };
        host.publishTranscriptSignalObservation = (messages: any) => publishTranscriptSignalObservation(host, messages);
        host.readExternalCompletionMessages = () => readExternalCompletionMessages(host);
        host.probeNativeTranscriptSignals = () => probeNativeTranscriptSignals(host);
        if (mode === 'stale') {
            append('assistant', 'interim narration', 1_800_000_000_000);
            fs.appendFileSync(transcriptPath, JSON.stringify({ role: 'assistant', receivedAt: 1_800_000_000_001,
                content: [{ type: 'tool_use', name: 'Read', input: { file: 'first' } }] }) + '\n');
            host.probeNativeTranscriptSignals();
            expect(getLiveTurnPendingEvidence(host)).toMatchObject({ pending: true, kind: 'transcript_tool' });
            // Even a previously quiet signal must not authorize a stall while rebuilding.
            host.lastTranscriptSignalSnapshot.signals.in_turn_progress = false;
            host.lastTranscriptSignalSnapshot.signals.transcript_growing = false;
        }
        const snapshot = host.lastTranscriptSignalSnapshot;
        const probe = host.lastExternalCompletionProbe;
        const observations = host.adapter.setSignalObservation.mock.calls.length;
        for (let i = 0; i < 600; i++) append('assistant', `appended ${i}`, 1_800_000_001_000 + i);
        const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(9);
        const deferred = host.probeNativeTranscriptSignals();
        clock.mockRestore();
        expect(deferred.pending).toBe(true);
        expect(host.lastTranscriptSignalSnapshot).toBe(snapshot);
        expect(host.lastExternalCompletionProbe).toBe(probe);
        expect(host.adapter.setSignalObservation).toHaveBeenCalledTimes(observations);
        if (mode === 'stale') {
            expect(getLiveTurnPendingEvidence(host)).toMatchObject({ pending: true, kind: 'transcript_tool' });
        }
        runMeshStallTick(host, 180_001);
        expect(host.meshStallAnchorAt).toBe(1);
        expect(host.meshStallEmittedForAnchor).toBe(false);
        expect(host.pushEvent).not.toHaveBeenCalled();
        await reader.readAsync({ agentType: host.type, providerSessionId: SESSION_ID });
        expect(host.probeNativeTranscriptSignals().pending).not.toBe(true);
        expect(host.lastExternalCompletionProbe.msgCount).toBe(mode === 'stale' ? 602 : 600);
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
        const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(9);
        expect(reader({ agentType: 'cache-test-cli', providerSessionId: SESSION_ID })).toMatchObject({ unavailableReason: 'native_history_loading' });
        clock.mockRestore();
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

    it('observes completion appends and terminal markers synchronously in the same tick without prefix replay', () => {
        config.source.message_filter = { where: "$.type == 'message'" };
        const write = (rec: any) => fs.appendFileSync(transcriptPath, JSON.stringify(rec) + '\n');
        write({ type: 'message', role: 'assistant', content: 'answer', receivedAt: 1_800_000_000_000 });
        const reader = createCooperativeNativeHistoryReader(config);
        const host: any = { type: 'codex-cli', instanceId: 'runtime', workingDir: tmpDir, startedAt: 0,
            providerSessionId: SESSION_ID, adapter: { chatMessagesOwnedExternally: true },
            provider: { nativeHistory: { mode: 'native-source', scripts: { readSession: 'readNativeHistory' } }, scripts: { readNativeHistory: reader } },
            spawnedEnvOverrides: () => ({}), publishTranscriptSignalObservation: vi.fn() };
        expect(readExternalCompletionMessages(host)).toHaveLength(1);
        const before = __getParsedJsonlCacheStatsForTests();
        const terminal = { type: 'event_msg', timestamp: '2027-01-15T08:00:01.000Z', payload: { type: 'task_complete', turn_id: 'turn', last_agent_message: 'done' } };
        write(terminal);
        expect(readExternalCompletionMessages(host)).toHaveLength(1);
        expect(host.lastNativeTurnTerminalMarkers).toMatchObject([{ outcome: 'completed', turnId: 'turn', summary: 'done' }]);
        const after = __getParsedJsonlCacheStatsForTests();
        expect(after.fullReads).toBe(before.fullReads);
        expect(after.recordsParsed - before.recordsParsed).toBe(1);
        expect(after.bytesRead - before.bytesRead).toBe(Buffer.byteLength(JSON.stringify(terminal) + '\n'));
    });

    it.each(['growing rewrite', 'same-size rewrite', 'ino-zero replacement'])('rebuilds a %s instead of resuming the wrong prefix', mode => {
        if (mode === 'ino-zero replacement') {
            const realStat = fs.statSync;
            vi.spyOn(fs, 'statSync').mockImplementation(((...args: any[]) => {
                const stat = (realStat as any)(...args);
                Object.defineProperty(stat, 'ino', { value: 0 });
                return stat;
            }) as any);
        }
        append('user', 'old prefix', 1_800_000_000_000);
        readJsonlLines(transcriptPath);
        read();
        const before = __getParsedJsonlCacheStatsForTests();
        const replacement = JSON.stringify({ role: 'user', content: 'new prefix', receivedAt: 1_800_000_000_000 }) + '\n';
        const extra = JSON.stringify({ role: 'assistant', content: 'new tail', receivedAt: 1_800_000_001_000 }) + '\n';
        if (mode === 'ino-zero replacement') {
            fs.writeFileSync(transcriptPath + '.new', replacement + extra);
            fs.renameSync(transcriptPath + '.new', transcriptPath);
        } else {
            fs.writeFileSync(transcriptPath, replacement + (mode === 'growing rewrite' ? extra : ''));
        }
        const future = new Date(Date.now() + 10_000);
        fs.utimesSync(transcriptPath, future, future);
        const expected = mode === 'same-size rewrite' ? ['new prefix'] : ['new prefix', 'new tail'];
        expect(readJsonlLines(transcriptPath).map(rec => rec.content)).toEqual(expected);
        const rebuilt = read();
        expect(rebuilt!.messages.map(msg => msg.content)).toEqual(expected);
        expect(__getParsedJsonlCacheStatsForTests().fullReads - before.fullReads).toBe(1);
        __resetParsedJsonlCacheForTests();
        expect(read()).toEqual(rebuilt);
    });

    it('serves a marked stale snapshot during a budgeted rebuild and coalesces callers by source', async () => {
        append('assistant', 'last good answer', 1_800_000_000_000);
        const reader = createCooperativeNativeHistoryReader(config);
        const input = { agentType: 'cache-test-cli', providerSessionId: SESSION_ID };
        const first = reader(input)!;
        for (let i = 0; i < 600; i++) append('assistant', `appended ${i}`, 1_800_000_001_000 + i);
        // Deterministic budget exhaustion after the first useful chunk.
        const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(9);
        const stale = reader(input)!;
        clock.mockRestore();
        expect(stale).toMatchObject({ stale: true, sourcePath: transcriptPath });
        expect(stale.messages).toBe(first.messages);
        expect(stale.unavailableReason).toBeUndefined();
        const options: any = { canonicalHistory: { mode: 'native-source', scripts: { readSession: 'readNativeHistory' } },
            historySessionId: SESSION_ID, scripts: { readNativeHistory: reader } };
        expect(readProviderChatHistory(input.agentType, options)).toMatchObject({ source: 'provider-native', stale: true });
        // Coalescing source work must still enforce each caller's session pin.
        const foreign = { ...input, providerSessionId: '11111111-1111-4111-9111-111111111111' };
        expect(reader(foreign)).toBeNull();
        const foreignRead = reader.readAsync(foreign);
        const [status, completion, chat] = await Promise.all([
            reader.readAsync(input),
            reader.readAsync({ agentType: input.agentType, historySessionId: SESSION_ID, forceRefresh: true, workspace: tmpDir, args: { forceRefresh: true } }),
            reader.readAsync({ agentType: input.agentType, sessionId: SESSION_ID, instanceId: 'read-chat', args: { offset: 20, limit: 30 } }),
        ]);
        expect(await foreignRead).toBeNull();
        expect(status).toBe(completion);
        expect(status).toBe(chat);
        expect(status!.messages).toHaveLength(601);
        expect(status!.stale).toBeUndefined();
        expect(status!.messages[0]._src).toBe(first.messages[0]._src);
        expect(__getParsedJsonlCacheStatsForTests()).toMatchObject({ fullReads: 1, incrementalReads: 1, recordsParsed: 601 });
    });

    it('preserves existing completion markers and snapshots while a cold large source is loading', async () => {
        for (let i = 0; i < 600; i++) append('assistant', `message ${i}`, 1_800_000_000_000 + i);
        const reader = createCooperativeNativeHistoryReader(config);
        const markers = [{ outcome: 'completed', turnId: 'previous' }];
        const snapshot = { msgCount: 1 };
        const host: any = { type: 'codex-cli', instanceId: 'runtime', workingDir: tmpDir, startedAt: 0,
            providerSessionId: SESSION_ID, adapter: { chatMessagesOwnedExternally: true },
            provider: { nativeHistory: { mode: 'native-source', scripts: { readSession: 'readNativeHistory' } }, scripts: { readNativeHistory: reader } },
            lastNativeTurnTerminalMarkers: markers, lastExternalCompletionProbe: snapshot,
            spawnedEnvOverrides: () => ({}), publishTranscriptSignalObservation: vi.fn() };
        const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(9);
        expect(readExternalCompletionMessages(host)).toEqual([]);
        clock.mockRestore();
        expect(host.lastNativeTurnTerminalMarkers).toBe(markers);
        expect(host.lastExternalCompletionProbe).toBe(snapshot);
        expect(host.publishTranscriptSignalObservation).not.toHaveBeenCalled();
        await reader.readAsync({ agentType: host.type, providerSessionId: SESSION_ID });
        expect(readExternalCompletionMessages(host)).toHaveLength(600);
    });

    it('re-stats after cooperative work and seals tool references with the completed revision', async () => {
        config.source.message_map.tools = {};
        for (let i = 0; i < 600; i++) append('assistant', `message ${i}`, 1_800_000_000_000 + i);
        fs.appendFileSync(transcriptPath, JSON.stringify({ role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { text: 'a'.repeat(5000) } }] }) + '\n');
        const reader = createCooperativeNativeHistoryReader(config);
        const input = { agentType: 'cache-test-cli', providerSessionId: SESSION_ID };
        const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(9);
        expect(reader(input)).toMatchObject({ unavailableReason: 'native_history_loading' });
        clock.mockRestore();
        const future = new Date(Date.now() + 10_000);
        fs.utimesSync(transcriptPath, future, future);
        const result = (await reader.readAsync(input))!;
        const mtime = Math.floor(fs.statSync(transcriptPath).mtimeMs);
        expect(result.sourceMtimeMs).toBe(mtime);
        expect(result.messages.at(-1)!.toolBlockRef!.sourceMtimeMs).toBe(mtime);
        expect(reader(input)!.sourceMtimeMs).toBe(mtime);
    });

    it('keeps trailing-tool admission vetoes and watchdog progress while the real JSONL grows', () => {
        config.source.message_map.tools = {};
        append('assistant', 'interim narration', 1_800_000_000_000);
        const reader = createCooperativeNativeHistoryReader(config);
        const host: any = { type: 'claude-cli', instanceId: 'runtime-growing', workingDir: tmpDir, startedAt: 1,
            providerSessionId: SESSION_ID, adapter: { chatMessagesOwnedExternally: true, setSignalObservation: vi.fn(),
                getLastApprovalResolvedAt: () => 0, getStatus: () => ({ lastOutputAt: 1, status: 'idle' }) },
            provider: { nativeHistory: { mode: 'native-source', scripts: { readSession: 'readNativeHistory' } }, scripts: { readNativeHistory: reader } },
            spawnedEnvOverrides: () => ({}), hasAdapterPendingResponse: () => false, isModalParked: () => false,
            completionHasFinalAssistantMessage: () => true,
            meshStallAnchorAt: 1, meshStallEmittedForAnchor: false, meshStallLastFiredAt: -1,
            meshStallTranscriptSignalSampled: true, isMeshWorkerSession: () => true,
            meshTraceCtx: () => ({}), pushEvent: vi.fn() };
        host.publishTranscriptSignalObservation = (messages: any) => publishTranscriptSignalObservation(host, messages);
        host.readExternalCompletionMessages = () => readExternalCompletionMessages(host);
        host.probeNativeTranscriptSignals = () => probeNativeTranscriptSignals(host);
        host.probeNativeTranscriptSignals();
        for (let i = 0; i < 3; i++) {
            fs.appendFileSync(transcriptPath, JSON.stringify({ role: 'assistant', receivedAt: 1_800_000_001_000 + i,
                content: [{ type: 'tool_use', name: 'Read', input: { file: `file-${i}` } }] }) + '\n');
            expect(getLiveTurnPendingEvidence(host)).toMatchObject({ pending: true, kind: 'transcript_tool' });
            runMeshStallTick(host, 180_001 + i * 180_000);
            expect(host.meshStallAnchorAt).toBe(180_001 + i * 180_000);
            expect(host.pushEvent).not.toHaveBeenCalled();
        }
        expect(__getParsedJsonlCacheStatsForTests()).toMatchObject({ fullReads: 1, incrementalReads: 3, recordsParsed: 4 });
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
