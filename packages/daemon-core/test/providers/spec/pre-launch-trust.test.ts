/**
 * Coverage for pre_launch_trust — the declarative pre-spawn folder-trust step
 * that stops antigravity's `agy` (and any CLI with a first-run "trust this
 * folder?" gate) from blocking in a fresh worktree.
 *
 * The helper idempotently appends the realpath of the launch workspace to the
 * declared trusted-folders array in the CLI's JSON settings file, preserving
 * everything else and never throwing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applyPreLaunchTrust } from '../../../src/providers/spec/pre-launch-trust.js';
import { resolveLaunchTrustPlan } from '../../../src/providers/trust-provenance-ledger.js';
import type { ResolvedTrustPlan } from '../../../src/providers/trust-provenance-ledger.js';

describe('applyPreLaunchTrust', () => {
    let tmp: string;
    let settingsPath: string;
    let workspace: string;

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pretrust-'));
        settingsPath = path.join(tmp, 'settings.json');
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
    });

    afterEach(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
        fs.rmSync(workspace, { recursive: true, force: true });
    });

    function plan(declaredPath = settingsPath) {
        return resolveLaunchTrustPlan({
            provider: 'antigravity-cli',
            workspace,
            trust: { settings_path: declaredPath, key: 'trustedWorkspaces' },
            storeHome: tmp,
            scope: 'user',
            origin: 'user_confirmed',
            sessionKey: 'session-test',
            lifecycle: { kind: 'persistent', expiresAt: null },
        })!;
    }

    it('creates the settings file and adds the workspace realpath', () => {
        const added = applyPreLaunchTrust({ settings_path: settingsPath, key: 'trustedWorkspaces' }, plan());
        const real = fs.realpathSync(workspace);
        expect(added).toBe(real);
        const json = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        expect(json.trustedWorkspaces).toContain(real);
    });

    it('preserves existing settings and trusted entries', () => {
        fs.writeFileSync(settingsPath, JSON.stringify({
            colorScheme: 'light',
            trustedWorkspaces: ['/already/trusted'],
        }), 'utf8');
        applyPreLaunchTrust({ settings_path: settingsPath, key: 'trustedWorkspaces' }, plan());
        const json = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        expect(json.colorScheme).toBe('light');
        expect(json.trustedWorkspaces).toContain('/already/trusted');
        expect(json.trustedWorkspaces).toContain(fs.realpathSync(workspace));
    });

    it('is idempotent — a second call adds nothing and reports no change', () => {
        applyPreLaunchTrust({ settings_path: settingsPath, key: 'trustedWorkspaces' }, plan());
        const second = applyPreLaunchTrust({ settings_path: settingsPath, key: 'trustedWorkspaces' }, plan());
        expect(second).toBeNull();
        const json = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        const real = fs.realpathSync(workspace);
        expect(json.trustedWorkspaces.filter((p: string) => p === real)).toHaveLength(1);
    });

    it('uses the absolute planned store and never re-expands the declaration', () => {
        const trust = { settings_path: '~/.gemini/antigravity-cli/settings.json', key: 'trustedWorkspaces' };
        expect(() => applyPreLaunchTrust(trust, plan())).not.toThrow();
        expect(fs.existsSync(settingsPath)).toBe(true);
    });

    it('does not throw on malformed existing JSON', () => {
        fs.writeFileSync(settingsPath, '{ not valid json', 'utf8');
        expect(() => applyPreLaunchTrust({ settings_path: settingsPath, key: 'trustedWorkspaces' }, plan())).not.toThrow();
    });
});

/**
 * grok_toml_file — the SHARED-store named scheme.
 *
 * The distinction from kimi_workspace_file is load-bearing. kimi writes one
 * file per workspace, so file existence IS the idempotence key. grok writes
 * every trusted folder into one shared `trusted_folders.toml`, so by the time
 * a second workspace launches the file already exists — keying on existence
 * would silently skip every workspace after the first. Idempotence therefore
 * has to be keyed on the `[folders."<realpath>"]` table, and the write has to
 * append so sibling entries (and any explicit `trusted = false` the user set)
 * survive untouched.
 */
describe('applyPreLaunchTrust — grok_toml_file', () => {
    let tmp: string;
    let storePath: string;
    let workspace: string;

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pretrust-grok-'));
        storePath = path.join(tmp, '.grok', 'trusted_folders.toml');
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-grok-'));
    });

    afterEach(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
        fs.rmSync(workspace, { recursive: true, force: true });
    });

    function grokPlan(): ResolvedTrustPlan {
        return {
            provider: 'grok-cli',
            workspaceRealpath: fs.realpathSync(workspace),
            storePath,
            scope: 'user',
            origin: 'user_confirmed',
            sessionKey: 'session-grok',
            lifecycle: { kind: 'persistent', expiresAt: null },
        };
    }

    it('creates the store and writes the folder table for the workspace realpath', () => {
        const added = applyPreLaunchTrust({ scheme: 'grok_toml_file' }, grokPlan());
        const real = fs.realpathSync(workspace);
        expect(added).toBe(real);
        const toml = fs.readFileSync(storePath, 'utf8');
        expect(toml).toContain(`[folders."${real}"]`);
        expect(toml).toMatch(/trusted = true/);
        expect(toml).toMatch(/decided_at = \d+/);
    });

    it('appends to a populated shared store without disturbing existing entries', () => {
        fs.mkdirSync(path.dirname(storePath), { recursive: true });
        fs.writeFileSync(
            storePath,
            '[folders."/already/trusted"]\ntrusted = true\ndecided_at = 111\n',
            'utf8',
        );
        applyPreLaunchTrust({ scheme: 'grok_toml_file' }, grokPlan());
        const toml = fs.readFileSync(storePath, 'utf8');
        expect(toml).toContain('[folders."/already/trusted"]');
        expect(toml).toContain('decided_at = 111');
        expect(toml).toContain(`[folders."${fs.realpathSync(workspace)}"]`);
    });

    it('★writes this workspace even though the shared store already exists', () => {
        // The kimi rule (skip if the file exists) would drop this write entirely.
        fs.mkdirSync(path.dirname(storePath), { recursive: true });
        fs.writeFileSync(storePath, '[folders."/some/other/dir"]\ntrusted = true\n', 'utf8');
        const added = applyPreLaunchTrust({ scheme: 'grok_toml_file' }, grokPlan());
        expect(added).toBe(fs.realpathSync(workspace));
    });

    it('is idempotent per folder — a second call adds no duplicate table', () => {
        applyPreLaunchTrust({ scheme: 'grok_toml_file' }, grokPlan());
        const second = applyPreLaunchTrust({ scheme: 'grok_toml_file' }, grokPlan());
        expect(second).toBeNull();
        const header = `[folders."${fs.realpathSync(workspace)}"]`;
        const occurrences = fs.readFileSync(storePath, 'utf8')
            .split(/\r?\n/)
            .filter((line) => line.trim() === header);
        expect(occurrences).toHaveLength(1);
    });

    it('never flips an existing trusted = false decision', () => {
        const real = fs.realpathSync(workspace);
        fs.mkdirSync(path.dirname(storePath), { recursive: true });
        fs.writeFileSync(storePath, `[folders."${real}"]\ntrusted = false\ndecided_at = 222\n`, 'utf8');
        expect(applyPreLaunchTrust({ scheme: 'grok_toml_file' }, grokPlan())).toBeNull();
        const toml = fs.readFileSync(storePath, 'utf8');
        expect(toml).toContain('trusted = false');
        expect(toml).not.toContain('trusted = true');
    });

    it('separates a table from a store whose last line lacks a trailing newline', () => {
        fs.mkdirSync(path.dirname(storePath), { recursive: true });
        fs.writeFileSync(storePath, '[folders."/no/trailing/newline"]\ntrusted = true', 'utf8');
        applyPreLaunchTrust({ scheme: 'grok_toml_file' }, grokPlan());
        const toml = fs.readFileSync(storePath, 'utf8');
        expect(toml).not.toMatch(/trusted = true\[folders/);
        expect(toml).toContain(`\n[folders."${fs.realpathSync(workspace)}"]`);
    });
});

/**
 * claude_json_projects — the OBJECT-OF-OBJECTS named scheme.
 *
 * Unlike every other scheme, `~/.claude.json`'s `projects[realpath]` value is
 * an object Claude Code itself populates with dozens of session-history
 * fields (mcpServers, lastSessionId, allowedTools, …). The writer must be
 * SPARSE: touch only `hasTrustDialogAccepted` on the one key for this
 * workspace, never inventing or erasing any sibling field.
 */
describe('applyPreLaunchTrust — claude_json_projects', () => {
    let tmp: string;
    let storePath: string;
    let workspace: string;

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pretrust-claude-'));
        storePath = path.join(tmp, '.claude.json');
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-claude-'));
    });

    afterEach(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
        fs.rmSync(workspace, { recursive: true, force: true });
    });

    function claudePlan(): ResolvedTrustPlan {
        return {
            provider: 'claude-cli',
            workspaceRealpath: fs.realpathSync(workspace),
            storePath,
            scope: 'user',
            origin: 'user_confirmed',
            sessionKey: 'session-claude',
            lifecycle: { kind: 'persistent', expiresAt: null },
        };
    }

    it('creates the store and a sparse new project entry', () => {
        const added = applyPreLaunchTrust({ scheme: 'claude_json_projects' }, claudePlan());
        const real = fs.realpathSync(workspace);
        expect(added).toBe(real);
        const json = JSON.parse(fs.readFileSync(storePath, 'utf8'));
        expect(json.projects[real]).toEqual({ hasTrustDialogAccepted: true });
    });

    it('preserves every other top-level key and every sibling project entry', () => {
        fs.writeFileSync(storePath, JSON.stringify({
            theme: 'dark',
            oauthAccount: { emailAddress: 'kjs0116@dstrict.com' },
            projects: {
                '/already/trusted': { hasTrustDialogAccepted: true, lastSessionId: 'abc-123' },
            },
        }), 'utf8');
        applyPreLaunchTrust({ scheme: 'claude_json_projects' }, claudePlan());
        const json = JSON.parse(fs.readFileSync(storePath, 'utf8'));
        expect(json.theme).toBe('dark');
        expect(json.oauthAccount).toEqual({ emailAddress: 'kjs0116@dstrict.com' });
        expect(json.projects['/already/trusted']).toEqual({ hasTrustDialogAccepted: true, lastSessionId: 'abc-123' });
        expect(json.projects[fs.realpathSync(workspace)]).toEqual({ hasTrustDialogAccepted: true });
    });

    it('flips only hasTrustDialogAccepted on an EXISTING entry, keeping every other field', () => {
        const real = fs.realpathSync(workspace);
        fs.writeFileSync(storePath, JSON.stringify({
            projects: {
                [real]: {
                    hasTrustDialogAccepted: false,
                    mcpServers: { foo: { command: 'bar' } },
                    lastCost: 1.23,
                    allowedTools: ['Read', 'Edit'],
                },
            },
        }), 'utf8');
        applyPreLaunchTrust({ scheme: 'claude_json_projects' }, claudePlan());
        const json = JSON.parse(fs.readFileSync(storePath, 'utf8'));
        expect(json.projects[real].hasTrustDialogAccepted).toBe(true);
        expect(json.projects[real].mcpServers).toEqual({ foo: { command: 'bar' } });
        expect(json.projects[real].lastCost).toBe(1.23);
        expect(json.projects[real].allowedTools).toEqual(['Read', 'Edit']);
    });

    it('is idempotent — a second call is a true no-op once already trusted', () => {
        applyPreLaunchTrust({ scheme: 'claude_json_projects' }, claudePlan());
        const second = applyPreLaunchTrust({ scheme: 'claude_json_projects' }, claudePlan());
        expect(second).toBeNull();
    });

    it('does not throw on malformed existing JSON — fails safe and leaves the file untouched', () => {
        // Never rewrite a file we cannot parse — same fail-safe contract as
        // every other scheme in this suite (grok/codex above never repair a
        // malformed store either).
        fs.writeFileSync(storePath, '{ not valid json', 'utf8');
        expect(() => applyPreLaunchTrust({ scheme: 'claude_json_projects' }, claudePlan())).not.toThrow();
        expect(applyPreLaunchTrust({ scheme: 'claude_json_projects' }, claudePlan())).toBeNull();
        expect(fs.readFileSync(storePath, 'utf8')).toBe('{ not valid json');
    });
});
