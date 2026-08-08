import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { clearAuthCredentials, loadConfig, resetConfig } from '../../src/config/config.js';

// `clearAuthCredentials()` backs two callers that must behave identically:
// `adhdev logout` and the daemon's WS close-code 4013 (dashboard "Remove").
//
// The property under test is the split between CREDENTIALS and IDENTITY.
// `machineId` is an identifier, not a credential — server auth is the adm_
// `machineSecret`, whose hash the server deletes along with the machines row.
// But `mreg_ = sha256(userId:machineId)`, so dropping `machineId` changes the
// registered id and makes the next `setup` INSERT a second machines row rather
// than UPDATE the existing one. That is the "I removed it and it came back"
// symptom this helper exists to prevent, so identity preservation is asserted
// field-by-field rather than as a single smoke check.

let tempDir = '';
let savedConfigDir: string | undefined;

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-clear-auth-'));
    savedConfigDir = process.env.ADHDEV_CONFIG_DIR;
    process.env.ADHDEV_CONFIG_DIR = tempDir;
});

afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR;
    else process.env.ADHDEV_CONFIG_DIR = savedConfigDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = '';
});

/** A fully populated config, as an authenticated machine would have on disk. */
function writeAuthenticatedConfig() {
    fs.writeFileSync(
        path.join(tempDir, 'config.json'),
        JSON.stringify({
            machineId: 'mach_abc123def456',
            registeredMachineId: 'mreg_stableregisteredid',
            machineSecret: 'adm_supersecrettokenvalue',
            userEmail: 'owner@example.com',
            userName: 'Owner',
            machineNickname: 'workstation',
            serverUrl: 'https://self-hosted.example.com',
            selectedIde: 'cursor',
            configuredIdes: ['cursor', 'vscode'],
            enabledIdes: ['cursor'],
            installedExtensions: ['ext-a'],
            ideSettings: { cursor: { port: 9222 } },
            workspaces: [{ id: 'ws1', name: 'main', path: '/tmp/ws1' }],
            defaultWorkspaceId: 'ws1',
            providerSettings: { 'claude-cli': { model: 'opus' } },
            machineProviders: { 'claude-cli': { enabled: true } },
            providerSourceMode: 'normal',
            setupCompleted: true,
        }),
        'utf-8',
    );
}

describe('clearAuthCredentials', () => {
    it('clears the credentials that authenticate to the server', () => {
        writeAuthenticatedConfig();

        clearAuthCredentials();

        const config = loadConfig();
        expect(config.machineSecret).toBeFalsy();
        expect(config.userEmail).toBeNull();
        expect(config.userName).toBeNull();
    });

    it('preserves machineId so re-setup resolves to the SAME mreg_ row', () => {
        writeAuthenticatedConfig();

        clearAuthCredentials();

        // The regression guard: a changed machineId silently becomes a second
        // machines row on the server (INSERT instead of UPDATE).
        expect(loadConfig().machineId).toBe('mach_abc123def456');
    });

    it('preserves registeredMachineId', () => {
        writeAuthenticatedConfig();

        clearAuthCredentials();

        expect(loadConfig().registeredMachineId).toBe('mreg_stableregisteredid');
    });

    it('preserves IDE, workspace, provider and custom serverUrl settings', () => {
        writeAuthenticatedConfig();

        clearAuthCredentials();

        const config = loadConfig();
        expect(config.serverUrl).toBe('https://self-hosted.example.com');
        expect(config.selectedIde).toBe('cursor');
        expect(config.configuredIdes).toEqual(['cursor', 'vscode']);
        expect(config.enabledIdes).toEqual(['cursor']);
        expect(config.installedExtensions).toEqual(['ext-a']);
        expect(config.ideSettings).toEqual({ cursor: { port: 9222 } });
        expect(config.workspaces).toHaveLength(1);
        expect(config.defaultWorkspaceId).toBe('ws1');
        expect(config.providerSettings).toEqual({ 'claude-cli': { model: 'opus' } });
        expect(config.machineProviders).toEqual({ 'claude-cli': { enabled: true } });
        expect(config.machineNickname).toBe('workstation');
    });

    it('is meaningfully narrower than resetConfig, which drops identity and settings', () => {
        // Pins the contrast the 4013 handler depends on. If resetConfig ever
        // started preserving identity this helper would be redundant — and if
        // clearAuthCredentials ever widened to a full reset, the bug returns
        // with both tests above still passing in isolation.
        writeAuthenticatedConfig();
        resetConfig();
        const afterReset = loadConfig();

        expect(afterReset.machineId).not.toBe('mach_abc123def456');
        expect(afterReset.selectedIde).toBeNull();
        expect(afterReset.serverUrl).not.toBe('https://self-hosted.example.com');
    });

    it('is idempotent and safe to run when already logged out', () => {
        writeAuthenticatedConfig();

        clearAuthCredentials();
        expect(() => clearAuthCredentials()).not.toThrow();

        const config = loadConfig();
        expect(config.machineSecret).toBeFalsy();
        expect(config.machineId).toBe('mach_abc123def456');
    });

    it('works on a config that has no credentials to begin with', () => {
        fs.writeFileSync(
            path.join(tempDir, 'config.json'),
            JSON.stringify({ machineId: 'mach_freshmachine0001' }),
            'utf-8',
        );

        expect(() => clearAuthCredentials()).not.toThrow();
        expect(loadConfig().machineId).toBe('mach_freshmachine0001');
    });
});
