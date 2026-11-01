/**
 * Post-restart transcript recovery for kimi, cursor-cli and opencode (the
 * codex equivalent lives in native-history-codex-restart-recovery.test.ts).
 * "Restart" = fresh sent-prompt/claim registries and a spawn floor of NOW, with
 * transcripts hours old; only the persisted per-instance input history remains.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeNativeHistory } from '../../../src/providers/spec/native-history-executor.js';
import { __resetSentPromptRegistry } from '../../../src/providers/native-history/sent-prompt-registry.js';
import {
    __resetTranscriptClaimRegistry, claimTranscript, transcriptClaimOwnerToken,
} from '../../../src/providers/native-history/transcript-claim-registry.js';
import { __resetRestartRecoveryForTest } from '../../../src/providers/spec/native-history-restart-recovery.js';
import { __clearGlobCacheForTest, claimKeyForPath } from '../../../src/providers/spec/native-history-paths.js';
import { loadBetterSqlite3 } from '../../../src/system/load-better-sqlite3.js';

const PROMPT = 'Independent review of the staged build script, read only, report verdict in chat.';
let tmp = '';
let ws = '';
let prevCfg: string | undefined;
let prevHome: string | undefined;

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-recovery-'));
    prevCfg = process.env.ADHDEV_CONFIG_DIR; process.env.ADHDEV_CONFIG_DIR = path.join(tmp, 'cfg');
    prevHome = process.env.HOME; process.env.HOME = tmp;
    ws = path.join(tmp, 'ws'); fs.mkdirSync(ws, { recursive: true }); ws = fs.realpathSync(ws);
    __resetSentPromptRegistry(); __resetTranscriptClaimRegistry(); __resetRestartRecoveryForTest(); __clearGlobCacheForTest();
});
afterEach(() => {
    if (prevCfg === undefined) delete process.env.ADHDEV_CONFIG_DIR; else process.env.ADHDEV_CONFIG_DIR = prevCfg;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
});

function history(agentType: string, instance: string, at: number, text: string): void {
    const dir = path.join(tmp, 'cfg', 'history', agentType); fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${instance}_2026-01-01.jsonl`),
        JSON.stringify({ ts: new Date(at).toISOString(), receivedAt: at, role: 'user', content: text, instanceId: instance }) + '\n');
}
const aged = (p: string) => { const t = new Date(Date.now() - 2 * 3_600_000); fs.utimesSync(p, t, t); };
const started = () => Date.now() - 3 * 3_600_000;

// ── kimi ────────────────────────────────────────────────────────────────────
const KIMI = (root: string): any => ({
    kind: 'jsonl', path: `${root}/*/session_*/agents/main`, file_pattern: 'wire.jsonl', session_id_from: 'dir_uuid',
    workspace_from_sidecar: { rel_path: '../../state.json', workspace_path: '$.workDir || $.cwd' },
    records: [
        { where: '$.type == "turn.prompt"', message_map: { role: 'user', content: '$.input', timestamp_ms: '$.time' } },
        { where: '$.type == "context.append_loop_event" && $.event.type == "content.part" && $.event.part.type == "text"',
            message_map: { role: 'assistant', content: '$.event.part.text', timestamp_ms: '$.time' } },
    ],
});
function kimiSession(uuid: string, workDir: string, at: number, prompt: string): string {
    const dir = path.join(tmp, 'kimi', 'wd_x_abcdef123456', `session_${uuid}`);
    fs.mkdirSync(path.join(dir, 'agents', 'main'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ workDir }));
    const wire = path.join(dir, 'agents', 'main', 'wire.jsonl');
    fs.writeFileSync(wire, [
        { type: 'turn.prompt', input: [{ type: 'text', text: prompt }], time: at },
        { type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: 'verdict: ok' } }, time: at + 500 },
    ].map(r => JSON.stringify(r)).join('\n') + '\n');
    aged(wire);
    return wire;
}
describe('kimi restart recovery', () => {
    const read = (instanceId = 'k1') => executeNativeHistory({ source: KIMI(path.join(tmp, 'kimi')) } as any,
        { agentType: 'kimi', workspace: ws, instanceId, sessionStartedAtMs: Date.now() } as any);
    const U1 = 'ba1a3c5c-0ad8-48e5-9f49-3feaa9c449b6';

    it('maps the wire whose first prompt equals the first persisted input', () => {
        const at = started(); history('kimi', 'k1', at + 3000, PROMPT);
        kimiSession(U1, ws, at + 4000, PROMPT);
        const r = read();
        expect(r?.providerSessionId).toBe(U1);
        expect(r?.ownerConfirmed).toBe(true);
        expect(r?.messages.some(m => m.role === 'assistant' && m.content === 'verdict: ok')).toBe(true);
    });
    it('fails closed: no persisted evidence, two candidates, sibling same input, wrong cwd, claim taken', () => {
        const at = started();
        kimiSession(U1, ws, at + 4000, PROMPT);
        expect(read()).toBeNull();                                   // no persisted evidence
        history('kimi', 'k1', at + 3000, PROMPT);
        history('kimi', 'k2', at + 3500, PROMPT);
        expect(read()).toBeNull();                                   // sibling persisted the same first input
        fs.rmSync(path.join(tmp, 'cfg', 'history', 'kimi', 'k2_2026-01-01.jsonl'));
        __resetRestartRecoveryForTest(); __clearGlobCacheForTest();
        kimiSession('cc225d6d-1be9-59f6-a05a-4ffbb0d550c7', ws, at + 5000, PROMPT);
        expect(read()).toBeNull();                                   // two candidates
    });
    it('rejects wrong cwd and taken claim', () => {
        const at = started(); history('kimi', 'k1', at + 3000, PROMPT);
        kimiSession(U1, path.join(tmp, 'elsewhere'), at + 4000, PROMPT);
        expect(read()).toBeNull();
        __resetRestartRecoveryForTest(); __clearGlobCacheForTest();
        const wire = kimiSession('cc225d6d-1be9-59f6-a05a-4ffbb0d550c7', ws, at + 4000, PROMPT);
        claimTranscript(claimKeyForPath(wire), transcriptClaimOwnerToken('someone-else'));
        expect(read()).toBeNull();
    });
});

// ── cursor-cli ──────────────────────────────────────────────────────────────
const CURSOR = (root: string): any => ({
    kind: 'jsonl', path: `${root}/*/agent-transcripts/*`, file_pattern: '*.jsonl', recent_window_ms: 86_400_000,
    session_id_from: 'filename_uuid', workspace_from_input: true,
    message_map: { role: '$.role', content: '$.message.content', content_strip: ['timestamp'], content_unwrap: ['user_query'], tools: {} },
});
function cursorTranscript(id: string, workspace: string, prompt: string): string {
    const slug = workspace.replace(/^\/+/, '').replace(/[^A-Za-z0-9_-]/g, '-').replace(/-{2,}/g, '-');
    const dir = path.join(tmp, 'cursor', slug, 'agent-transcripts', id); fs.mkdirSync(dir, { recursive: true });
    const rec = (role: string, text: string) => JSON.stringify({ role, message: { content: [{ type: 'text', text }] } });
    const f = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(f, [
        rec('user', `<timestamp>Friday, Oct 30, 2026, 10:57 PM (UTC+9)</timestamp>\n<user_query>\n${prompt}\n</user_query>`),
        rec('assistant', 'verdict: ok'),
    ].join('\n') + '\n');
    aged(f);
    return f;
}
describe('cursor-cli restart recovery', () => {
    const read = (instanceId = 'c1') => executeNativeHistory({ source: CURSOR(path.join(tmp, 'cursor')) } as any,
        { agentType: 'cursor-cli', workspace: ws, instanceId, sessionStartedAtMs: Date.now() } as any);
    const U1 = '4d6f86df-6593-41e9-adc6-6eba271af8e8';

    it('maps the transcript whose first user message equals the first persisted input', () => {
        const at = started(); history('cursor-cli', 'c1', at, PROMPT);
        cursorTranscript(U1, ws, PROMPT);
        const r = read();
        expect(r?.providerSessionId).toBe(U1);
        expect(r?.ownerConfirmed).toBe(true);
        expect(r?.messages.some(m => m.role === 'assistant' && m.content === 'verdict: ok')).toBe(true);
    });
    it('fails closed: no evidence, sibling same input, two candidates', () => {
        const at = started();
        cursorTranscript(U1, ws, PROMPT);
        expect(read()).toBeNull();
        history('cursor-cli', 'c1', at, PROMPT); history('cursor-cli', 'c2', at + 500, PROMPT);
        expect(read()).toBeNull();
        fs.rmSync(path.join(tmp, 'cfg', 'history', 'cursor-cli', 'c2_2026-01-01.jsonl'));
        __resetRestartRecoveryForTest(); __clearGlobCacheForTest();
        cursorTranscript('11111111-1111-4111-8111-111111111111', ws, PROMPT);
        expect(read()).toBeNull();
    });
    it('rejects wrong workspace, partial input and taken claim', () => {
        const at = started(); history('cursor-cli', 'c1', at, PROMPT);
        cursorTranscript(U1, path.join(tmp, 'other-ws'), PROMPT);
        cursorTranscript('22222222-2222-4222-8222-222222222222', ws, `prefix ${PROMPT} suffix`);
        expect(read()).toBeNull();
        __resetRestartRecoveryForTest(); __clearGlobCacheForTest();
        const f = cursorTranscript('33333333-3333-4333-8333-333333333333', ws, PROMPT);
        claimTranscript(claimKeyForPath(f), transcriptClaimOwnerToken('someone-else'));
        expect(read()).toBeNull();
    });
});

// ── opencode (sqlite) ───────────────────────────────────────────────────────
const OPENCODE = (db: string): any => ({
    kind: 'sqlite', path: db,
    session_query: "SELECT id FROM session WHERE (@workspace = '' OR directory = @workspace) AND time_updated >= (@floor - 2) * 1000 ORDER BY time_updated DESC LIMIT 5",
    list_query: 'SELECT id, title, directory AS workspace, time_created AS first_at, time_updated AS last_at, (SELECT count(*) FROM message m WHERE m.session_id = session.id) AS message_count FROM session ORDER BY time_updated DESC',
    message_query: "SELECT json_extract(m.data, '$.role') AS role, COALESCE(group_concat(CASE WHEN json_extract(p.data, '$.type') = 'text' THEN json_extract(p.data, '$.text') ELSE NULL END, ''), '') AS content, (SELECT directory FROM session WHERE id = m.session_id) AS workspace, m.time_created AS timestamp_ms FROM message m LEFT JOIN part p ON p.message_id = m.id AND json_extract(p.data, '$.type') IN ('text', 'reasoning') WHERE m.session_id = ? GROUP BY m.id HAVING content IS NOT NULL AND content != '' ORDER BY m.time_created",
    message_map: { role: '$.role', content: '$.content', workspace: '$.workspace', timestamp_ms: '$.timestamp_ms' },
});
function openDb(): { db: any; file: string } {
    const file = path.join(tmp, 'opencode.db');
    const db = new (loadBetterSqlite3())(file);
    db.exec('CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER);'
        + 'CREATE TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);'
        + 'CREATE TABLE IF NOT EXISTS part (id TEXT PRIMARY KEY, message_id TEXT, data TEXT);');
    return { db, file };
}
function ocSession(db: any, id: string, directory: string, at: number, prompt: string): void {
    db.prepare('INSERT INTO session VALUES (?,?,?,?,?)').run(id, 't', directory, at, at + 60_000);
    for (const [i, [role, text]] of ([['user', prompt], ['assistant', 'verdict: ok']] as const).entries()) {
        const mid = `${id}_m${i}`;
        db.prepare('INSERT INTO message VALUES (?,?,?,?)').run(mid, id, at + 1000 * (i + 1), JSON.stringify({ role }));
        db.prepare('INSERT INTO part VALUES (?,?,?)').run(`${mid}_p`, mid, JSON.stringify({ type: 'text', text }));
    }
}
describe('opencode restart recovery', () => {
    let h: { db: any; file: string };
    beforeEach(() => { h = openDb(); });
    afterEach(() => { try { h.db.close(); } catch { /* ignore */ } });
    const read = (instanceId = 'o1') => executeNativeHistory({ source: OPENCODE(h.file) } as any,
        { agentType: 'opencode', workspace: ws, instanceId, sessionStartedAtMs: Date.now() } as any);

    it('maps the idle session whose first user message equals the first persisted input', () => {
        const at = started(); history('opencode', 'o1', at + 2000, PROMPT);
        ocSession(h.db, 'ses_aaa', ws, at, PROMPT);
        const r = read();
        expect(r?.providerSessionId).toBe('ses_aaa');
        expect(r?.ownerConfirmed).toBe(true);
        expect(r?.messages.some(m => m.role === 'assistant' && m.content === 'verdict: ok')).toBe(true);
    });
    it('fails closed: no evidence, sibling same input, two candidates', () => {
        const at = started();
        ocSession(h.db, 'ses_aaa', ws, at, PROMPT);
        expect(read()).toBeNull();
        history('opencode', 'o1', at + 2000, PROMPT); history('opencode', 'o2', at + 2500, PROMPT);
        expect(read()).toBeNull();
        fs.rmSync(path.join(tmp, 'cfg', 'history', 'opencode', 'o2_2026-01-01.jsonl'));
        __resetRestartRecoveryForTest();
        ocSession(h.db, 'ses_bbb', ws, at + 1000, PROMPT);
        expect(read()).toBeNull();
    });
    it('rejects wrong directory, partial input and taken claim', () => {
        const at = started(); history('opencode', 'o1', at + 2000, PROMPT);
        ocSession(h.db, 'ses_other', path.join(tmp, 'other'), at, PROMPT);
        ocSession(h.db, 'ses_part', ws, at, `prefix ${PROMPT} suffix`);
        expect(read()).toBeNull();
        __resetRestartRecoveryForTest();
        ocSession(h.db, 'ses_ccc', ws, at, PROMPT);
        claimTranscript(`${h.file}#ses_ccc`, transcriptClaimOwnerToken('someone-else'));
        expect(read()).toBeNull();
    });
});

// ── the persisted pin (exact bind) wins over recovery, with no input history at all ──
describe('persisted provider session pin is consulted first', () => {
    it('kimi / cursor-cli / opencode exact-bind on providerSessionId after a restart', () => {
        const at = started();
        const U = 'ba1a3c5c-0ad8-48e5-9f49-3feaa9c449b6';
        kimiSession(U, ws, at, PROMPT);
        const k = executeNativeHistory({ source: KIMI(path.join(tmp, 'kimi')) } as any,
            { agentType: 'kimi', workspace: ws, instanceId: 'k9', sessionStartedAtMs: Date.now(), providerSessionId: U } as any);
        expect(k?.providerSessionId).toBe(U);
        const CU = '4d6f86df-6593-41e9-adc6-6eba271af8e8';
        cursorTranscript(CU, ws, PROMPT);
        const c = executeNativeHistory({ source: CURSOR(path.join(tmp, 'cursor')) } as any,
            { agentType: 'cursor-cli', workspace: ws, instanceId: 'c9', sessionStartedAtMs: Date.now(), providerSessionId: CU } as any);
        expect(c?.providerSessionId).toBe(CU);
        const h = openDb();
        try {
            ocSession(h.db, 'ses_pin', ws, at, PROMPT);
            const o = executeNativeHistory({ source: OPENCODE(h.file) } as any,
                { agentType: 'opencode', workspace: ws, instanceId: 'o9', sessionStartedAtMs: Date.now(), providerSessionId: 'ses_pin' } as any);
            expect(o?.providerSessionId).toBe('ses_pin');
        } finally { h.db.close(); }
    });
});
