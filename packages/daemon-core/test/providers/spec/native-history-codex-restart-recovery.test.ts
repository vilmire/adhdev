import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeNativeHistory } from '../../../src/providers/spec/native-history-executor.js';
import { __resetSentPromptRegistry } from '../../../src/providers/native-history/sent-prompt-registry.js';
import { __resetTranscriptClaimRegistry } from '../../../src/providers/native-history/transcript-claim-registry.js';
import { __resetCodexRecoveryForTest } from '../../../src/providers/spec/native-history-codex-recovery.js';

let tmp = '';
let prevCfg: string | undefined;
let prevHome: string | undefined;
const PROMPT = 'Independent review of the staged build script, read only, report verdict in chat.';
const cfg: any = { source: { kind: 'jsonl', path: '~/.codex/sessions/{yyyy}/{mm}/{dd}', file_pattern: 'rollout-*.jsonl', session_id_from: 'filename_uuid',
    message_map: { role: '$.payload.role', content: '$.payload.content[0].text', timestamp_ms: '$.timestamp' },
    message_filter: { where: "$.type == 'response_item' && $.payload.type == 'message'" } } };

function dayDir(at: number): string {
    const d = new Date(at);
    return path.join(tmp, '.codex', 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
}
function rollout(id: string, cwd: string, startAt: number, user: string): string {
    const dir = dayDir(startAt); fs.mkdirSync(dir, { recursive: true });
    const iso = (t: number) => new Date(t).toISOString();
    const p = path.join(dir, `rollout-x-${id}.jsonl`);
    const rows = [
        { timestamp: iso(startAt), type: 'session_meta', payload: { id, cwd, timestamp: iso(startAt) } },
        { timestamp: iso(startAt + 1000), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: user }] } },
        { timestamp: iso(startAt + 2000), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'verdict: ok' }] } },
    ];
    fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    const old = new Date(Date.now() - 2 * 3_600_000); fs.utimesSync(p, old, old); // aged past the live window, as after a restart
    return p;
}
function history(instance: string, at: number, text: string): void {
    const dir = path.join(tmp, 'cfg', 'history', 'codex-cli'); fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${instance}_2026-01-01.jsonl`), JSON.stringify({ ts: new Date(at).toISOString(), receivedAt: at, role: 'user', content: text, instanceId: instance }) + '\n');
}

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-recovery-'));
    prevCfg = process.env.ADHDEV_CONFIG_DIR; process.env.ADHDEV_CONFIG_DIR = path.join(tmp, 'cfg');
    prevHome = process.env.HOME; process.env.HOME = tmp;
    __resetSentPromptRegistry(); __resetTranscriptClaimRegistry(); __resetCodexRecoveryForTest();
});
afterEach(() => {
    if (prevCfg === undefined) delete process.env.ADHDEV_CONFIG_DIR; else process.env.ADHDEV_CONFIG_DIR = prevCfg;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('codex restart recovery from persisted inputs', () => {
    const ws = () => { const w = path.join(tmp, 'ws'); fs.mkdirSync(w, { recursive: true }); return fs.realpathSync(w); };
    // Daemon restarted: spawn floor is NOW, registry empty, rollout is hours old.
    const read = (w: string, instanceId = 'w1') => executeNativeHistory(cfg, { agentType: 'codex-cli', workspace: w, instanceId, sessionStartedAtMs: Date.now() } as any);

    it('maps the rollout whose user record equals the first persisted input', () => {
        const w = ws(); const started = Date.now() - 3 * 3_600_000;
        history('w1', started + 4000, PROMPT);
        const p = rollout('01a19460-c05a-7992-9005-8cfc0ad93254', w, started, PROMPT);
        void p;
        const r = read(w);
        expect(r?.providerSessionId).toBe('01a19460-c05a-7992-9005-8cfc0ad93254');
        expect(r?.ownerConfirmed).toBe(true);
        expect(r?.messages.some(m => m.role === 'assistant' && m.content === 'verdict: ok')).toBe(true);
    });
    it('fails closed without persisted evidence and when a sibling persisted the same input', () => {
        const w = ws(); const started = Date.now() - 3_600_000;
        rollout('11111111-1111-4111-8111-111111111111', w, started, PROMPT);
        expect(read(w)).toBeNull();
        history('w1', started + 4000, PROMPT);
        history('w2', started + 5000, PROMPT);
        expect(read(w)).toBeNull();
    });
    it('rejects wrong cwd and partial input', () => {
        const w = ws(); const started = Date.now() - 3_600_000;
        history('w1', started + 4000, PROMPT);
        rollout('22222222-2222-4222-8222-222222222222', path.join(tmp, 'other'), started, PROMPT);
        rollout('33333333-3333-4333-8333-333333333333', w, started, `prefix ${PROMPT} suffix`);
        expect(read(w)).toBeNull();
    });
    it('refuses when two rollouts qualify', () => {
        const w = ws(); const started = Date.now() - 3_600_000;
        history('w1', started + 4000, PROMPT);
        rollout('44444444-4444-4444-8444-444444444444', w, started, PROMPT);
        rollout('55555555-5555-4555-8555-555555555555', w, started + 1000, PROMPT);
        expect(read(w)).toBeNull();
    });
});
