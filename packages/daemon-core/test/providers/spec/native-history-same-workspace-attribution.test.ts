/**
 * Two live sessions of a provider that exposes no session id up front (cursor's
 * agent-transcripts jsonl, opencode's sqlite) in ONE workspace used to bind to
 * the same conversation: the newest file/row won for both readers, so each
 * dashboard showed the other's answers and the binding pinned the wrong id
 * (2026-10-05 provider matrix: both cursor sessions showed "391", both opencode
 * sessions "399").
 *
 * Attribution now follows content evidence — the transcript containing a prompt
 * THIS session sent is its own (claimed); another session's claimed transcript
 * is never picked; no evidence resolves nothing instead of borrowing.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeNativeHistory } from '../../../src/providers/spec/native-history-executor.js';
import { loadBetterSqlite3 } from '../../../src/system/load-better-sqlite3.js';
import { __resetTranscriptClaimRegistry } from '../../../src/providers/native-history/transcript-claim-registry.js';
import { __resetSentPromptRegistry, recordSentPrompt } from '../../../src/providers/native-history/sent-prompt-registry.js';

const WORKSPACE = '/Users/example/Work/myrepo';
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const PROMPT_A = 'What is 17 times 23? Reply with only the number.';
const PROMPT_B = 'What is 19 times 21? Reply with only the number.';

let tmpDir = '';

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'same-ws-attr-'));
    __resetTranscriptClaimRegistry();
    __resetSentPromptRegistry();
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    __resetTranscriptClaimRegistry();
    __resetSentPromptRegistry();
});

describe('cursor (jsonl, no session id) — same-workspace sessions', () => {
    let projectsDir = '';
    const cfg = () => ({
        source: {
            kind: 'jsonl' as const,
            path: `${projectsDir}/*/agent-transcripts/*`,
            file_pattern: '*.jsonl',
            session_id_from: 'filename_uuid' as const,
            workspace_from_input: true,
            message_map: { role: '$.role', content: '$.message.content', content_strip: ['timestamp'], content_unwrap: ['user_query'], tools: {} },
        },
    });
    function writeTranscript(id: string, prompt: string, answer: string, mtimeMs: number): void {
        const dir = path.join(projectsDir, WORKSPACE.replace(/^\/+/, '').replace(/[^A-Za-z0-9_-]/g, '-'), 'agent-transcripts', id);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${id}.jsonl`);
        fs.writeFileSync(file, [
            JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: `<timestamp>now</timestamp>\n<user_query>\n${prompt}\n</user_query>` }] } }),
            JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: answer }] } }),
        ].join('\n') + '\n');
        fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
    }
    const read = (instanceId: string) => executeNativeHistory(cfg() as any, { agentType: 'cursor-cli', instanceId, workspace: WORKSPACE, sessionStartedAtMs: 0 });

    beforeEach(() => {
        projectsDir = path.join(tmpDir, 'projects');
        fs.mkdirSync(projectsDir, { recursive: true });
    });

    it('each session reads its own transcript even when the sibling\'s is newer', () => {
        const now = Date.now();
        writeTranscript(ID_A, PROMPT_A, '391', now - 2000);
        writeTranscript(ID_B, PROMPT_B, '399', now - 1000);
        recordSentPrompt('sess-a', PROMPT_A);
        recordSentPrompt('sess-b', PROMPT_B);

        const a = read('sess-a');
        const b = read('sess-b');
        expect(a?.providerSessionId).toBe(ID_A);
        expect(a?.messages.map(m => m.content)).toContain('391');
        expect(a?.ownerConfirmed).toBe(true);
        expect(b?.providerSessionId).toBe(ID_B);
        expect(b?.messages.map(m => m.content)).toContain('399');
    });

    it('does not borrow the only transcript when it holds none of this session\'s prompts', () => {
        writeTranscript(ID_A, PROMPT_A, '391', Date.now());
        recordSentPrompt('sess-b', PROMPT_B);
        expect(read('sess-b')).toBeNull();
    });

    it('keeps the legacy newest pick for a session with no recorded prompts', () => {
        writeTranscript(ID_A, PROMPT_A, '391', Date.now());
        expect(read('restored-session')?.providerSessionId).toBe(ID_A);
    });

    it('never hands a recency reader a transcript another live session claimed', () => {
        const now = Date.now();
        writeTranscript(ID_A, PROMPT_A, '391', now);
        recordSentPrompt('sess-a', PROMPT_A);
        expect(read('sess-a')?.providerSessionId).toBe(ID_A);
        // A restored sibling with no prompt history must not alias A's transcript.
        expect(read('restored-session')).toBeNull();
    });
});

describe('opencode (sqlite, no session id) — same-workspace sessions', () => {
    let dbPath = '';
    const NOW_MS = 1_784_090_000_000;
    const cfg = () => ({
        source: {
            kind: 'sqlite' as const,
            path: dbPath,
            session_query: "SELECT id FROM session WHERE (@workspace = '' OR directory = @workspace) AND time_updated >= (@floor - 2) * 1000 ORDER BY time_updated DESC LIMIT 5",
            message_query: "SELECT json_extract(m.data, '$.role') AS role, group_concat(CASE WHEN json_extract(p.data, '$.type') = 'text' THEN json_extract(p.data, '$.text') ELSE NULL END, '') AS content, (SELECT directory FROM session WHERE id = m.session_id) AS workspace, m.time_created AS timestamp_ms FROM message m JOIN part p ON p.message_id = m.id WHERE m.session_id = ? AND json_extract(p.data, '$.type') IN ('text', 'reasoning') GROUP BY m.id HAVING content IS NOT NULL AND content != '' ORDER BY m.time_created",
            message_map: { role: '$.role', content: '$.content', workspace: '$.workspace', timestamp_ms: '$.timestamp_ms' },
        },
    });
    const read = (instanceId: string) => executeNativeHistory(cfg() as any, { agentType: 'opencode', instanceId, workspace: WORKSPACE, sessionStartedAtMs: NOW_MS });

    beforeEach(() => {
        dbPath = path.join(tmpDir, 'opencode.db');
        const Database = loadBetterSqlite3();
        const db = new Database(dbPath);
        db.exec(`
            CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
            CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
            CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, data TEXT NOT NULL);
        `);
        const add = (sid: string, updated: number, prompt: string, answer: string) => {
            db.prepare('INSERT INTO session VALUES (?, ?, ?, ?)').run(sid, WORKSPACE, NOW_MS, updated);
            for (const [i, role, text] of [[1, 'user', prompt], [2, 'assistant', answer]] as const) {
                db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(`m_${sid}_${i}`, sid, NOW_MS + i, JSON.stringify({ role }));
                db.prepare('INSERT INTO part VALUES (?, ?, ?, ?)').run(`p_${sid}_${i}`, `m_${sid}_${i}`, sid, JSON.stringify({ type: 'text', text }));
            }
        };
        add('ses_A', NOW_MS + 1_000, PROMPT_A, '391');
        add('ses_B', NOW_MS + 2_000, PROMPT_B, '399');
        db.close();
    });

    it('each session binds its own row even when the sibling\'s is newer', () => {
        recordSentPrompt('sess-a', PROMPT_A);
        recordSentPrompt('sess-b', PROMPT_B);
        expect(read('sess-a')?.providerSessionId).toBe('ses_A');
        expect(read('sess-b')?.providerSessionId).toBe('ses_B');
    });

    it('skips a row another live session claimed', () => {
        recordSentPrompt('sess-b', PROMPT_B);
        expect(read('sess-b')?.providerSessionId).toBe('ses_B');
        expect(read('restored-session')?.providerSessionId).toBe('ses_A');
    });
});
