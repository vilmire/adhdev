/**
 * Coverage for claude-workspace-trust — the pre-spawn hook that sets
 * `hasTrustDialogAccepted: true` for a workspace in claude-cli's
 * `~/.claude.json` `projects` map, so the first-run "Is this a project you
 * trust" prompt never appears on a fresh worktree clone.
 *
 * claude-cli has NO worker-private HOME (absent from
 * WORKER_PRIVATE_HOME_SPECS), so unlike grok/codex there is no
 * GROK_HOME/CODEX_HOME-equivalent override — a worker's grant always lands in
 * whichever `~/.claude.json` `env.HOME` (or `CLAUDE_CONFIG_DIR`) resolves to.
 * The entry format asserted here was read live from this machine's own real
 * `~/.claude.json` (no values printed) rather than inferred.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applyClaudeWorkspaceTrust, __test__ } from '../../src/providers/claude-workspace-trust.js';

const { isOverBroadRoot } = __test__;

describe('applyClaudeWorkspaceTrust', () => {
    let claudeHome: string;
    let workspace: string;
    const env = () => ({ ...process.env, HOME: claudeHome, CLAUDE_CONFIG_DIR: undefined });
    const storePath = () => path.join(claudeHome, '.claude.json');
    const real = () => fs.realpathSync(workspace);

    beforeEach(() => {
        claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-home-'));
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ws-'));
    });

    afterEach(() => {
        fs.rmSync(claudeHome, { recursive: true, force: true });
        fs.rmSync(workspace, { recursive: true, force: true });
    });

    it('creates the store and a sparse new project entry', () => {
        const registered = applyClaudeWorkspaceTrust(workspace, env());
        expect(registered).toBe(real());

        const json = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
        expect(json.projects[real()]).toEqual({ hasTrustDialogAccepted: true });
    });

    it('records the realpath, not the symlinked path claude-cli was launched with', () => {
        const link = path.join(os.tmpdir(), `claude-link-${Date.now()}`);
        fs.symlinkSync(workspace, link);
        try {
            expect(applyClaudeWorkspaceTrust(link, env())).toBe(real());
            const json = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
            expect(json.projects[real()]).toEqual({ hasTrustDialogAccepted: true });
        } finally {
            fs.rmSync(link, { force: true });
        }
    });

    it('is idempotent — a second call reports no change', () => {
        expect(applyClaudeWorkspaceTrust(workspace, env())).toBe(real());
        const first = fs.readFileSync(storePath(), 'utf8');

        expect(applyClaudeWorkspaceTrust(workspace, env())).toBeNull();
        expect(fs.readFileSync(storePath(), 'utf8')).toBe(first);
    });

    it('preserves every other top-level key and every sibling project entry', () => {
        fs.writeFileSync(storePath(), JSON.stringify({
            theme: 'dark',
            numStartups: 42,
            projects: {
                '/already/trusted': { hasTrustDialogAccepted: true, lastSessionId: 'abc-123', mcpServers: {} },
            },
        }), 'utf8');
        applyClaudeWorkspaceTrust(workspace, env());

        const json = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
        expect(json.theme).toBe('dark');
        expect(json.numStartups).toBe(42);
        expect(json.projects['/already/trusted']).toEqual({
            hasTrustDialogAccepted: true, lastSessionId: 'abc-123', mcpServers: {},
        });
        expect(json.projects[real()]).toEqual({ hasTrustDialogAccepted: true });
    });

    it('flips only hasTrustDialogAccepted on an EXISTING entry, keeping every other field byte-for-byte', () => {
        fs.mkdirSync(path.dirname(storePath()), { recursive: true });
        fs.writeFileSync(storePath(), JSON.stringify({
            projects: {
                [real()]: {
                    hasTrustDialogAccepted: false,
                    mcpServers: { foo: { command: 'bar' } },
                    lastCost: 1.23,
                    allowedTools: ['Read', 'Edit'],
                    exampleFiles: ['a.ts', 'b.ts'],
                },
            },
        }), 'utf8');
        applyClaudeWorkspaceTrust(workspace, env());

        const json = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
        expect(json.projects[real()].hasTrustDialogAccepted).toBe(true);
        expect(json.projects[real()].mcpServers).toEqual({ foo: { command: 'bar' } });
        expect(json.projects[real()].lastCost).toBe(1.23);
        expect(json.projects[real()].allowedTools).toEqual(['Read', 'Edit']);
        expect(json.projects[real()].exampleFiles).toEqual(['a.ts', 'b.ts']);
    });

    it('registers only the launched directory — never a parent', () => {
        const child = path.join(workspace, 'nested');
        fs.mkdirSync(child);
        applyClaudeWorkspaceTrust(child, env());

        const json = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
        expect(json.projects[fs.realpathSync(child)]).toEqual({ hasTrustDialogAccepted: true });
        expect(json.projects[real()]).toBeUndefined();
    });

    it('refuses over-broad roots', () => {
        expect(applyClaudeWorkspaceTrust('/', env())).toBeNull();
        expect(applyClaudeWorkspaceTrust(os.homedir(), env())).toBeNull();
        expect(fs.existsSync(storePath())).toBe(false);
    });

    it('creates the home directory when it does not exist yet', () => {
        fs.rmSync(claudeHome, { recursive: true, force: true });
        expect(applyClaudeWorkspaceTrust(workspace, env())).toBe(real());
        const json = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
        expect(json.projects[real()]).toEqual({ hasTrustDialogAccepted: true });
    });

    it('does not throw on malformed existing JSON — fails safe and leaves the file untouched', () => {
        // Never rewrite a file we cannot parse: the owner's real ~/.claude.json
        // could hold content this function has no authority to discard. Best-
        // effort means swallow-and-log, not "repair" the file with a guess.
        fs.writeFileSync(storePath(), '{ not valid json', 'utf8');
        expect(() => applyClaudeWorkspaceTrust(workspace, env())).not.toThrow();
        expect(applyClaudeWorkspaceTrust(workspace, env())).toBeNull();
        expect(fs.readFileSync(storePath(), 'utf8')).toBe('{ not valid json');
    });

    it('swallows failures rather than blocking launch', () => {
        // Store path occupied by a directory -> readFileSync/rename throws.
        fs.mkdirSync(storePath(), { recursive: true });
        expect(() => applyClaudeWorkspaceTrust(workspace, env())).not.toThrow();
        expect(applyClaudeWorkspaceTrust(workspace, env())).toBeNull();
    });

    it('★follows env.HOME — env.HOME wins over os.homedir() for this worker', () => {
        // claude-cli has no private-HOME axis today, but the resolver still
        // prefers env.HOME first (matching codex/grok's rationale): os.homedir()
        // reads the passwd entry on POSIX and does not follow a launch-time HOME
        // redirect, so preferring it here would silently target the wrong store
        // the moment a private-HOME axis is ever added for claude-cli.
        const otherHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-other-home-'));
        try {
            const registered = applyClaudeWorkspaceTrust(workspace, { ...process.env, HOME: claudeHome });
            expect(registered).toBe(real());
            expect(fs.existsSync(path.join(otherHome, '.claude.json'))).toBe(false);
        } finally {
            fs.rmSync(otherHome, { recursive: true, force: true });
        }
    });

    it('CLAUDE_CONFIG_DIR overrides env.HOME (the CLI itself reads it first)', () => {
        const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-config-dir-'));
        try {
            applyClaudeWorkspaceTrust(workspace, { ...process.env, HOME: claudeHome, CLAUDE_CONFIG_DIR: configDir });
            const store = path.join(configDir, '..', '.claude.json');
            const json = JSON.parse(fs.readFileSync(path.resolve(store), 'utf8'));
            expect(json.projects[real()]).toEqual({ hasTrustDialogAccepted: true });
            expect(fs.existsSync(path.join(claudeHome, '.claude.json'))).toBe(false);
        } finally {
            fs.rmSync(configDir, { recursive: true, force: true });
        }
    });
});

describe('helpers', () => {
    it('treats the filesystem root, home, and relative paths as over-broad', () => {
        expect(isOverBroadRoot('/')).toBe(true);
        expect(isOverBroadRoot('relative/path')).toBe(true);
        expect(isOverBroadRoot(fs.realpathSync(os.homedir()))).toBe(true);
        expect(isOverBroadRoot('/private/tmp/a-real-project')).toBe(false);
    });
});
