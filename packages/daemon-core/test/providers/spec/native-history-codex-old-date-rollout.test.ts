/**
 * A long-lived codex session's rollout stays in the date directory of the day it
 * was created. The exact-id lookup only searched today +-2 days, so a coordinator
 * running 3+ days read `native_history_empty` although its rollout was big and
 * current. The id is authoritative: it must be found in any date directory, and a
 * huge rollout must still yield its recent tail.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeNativeHistory } from '../../../src/providers/spec/native-history-executor.js';

const SID = '01a1bad1-dd04-7a91-bd17-45e5478e74fe';
let home = '';
let prevHome: string | undefined;

const cfg = {
    source: {
        kind: 'jsonl', path: '~/.codex/sessions/{yyyy}/{mm}/{dd}', file_pattern: 'rollout-*.jsonl', session_id_from: 'filename_uuid',
        message_filter: { where: "$.type == 'response_item' && $.payload.type == 'message'" },
        message_map: { role: '$.payload.role', content: '$.payload.content[0].text', timestamp_ms: '$.timestamp' },
    },
} as any;

function writeRollout(daysAgo: number, turns: number): string {
    const d = new Date(Date.now() - daysAgo * 86_400_000);
    const dir = path.join(home, '.codex', 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    fs.mkdirSync(dir, { recursive: true });
    const rows: object[] = [{ timestamp: new Date().toISOString(), type: 'session_meta', payload: { id: SID, cwd: '/ws', timestamp: new Date().toISOString() } }];
    for (let i = 0; i < turns; i++) {
        const role = i % 2 ? 'assistant' : 'user';
        rows.push({ timestamp: new Date(Date.now() - (turns - i) * 1000).toISOString(), type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text: `m${i} ${'x'.repeat(200)}` }] } });
    }
    const f = path.join(dir, `rollout-2026-11-08T20-01-18-${SID}.jsonl`);
    fs.writeFileSync(f, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    return f;
}

beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-old-')); prevHome = process.env.HOME; process.env.HOME = home; });
afterEach(() => { if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome; fs.rmSync(home, { recursive: true, force: true }); });

describe('codex rollout lookup by id', () => {
    it('finds a rollout created 3 days ago', () => {
        writeRollout(3, 6);
        const r = executeNativeHistory(cfg, { agentType: 'codex-cli', providerSessionId: SID, workspace: '/ws' } as any);
        expect(r?.messages.length).toBe(6);
        expect(r?.providerSessionId).toBe(SID);
    });
    it('finds a rollout created 40 days ago', () => {
        writeRollout(40, 4);
        const r = executeNativeHistory(cfg, { agentType: 'codex-cli', providerSessionId: SID, workspace: '/ws' } as any);
        expect(r?.messages.length).toBe(4);
    });
    it('returns the recent tail of a large old rollout', () => {
        const f = writeRollout(3, 30000);
        expect(fs.statSync(f).size).toBeGreaterThan(8 * 1024 * 1024);
        const r = executeNativeHistory(cfg, { agentType: 'codex-cli', providerSessionId: SID, workspace: '/ws' } as any);
        expect(r?.messages.length).toBeGreaterThan(0);
        expect(r!.messages[r!.messages.length - 1].content).toContain('m29999');
    });
});
