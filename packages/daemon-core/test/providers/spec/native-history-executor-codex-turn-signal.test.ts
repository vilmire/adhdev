/**
 * codex-cli turnTerminalMarkers via the declarative jsonl executor.
 *
 * codex-cli ships as a v1 SDK provider (specs/4.0.json, SpecCliAdapter),
 * which reads its transcript through executeNativeHistory/executeJsonl in
 * native-history-executor.ts — NOT through the legacy TypeScript reader
 * (codex-cli-transcript.ts / native-history/dispatcher.ts) the
 * NATIVE-TURN-SIGNAL fix (oss 2cc6a15a) wired turnTerminalMarkers into. That
 * fix never took effect for codex-cli's actual live read path: executeJsonl's
 * NativeHistoryResult carried no turnTerminalMarkers field at all, so
 * completionFinalAssistantEvidence's nativeTurnTerminalMarker() always saw
 * `markers=null` and fell through to timeout-only release — the
 * infinite-generating class the NATIVE-TURN-SIGNAL fix was supposed to close,
 * live-reproduced 2026-08-10 (standalone Turn B: a silent tool-only turn held
 * ~105s in native_transcript_advancing/busy_lease_active with a genuine
 * task_complete already on disk).
 *
 * These tests drive the SAME declarative `source` block codex-cli's
 * specs/4.0.json ships, against fixtures shaped like real rollout files, and
 * assert the executor now surfaces turnTerminalMarkers built-in for
 * agentType 'codex-cli' — mirroring codex-cli-transcript.ts's
 * CODEX_DEFAULT_COMPLETION_SIGNAL default.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeNativeHistory } from '../../../src/providers/spec/native-history-executor.js';

// The shipped codex-cli nativeHistory.source (kept in sync with
// adhdev-providers/cli/codex-cli/specs/4.0.json's native_history.source).
const CODEX_SOURCE = {
    kind: 'jsonl' as const,
    path: '{SESSIONS}/{yyyy}/{mm}/{dd}',
    file_pattern: 'rollout-*.jsonl',
    session_id_from: 'filename_uuid' as const,
    message_filter: {
        where: "$.type == 'response_item' && $.payload.type == 'message'",
    },
    message_map: {
        role: '$.payload.role',
        content: '$.payload.content[0].text',
        timestamp_ms: '$.timestamp',
    },
};

let tmpDir = '';
let sessionsDir = '';
const SESSION_ID = '019feb8e-cf2d-7241-9e00-9eb1f199c5af';
const WORKSPACE = '/Users/example/Work/myrepo';

function sourceForTmp(): typeof CODEX_SOURCE {
    return { ...CODEX_SOURCE, path: CODEX_SOURCE.path.replace('{SESSIONS}', sessionsDir) };
}

function writeRollout(sessionId: string, lines: string[]): string {
    const dir = path.join(sessionsDir, '2026', '08', '10');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `rollout-2026-08-10T21-03-52-${sessionId}.jsonl`);
    fs.writeFileSync(filePath, lines.map((l) => l).join('\n') + '\n', 'utf8');
    return filePath;
}

function metaLine(sessionId: string, workspace: string, ts: number): string {
    return JSON.stringify({ timestamp: ts, type: 'session_meta', payload: { id: sessionId, cwd: workspace } });
}

function userMsg(text: string, ts: number): string {
    return JSON.stringify({ timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'text', text }] } });
}

function taskComplete(turnId: string, lastAgentMessage: string | null, ts: number): string {
    return JSON.stringify({
        timestamp: ts,
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: turnId, last_agent_message: lastAgentMessage, started_at: Math.floor(ts / 1000) - 5, completed_at: Math.floor(ts / 1000) },
    });
}

function turnAborted(turnId: string, ts: number): string {
    return JSON.stringify({
        timestamp: ts,
        type: 'event_msg',
        payload: { type: 'turn_aborted', turn_id: turnId },
    });
}

describe('codex-cli turnTerminalMarkers (declarative jsonl executor)', () => {
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-turn-signal-'));
        sessionsDir = path.join(tmpDir, 'sessions');
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('surfaces a task_complete marker with empty last_agent_message (the silent tool-only turn class)', () => {
        const ts0 = Date.now() - 10_000;
        writeRollout(SESSION_ID, [
            metaLine(SESSION_ID, WORKSPACE, ts0),
            userMsg('read the first line', ts0 + 100),
            taskComplete('turn-abc-1', null, ts0 + 5_000),
        ]);

        const result = executeNativeHistory({ source: sourceForTmp() } as any, {
            agentType: 'codex-cli',
            historySessionId: SESSION_ID,
            workspace: WORKSPACE,
        });

        expect(result).not.toBeNull();
        expect(result?.turnTerminalMarkers).toBeDefined();
        expect(result?.turnTerminalMarkers).toHaveLength(1);
        expect(result?.turnTerminalMarkers?.[0]).toMatchObject({
            outcome: 'completed',
            summary: '',
            turnId: 'turn-abc-1',
        });
    });

    it('surfaces a task_complete marker WITH a real last_agent_message', () => {
        const ts0 = Date.now() - 10_000;
        writeRollout(SESSION_ID, [
            metaLine(SESSION_ID, WORKSPACE, ts0),
            userMsg('what is 1+1?', ts0 + 100),
            taskComplete('turn-abc-2', 'The answer is 2.', ts0 + 3_000),
        ]);

        const result = executeNativeHistory({ source: sourceForTmp() } as any, {
            agentType: 'codex-cli',
            historySessionId: SESSION_ID,
            workspace: WORKSPACE,
        });

        expect(result?.turnTerminalMarkers).toHaveLength(1);
        expect(result?.turnTerminalMarkers?.[0]).toMatchObject({
            outcome: 'completed',
            summary: 'The answer is 2.',
            turnId: 'turn-abc-2',
        });
    });

    it('surfaces a turn_aborted marker as outcome=aborted', () => {
        const ts0 = Date.now() - 10_000;
        writeRollout(SESSION_ID, [
            metaLine(SESSION_ID, WORKSPACE, ts0),
            userMsg('do something', ts0 + 100),
            turnAborted('turn-abc-3', ts0 + 2_000),
        ]);

        const result = executeNativeHistory({ source: sourceForTmp() } as any, {
            agentType: 'codex-cli',
            historySessionId: SESSION_ID,
            workspace: WORKSPACE,
        });

        expect(result?.turnTerminalMarkers).toHaveLength(1);
        expect(result?.turnTerminalMarkers?.[0].outcome).toBe('aborted');
    });

    it('collects markers across MULTIPLE turns in file order', () => {
        const ts0 = Date.now() - 30_000;
        writeRollout(SESSION_ID, [
            metaLine(SESSION_ID, WORKSPACE, ts0),
            userMsg('turn 1', ts0 + 100),
            taskComplete('turn-1', 'first reply', ts0 + 3_000),
            userMsg('turn 2', ts0 + 4_000),
            taskComplete('turn-2', null, ts0 + 8_000),
        ]);

        const result = executeNativeHistory({ source: sourceForTmp() } as any, {
            agentType: 'codex-cli',
            historySessionId: SESSION_ID,
            workspace: WORKSPACE,
        });

        expect(result?.turnTerminalMarkers).toHaveLength(2);
        expect(result?.turnTerminalMarkers?.map((m) => m.turnId)).toEqual(['turn-1', 'turn-2']);
    });

    it('does NOT surface turnTerminalMarkers for a non-codex agentType (built-in default is scoped)', () => {
        const ts0 = Date.now() - 10_000;
        writeRollout(SESSION_ID, [
            metaLine(SESSION_ID, WORKSPACE, ts0),
            userMsg('hello', ts0 + 100),
            taskComplete('turn-x', 'hi', ts0 + 2_000),
        ]);

        const result = executeNativeHistory({ source: sourceForTmp() } as any, {
            agentType: 'some-other-cli',
            historySessionId: SESSION_ID,
            workspace: WORKSPACE,
        });

        expect(result?.turnTerminalMarkers).toBeUndefined();
    });

    it('omits turnTerminalMarkers entirely when the rollout carries no task_complete/turn_aborted (field stays undefined, not [])', () => {
        const ts0 = Date.now() - 10_000;
        writeRollout(SESSION_ID, [
            metaLine(SESSION_ID, WORKSPACE, ts0),
            userMsg('hello', ts0 + 100),
            userMsg('another user msg mid-turn (no terminal record yet)', ts0 + 200),
        ]);

        const result = executeNativeHistory({ source: sourceForTmp() } as any, {
            agentType: 'codex-cli',
            historySessionId: SESSION_ID,
            workspace: WORKSPACE,
        });

        expect(result).not.toBeNull();
        expect(result?.turnTerminalMarkers).toBeUndefined();
    });
});
