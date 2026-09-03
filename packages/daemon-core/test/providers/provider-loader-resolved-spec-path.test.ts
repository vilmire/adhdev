/**
 * Regression coverage for the `_resolvedSpecPath` carrier field.
 *
 * Root cause this guards (agy folder-trust stall): `resolve()` deep-clones the
 * map entry (`JSON.parse(JSON.stringify(base))`) and assigns
 * `_resolvedSpecPath` to the CLONE. `getMeta()` returns the map entry, which
 * therefore never carries the field. The delegated (mesh worker) launch path
 * read it off `getMeta()`, so `loadPreLaunchTrustFromSpecPath(undefined)`
 * always returned null, no worker-auto trust grant was ever ledgered, and
 * every fresh worktree hit antigravity's "Do you trust the contents of this
 * project?" prompt with no reachable approval surface.
 *
 * The contract asserted here: whichever accessor a launch path uses, a
 * provider that ships a spec file must expose the resolved spec path.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ProviderLoader } from '../../src/providers/provider-loader.js';
import { loadPreLaunchTrustFromSpecPath } from '../../src/providers/trust-provenance-ledger.js';

const TYPE = 'trust-probe-cli';

function writeProviderWithSpec(root: string): void {
    const dir = join(root, 'cli', TYPE);
    mkdirSync(join(dir, 'specs'), { recursive: true });
    writeFileSync(join(dir, 'provider.json'), JSON.stringify({
        type: TYPE,
        name: TYPE,
        displayName: 'Trust Probe CLI',
        category: 'cli',
        spawn: { command: 'trust-probe', args: [] },
        compatibility: [{ spec: 'specs/4.0.json' }],
    }, null, 2), 'utf-8');
    writeFileSync(join(dir, 'specs', '4.0.json'), JSON.stringify({
        version: '4.0',
        pre_launch_trust: {
            settings_path: '~/.trust-probe/settings.json',
            key: 'trustedWorkspaces',
        },
        states: [{ id: 'idle', label: 'Idle' }],
    }, null, 2), 'utf-8');
}

describe('_resolvedSpecPath is reachable from every provider accessor', () => {
    let userDir = '';

    beforeEach(() => {
        userDir = mkdtempSync(join(tmpdir(), 'adhdev-resolved-spec-path-'));
        writeProviderWithSpec(userDir);
    });

    afterEach(() => {
        if (userDir) rmSync(userDir, { recursive: true, force: true });
    });

    it('exposes the spec path without requiring a prior resolve()', () => {
        const loader = new ProviderLoader({ userDir, disableUpstream: true, channelStore: null });
        loader.loadAll();

        // A getMeta() holder has no spec path on the object itself — that is
        // the trap. The accessor is the supported way to get it.
        const meta = loader.getMeta(TYPE) as { _resolvedSpecPath?: string } | undefined;
        expect(meta, 'provider must be loaded').toBeTruthy();
        expect(meta?._resolvedSpecPath, 'the hidden field is NOT on the map entry').toBeUndefined();

        expect(loader.getResolvedSpecPath(TYPE), 'accessor must resolve the spec path').toBeTruthy();
    });

    it('lets the delegated launch path load pre_launch_trust for the provider', () => {
        const loader = new ProviderLoader({ userDir, disableUpstream: true, channelStore: null });
        loader.loadAll();

        const trust = loadPreLaunchTrustFromSpecPath(loader.getResolvedSpecPath(TYPE) ?? undefined);

        // Before the fix this was null, so resolvedTrustPlan stayed null and
        // the worker was launched with no workspace trust at all.
        expect(trust).toEqual({
            settings_path: '~/.trust-probe/settings.json',
            key: 'trustedWorkspaces',
        });
    });
});
