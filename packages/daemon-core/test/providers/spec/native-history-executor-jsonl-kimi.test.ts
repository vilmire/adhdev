/**
 * Kimi Code nativeHistory (JSONL) — KIMI-MULTITURN-TRANSCRIPT-FLICKER root fix.
 *
 * kimi was the last pure-PTY provider: no nativeHistory, tui.transcriptPty.scope
 * derived the whole transcript from the rendered PTY buffer every read, so a new
 * turn's bufferStart jump momentarily dropped every prior bubble (the observed
 * flicker). The root fix is to read kimi's on-disk transcript as
 * transcriptAuthority:"provider" like cursor/opencode.
 *
 * kimi persists every session at
 *   ~/.kimi-code/sessions/<wdKey>/session_<uuid>/agents/main/wire.jsonl
 * with a two-shape record schema (validated live on-machine):
 *   - user turns:  {type:"turn.prompt", input:[{type:"text",text}], time}
 *   - assistant:   {type:"context.append_loop_event",
 *                   event:{type:"content.part", part:{type:"text"|"think", text|think}}, time}
 * plus non-message records (metadata/config/usage) that must be dropped, and
 * `think` reasoning parts that are NOT user-visible text.
 *
 * The workspace lives ONLY in the sibling `state.json` `workDir` — the wire file
 * carries no session_meta cwd and the `wd_<slug>_<sha12>` dir is irreversible.
 * The session id lives in the `session_<uuid>` DIRECTORY segment (the leaf file
 * is always `wire.jsonl`), so filename-uuid extraction can't capture it.
 *
 * These tests drive the declarative jsonl executor with the SAME `source` block
 * the shipped kimi provider.v1.json ships, against a fixture mirroring the real
 * on-disk layout. They assert:
 *   (a) user turns are user; assistant text turns are assistant,
 *   (b) `think` reasoning parts and non-message records are dropped,
 *   (c) session id is extracted from the `session_<uuid>` directory segment,
 *   (d) a `session_<uuid>`-form pin still matches by embedded uuid,
 *   (e) the first-turn workspace-only read (no pinned id) resolves via the
 *       state.json sidecar workDir and stamps the workspace so
 *       hasSafeNativeHistoryMapping accepts it,
 *   (f) a mismatched workspace is NOT selected (no cross-workspace aliasing).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeNativeHistory } from '../../../src/providers/spec/native-history-executor.js';

// The shipped kimi nativeHistory.source (kept in sync with
// adhdev-providers/cli/kimi/provider.v1.json).
const KIMI_SOURCE = {
    kind: 'jsonl' as const,
    path: '{SESSIONS}/*/session_*/agents/main',
    file_pattern: 'wire.jsonl',
    session_id_from: 'dir_uuid' as const,
    workspace_from_sidecar: {
        rel_path: '../../state.json',
        workspace_path: '$.workDir',
    },
    records: [
        {
            where: '$.type == "turn.prompt"',
            message_map: { role: 'user', content: '$.input', timestamp_ms: '$.time' },
        },
        {
            where: '$.type == "context.append_loop_event" && $.event.type == "content.part" && $.event.part.type == "text"',
            message_map: { role: 'assistant', content: '$.event.part.text', timestamp_ms: '$.time' },
        },
    ],
};

const UUID = 'ba1a3c5c-0ad8-48e5-9f49-3feaa9c449b6';
const SESSION_ID = `session_${UUID}`;
const WORKSPACE = '/Users/example/Work/myrepo';

let tmpDir = '';
let sessionsDir = '';

/** kimi's on-disk workDir key: `wd_<lastSegment>_<12hex>` — irreversible, so the
 *  exact hash is irrelevant to the reader (workspace comes from the sidecar). */
function wdKey(ws: string, hex12: string): string {
    const last = ws.replace(/\/+$/, '').split('/').pop() || 'root';
    return `wd_${last}_${hex12}`;
}

/**
 * Write a kimi session dir: session_<uuid>/state.json (workDir sidecar) +
 * agents/main/wire.jsonl (two-shape transcript).
 */
function writeSession(opts: {
    sessionId: string;
    workspace: string;
    hex12: string;
    lines: any[];
    mtimeMs?: number;
}): string {
    const sessionDir = path.join(sessionsDir, wdKey(opts.workspace, opts.hex12), opts.sessionId);
    const wireDir = path.join(sessionDir, 'agents', 'main');
    fs.mkdirSync(wireDir, { recursive: true });
    fs.writeFileSync(
        path.join(sessionDir, 'state.json'),
        JSON.stringify({ workDir: opts.workspace, title: 'test' }),
        'utf8',
    );
    const wirePath = path.join(wireDir, 'wire.jsonl');
    fs.writeFileSync(wirePath, opts.lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
    if (typeof opts.mtimeMs === 'number') {
        const sec = opts.mtimeMs / 1000;
        fs.utimesSync(wirePath, sec, sec);
    }
    return wirePath;
}

/** The realistic multi-turn wire.jsonl shape (non-message + think + text). */
function multiTurnLines(baseTs: number): any[] {
    return [
        { type: 'metadata', protocol_version: 1, created_at: baseTs },
        { type: 'config.update', profileName: 'default', systemPrompt: 'x', time: baseTs },
        { type: 'tools.set_active_tools', names: ['Agent'], time: baseTs },
        // Turn 0
        { type: 'turn.prompt', input: [{ type: 'text', text: 'What is 2+2?' }], origin: { kind: 'user' }, time: baseTs + 100 },
        {
            type: 'context.append_loop_event',
            event: { type: 'content.part', turnId: '0', part: { type: 'think', think: 'The user asks a simple arithmetic question.' } },
            time: baseTs + 200,
        },
        {
            type: 'context.append_loop_event',
            event: { type: 'content.part', turnId: '0', part: { type: 'text', text: 'TURN-1: 2+2 = 4.' } },
            time: baseTs + 300,
        },
        { type: 'usage.record', time: baseTs + 350 },
        // Turn 1
        { type: 'turn.prompt', input: [{ type: 'text', text: 'And 3+3?' }], origin: { kind: 'user' }, time: baseTs + 400 },
        {
            type: 'context.append_loop_event',
            event: { type: 'content.part', turnId: '1', part: { type: 'text', text: 'TURN-2: 3+3 = 6.' } },
            time: baseTs + 500,
        },
    ];
}

function run(input: any) {
    const src = { ...KIMI_SOURCE, path: KIMI_SOURCE.path.replace('{SESSIONS}', sessionsDir) };
    return executeNativeHistory({ source: src } as any, input);
}

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-nh-'));
    sessionsDir = path.join(tmpDir, '.kimi-code', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
});

afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('kimi nativeHistory jsonl', () => {
    it('classifies user/assistant turns and drops think + non-message records', () => {
        const base = Date.now() - 60_000;
        writeSession({ sessionId: SESSION_ID, workspace: WORKSPACE, hex12: '78117b8afba9', lines: multiTurnLines(base), mtimeMs: base + 500 });
        const r = run({ providerSessionId: SESSION_ID, workspace: WORKSPACE, sessionStartedAtMs: 0 });
        expect(r).not.toBeNull();

        const user = r!.messages.filter((m: any) => m.role === 'user');
        const assistant = r!.messages.filter((m: any) => m.role === 'assistant');

        // (a) both user prompts classified user.
        expect(user.map((m: any) => m.content)).toEqual(['What is 2+2?', 'And 3+3?']);
        // (a) both assistant text parts classified assistant.
        expect(assistant.map((m: any) => m.content)).toEqual(['TURN-1: 2+2 = 4.', 'TURN-2: 3+3 = 6.']);
        // (b) the `think` reasoning part never surfaces as a bubble.
        expect(r!.messages.some((m: any) => m.content.includes('arithmetic question'))).toBe(false);
        // (b) non-message records (metadata/config/usage) produce no bubbles.
        expect(r!.messages).toHaveLength(4);
        // ordering: chronological (turn.prompt time < its answer time).
        expect(r!.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    });

    it('extracts the session id from the session_<uuid> directory segment', () => {
        const base = Date.now() - 60_000;
        writeSession({ sessionId: SESSION_ID, workspace: WORKSPACE, hex12: '78117b8afba9', lines: multiTurnLines(base), mtimeMs: base + 500 });
        const r = run({ workspace: WORKSPACE, sessionStartedAtMs: 0 });
        expect(r).not.toBeNull();
        // executor extracts the bare uuid from `session_<uuid>`.
        expect(r!.providerSessionId).toBe(UUID);
    });

    it('matches a session_<uuid>-form pin by embedded uuid', () => {
        const base = Date.now() - 60_000;
        writeSession({ sessionId: SESSION_ID, workspace: WORKSPACE, hex12: '78117b8afba9', lines: multiTurnLines(base), mtimeMs: base + 500 });
        // Daemon pins the on-disk `session_<uuid>` form; must still resolve.
        const r = run({ providerSessionId: SESSION_ID, workspace: WORKSPACE, sessionStartedAtMs: 0 });
        expect(r).not.toBeNull();
        expect(r!.messages).toHaveLength(4);
    });

    it('first-turn workspace-only read resolves via the state.json sidecar + stamps workspace', () => {
        const base = Date.now() - 60_000;
        writeSession({ sessionId: SESSION_ID, workspace: WORKSPACE, hex12: '78117b8afba9', lines: multiTurnLines(base), mtimeMs: base + 500 });
        // No pinned session id — workspace-scoped read (the antigravity/opencode
        // first-read case). Must resolve the file by matching the sidecar workDir,
        // stamp the workspace on every message, and surface the discovered id.
        const r = run({ workspace: WORKSPACE, sessionStartedAtMs: 0 });
        expect(r).not.toBeNull();
        expect(r!.providerSessionId).toBe(UUID);
        expect(r!.workspace).toBe(WORKSPACE);
        expect(r!.messages.every((m: any) => m.workspace === WORKSPACE)).toBe(true);
    });

    it('does not select another workspace session (no cross-workspace aliasing)', () => {
        const base = Date.now() - 60_000;
        // Only an UNRELATED workspace's session exists on disk.
        writeSession({ sessionId: SESSION_ID, workspace: '/Users/example/other/repo', hex12: 'aaaaaaaaaaaa', lines: multiTurnLines(base), mtimeMs: base + 500 });
        const r = run({ workspace: WORKSPACE, sessionStartedAtMs: 0 });
        // The sidecar workDir doesn't match → fail closed, no aliasing.
        expect(r).toBeNull();
    });

    it('picks the requested workspace session when several workspaces coexist', () => {
        const base = Date.now() - 60_000;
        // Newer session in a DIFFERENT workspace must not win a workspace-scoped read.
        writeSession({ sessionId: 'session_11111111-1111-1111-1111-111111111111', workspace: '/Users/example/other/repo', hex12: 'aaaaaaaaaaaa', lines: multiTurnLines(base + 10_000), mtimeMs: base + 10_500 });
        writeSession({ sessionId: SESSION_ID, workspace: WORKSPACE, hex12: '78117b8afba9', lines: multiTurnLines(base), mtimeMs: base + 500 });
        const r = run({ workspace: WORKSPACE, sessionStartedAtMs: 0 });
        expect(r).not.toBeNull();
        expect(r!.providerSessionId).toBe(UUID);
        expect(r!.workspace).toBe(WORKSPACE);
    });
});
