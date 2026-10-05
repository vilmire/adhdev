/**
 * Daemon-written workspace MCP configs (a worker's carries its session bind
 * token) must stay out of `git add -A`: listed in the repo's LOCAL exclude file,
 * never in a tracked .gitignore (2026-10-06 provider matrix: a base-node
 * opencode worker left its token in repo-root opencode.json).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureLocalGitExclude } from '../../src/git/git-local-exclude.js';

let root = '';
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

function repo(): string {
    root = mkdtempSync(join(tmpdir(), 'adhdev-local-exclude-'));
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: root });
    writeFileSync(join(root, 'README.md'), 'x\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: root });
    return root;
}
const status = (cwd: string) => execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' });

describe('ensureLocalGitExclude', () => {
    it('hides a generated workspace config from status and add -A, once', () => {
        const ws = repo();
        writeFileSync(join(ws, 'opencode.json'), '{"mcp":{"adhdev-worker":{"environment":{"ADHDEV_WORKER_SESSION_BIND":"wsb_secret"}}}}');
        mkdirSync(join(ws, '.kimi-code'));
        writeFileSync(join(ws, '.kimi-code', 'mcp.json'), '{}');
        expect(ensureLocalGitExclude(ws, join(ws, 'opencode.json'))).toBe(true);
        expect(ensureLocalGitExclude(ws, join(ws, '.kimi-code', 'mcp.json'))).toBe(true);
        expect(ensureLocalGitExclude(ws, join(ws, 'opencode.json'))).toBe(true);
        expect(status(ws)).toBe('');
        execFileSync('git', ['add', '-A'], { cwd: ws });
        expect(execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: ws, encoding: 'utf8' })).toBe('');
        const exclude = readFileSync(join(ws, '.git', 'info', 'exclude'), 'utf8');
        expect(exclude.split('\n').filter(l => l === '/opencode.json')).toHaveLength(1);
        expect(exclude).toContain('/.kimi-code/mcp.json');
    });

    it('leaves a tracked file tracked and refuses paths outside the workspace', () => {
        const ws = repo();
        ensureLocalGitExclude(ws, join(ws, 'README.md'));
        writeFileSync(join(ws, 'README.md'), 'changed\n');
        expect(status(ws)).toContain('README.md');
        expect(ensureLocalGitExclude(ws, join(tmpdir(), 'elsewhere.json'))).toBe(false);
    });
});
