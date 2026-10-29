import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNativeHistoryDispatcher, clearCodexRuntimeBinding } from '../../../src/providers/native-history/dispatcher.js';
import { recordSentPrompt, __resetSentPromptRegistry } from '../../../src/providers/native-history/sent-prompt-registry.js';
const homes: string[] = [];
afterEach(() => { __resetSentPromptRegistry(); clearCodexRuntimeBinding(); for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }); });
function fixture() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-verified-')); homes.push(home);
    const root = path.join(home, '.codex/sessions'); fs.mkdirSync(root, { recursive: true });
    const start = Date.now(); const workspace = path.join(home, 'workspace'); fs.mkdirSync(workspace);
    const read = createNativeHistoryDispatcher('codex-cli');
    const input = { workspace, instanceId: 'owner', sessionStartedAtMs: start, envOverrides: { HOME: home } };
    const write = (id: string, prompt: string) => fs.writeFileSync(path.join(root, `${id}.jsonl`), [
        { type: 'session_meta', timestamp: start, payload: { id, cwd: workspace, timestamp: start } },
        { type: 'response_item', timestamp: start + 1, payload: { type: 'message', role: 'user', content: prompt } },
        { type: 'event_msg', timestamp: start + 2, payload: { type: 'task_complete', turn_id: 'turn', last_agent_message: 'Native final' } },
    ].map(r => JSON.stringify(r)).join('\n'));
    return { home, root, start, workspace, read, input, write };
}
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
describe('Codex verified eventual native discovery', () => {
    it('retries missing history, ignores a sibling, and binds only exclusive full input in the spawned HOME', () => {
        const f = fixture(); recordSentPrompt('owner', 'Distinct complete owner input'); recordSentPrompt('sibling', 'Distinct sibling input');
        expect(f.read(f.input)).toBeNull();
        f.write(B, 'Distinct sibling input'); expect(f.read(f.input)).toBeNull();
        f.write(A, 'Distinct complete owner input');
        expect(f.read(f.input)).toMatchObject({ providerSessionId: A, ownerConfirmed: true });
        expect(f.read({ ...f.input, providerSessionId: B, sessionId: B })?.providerSessionId).toBe(B);
        expect(f.read({ ...f.input, providerSessionId: '33333333-3333-4333-8333-333333333333', sessionId: '33333333-3333-4333-8333-333333333333' })).toBeNull();
    });
    it('rejects shared prompts and multiple matching native sessions rather than picking newest', () => {
        const f = fixture(); recordSentPrompt('owner', 'Shared complete prompt'); recordSentPrompt('sibling', 'Shared complete prompt');
        f.write(A, 'Shared complete prompt'); expect(f.read(f.input)).toBeNull();
        __resetSentPromptRegistry(); recordSentPrompt('owner', 'Unique full prompt');
        f.write(A, 'Unique full prompt'); f.write(B, 'Unique full prompt'); expect(f.read(f.input)).toBeNull();
    });
});

describe('native final entry ordering', () => {
    it.each([false, true])('ingests final_answer with tool completion after=%s without duplicating task_complete', async after => {
        const f = fixture(); const file = path.join(f.root, `${A}.jsonl`);
        const row = (type: string, payload: object, at: number) => JSON.stringify({ type, payload, timestamp: f.start + at });
        const final = row('response_item', { type: 'message', role: 'assistant', phase: 'final_answer', content: 'Native final' }, 4);
        const tool = row('response_item', { type: 'function_call_output', call_id: 'tool', output: 'report_completion result' }, 5);
        fs.writeFileSync(file, [row('session_meta', { id: A, cwd: f.workspace }, 0),
            row('event_msg', { type: 'task_started', turn_id: 'one' }, 1),
            row('response_item', { type: 'message', role: 'user', content: 'First input' }, 2),
            ...(after ? [final, tool] : [tool, final]),
            row('event_msg', { type: 'task_complete', turn_id: 'one', last_agent_message: 'Native final' }, 6),
            row('event_msg', { type: 'task_started', turn_id: 'two' }, 7),
            row('event_msg', { type: 'task_complete', turn_id: 'two', last_agent_message: 'Native final' }, 8),
        ].join('\n'));
        const result = f.read({ ...f.input, sessionId: A, providerSessionId: A });
        expect(result?.messages.filter(m => m.kind === 'standard' && m.role === 'assistant')).toMatchObject([
            { content: 'Native final', bubbleState: 'final' }, { content: 'Native final', bubbleState: 'final' },
        ]);
        expect(result?.messages.filter(m => m.kind === 'tool')).toHaveLength(1);
    });
});
