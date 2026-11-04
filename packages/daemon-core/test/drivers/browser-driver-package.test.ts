/**
 * The shipped browser-playwright driver through the real DriverService gates:
 * read/write/commit tiers, owner approve/reject, mesh policy restriction, redirect
 * refusal and screenshot-as-artifact. The browser itself is replaced by the package's
 * fake MCP server; the real proxy (bin/browser-server.js) runs unmodified.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DriverService } from '../../src/drivers/driver-service.js';
import { DriverActivationStore, type InstalledDriverManifest } from '../../src/drivers/activation-store.js';
import { ManagedMcpProcess } from '../../src/drivers/managed-mcp-process.js';
import { AssistantDriverStaging } from '../../src/assistant/driver-staging.js';
import { DriverActionStaging } from '../../src/drivers/staged-action.js';
import { createSessionLifecycleBus } from '../../src/sessions/lifecycle-bus.js';

const providers = new URL('../../../../../adhdev-providers/', import.meta.url).pathname;
const pkgDir = join(providers, 'driver', 'browser-playwright');
const fake = join(providers, 'tests', 'fixtures', 'fake-playwright-mcp.js');
const present = existsSync(join(pkgDir, 'provider.v1.json')) && existsSync(fake);
const worker = { meshId: 'mesh', taskId: 'task', sessionId: 'session' };

describe.skipIf(!present)('browser-playwright driver package', () => {
    let dir: string; let ws: string; let service: DriverService; let manifest: InstalledDriverManifest;
    let policy: Record<string, { actions: string[] }> | undefined; let registered: string[]; let redirects = '{}';
    const digest = `sha256:${'c'.repeat(64)}`;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'browser-driver-')); ws = mkdtempSync(join(tmpdir(), 'browser-driver-ws-'));
        registered = []; policy = {}; redirects = '{}';
        manifest = { ...JSON.parse(readFileSync(join(pkgDir, 'provider.v1.json'), 'utf8')), _sourceTrust: 'trusted' };
        const activations = new DriverActivationStore({ configDir: dir });
        activations.approve(manifest, digest);
        service = new DriverService({
            registry: { getByCategory: () => [manifest] }, readCurrent: () => ({ module: manifest, treeDigest: digest, cwd: pkgDir }),
            activations, activationStaging: new AssistantDriverStaging({ configDir: dir }), actions: new DriverActionStaging(dir),
            policy: async () => policy, relay: () => ({ ok: true }), bus: createSessionLifecycleBus(),
            // Same runtime as the manifest, plus the test-only names the proxy reads for its fake inner server.
            createProcess: () => new ManagedMcpProcess({ ...manifest.runtime, env: ['ADHDEV_BROWSER_INNER_MCP', 'FAKE_REDIRECTS', 'ADHDEV_BROWSER_ALLOW_PRIVATE'] },
                { cwd: join(dir, 'runtime'), packageDir: pkgDir, env: { ...process.env, ADHDEV_BROWSER_INNER_MCP: fake, FAKE_REDIRECTS: redirects, ADHDEV_BROWSER_ALLOW_PRIVATE: '1' } }),
            artifacts: { resolve: async () => ({ workspaceRoot: ws, register: async (r) => { registered.push(r.relPath);
                return { artifactId: `art_${registered.length}`, sha256: 'a'.repeat(64), sizeBytes: 70 }; } }) },
        });
    });
    afterEach(async () => { await service.close(); rmSync(dir, { recursive: true, force: true }); rmSync(ws, { recursive: true, force: true }); });
    const text = (r: { output?: unknown }) => JSON.stringify(r.output);

    it('runs read and write tiers without approval', async () => {
        const nav = await service.invoke(worker, { type: 'browser-playwright', action: 'navigate', args: { url: 'http://localhost:3000/' } });
        expect(nav).toMatchObject({ success: true });
        expect(text(nav)).toContain('Page URL: http://localhost:3000/');
        expect(await service.invoke(worker, { type: 'browser-playwright', action: 'snapshot', args: {} })).toMatchObject({ success: true });
        expect(await service.invoke(worker, { type: 'browser-playwright', action: 'tabs', args: {} })).toMatchObject({ success: true });
    }, 30_000);

    it('holds commit-tier actions for the owner; apply executes once, discard never runs', async () => {
        const staged = await service.invoke(worker, { type: 'browser-playwright', action: 'click_commit', args: { target: 'e9' } });
        expect(staged).toMatchObject({ success: false, code: 'owner_approval_required' });
        expect(service.stagedActions().map(a => a.action)).toEqual(['click_commit']);
        const applied = await service.resolveAction(String(staged.stagedId), 'apply', 'standalone');
        expect(applied).toMatchObject({ success: true });
        expect(text(applied)).toContain('called browser_click');
        expect(await service.resolveAction(String(staged.stagedId), 'apply', 'standalone')).toMatchObject({ code: 'already_resolved' });
        const second = await service.invoke(worker, { type: 'browser-playwright', action: 'press_enter', args: {} });
        const rejected = await service.resolveAction(String(second.stagedId), 'discard', 'standalone');
        expect(rejected).toMatchObject({ code: 'discarded' });
        expect(service.invocations().filter(r => r.action === 'press_enter')).toHaveLength(0);
    }, 30_000);

    it('lets a mesh restrict the driver to the read tier', async () => {
        policy = { 'browser-playwright': { actions: ['snapshot', 'screenshot', 'console', 'network', 'tabs'] } };
        expect(await service.invoke(worker, { type: 'browser-playwright', action: 'click', args: { target: 'e1' } })).toMatchObject({ code: 'driver_not_allowed_for_mesh' });
        expect(await service.invoke(worker, { type: 'browser-playwright', action: 'snapshot', args: {} })).toMatchObject({ success: true });
    }, 30_000);

    it('rejects arguments outside the closed schemas (filename, scripts, bad urls)', async () => {
        for (const [action, args] of [['screenshot', { filename: 'x.png' }], ['navigate', { url: 'file:///etc/passwd' }],
            ['type', { target: 'e1', text: 'x', submit: true }], ['navigate', {}]] as const) {
            expect(await service.invoke(worker, { type: 'browser-playwright', action, args })).toMatchObject({ code: 'invalid_arguments' });
        }
        expect(await service.invoke(worker, { type: 'browser-playwright', action: 'run_code_unsafe', args: {} })).toMatchObject({ code: 'driver_not_allowed_for_mesh' });
    });

    it('refuses a redirect into a blocked address', async () => {
        redirects = JSON.stringify({ 'http://a.test/r': 'http://169.254.169.254/x' });
        const result = await service.invoke(worker, { type: 'browser-playwright', action: 'navigate', args: { url: 'http://a.test/r' } });
        expect(result).toMatchObject({ success: false });
        expect(text(result)).toContain('metadata_host_blocked');
    }, 30_000);

    it('registers a screenshot as an artifact and never returns base64', async () => {
        const shot = await service.invoke(worker, { type: 'browser-playwright', action: 'screenshot', args: { type: 'png' } });
        expect(shot).toMatchObject({ success: true, artifacts: [{ type: 'image', artifactId: 'art_1' }] });
        expect(text(shot)).not.toContain('iVBORw0KGgo');
        expect(registered[0]).toMatch(/^\.adhdev\/driver-results\/.+\/image-1\.png$/);
    }, 30_000);
});
