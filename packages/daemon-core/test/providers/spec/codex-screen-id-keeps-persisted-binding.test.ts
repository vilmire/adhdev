/**
 * After a daemon restart the codex status line can print a thread uuid that differs
 * from the persisted binding (resume/compaction thread, or a thread with no turn
 * yet). The spec adapter used to adopt it blindly, rebinding the session to a
 * rollout with no history, so read_chat returned `messages: []`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractProviderSessionIdFromScreen, __resetCodexScreenIdDecisionsForTest } from '../../../src/providers/spec/spec-adapter-screen-reads.js';

const OLD_ID = '0195aaaa-1111-7222-8333-444455556666';
const NEW_ID = '01a1ba63-1111-7222-8333-444455556666';
const OTHER_ID = '0195bbbb-1111-7222-8333-444455556666';

let home = '';
let prevHome: string | undefined;

function rollout(id: string, withTurn: boolean, ts = '2026-11-01T10:00:00.000Z') {
    const dir = path.join(home, '.codex', 'sessions', '2026', '11', '01');
    fs.mkdirSync(dir, { recursive: true });
    const rows: object[] = [{ timestamp: ts, type: 'session_meta', payload: { id, cwd: '/ws', timestamp: ts } }];
    if (withTurn) {
        rows.push({ timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] } });
        rows.push({ timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] } });
    }
    fs.writeFileSync(path.join(dir, `rollout-2026-11-01T10-00-00-${id}.jsonl`), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}
const driver = (id: string) => ({ snapshot: () => `gpt-5 · high · ${id}\n` }) as any;

beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-screen-id-'));
    prevHome = process.env.HOME;
    process.env.HOME = home;
    __resetCodexScreenIdDecisionsForTest();
});
afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
});

describe('codex screen thread id vs persisted binding', () => {
    it('keeps the persisted id when its rollout has history and the screen id has none', () => {
        rollout(OLD_ID, true);
        rollout(NEW_ID, false);
        expect(extractProviderSessionIdFromScreen(driver(NEW_ID), 'codex-cli', OLD_ID)).toBe(OLD_ID);
    });

    it('does not adopt a newer unrelated rollout of another session in the same workspace', () => {
        rollout(OLD_ID, true);
        rollout(OTHER_ID, false, '2026-11-01T11:00:00.000Z');
        expect(extractProviderSessionIdFromScreen(driver(OTHER_ID), 'codex-cli', OLD_ID)).toBe(OLD_ID);
    });

    it('adopts the screen id when its rollout has history (genuine thread switch)', () => {
        rollout(OLD_ID, true);
        rollout(NEW_ID, true);
        expect(extractProviderSessionIdFromScreen(driver(NEW_ID), 'codex-cli', OLD_ID)).toBe(NEW_ID);
    });

    it('adopts the screen id when the persisted rollout is gone or no id is bound yet', () => {
        rollout(NEW_ID, false);
        expect(extractProviderSessionIdFromScreen(driver(NEW_ID), 'codex-cli', OLD_ID)).toBe(NEW_ID);
        expect(extractProviderSessionIdFromScreen(driver(NEW_ID), 'codex-cli', undefined)).toBe(NEW_ID);
    });
});
