/**
 * Slug-divergence recovery for the JSONL executor (claude-cli native history).
 *
 * Regression: the concrete transcript path is built from a per-cwd slug derived
 * from fs.realpathSync(workspace). On Windows realpath normalizes the path
 * (drive-letter case, \\?\ prefix, junction expansion) so the slug diverges
 * from the directory the CLI actually wrote → statSync ENOENT → the executor
 * returned null with NO scan fallback → 0 messages (user AND assistant), and
 * native-source providers have no PTY fallback. The dashboard then showed an
 * empty chat for every delegated Windows session.
 *
 * Fix: when the slug-derived concrete path misses, retry with the raw-workspace
 * slug, then last-resort scan the projects root for `<sessionId>.jsonl`.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeNativeHistory } from '../../../src/providers/spec/native-history-executor.js';

let tmpDir = '';

const SESSION_ID = '653139e5-990e-4fb1-87e8-0c2f981b04ba';

function claudeCfg(projectsDir: string) {
    return {
        source: {
            kind: 'jsonl' as const,
            // mirrors adhdev-providers/cli/claude-cli/specs/4.0.json
            path: `${projectsDir}/{cwd_claude_project}/{session_id}.jsonl`,
            session_id_from: 'filename_uuid' as const,
            message_filter: { where: "$.type == 'user' || $.type == 'assistant'" },
            message_map: {
                role: '$.message.role',
                content: '$.message.content',
                timestamp_ms: '$.timestamp',
            },
        },
    };
}

function writeTranscript(projectsDir: string, projectDirName: string, sessionId: string): string {
    const filePath = path.join(projectsDir, projectDirName, `${sessionId}.jsonl`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const lines = [
        JSON.stringify({ type: 'user', sessionId, cwd: 'D:\\gh\\adhdev-cloud', timestamp: new Date().toISOString(), message: { role: 'user', content: 'ㅇㅇ' } }),
        JSON.stringify({ type: 'assistant', sessionId, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }),
    ];
    fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf-8');
    return filePath;
}

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-history-slug-'));
});

afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('executeJsonl — slug divergence recovery', () => {
    it('finds the transcript via projects-root scan when the slug-derived dir does not match', () => {
        const projectsDir = path.join(tmpDir, '.claude', 'projects');
        // The file lives under the slug the CLI actually used (Windows-style cwd
        // slugged). The daemon's workspace below resolves to a DIFFERENT slug, so
        // the concrete path misses and only the session-id scan can recover it.
        const cliProjectDir = 'D--gh-adhdev-cloud';
        const expected = writeTranscript(projectsDir, cliProjectDir, SESSION_ID);

        // workspace points at a real (existing) dir whose slug != cliProjectDir,
        // guaranteeing the realpath/raw slug both miss.
        const workspace = path.join(tmpDir, 'some', 'other', 'workspace');
        fs.mkdirSync(workspace, { recursive: true });

        const result = executeNativeHistory(claudeCfg(projectsDir), {
            workspace,
            providerSessionId: SESSION_ID,
            sessionId: SESSION_ID,
        });

        expect(result).not.toBeNull();
        expect(result?.sourcePath).toBe(expected);
        expect(result?.providerSessionId).toBe(SESSION_ID);
        // Both user and assistant bubbles come back (the exact symptom: 0 → 2).
        const roles = result?.messages.map(m => m.role);
        expect(roles).toContain('user');
        expect(roles).toContain('assistant');
        expect(result?.messages.map(m => m.content)).toEqual(expect.arrayContaining(['ㅇㅇ', 'done']));
    });

    it('prefers the raw-workspace slug before scanning (cheap recovery from realpath divergence)', () => {
        const projectsDir = path.join(tmpDir, '.claude', 'projects');
        // Simulate realpath divergence: the file lives under the RAW-slug dir.
        // On macOS the tmpdir resolves through /var -> /private/var, so the
        // realpath slug differs from the raw slug; placing the file only at the
        // raw slug means the realpath concrete path misses and the raw-slug
        // retry must catch it (before any scan).
        const workspace = path.join(tmpDir, 'proj');
        fs.mkdirSync(workspace, { recursive: true });
        const rawSlug = workspace.replace(/[^A-Za-z0-9_-]/g, '-');
        const expected = writeTranscript(projectsDir, rawSlug, SESSION_ID);

        const result = executeNativeHistory(claudeCfg(projectsDir), {
            workspace,
            providerSessionId: SESSION_ID,
            sessionId: SESSION_ID,
        });

        expect(result).not.toBeNull();
        expect(result?.sourcePath).toBe(expected);
        expect(result?.messages.length).toBe(2);
    });

    it('still returns null (and does not throw) when no transcript exists for the session id', () => {
        const projectsDir = path.join(tmpDir, '.claude', 'projects');
        fs.mkdirSync(projectsDir, { recursive: true });
        const workspace = path.join(tmpDir, 'proj');
        fs.mkdirSync(workspace, { recursive: true });

        const result = executeNativeHistory(claudeCfg(projectsDir), {
            workspace,
            providerSessionId: SESSION_ID,
            sessionId: SESSION_ID,
        });
        expect(result).toBeNull();
    });
});
