/**
 * background-task-detector — claude-cli run_in_background bash awareness.
 *
 * (FALSE-IDLE-BACKGROUND-CMD) The daemon's idle/generating judgment is
 * PTY-screen-derived and blind to claude-cli's own run_in_background bash jobs.
 * When such a job is launched and the parent turn returns to a ready prompt,
 * the session looks idle while the job is still running → a false completion.
 *
 * The durable signal is the native-history JSONL transcript: a background bash
 * `tool_use` with NO matching `tool_result` = the job is still running. These
 * tests exercise the pairing logic (detectFromRecords) and the on-disk read
 * path (detectBackgroundTaskActive).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    detectFromRecords,
    detectBackgroundTaskActive,
} from '../../../src/providers/spec/background-task-detector.js';

// ── Transcript record builders (claude-cli JSONL shape) ──────────────────────

function bgBashLaunch(id: string, command = 'npm test') {
    return {
        type: 'assistant',
        message: {
            role: 'assistant',
            content: [
                { type: 'text', text: 'Running tests in the background.' },
                { type: 'tool_use', id, name: 'Bash', input: { command, run_in_background: true } },
            ],
        },
    };
}

function fgBashLaunch(id: string, command = 'ls') {
    return {
        type: 'assistant',
        message: {
            role: 'assistant',
            content: [
                { type: 'tool_use', id, name: 'Bash', input: { command } },
            ],
        },
    };
}

function toolResult(id: string, text = 'ok') {
    return {
        type: 'user',
        message: {
            role: 'user',
            content: [
                { type: 'tool_result', tool_use_id: id, content: text },
            ],
        },
    };
}

function userText(text = 'do something') {
    return { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
}

// ── detectFromRecords (pure pairing logic) ───────────────────────────────────

describe('detectFromRecords — background bash pairing', () => {
    it('flags an unresolved background bash tool_use (no tool_result)', () => {
        const records = [
            userText(),
            bgBashLaunch('bash_1'),
        ];
        const r = detectFromRecords(records);
        expect(r.active).toBe(true);
        expect(r.count).toBe(1);
        expect(r.ids).toEqual(['bash_1']);
    });

    it('does NOT flag once the tool_result arrives', () => {
        const records = [
            userText(),
            bgBashLaunch('bash_1'),
            toolResult('bash_1'),
        ];
        const r = detectFromRecords(records);
        expect(r.active).toBe(false);
        expect(r.count).toBe(0);
    });

    it('does NOT flag a foreground bash (no run_in_background flag)', () => {
        const records = [
            userText(),
            fgBashLaunch('bash_fg'),
        ];
        const r = detectFromRecords(records);
        expect(r.active).toBe(false);
    });

    it('does NOT flag a foreground bash even without a completion', () => {
        // A normal foreground bash that never got a tool_result in the tail must
        // never trip the hold — only run_in_background bash qualifies.
        const records = [fgBashLaunch('bash_fg', 'sleep 1')];
        const r = detectFromRecords(records);
        expect(r.active).toBe(false);
    });

    it('flags only the still-unresolved job when multiple background jobs exist', () => {
        const records = [
            bgBashLaunch('bash_a', 'build'),
            bgBashLaunch('bash_b', 'test'),
            toolResult('bash_a'),
        ];
        const r = detectFromRecords(records);
        expect(r.active).toBe(true);
        expect(r.count).toBe(1);
        expect(r.ids).toEqual(['bash_b']);
    });

    it('returns inactive for an empty transcript', () => {
        expect(detectFromRecords([]).active).toBe(false);
    });

    it('ignores malformed / non-object records', () => {
        const r = detectFromRecords([null, 42, 'x', { type: 'assistant' }]);
        expect(r.active).toBe(false);
    });
});

// ── detectBackgroundTaskActive (on-disk read path) ───────────────────────────

let tmpDir = '';
const SESSION_ID = '653139e5-990e-4fb1-87e8-0c2f981b04ba';

function claudeCfg(projectsDir: string) {
    return {
        source: {
            kind: 'jsonl' as const,
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

function writeTranscript(projectsDir: string, workspace: string, records: unknown[]): string {
    const slug = workspace.replace(/[^A-Za-z0-9_-]/g, '-');
    const filePath = path.join(projectsDir, slug, `${SESSION_ID}.jsonl`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const lines = records.map((r) => JSON.stringify(r));
    fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf-8');
    return filePath;
}

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-task-detect-'));
});

afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('detectBackgroundTaskActive — on-disk read', () => {
    it('reads an unresolved background bash from the live transcript', () => {
        const projectsDir = path.join(tmpDir, '.claude', 'projects');
        const workspace = fs.mkdtempSync(path.join(tmpDir, 'ws-'));
        writeTranscript(projectsDir, fs.realpathSync(workspace), [
            userText(),
            bgBashLaunch('bash_1'),
        ]);
        const r = detectBackgroundTaskActive(claudeCfg(projectsDir), {
            agentType: 'claude-cli',
            providerSessionId: SESSION_ID,
            workspace,
        });
        expect(r.active).toBe(true);
        expect(r.ids).toEqual(['bash_1']);
    });

    it('reads inactive once the tool_result has landed', () => {
        const projectsDir = path.join(tmpDir, '.claude', 'projects');
        const workspace = fs.mkdtempSync(path.join(tmpDir, 'ws-'));
        writeTranscript(projectsDir, fs.realpathSync(workspace), [
            userText(),
            bgBashLaunch('bash_1'),
            toolResult('bash_1'),
        ]);
        const r = detectBackgroundTaskActive(claudeCfg(projectsDir), {
            agentType: 'claude-cli',
            providerSessionId: SESSION_ID,
            workspace,
        });
        expect(r.active).toBe(false);
    });

    it('short-circuits inactive for non-claude-cli providers', () => {
        const projectsDir = path.join(tmpDir, '.claude', 'projects');
        const workspace = fs.mkdtempSync(path.join(tmpDir, 'ws-'));
        writeTranscript(projectsDir, fs.realpathSync(workspace), [bgBashLaunch('bash_1')]);
        const r = detectBackgroundTaskActive(claudeCfg(projectsDir), {
            agentType: 'codex-cli',
            providerSessionId: SESSION_ID,
            workspace,
        });
        expect(r.active).toBe(false);
    });

    it('returns inactive when no transcript file exists', () => {
        const projectsDir = path.join(tmpDir, '.claude', 'projects');
        const r = detectBackgroundTaskActive(claudeCfg(projectsDir), {
            agentType: 'claude-cli',
            providerSessionId: SESSION_ID,
            workspace: path.join(tmpDir, 'nonexistent'),
        });
        expect(r.active).toBe(false);
    });
});
