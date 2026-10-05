/**
 * A codex turn that ends on a provider error ("Selected model is at capacity")
 * writes task_complete with `last_agent_message: null` and an `error` object.
 * The reader dropped it, so the dashboard showed a silent idle session and the
 * user never learned the turn failed (2026-10-05 provider matrix).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { readSession } from '../../../src/providers/native-history/codex-cli-transcript.js';

const ID = '01a10b98-2821-73f3-8703-cb303c4c739b';
let dir = '';
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

function rollout(lines: object[]): string {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-err-'));
    const file = path.join(dir, `rollout-2026-10-05T19-24-43-${ID}.jsonl`);
    fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    return file;
}

describe('codex rollout — turn ended on an error', () => {
    it('surfaces task_complete.error as the turn reply', () => {
        const file = rollout([
            { timestamp: '2026-10-05T10:24:45.000Z', type: 'session_meta', payload: { id: ID, cwd: '/tmp/ws' } },
            { timestamp: '2026-10-05T10:24:46.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Provider check run' }] } },
            { timestamp: '2026-10-05T10:24:48.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', last_agent_message: null, error: { message: 'Selected model is at capacity. Please try a different model.', codex_error_info: 'server_overloaded' } } },
        ]);
        const session = readSession(file);
        const assistant = session!.messages.filter(m => m.role === 'assistant');
        expect(assistant.map(m => m.content)).toEqual(['⚠️ Selected model is at capacity. Please try a different model.']);
    });

    it('keeps the agent message when the turn completed normally', () => {
        const file = rollout([
            { timestamp: '2026-10-05T10:24:45.000Z', type: 'session_meta', payload: { id: ID, cwd: '/tmp/ws' } },
            { timestamp: '2026-10-05T10:24:46.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } },
            { timestamp: '2026-10-05T10:24:48.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', last_agent_message: 'hello' } },
        ]);
        expect(readSession(file)!.messages.filter(m => m.role === 'assistant').map(m => m.content)).toEqual(['hello']);
    });
});
