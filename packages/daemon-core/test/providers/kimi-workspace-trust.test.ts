/**
 * Coverage for kimi-workspace-trust — the pre-spawn hook that writes kimi's
 * per-workspace trust file so the first-run "trust this folder?" TUI prompt
 * never appears (an unanswered prompt makes kimi exit(0) immediately).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applyKimiWorkspaceTrust, __test__ } from '../../src/providers/kimi-workspace-trust.js';

const { workspaceTrustKey } = __test__;

describe('workspaceTrustKey', () => {
    it('matches the known real key for /Users/vilmire/Work/adhdev', () => {
        expect(workspaceTrustKey('/Users/vilmire/Work/adhdev')).toBe('wd_adhdev_78117b8afba9');
    });

    it('matches known real keys for other captured workspaces', () => {
        expect(workspaceTrustKey('/private/tmp/adhdev-kimi-flip-ws')).toBe('wd_adhdev-kimi-flip-ws_5b16883ed3bf');
        expect(workspaceTrustKey('/Users/vilmire')).toBe('wd_vilmire_0decb91fc05d');
    });

    it('truncates a long basename slug to 40 chars', () => {
        const key = workspaceTrustKey('/tmp/fix-dispatch-idempotency-and-delivery-status');
        expect(key).toBe('wd_fix-dispatch-idempotency-and-delivery-st_ed033ae7d2c3');
        expect(key.split('_')[1].length).toBe(40);
    });
});

describe('applyKimiWorkspaceTrust', () => {
    let kimiHome: string;
    let workspace: string;
    const env = () => ({ ...process.env, KIMI_CODE_HOME: kimiHome });

    beforeEach(() => {
        kimiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-home-'));
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-ws-'));
    });

    afterEach(() => {
        fs.rmSync(kimiHome, { recursive: true, force: true });
        fs.rmSync(workspace, { recursive: true, force: true });
    });

    it('creates the trust file with the expected key and contents', () => {
        const real = fs.realpathSync(workspace);
        const added = applyKimiWorkspaceTrust(workspace, env());
        expect(added).toBe(real);

        const key = workspaceTrustKey(real);
        const filePath = path.join(kimiHome, 'workspace-trust', key);
        expect(fs.existsSync(filePath)).toBe(true);
        const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        expect(json.root).toBe(real);
        expect(typeof json.trustedAt).toBe('number');
    });

    it('is idempotent — does not overwrite an existing trust file', () => {
        const real = fs.realpathSync(workspace);
        const key = workspaceTrustKey(real);
        const dir = path.join(kimiHome, 'workspace-trust');
        fs.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, key);
        fs.writeFileSync(filePath, JSON.stringify({ root: real, trustedAt: 1 }), 'utf8');

        const result = applyKimiWorkspaceTrust(workspace, env());
        expect(result).toBeNull();
        const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        expect(json.trustedAt).toBe(1);
    });

    it('does not throw when the trust dir cannot be written', () => {
        // Point KIMI_CODE_HOME at a path whose parent is actually a file, so
        // mkdirSync must fail.
        const blockerFile = path.join(kimiHome, 'blocker');
        fs.writeFileSync(blockerFile, 'x', 'utf8');
        const badHome = path.join(blockerFile, 'nested');
        expect(() => applyKimiWorkspaceTrust(workspace, { ...process.env, KIMI_CODE_HOME: badHome })).not.toThrow();
        const result = applyKimiWorkspaceTrust(workspace, { ...process.env, KIMI_CODE_HOME: badHome });
        expect(result).toBeNull();
    });

    it('normalizes a symlinked workspace path to its realpath before hashing', () => {
        const target = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-target-'));
        const linkPath = path.join(os.tmpdir(), `kimi-link-${Date.now()}`);
        fs.symlinkSync(target, linkPath);
        try {
            const real = fs.realpathSync(target);
            const added = applyKimiWorkspaceTrust(linkPath, env());
            expect(added).toBe(real);
            const key = workspaceTrustKey(real);
            const filePath = path.join(kimiHome, 'workspace-trust', key);
            expect(fs.existsSync(filePath)).toBe(true);
            const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            expect(json.root).toBe(real);
        } finally {
            fs.rmSync(linkPath, { force: true });
            fs.rmSync(target, { recursive: true, force: true });
        }
    });
});
