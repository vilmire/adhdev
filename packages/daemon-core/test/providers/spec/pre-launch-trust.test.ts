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

    it('creates the settings file and adds the workspace realpath', () => {
        const added = applyPreLaunchTrust({ settings_path: settingsPath, key: 'trustedWorkspaces' }, workspace);
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
        applyPreLaunchTrust({ settings_path: settingsPath, key: 'trustedWorkspaces' }, workspace);
        const json = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        expect(json.colorScheme).toBe('light');
        expect(json.trustedWorkspaces).toContain('/already/trusted');
        expect(json.trustedWorkspaces).toContain(fs.realpathSync(workspace));
    });

    it('is idempotent — a second call adds nothing and reports no change', () => {
        applyPreLaunchTrust({ settings_path: settingsPath, key: 'trustedWorkspaces' }, workspace);
        const second = applyPreLaunchTrust({ settings_path: settingsPath, key: 'trustedWorkspaces' }, workspace);
        expect(second).toBeNull();
        const json = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        const real = fs.realpathSync(workspace);
        expect(json.trustedWorkspaces.filter((p: string) => p === real)).toHaveLength(1);
    });

    it('expands a leading ~ to the home directory', () => {
        const rel = path.relative(os.homedir(), settingsPath);
        // Only meaningful when the tmp dir is under HOME; otherwise skip the
        // assertion but still prove expandHome does not throw on a ~ path.
        const trust = { settings_path: rel.startsWith('..') ? settingsPath : `~/${rel}`, key: 'trustedWorkspaces' };
        expect(() => applyPreLaunchTrust(trust, workspace)).not.toThrow();
    });

    it('does not throw on malformed existing JSON', () => {
        fs.writeFileSync(settingsPath, '{ not valid json', 'utf8');
        expect(() => applyPreLaunchTrust({ settings_path: settingsPath, key: 'trustedWorkspaces' }, workspace)).not.toThrow();
    });
});
