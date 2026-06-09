/**
 * Per-session rollout binding for the JSONL executor.
 *
 * Regression: when two codex-cli sessions launched concurrently in the same
 * workspace, both daemon sessions bound to the same rollout JSONL because
 * `newestRecentFile` selects by mtime only. The executor now disambiguates
 * by reading each candidate's `session_meta` payload and matching cwd +
 * meta.timestamp against the daemon's spawnedAtMs.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeNativeHistory } from '../../../src/providers/spec/native-history-executor.js';

let tmpDir = '';

function todayDateDir(base: string): string {
    const now = new Date();
    const yyyy = String(now.getFullYear());
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    return path.join(base, '.codex', 'sessions', yyyy, mm, dd);
}

function writeRollout(
    dir: string,
    uuid: string,
    sessionTsIso: string,
    cwd: string,
    messages: Array<{ role: 'user' | 'assistant'; text: string; ts: string }>,
    mtimeMs?: number,
): string {
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `rollout-${sessionTsIso.replace(/[:.]/g, '-').slice(0, 19)}-${uuid}.jsonl`);
    const lines: string[] = [];
    lines.push(JSON.stringify({
        timestamp: sessionTsIso,
        type: 'session_meta',
        payload: { id: uuid, cwd, timestamp: sessionTsIso, originator: 'codex-tui' },
    }));
    for (const m of messages) {
        lines.push(JSON.stringify({
            timestamp: m.ts,
            type: 'response_item',
            payload: { type: 'message', role: m.role, content: [{ type: 'input_text', text: m.text }] },
        }));
    }
    fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf-8');
    if (typeof mtimeMs === 'number') {
        const sec = mtimeMs / 1000;
        fs.utimesSync(filePath, sec, sec);
    }
    return filePath;
}

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-history-binding-'));
});

afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

describe('executeJsonl — concurrent codex-cli sessions in same workspace', () => {
    it('binds each daemon session to its own rollout by session_meta.timestamp', () => {
        const dateDir = todayDateDir(tmpDir);
        const workspace = path.join(tmpDir, 'project');
        fs.mkdirSync(workspace, { recursive: true });

        // Daemon session A spawned at T0; codex creates rollout_a at T0 + 100ms
        const t0 = Date.now() - 60_000;
        const rolloutA = writeRollout(
            dateDir,
            '019ea15f-85ab-7133-8347-920def0c7906',
            new Date(t0 + 100).toISOString(),
            workspace,
            [{ role: 'user', text: 'ABC', ts: new Date(t0 + 200).toISOString() }],
            t0 + 100,
        );

        // Daemon session B spawned at T0 + 5s; codex creates rollout_b at +5.1s
        const t1 = t0 + 5_000;
        const rolloutB = writeRollout(
            dateDir,
            '019ea15f-862e-7dd2-861e-e81c2ff13ae2',
            new Date(t1 + 100).toISOString(),
            workspace,
            [{ role: 'user', text: 'DEF', ts: new Date(t1 + 200).toISOString() }],
            t1 + 100,
        );

        const cfg = {
            source: {
                kind: 'jsonl' as const,
                path: `${tmpDir}/.codex/sessions/{yyyy}/{mm}/{dd}`,
                file_pattern: 'rollout-*.jsonl',
                session_id_from: 'filename_uuid' as const,
                message_filter: { where: "$.type == 'response_item' && $.payload.type == 'message'" },
                message_map: {
                    role: '$.payload.role',
                    content: '$.payload.content[0].text',
                    timestamp_ms: '$.timestamp',
                },
            },
        };

        // Daemon session A reads — sessionStartedAtMs aligns with rollout_a
        const resultA = executeNativeHistory(cfg, {
            workspace,
            sessionStartedAtMs: t0,
        });
        expect(resultA?.sourcePath).toBe(rolloutA);
        expect(resultA?.providerSessionId).toBe('019ea15f-85ab-7133-8347-920def0c7906');
        expect(resultA?.messages.map(m => m.content)).toEqual(['ABC']);

        // Daemon session B reads — sessionStartedAtMs aligns with rollout_b
        const resultB = executeNativeHistory(cfg, {
            workspace,
            sessionStartedAtMs: t1,
        });
        expect(resultB?.sourcePath).toBe(rolloutB);
        expect(resultB?.providerSessionId).toBe('019ea15f-862e-7dd2-861e-e81c2ff13ae2');
        expect(resultB?.messages.map(m => m.content)).toEqual(['DEF']);
    });

    it('falls back to mtime-newest when no session_meta matches workspace', () => {
        const dateDir = todayDateDir(tmpDir);
        const workspace = path.join(tmpDir, 'project');
        fs.mkdirSync(workspace, { recursive: true });
        const otherWorkspace = path.join(tmpDir, 'other');
        fs.mkdirSync(otherWorkspace, { recursive: true });

        const t0 = Date.now() - 60_000;
        // Both rollouts belong to a different workspace
        const rolloutA = writeRollout(
            dateDir,
            '019ea15f-aaaa-7133-8347-920def0c7906',
            new Date(t0).toISOString(),
            otherWorkspace,
            [{ role: 'user', text: 'X', ts: new Date(t0).toISOString() }],
            t0,
        );
        const rolloutB = writeRollout(
            dateDir,
            '019ea15f-bbbb-7dd2-861e-e81c2ff13ae2',
            new Date(t0 + 1000).toISOString(),
            otherWorkspace,
            [{ role: 'user', text: 'Y', ts: new Date(t0 + 1000).toISOString() }],
            t0 + 1000,
        );

        const cfg = {
            source: {
                kind: 'jsonl' as const,
                path: `${tmpDir}/.codex/sessions/{yyyy}/{mm}/{dd}`,
                file_pattern: 'rollout-*.jsonl',
                session_id_from: 'filename_uuid' as const,
                message_filter: { where: "$.type == 'response_item' && $.payload.type == 'message'" },
                message_map: {
                    role: '$.payload.role',
                    content: '$.payload.content[0].text',
                    timestamp_ms: '$.timestamp',
                },
            },
        };

        const result = executeNativeHistory(cfg, {
            workspace,
            sessionStartedAtMs: t0,
        });
        // Workspace doesn't match either rollout's cwd, so per-session
        // binding bails out and we fall back to mtime-newest.
        expect(result?.sourcePath).toBe(rolloutB);
        void rolloutA;
    });

    it('ignores rollouts outside the spawn-grace window', () => {
        const dateDir = todayDateDir(tmpDir);
        const workspace = path.join(tmpDir, 'project');
        fs.mkdirSync(workspace, { recursive: true });

        const t0 = Date.now() - 60_000;
        // Rollout from a session in the same workspace that started 1 minute earlier
        const staleRollout = writeRollout(
            dateDir,
            '019ea15f-cccc-7133-8347-920def0c7906',
            new Date(t0 - 60_000).toISOString(),
            workspace,
            [{ role: 'user', text: 'OLD', ts: new Date(t0 - 60_000).toISOString() }],
            t0 - 60_000,
        );

        const cfg = {
            source: {
                kind: 'jsonl' as const,
                path: `${tmpDir}/.codex/sessions/{yyyy}/{mm}/{dd}`,
                file_pattern: 'rollout-*.jsonl',
                session_id_from: 'filename_uuid' as const,
                message_filter: { where: "$.type == 'response_item' && $.payload.type == 'message'" },
                message_map: {
                    role: '$.payload.role',
                    content: '$.payload.content[0].text',
                    timestamp_ms: '$.timestamp',
                },
            },
        };

        const result = executeNativeHistory(cfg, {
            workspace,
            sessionStartedAtMs: t0,
        });
        // The stale rollout's meta.timestamp is > SPAWN_BIND_GRACE_MS away
        // from sessionStartedAtMs, so spawn-binding refuses it. The mtime
        // floor (sessionFloor - 10s) also rejects it, so the fallback
        // mtime picker returns null → executeJsonl returns null.
        expect(result).toBeNull();
        void staleRollout;
    });

    it('prefers an explicit session id over newest same-workspace rollout', () => {
        const dateDir = todayDateDir(tmpDir);
        const workspace = path.join(tmpDir, 'project');
        fs.mkdirSync(workspace, { recursive: true });

        const t0 = Date.now() - 60_000;
        const requestedId = '019ea15f-dddd-7133-8347-920def0c7906';
        const newerId = '019ea15f-eeee-7dd2-861e-e81c2ff13ae2';
        const requestedRollout = writeRollout(
            dateDir,
            requestedId,
            new Date(t0).toISOString(),
            workspace,
            [{ role: 'assistant', text: 'REQUESTED', ts: new Date(t0 + 100).toISOString() }],
            t0,
        );
        writeRollout(
            dateDir,
            newerId,
            new Date(t0 + 30_000).toISOString(),
            workspace,
            [{ role: 'assistant', text: 'NEWER', ts: new Date(t0 + 30_100).toISOString() }],
            t0 + 30_000,
        );

        const cfg = {
            source: {
                kind: 'jsonl' as const,
                path: `${tmpDir}/.codex/sessions/{yyyy}/{mm}/{dd}`,
                file_pattern: 'rollout-*.jsonl',
                session_id_from: 'filename_uuid' as const,
                message_filter: { where: "$.type == 'response_item' && $.payload.type == 'message'" },
                message_map: {
                    role: '$.payload.role',
                    content: '$.payload.content[0].text',
                    timestamp_ms: '$.timestamp',
                },
            },
        };

        const result = executeNativeHistory(cfg, {
            workspace,
            historySessionId: requestedId,
            sessionStartedAtMs: t0 + 30_000,
        });
        expect(result?.sourcePath).toBe(requestedRollout);
        expect(result?.providerSessionId).toBe(requestedId);
        expect(result?.messages.map(m => m.content)).toEqual(['REQUESTED']);
    });

    it('does not fall back to newest rollout when an explicit session id is missing', () => {
        const dateDir = todayDateDir(tmpDir);
        const workspace = path.join(tmpDir, 'project');
        fs.mkdirSync(workspace, { recursive: true });

        const t0 = Date.now() - 60_000;
        writeRollout(
            dateDir,
            '019ea15f-ffff-7133-8347-920def0c7906',
            new Date(t0).toISOString(),
            workspace,
            [{ role: 'assistant', text: 'EXISTING', ts: new Date(t0 + 100).toISOString() }],
            t0,
        );

        const cfg = {
            source: {
                kind: 'jsonl' as const,
                path: `${tmpDir}/.codex/sessions/{yyyy}/{mm}/{dd}`,
                file_pattern: 'rollout-*.jsonl',
                session_id_from: 'filename_uuid' as const,
                message_filter: { where: "$.type == 'response_item' && $.payload.type == 'message'" },
                message_map: {
                    role: '$.payload.role',
                    content: '$.payload.content[0].text',
                    timestamp_ms: '$.timestamp',
                },
            },
        };

        const result = executeNativeHistory(cfg, {
            workspace,
            historySessionId: '019ea160-0000-7133-8347-920def0c7906',
            sessionStartedAtMs: t0,
        });
        expect(result).toBeNull();
    });
});
