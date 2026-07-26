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
import { hasTrailingToolActivityAfterFinalAssistant, selectFinalAssistantTurnEndMessage } from '../../../src/providers/chat-message-normalization.js';

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
        // TX-FSM Stage 2.1 (KIMI-PARSED-RACE): kimi's wire.jsonl also records tool
        // invocation as `context.append_loop_event` / `event.type` "tool.call" and
        // "tool.result" (validated live: real sessions show these interleaved with
        // content.part text within the SAME turnId — an interim narration bullet can
        // land, then a tool.call ~seconds-to-minutes later, then the true final text).
        // Mapping them to kind:'tool' bubbles lets hasTrailingToolActivityAfterFinal­
        // Assistant veto an interim bubble once the tool call has actually landed.
        {
            where: '$.type == "context.append_loop_event" && $.event.type == "tool.call"',
            message_map: {
                role: 'assistant',
                content: '$.event.name',
                timestamp_ms: '$.time',
                tools: {
                    block_type: '$.event.type',
                    call_types: ['tool.call'],
                    result_types: ['tool.result'],
                    call_name: '$.event.name',
                    call_args: '$.event.args',
                },
            },
        },
        {
            where: '$.type == "context.append_loop_event" && $.event.type == "tool.result"',
            message_map: {
                role: 'assistant',
                content: '$.event.type',
                timestamp_ms: '$.time',
                tools: {
                    block_type: '$.event.type',
                    call_types: ['tool.call'],
                    result_types: ['tool.result'],
                    result_content: '$.event.result.output',
                },
            },
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

    describe('(TX-FSM Stage 2.1) tool.call/tool.result mapping + trailing-tool-activity veto', () => {
        // Mirrors a REAL captured kimi wire.jsonl shape (session kimi-p3-s1, turn 2): an
        // interim narration bubble ("Actually, I can't confirm that yet...") lands, THEN
        // (tens of seconds later live) a tool.call/tool.result, THEN the true final answer —
        // all within the same turnId. Each test truncates the on-disk transcript to the
        // exact record count a completion-gate poll would have seen at that moment.
        const ALL_LINES = [
            { type: 'turn.prompt', input: [{ type: 'text', text: 'confirm and retry' }], time: 0 },
            {
                type: 'context.append_loop_event',
                event: { type: 'content.part', turnId: '2', part: { type: 'text', text: "Actually, I can't confirm that yet." } },
                time: 100,
            },
            {
                type: 'context.append_loop_event',
                event: { type: 'tool.call', turnId: '2', name: 'Bash', args: { command: 'echo hi' } },
                time: 50_100,
            },
            {
                type: 'context.append_loop_event',
                event: { type: 'tool.result', result: { output: 'hi' } },
                time: 50_200,
            },
            {
                type: 'context.append_loop_event',
                event: { type: 'content.part', turnId: '2', part: { type: 'text', text: 'Both commands have now run successfully.' } },
                time: 59_000,
            },
        ];

        function runTruncated(nLines: number) {
            const base = Date.now() - 60_000;
            const lines = ALL_LINES.slice(0, nLines).map((l) => ({ ...l, time: base + l.time }));
            writeSession({ sessionId: SESSION_ID, workspace: WORKSPACE, hex12: '78117b8afba9', lines, mtimeMs: base + (lines[lines.length - 1]?.time ?? 0) });
            const r = run({ providerSessionId: SESSION_ID, workspace: WORKSPACE, sessionStartedAtMs: 0 });
            expect(r).not.toBeNull();
            return r!.messages;
        }

        it('at the interim-narration-only point (before tool.call lands): no tool bubble exists yet — the veto cannot fire (the residual gap the cli-provider-instance quiet-dwell guard covers)', () => {
            const messages = runTruncated(2); // turn.prompt + interim text only
            expect(messages.some((m: any) => m.kind === 'tool')).toBe(false);
            expect(hasTrailingToolActivityAfterFinalAssistant(messages as any)).toBe(false);
            expect(selectFinalAssistantTurnEndMessage(messages as any)?.content).toBe("Actually, I can't confirm that yet.");
        });

        it('once tool.call/tool.result land: kind:tool bubbles are produced and the trailing-tool-activity veto fires', () => {
            const messages = runTruncated(4); // + tool.call + tool.result, final text NOT yet written
            const toolMsgs = messages.filter((m: any) => m.kind === 'tool');
            expect(toolMsgs).toHaveLength(2);
            expect(toolMsgs.some((m: any) => String(m.content).includes('Bash'))).toBe(true);
            expect(toolMsgs.some((m: any) => String(m.content).includes('hi'))).toBe(true);
            // The interim bubble is STILL the last visible assistant message (tool bubbles are
            // not user-facing), but it is now proven non-final by the trailing tool activity.
            expect(selectFinalAssistantTurnEndMessage(messages as any)?.content).toBe("Actually, I can't confirm that yet.");
            expect(hasTrailingToolActivityAfterFinalAssistant(messages as any)).toBe(true);
        });

        it('once the true final answer lands: no trailing tool activity after it — the veto correctly clears', () => {
            const messages = runTruncated(ALL_LINES.length);
            expect(hasTrailingToolActivityAfterFinalAssistant(messages as any)).toBe(false);
            expect(selectFinalAssistantTurnEndMessage(messages as any)?.content).toBe('Both commands have now run successfully.');
        });
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
