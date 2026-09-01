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
