/**
 * Cursor-agent nativeHistory (JSONL) — CURSOR-PROMPT-ECHO-DOUBLECLASSIFY-RCA.
 *
 * Root fix for the duplicate CURSOR-AGENT bubble: cursor uses PTY as the
 * transcript authority, so the echoed user prompt could be re-classified as an
 * assistant bubble on a PTY path the static-frame parser doesn't exercise (a
 * mid-render partial frame). cursor-agent also writes a clean, structured JSONL
 * transcript at `~/.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl`
 * (role user/assistant + Anthropic `message.content[]` blocks, turns cleanly
 * separated). Reading THAT as `transcriptAuthority:"provider"` makes the
 * double-classification structurally impossible — a user turn is a `role:"user"`
 * record and can never become an assistant bubble.
 *
 * These tests drive the declarative jsonl executor with the SAME `source` block
 * the shipped cursor-cli provider.v1.json ships, against a fixture that mirrors
 * the real on-disk shape (validated live on-machine). They assert:
 *   (a) the user turn is classified user (prompt text cleaned of the
 *       <timestamp>/<user_query> wrapper),
 *   (b) the echoed prompt does NOT produce a second assistant bubble,
 *   (c) a real assistant reply IS classified assistant,
 *   (d) tool_use blocks surface as assistant/tool bubbles,
 *   (e) the first-turn workspace-only read (no provider session id yet) still
 *       resolves + stamps the workspace so hasSafeNativeHistoryMapping can accept
 *       it and the daemon can pin the discovered session id,
 *   (f) a mismatched workspace is NOT stamped (no cross-workspace aliasing).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeNativeHistory } from '../../../src/providers/spec/native-history-executor.js';

// The shipped cursor-cli nativeHistory.source (kept in sync with
// adhdev-providers/cli/cursor-cli/provider.v1.json).
const CURSOR_SOURCE = {
    kind: 'jsonl' as const,
    path: '{PROJECTS}/*/agent-transcripts/*',
    file_pattern: '*.jsonl',
    session_id_from: 'filename_uuid' as const,
    workspace_from_input: true,
    message_map: {
        role: '$.role',
        content: '$.message.content',
        content_strip: ['timestamp'],
        content_unwrap: ['user_query'],
        tools: {},
    },
};

let tmpDir = '';
let projectsDir = '';
const SESSION_ID = '8c6cf338-ef5c-4df5-91a5-66c1e2ed4339';
const WORKSPACE = '/Users/example/Work/myrepo';

/** cursor's on-disk project slug: realpath, leading '/' dropped, non-alnum → '-'. */
function cursorSlug(ws: string): string {
    return ws.replace(/^\/+/, '').replace(/[^A-Za-z0-9_-]/g, '-');
}

function writeTranscript(sessionId: string, workspace: string, mtimeMs?: number): string {
    const slug = cursorSlug(workspace);
    const dir = path.join(projectsDir, slug, 'agent-transcripts', sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const fixture = fs.readFileSync(
        new URL('./fixtures/cursor-agent-transcript.jsonl', import.meta.url), 'utf8');
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(filePath, fixture, 'utf8');
    if (typeof mtimeMs === 'number') {
        const sec = mtimeMs / 1000;
        fs.utimesSync(filePath, sec, sec);
    }
    return filePath;
}

function run(input: any) {
    const src = { ...CURSOR_SOURCE, path: CURSOR_SOURCE.path.replace('{PROJECTS}', projectsDir) };
    return executeNativeHistory({ source: src } as any, input);
}

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-nh-'));
    projectsDir = path.join(tmpDir, '.cursor', 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
});

afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('cursor nativeHistory jsonl', () => {
    it('resolves by session id and separates user/assistant with no echo leak', () => {
        writeTranscript(SESSION_ID, WORKSPACE);
        const r = run({ providerSessionId: SESSION_ID, workspace: WORKSPACE, sessionStartedAtMs: 0 });
        expect(r).not.toBeNull();
        const user = r!.messages.filter((m: any) => m.role === 'user');
        const assistantText = r!.messages.filter((m: any) => m.role === 'assistant' && m.kind !== 'tool');

        // (a) user turn is user, prompt cleaned of the <timestamp>/<user_query> wrapper.
        expect(user).toHaveLength(1);
        expect(user[0].content).toBe('커서 테스트');
        expect(user[0].content).not.toContain('<user_query>');
        expect(user[0].content).not.toContain('timestamp');

        // (b) the echoed prompt never appears in an assistant bubble.
        expect(assistantText.some((m: any) => m.content.includes('커서 테스트'))).toBe(false);

        // (c) the real assistant reply IS classified assistant.
        expect(assistantText.some((m: any) => m.content.includes('CURSOR OK 2+2=4'))).toBe(true);

        // exactly one user bubble, no duplicate.
        expect(user.filter((m: any) => m.content === '커서 테스트')).toHaveLength(1);
    });

    it('surfaces tool_use blocks as assistant/tool bubbles', () => {
        writeTranscript(SESSION_ID, WORKSPACE);
        const r = run({ providerSessionId: SESSION_ID, workspace: WORKSPACE, sessionStartedAtMs: 0 });
        const tools = r!.messages.filter((m: any) => m.kind === 'tool');
        expect(tools).toHaveLength(1);
        expect(tools[0].role).toBe('assistant');
        expect(tools[0].content).toContain('ApplyPatch');
    });

    it('drops the turn_ended record (no stray system bubble)', () => {
        writeTranscript(SESSION_ID, WORKSPACE);
        const r = run({ providerSessionId: SESSION_ID, workspace: WORKSPACE, sessionStartedAtMs: 0 });
        expect(r!.messages.every((m: any) => m.role === 'user' || m.role === 'assistant')).toBe(true);
    });

    it('first-turn workspace-only read (no session id yet) resolves + stamps the workspace', () => {
        // Before the daemon captures cursor's self-allocated session id, the read
        // is workspace-scoped. The file must still resolve and every message must
        // carry the workspace so hasSafeNativeHistoryMapping accepts it and the
        // discovered id can be pinned for subsequent exact-match reads.
        writeTranscript(SESSION_ID, WORKSPACE, Date.now());
        const r = run({ workspace: WORKSPACE, sessionStartedAtMs: 0 });
        expect(r).not.toBeNull();
        expect(r!.providerSessionId).toBe(SESSION_ID);
        expect(r!.workspace).toBe(WORKSPACE);
        expect(r!.messages.every((m: any) => m.workspace === WORKSPACE)).toBe(true);
    });

    it('does not stamp a mismatched workspace (no cross-workspace aliasing)', () => {
        // The exact-session file still resolves by uuid, but because the file does
        // not live under the requested workspace's slug the workspace must stay
        // unset — the downstream guard then fails closed instead of aliasing.
        writeTranscript(SESSION_ID, WORKSPACE);
        const r = run({ providerSessionId: SESSION_ID, workspace: '/Users/example/other/repo', sessionStartedAtMs: 0 });
        expect(r).not.toBeNull();
        expect(r!.workspace).toBeUndefined();
        expect(r!.messages.every((m: any) => m.workspace === undefined)).toBe(true);
    });
});
