import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSession } from '../../../src/providers/native-history/codex-cli-transcript.js';
import { createNativeHistoryDispatcher } from '../../../src/providers/native-history/dispatcher.js';
import { readProviderChatHistory } from '../../../src/config/provider-native-history.js';
import { executeNativeHistory } from '../../../src/providers/spec/native-history-executor.js';
import { createCodexTurnProvenance } from '../../../src/providers/native-history/codex-turn-provenance.js';
const input = 'Synthetic acknowledged task input';
const digest = createHash('sha256').update(input).digest('hex');
function user(text: string, turn = 'one') { return { type: 'message', role: 'user', content: [{ type: 'input_text', text }],
    internal_chat_message_metadata_passthrough: { turn_id: turn } }; }
describe('Codex native lifecycle provenance', () => {
    it('binds only acknowledged response_item task input, deduplicating event_msg input', () => {
        const read = createCodexTurnProvenance('native', digest);
        read({ type: 'task_started', turn_id: 'one' }, 100);
        read(user('<environment_context>synthetic context</environment_context>'), 101);
        expect(read.openTurn()).toBeUndefined();
        read(user(input), 102);
        read({ type: 'user_message', message: input, turn_id: 'one' }, 103);
        expect(read.openTurn()).toMatchObject({ turnId: 'one', inputAt: 102, inputDigest: digest, startedAt: 100 });
        read(user('<environment_context>later synthetic context</environment_context>'), 104);
        read({ type: 'custom_tool_call_output', output: 'Script completed; inner command continues' }, 104);
        expect(read.openTurn()?.turnId).toBe('one');
        const marker = read({ type: 'task_complete', turn_id: 'one' }, 110,
            { receivedAt: 110, outcome: 'completed', summary: '', turnId: 'one' });
        expect(marker).toMatchObject({ inputDigest: digest, inputAt: 102, outcome: 'completed' });
        expect(read.openTurn()).toBeUndefined();
    });
    it('does not bind a foreign turn or infer response input without an ACK', () => {
        const read = createCodexTurnProvenance('native', digest);
        read({ type: 'task_started', turn_id: 'one' }, 100); read(user(input, 'other'), 101);
        expect(read.openTurn()).toBeUndefined();
        const unbound = createCodexTurnProvenance('native');
        unbound({ type: 'task_started', turn_id: 'one' }, 100); unbound(user(input), 101);
        expect(unbound.openTurn()).toBeUndefined();
    });
    it('retains legacy event input and classifies actual structured capacity failure', () => {
        const read = createCodexTurnProvenance('native');
        read({ type: 'task_started', turn_id: 'one' }, 100);
        read({ type: 'user_message', message: input }, 101);
        const marker = read({ type: 'task_complete', turn_id: 'one', error: { codex_error_info: 'server_overloaded' } }, 110,
            { receivedAt: 110, outcome: 'completed', summary: '', turnId: 'one' });
        expect(marker).toMatchObject({ outcome: 'failed', providerFailure: 'server_overloaded', inputDigest: digest });
        expect(read.openTurn()).toBeUndefined();
    });
    it('cuts old turn state on task reuse and rejects late foreign terminals', () => {
        const read = createCodexTurnProvenance('native', digest);
        read({ type: 'task_started', turn_id: 'one' }, 100); read(user(input), 101);
        read({ type: 'task_started', turn_id: 'two' }, 200);
        read({ type: 'task_complete', turn_id: 'one' }, 201, { receivedAt: 201, outcome: 'completed', summary: '', turnId: 'one' });
        expect(read.openTurn()).toBeUndefined();
        read(user(input, 'two'), 202); expect(read.openTurn()?.turnId).toBe('two');
        read({ type: 'turn_aborted', turn_id: 'two' }, 203, { receivedAt: 203, outcome: 'aborted', summary: '', turnId: 'two' });
        expect(read.openTurn()).toBeUndefined();
    });
});

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
describe('actual rollout format through both native readers', () => {
    it('carries ACK-bound open/terminal evidence through history normalization and isolates projection by ACK', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-lifecycle-')); directories.push(home);
        const id = '11111111-1111-4111-8111-111111111111';
        const dir = path.join(home, '.codex/sessions'); fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${id}.jsonl`); const start = Date.now() - 10_000;
        const rows = [
            { type: 'session_meta', timestamp: start, payload: { id, cwd: home, timestamp: start } },
            { type: 'event_msg', timestamp: start + 1, payload: { type: 'task_started', turn_id: 'one' } },
            { type: 'response_item', timestamp: start + 2, payload: user('<environment_context>synthetic environment</environment_context>') },
            { type: 'response_item', timestamp: start + 3, payload: user(input) },
            { type: 'response_item', timestamp: start + 4, payload: { type: 'custom_tool_call_output', output: [{ type: 'input_text', text: 'Script completed' }, { type: 'input_text', text: '{"session_id":7}' }] } },
        ];
        const write = () => fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n'); write();
        const cfg = { source: { kind: 'jsonl' as const, path: dir, file_pattern: '*.jsonl', session_id_from: 'filename_uuid' as const,
            message_filter: { where: "$.type == 'response_item' && $.payload.type == 'message'" },
            message_map: { role: '$.payload.role', content: '$.payload.content[0].text', timestamp_ms: '$.timestamp' } } };
        const args = { agentType: 'codex-cli', providerSessionId: id, sessionId: id, workspace: home, acknowledgedInputDigest: digest };
        const history = () => readProviderChatHistory('codex-cli', { historySessionId: id, workspace: home,
            canonicalHistory: { scripts: { readSession: 'readNativeHistory' } } as any,
            scripts: { readNativeHistory: createNativeHistoryDispatcher('codex-cli') },
            envOverrides: { HOME: home }, acknowledgedInputDigest: digest });
        expect(readSession(file, undefined, digest)?.codexOpenTurn).toMatchObject({ inputDigest: digest, turnId: 'one' });
        expect(history().codexOpenTurn).toMatchObject({ inputDigest: digest, turnId: 'one' });
        expect(executeNativeHistory(cfg, args)?.codexOpenTurn).toMatchObject({ inputDigest: digest, turnId: 'one' });
        expect(executeNativeHistory(cfg, { ...args, acknowledgedInputDigest: 'other' })?.codexOpenTurn).toBeUndefined();
        rows.push({ type: 'event_msg', timestamp: start + 5, payload: { type: 'task_complete', turn_id: 'one', error: { codex_error_info: 'server_overloaded' } } } as any); write();
        for (const result of [readSession(file, undefined, digest), history(), executeNativeHistory(cfg, args)]) {
            expect(result?.codexOpenTurn).toBeUndefined();
            expect(result?.turnTerminalMarkers).toMatchObject([{ turnId: 'one', inputDigest: digest, outcome: 'failed', providerFailure: 'server_overloaded' }]);
        }
    });
});
