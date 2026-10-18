import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DriverActivationStore, type InstalledDriverManifest } from '../../src/drivers/activation-store.js';
import { AssistantDriverStaging } from '../../src/assistant/driver-staging.js';

const A = `sha256:${'a'.repeat(64)}`;
const B = `sha256:${'b'.repeat(64)}`;
const module: InstalledDriverManifest = { type: 'browser', name: 'Browser', category: 'driver', providerVersion: '1.0.0',
    _sourceTrust: 'trusted', runtime: { kind: 'mcp-stdio', command: 'node', args: ['server.js'] },
    actions: [{ id: 'navigate', tool: 'navigate', risk: 'write' }], declaredAccess: { filesystem: ['workspace'], network: ['*'] } };
let dir: string;
let store: DriverActivationStore;
let staging: AssistantDriverStaging;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'driver-activation-'));
    store = new DriverActivationStore({ configDir: dir, now: () => new Date('2026-10-18T12:00:00Z') });
    staging = new AssistantDriverStaging({ configDir: dir });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('DriverActivationStore', () => {
    it('binds approvals to a digest; switching away refuses and reverting restores readiness across restarts', () => {
        expect(store.isReady(module.type, A)).toBe(false);
        const rec = store.autoActivateIfTrustedLow(module, A);
        expect(rec).toMatchObject({ type: 'browser', treeDigest: A, approvedBy: 'bundled', riskClass: 'low',
            approvedAt: '2026-10-18T12:00:00.000Z', declaredAccessSnapshot: module.declaredAccess });
        store = new DriverActivationStore({ configDir: dir });
        expect(store.isReady(module.type, A)).toBe(true);
        expect(store.isReady(module.type, B)).toBe(false);
        expect(store.isReady(module.type, A)).toBe(true);
        store.autoActivateIfTrustedLow(module, B);
        expect(store.isReady(module.type, A)).toBe(true);
        expect(store.isReady(module.type, B)).toBe(true);
        expect(store.list()).toHaveLength(2);
        expect(store.path).toBe(join(dir, 'drivers', 'activations.json'));
        if (process.platform !== 'win32') expect(statSync(store.path).mode & 0o777).toBe(0o600);
    });

    it('disabled wins across updates, prior approvals, store instances and staged approvals until explicit re-enable', () => {
        store.autoActivateIfTrustedLow(module, A);
        store.setDisabled(module, A, true);
        expect(new DriverActivationStore({ configDir: dir }).autoActivateIfTrustedLow(module, B)).toBeNull();
        expect(store.isReady(module.type, A)).toBe(false);
        expect(store.isReady(module.type, B)).toBe(false);
        expect(store.approve(module, B)).toBeNull();
        expect(staging.prepare(module, B, store)).toEqual({ state: 'installed' });
        store.setDisabled(module, B, false);
        expect(store.isReady(module.type, B)).toBe(true);
        expect(store.isReady(module.type, A)).toBe(false);
        expect(store.autoActivateIfTrustedLow(module, A)).toBeTruthy();
    });

    it('can disable an installed but never-approved driver', () => {
        store.setDisabled(module, A, true);
        expect(store.autoActivateIfTrustedLow(module, B)).toBeNull();
        expect(store.isReady(module.type, A)).toBe(false);
    });

    it('keeps trusted elevated installed until an owner toggle creates an approval', () => {
        const elevated = { ...module, declaredAccess: { desktopControl: true } };
        expect(staging.prepare(elevated, A, store)).toEqual({ state: 'installed' });
        expect(store.list()).toEqual([]);
        expect(staging.list()).toEqual([]);
        store.setDisabled(elevated, A, false);
        expect(store.list()[0]).toMatchObject({ approvedBy: 'owner', riskClass: 'elevated' });
        expect(staging.prepare(elevated, A, store)).toEqual({ state: 'ready' });
        expect(staging.prepare(elevated, B, store)).toEqual({ state: 'installed' });
        expect(store.isReady(module.type, B)).toBe(false);
    });

    it.each(['external-spec', 'external-js', 'user-custom', 'unknown'])('stages %s even at low risk, deduplicated by type/digest', trust => {
        const external = { ...module, _sourceTrust: trust };
        expect(store.autoActivateIfTrustedLow(external, A)).toBeNull();
        const result = staging.prepare(external, A, store);
        expect(result).toMatchObject({ state: 'staged', stagedId: expect.any(String) });
        expect(staging.prepare(external, A, store)).toEqual(result);
        expect(staging.list()).toHaveLength(1);
        expect(store.isReady(module.type, A)).toBe(false);
    });

    it('does not turn a never-approved disabled digest into approval when another digest is enabled', () => {
        const elevated = { ...module, declaredAccess: { desktopControl: true } };
        store.setDisabled(elevated, A, true);
        store.setDisabled(elevated, B, false);
        expect(store.isReady(module.type, A)).toBe(false);
        expect(store.isReady(module.type, B)).toBe(true);
    });

    it('snapshots declared access and does not trust a supplied riskClass', () => {
        const candidate = { ...module, declaredAccess: { desktopControl: true }, riskClass: 'low' };
        expect(store.autoActivateIfTrustedLow(candidate, A)).toBeNull();
        store.approve(candidate, A);
        candidate.declaredAccess.desktopControl = false;
        expect(store.list()[0]).toMatchObject({ riskClass: 'elevated', declaredAccessSnapshot: { desktopControl: true } });
    });

    it('fails closed on corruption and preserves its bytes rather than losing a possible disable', () => {
        store.setDisabled(module, A, true);
        writeFileSync(store.path, '{broken');
        expect(store.isReady(module.type, A)).toBe(false);
        expect(() => store.autoActivateIfTrustedLow(module, B)).toThrow();
        expect(readFileSync(store.path, 'utf8')).toBe('{broken');
    });
});
