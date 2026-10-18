import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonCommandRouter, type CommandRouterDeps } from '../../src/commands/router.js';
import { createAssistantServices, setAssistantServicesForTests } from '../../src/assistant/assistant-services.js';
import { AssistantDriverStaging } from '../../src/assistant/driver-staging.js';
import { computeDriverTreeDigest, readInstalledDriver } from '../../src/drivers/installed-driver.js';
import { computeProviderTreeDigest } from '../../src/providers/channel/tree-digest.js';
import type { InstalledDriverManifest } from '../../src/drivers/activation-store.js';
import { cleanupTempDir, resetMeshRuntimeStore } from '../helpers/temp-cleanup.js';

let dir: string;
let packageDir: string;
let before: string | undefined;
let router: DaemonCommandRouter;
let svc: ReturnType<typeof createAssistantServices>;
let manifest: InstalledDriverManifest;
const run = (args: Record<string, unknown>, source = 'p2p') => router.execute('assistant_staged_resolve', args, source);
const digest = () => computeDriverTreeDigest(packageDir);
const stage = () => svc.driverStaging!.write(manifest, digest());
const save = () => { const { _sourceTrust, ...raw } = manifest; writeFileSync(join(packageDir, 'provider.v1.json'), JSON.stringify(raw)); };
beforeEach(async () => {
    await resetMeshRuntimeStore();
    dir = mkdtempSync(join(tmpdir(), 'driver-staging-'));
    before = process.env.ADHDEV_CONFIG_DIR;
    process.env.ADHDEV_CONFIG_DIR = dir;
    packageDir = join(dir, 'providers', 'driver', 'browser');
    mkdirSync(packageDir, { recursive: true });
    manifest = { type: 'browser', name: 'Browser', category: 'driver', providerVersion: '1.0.0', _sourceTrust: 'user-custom',
        runtime: { kind: 'mcp-stdio', command: 'node', args: ['server.js'] },
        actions: [{ id: 'snapshot', tool: 'snapshot', risk: 'read' }],
        declaredAccess: { network: ['*'], filesystem: ['workspace'], desktopControl: false } };
    save();
    svc = createAssistantServices({ configDir: dir });
    setAssistantServicesForTests(svc);
    const deps = { commandHandler: { handle: vi.fn(), rejectUnknown: vi.fn() }, cliManager: {}, cdpManagers: new Map(),
        providerLoader: { getMeta: () => manifest, findProviderDir: () => packageDir },
        instanceManager: { getInstance: () => undefined, listInstanceIds: () => [], collectAllStates: () => [] },
        detectedIdes: { value: [] }, sessionRegistry: {}, statusInstanceId: 'test-driver-staging',
        bus: { emit: () => {}, on: () => () => {} },
    } as unknown as CommandRouterDeps;
    router = new DaemonCommandRouter(deps);
});
afterEach(async () => {
    router?.meshNodeStatePusher.stop(); router?.localMeshNodeGitWatch.stop();
    setAssistantServicesForTests(null);
    await cleanupTempDir(dir);
    if (before === undefined) delete process.env.ADHDEV_CONFIG_DIR; else process.env.ADHDEV_CONFIG_DIR = before;
});

describe('driver_activation through the real owner command', () => {
    it('uses the canonical channel tree digest and persists a private proposal in the existing Inbox', async () => {
        expect(digest()).toBe(computeProviderTreeDigest(join(dir, 'providers')));
        const id = stage();
        expect(await run({ action: 'list' })).toMatchObject({ success: true, driverActivations: [{ id, kind: 'driver_activation',
            type: 'browser', trust: 'user-custom', treeDigest: digest(), riskClass: 'low', runtime: manifest.runtime,
            declaredAccess: manifest.declaredAccess }] });
        expect(new AssistantDriverStaging({ configDir: dir }).read(id)).toBeTruthy();
        if (process.platform !== 'win32') expect(statSync(join(svc.driverStaging!.dir, `${id}.json`)).mode & 0o777).toBe(0o600);
        expect(svc.driverActivations!.isReady(manifest.type, digest())).toBe(false);
    });

    it('rejects ipc even when it claims an owner source and leaves the proposal unapproved', async () => {
        const id = stage();
        expect(await run({ id, decision: 'apply', _commandSource: 'p2p' }, 'ipc'))
            .toMatchObject({ success: false, code: 'COMMAND_SOURCE_REJECTED' });
        expect(await run({ action: 'list' }, 'ipc')).toMatchObject({ code: 'COMMAND_SOURCE_REJECTED' });
        expect(svc.driverStaging!.read(id)).toBeTruthy();
        expect(svc.driverActivations!.isReady(manifest.type, digest())).toBe(false);
    });

    it.each(['p2p', 'ws', 'standalone'])('approves exactly the stored digest through %s, once', async source => {
        const id = stage();
        expect(await run({ id, decision: 'apply', treeDigest: 'caller-supplied', type: 'another-driver' }, source))
            .toMatchObject({ success: true, result: 'applied', type: 'browser', treeDigest: digest() });
        expect(svc.driverActivations!.list()[0]).toMatchObject({ approvedBy: 'owner', riskClass: 'low', declaredAccessSnapshot: manifest.declaredAccess });
        expect(svc.driverActivations!.isReady(manifest.type, digest())).toBe(true);
        expect(await run({ id, decision: 'apply' }, source)).toMatchObject({ code: 'staged_not_found' });
    });

    it('rejects changed package bytes; reverting them permits the original proposal', async () => {
        const id = stage();
        const path = join(packageDir, 'provider.v1.json');
        const original = readFileSync(path, 'utf8');
        manifest.runtime.command = 'changed-executable'; save();
        expect(await run({ id, decision: 'apply' })).toMatchObject({ success: false, code: 'stale' });
        expect(svc.driverStaging!.read(id)).toBeTruthy();
        writeFileSync(path, original);
        expect(await run({ id, decision: 'apply' })).toMatchObject({ success: true, result: 'applied' });
    });

    it('does not let a pending proposal clear an owner disable', async () => {
        const id = stage();
        svc.driverActivations!.setDisabled(manifest, digest(), true);
        expect(await run({ id, decision: 'apply' })).toMatchObject({ code: 'driver_disabled' });
        expect(svc.driverStaging!.read(id)).toBeTruthy();
    });

    it('discards without activating or needing the installed package', async () => {
        const id = stage();
        expect(await run({ id, decision: 'discard' })).toMatchObject({ success: true, result: 'discarded' });
        expect(svc.driverStaging!.read(id)).toBeNull();
        expect(svc.driverActivations!.list()).toEqual([]);
    });

    it('expires activation proposals after the existing 14-day staged-write window', () => {
        const old = new AssistantDriverStaging({ configDir: dir, now: () => new Date('2026-01-01') });
        const id = old.write(manifest, digest());
        const current = new AssistantDriverStaging({ configDir: dir, now: () => new Date('2026-01-16') });
        const lookup = vi.fn();
        expect(current.resolve(id, 'apply', svc.driverActivations!, lookup)).toMatchObject({ code: 'expired' });
        expect(lookup).not.toHaveBeenCalled();
    });

    it('can restage an expired proposal instead of permanently reusing its id', () => {
        const old = new AssistantDriverStaging({ configDir: dir, now: () => new Date('2026-01-01') });
        const oldId = old.write(manifest, digest());
        const current = new AssistantDriverStaging({ configDir: dir, now: () => new Date('2026-01-16') });
        const newId = current.write(manifest, digest());
        expect(newId).not.toBe(oldId);
        expect(current.read(oldId)).toBeNull();
        expect(current.list()).toHaveLength(1);
    });

    it('reads on-disk manifest permissions rather than stale loader metadata', () => {
        const before = digest();
        const raw = { ...manifest, declaredAccess: { desktopControl: true } };
        delete raw._sourceTrust;
        writeFileSync(join(packageDir, 'provider.v1.json'), JSON.stringify(raw));
        const current = readInstalledDriver({ getMeta: () => manifest, findProviderDir: () => packageDir }, 'browser');
        expect(current?.treeDigest).not.toBe(before);
        expect(current?.module.declaredAccess).toEqual({ desktopControl: true });
    });
});
