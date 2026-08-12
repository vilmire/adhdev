/**
 * kimi turnTerminalMarkers via the declarative jsonl executor.
 *
 * kimi's wire.jsonl ends every turn with exactly one
 * `{"type":"turn.ended","turnId":<n>,"reason":"completed"|"cancelled",...,"time":<ms>}`
 * record — the CLI's own authoritative turn-terminal signal. Surfacing it as
 * NativeTurnTerminalMarker plugs kimi into the SAME provider-agnostic
 * completion gate codex-cli already uses
 * (completionFinalAssistantEvidence → nativeTurnTerminalMarker), so a kimi turn
 * whose final assistant bubble is missing/mismapped no longer waits for a
 * timeout-only release.
 *
 * Fixtures mirror the real on-disk layout (verified against live kimi 0.34
 * sessions): sessions/<wd_slug>/session_<uuid>/agents/main/wire.jsonl with the
 * workspace in the session_<uuid>/state.json sidecar.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeNativeHistory } from '../../../src/providers/spec/native-history-executor.js';

const UUID = 'd3f014e8-7c09-4b97-b3dd-a7acbb46db10';
const SESSION_ID = `session_${UUID}`;
const WORKSPACE = '/Users/example/Work/myrepo';

// Mirrors the shipped kimi nativeHistory.source (adhdev-providers/cli/kimi/provider.v1.json).
function kimiCfg(sessionsDir: string) {
    return {
        source: {
            kind: 'jsonl' as const,
            path: `${sessionsDir}/*/session_*/agents/main`,
            file_pattern: 'wire.jsonl',
            session_id_from: 'dir_uuid' as const,
            workspace_from_sidecar: { rel_path: '../../state.json', workspace_path: '$.workDir || $.cwd' },
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
        },
    };
}

let tmpDir = '';
let sessionsDir = '';

function writeKimiSession(lines: unknown[]): string {
    const sessionDir = path.join(sessionsDir, 'wd_myrepo_78117b8afba9', SESSION_ID);
    const wireDir = path.join(sessionDir, 'agents', 'main');
    fs.mkdirSync(wireDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({ workDir: WORKSPACE }), 'utf8');
    const wirePath = path.join(wireDir, 'wire.jsonl');
    fs.writeFileSync(wirePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
    return wirePath;
}

function prompt(text: string, ts: number): Record<string, unknown> {
    return { type: 'turn.prompt', turnId: 0, input: text, time: ts };
}

function assistantText(text: string, ts: number): Record<string, unknown> {
    return { type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text } }, time: ts };
}

function turnEnded(turnId: number, reason: string, ts: number): Record<string, unknown> {
    return { type: 'turn.ended', turnId, reason, durationMs: 1234, time: ts };
}

function read() {
    return executeNativeHistory(kimiCfg(sessionsDir) as any, {
        agentType: 'kimi',
        historySessionId: SESSION_ID,
        workspace: WORKSPACE,
    });
}

describe('kimi turnTerminalMarkers (declarative jsonl executor)', () => {
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-turn-signal-'));
        sessionsDir = path.join(tmpDir, '.kimi-code', 'sessions');
        fs.mkdirSync(sessionsDir, { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('surfaces a turn.ended reason=completed marker with its epoch-ms time and stringified turnId', () => {
        const ts0 = Date.now() - 10_000;
        writeKimiSession([
            prompt('hello', ts0),
            assistantText('hi there', ts0 + 1_000),
            turnEnded(0, 'completed', ts0 + 2_000),
        ]);

        const result = read();

        expect(result).not.toBeNull();
        expect(result?.turnTerminalMarkers).toHaveLength(1);
        expect(result?.turnTerminalMarkers?.[0]).toMatchObject({
            receivedAt: ts0 + 2_000,
            outcome: 'completed',
            summary: '',
            turnId: '0',
        });
    });

    it('maps turn.ended reason=cancelled to outcome=aborted', () => {
        const ts0 = Date.now() - 10_000;
        writeKimiSession([
            prompt('long task', ts0),
            turnEnded(0, 'cancelled', ts0 + 3_000),
        ]);

        const result = read();

        expect(result?.turnTerminalMarkers).toHaveLength(1);
        expect(result?.turnTerminalMarkers?.[0].outcome).toBe('aborted');
    });

    it('collects markers across multiple turns in file order', () => {
        const ts0 = Date.now() - 30_000;
        writeKimiSession([
            prompt('turn 1', ts0),
            assistantText('first', ts0 + 500),
            turnEnded(0, 'completed', ts0 + 1_000),
            prompt('turn 2', ts0 + 2_000),
            turnEnded(1, 'cancelled', ts0 + 5_000),
        ]);

        const result = read();

        expect(result?.turnTerminalMarkers).toHaveLength(2);
        expect(result?.turnTerminalMarkers?.map((m) => m.turnId)).toEqual(['0', '1']);
        expect(result?.turnTerminalMarkers?.[1].outcome).toBe('aborted');
    });

    it('omits turnTerminalMarkers while the turn is still open (no turn.ended yet)', () => {
        const ts0 = Date.now() - 10_000;
        writeKimiSession([
            prompt('in flight', ts0),
            assistantText('partial answer...', ts0 + 500),
        ]);

        const result = read();

        expect(result).not.toBeNull();
        expect(result?.turnTerminalMarkers).toBeUndefined();
    });
});
