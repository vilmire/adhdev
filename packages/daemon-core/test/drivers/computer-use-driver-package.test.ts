/**
 * The shipped computer-use driver through the real DriverService gates: the owner's
 * permission checkboxes, the desktop lease and screenshot-as-artifact. The OS backend
 * is replaced by the package's fake; the real MCP server (bin/computer-server.js) runs
 * unmodified. A real shell command runs for shell_run.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DriverService } from '../../src/drivers/driver-service.js';
import { DriverActivationStore, type InstalledDriverManifest } from '../../src/drivers/activation-store.js';
import { DriverGrantStore } from '../../src/drivers/grant-store.js';
import { ManagedMcpProcess } from '../../src/drivers/managed-mcp-process.js';
import { deriveDriverRiskClass } from '../../src/drivers/risk-class.js';
import { AssistantDriverStaging } from '../../src/assistant/driver-staging.js';
import { DriverActionStaging } from '../../src/drivers/staged-action.js';
import { createSessionLifecycleBus } from '../../src/sessions/lifecycle-bus.js';

const providers = new URL('../../../../../adhdev-providers/', import.meta.url).pathname;
const pkgDir = join(providers, 'driver', 'computer-use');
const fake = join(providers, 'tests', 'fixtures', 'computer-use-fake-backend.js');
const present = existsSync(join(pkgDir, 'provider.v1.json')) && existsSync(fake);
const TYPE = 'computer-use';
const worker = { meshId: 'mesh', taskId: 'task', sessionId: 'session' };
const other = { meshId: 'mesh', taskId: 'task-2', sessionId: 'session-2' };

describe.skipIf(!present)('computer-use driver package', () => {
    let dir: string; let ws: string; let service: DriverService; let manifest: InstalledDriverManifest; let registered: string[];
    const digest = `sha256:${'d'.repeat(64)}`;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'computer-driver-')); ws = mkdtempSync(join(tmpdir(), 'computer-driver-ws-'));
        registered = [];
        manifest = { ...JSON.parse(readFileSync(join(pkgDir, 'provider.v1.json'), 'utf8')), _sourceTrust: 'trusted' };
        service = new DriverService({
            registry: { getByCategory: () => [manifest] }, readCurrent: () => ({ module: manifest, treeDigest: digest, cwd: pkgDir }),
            activations: new DriverActivationStore({ configDir: dir }), grants: new DriverGrantStore({ configDir: dir }),
            activationStaging: new AssistantDriverStaging({ configDir: dir }), actions: new DriverActionStaging(dir),
            policy: async () => ({}), relay: () => ({ ok: true }), bus: createSessionLifecycleBus(),
            createProcess: () => new ManagedMcpProcess({ ...manifest.runtime, env: ['ADHDEV_COMPUTER_BACKEND'] },
                { cwd: join(dir, 'runtime'), packageDir: pkgDir, requestTimeoutMs: manifest.runtime.requestTimeoutMs, env: { ...process.env, ADHDEV_COMPUTER_BACKEND: fake } }),
            artifacts: { resolve: async () => ({ workspaceRoot: ws, register: async r => { registered.push(r.relPath);
                return { artifactId: `art_${registered.length}`, sha256: 'a'.repeat(64), sizeBytes: 70 }; } }) },
        });
    });
    afterEach(async () => { await service.close(); rmSync(dir, { recursive: true, force: true }); rmSync(ws, { recursive: true, force: true }); });

    it('is elevated and never auto-activates, and every desktop or shell action names a declared grant', () => {
        expect(deriveDriverRiskClass(manifest).riskClass).toBe('elevated');
        expect(manifest.grants?.map(g => g.id).sort()).toEqual(['input', 'screen', 'shell']);
        for (const action of manifest.actions) {
            if (action.id === 'status') expect(action.grant).toBeUndefined();
            else expect(['input', 'screen', 'shell']).toContain(action.grant);
            // The owner chose immediate execution: a checked box never stages a per-call approval.
            expect(action.risk).not.toBe('destructive');
        }
        expect(manifest.runtime.env).not.toContain('ADHDEV_COMPUTER_BACKEND');
    });

    it('reports all three boxes unchecked and refuses each until the owner checks it', async () => {
        const entry = (service.getGrants().drivers as Array<{ activation: string; grants: Array<{ id: string; granted: boolean }> }>)[0]!;
        expect(entry.activation).toBe('needs_approval');
        expect(entry.grants.every(g => g.granted === false)).toBe(true);

        // Checking one box activates this trusted driver, and only that box opens.
        expect(service.setGrants(TYPE, { screen: true })).toMatchObject({ success: true, activation: 'ready' });
        expect(await service.invoke(worker, { type: TYPE, action: 'screen_info', args: {} })).toMatchObject({ success: true });
        expect(await service.invoke(worker, { type: TYPE, action: 'click', args: { x: 1, y: 1 } })).toMatchObject({ code: 'driver_grant_required', grant: 'input' });
        expect(await service.invoke(worker, { type: TYPE, action: 'shell_run', args: { command: 'echo no' } })).toMatchObject({ code: 'driver_grant_required', grant: 'shell' });

        // Unchecking applies to the very next call.
        service.setGrants(TYPE, { screen: false });
        expect(await service.invoke(worker, { type: TYPE, action: 'screen_info', args: {} })).toMatchObject({ code: 'driver_grant_required', grant: 'screen' });
    }, 30_000);

    it('runs without per-call approval once checked; status never needs a box', async () => {
        service.setGrants(TYPE, { input: true, shell: true });
        expect(await service.invoke(worker, { type: TYPE, action: 'status', args: {} })).toMatchObject({ success: true });
        expect(await service.invoke(worker, { type: TYPE, action: 'click', args: { x: 1, y: 1 } })).toMatchObject({ success: true });
        const shell = await service.invoke(worker, { type: TYPE, action: 'shell_run', args: { command: 'echo driver-shell-ok' } });
        expect(JSON.stringify(shell.output)).toContain('driver-shell-ok');
        expect(service.stagedActions()).toEqual([]);
    }, 30_000);

    it('holds the desktop for one session, but not for shell_run or status', async () => {
        service.setGrants(TYPE, { screen: true, shell: true });
        expect(await service.invoke(worker, { type: TYPE, action: 'screen_info', args: {} })).toMatchObject({ success: true });
        expect(await service.invoke(other, { type: TYPE, action: 'screen_info', args: {} })).toMatchObject({ code: 'lease_held' });
        expect(await service.invoke(other, { type: TYPE, action: 'status', args: {} })).toMatchObject({ success: true });
        expect(await service.invoke(other, { type: TYPE, action: 'shell_run', args: { command: 'echo free' } })).toMatchObject({ success: true });
    }, 30_000);

    it('stores a screenshot as an artifact with a path the worker can open', async () => {
        service.setGrants(TYPE, { screen: true });
        const shot = await service.invoke(worker, { type: TYPE, action: 'screenshot', args: {} });
        expect(shot).toMatchObject({ success: true });
        const artifact = (shot.artifacts as Array<{ artifactId: string; relPath: string }>)[0]!;
        expect(artifact.artifactId).toBe('art_1');
        expect(artifact.relPath).toMatch(/^\.adhdev\/driver-results\/[^/]+\/image-1\.png$/);
        expect(existsSync(join(ws, artifact.relPath))).toBe(true);
        expect(JSON.stringify(shot.output)).not.toContain('iVBOR');
    }, 30_000);

    it('refuses extra arguments before reaching the backend', async () => {
        service.setGrants(TYPE, { input: true });
        expect(await service.invoke(worker, { type: TYPE, action: 'click', args: { x: 1, y: 1, script: 'x' } })).toMatchObject({ code: 'invalid_arguments' });
    }, 30_000);
});
