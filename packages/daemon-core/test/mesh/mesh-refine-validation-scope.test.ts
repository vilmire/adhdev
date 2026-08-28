import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runMeshRefineValidationGate } from '../../src/mesh/mesh-refine-gates.js';

// Directly exercises the validation gate's coarse change-impact scoping (a) and its
// graceful missing-deps continuation (b) without the full async refine orchestration.
describe('runMeshRefineValidationGate change-impact scoping', () => {
    const roots: string[] = [];
    afterEach(() => {
        for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    });

    function workspace(opts: { withNodeModules?: boolean } = {}): string {
        const dir = mkdtempSync(join(tmpdir(), 'adhdev-refine-scope-'));
        roots.push(dir);
        writeFileSync(join(dir, 'package.json'), JSON.stringify({
            scripts: {
                typecheck: 'node ok.js',
                'test:web-core': 'node ok.js',
                'test:daemon-core': 'node ok.js',
            },
        }, null, 2), 'utf-8');
        // A lockfile makes dependenciesLikelyMissing() fire when node_modules is absent.
        writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {} }), 'utf-8');
        writeFileSync(join(dir, 'ok.js'), 'process.exit(0)\n', 'utf-8');
        // A plain node script that needs no node_modules — stands in for
        // scripts/check-vendor-drift.mjs.
        writeFileSync(join(dir, 'check-vendor-drift.mjs'), 'process.exit(0)\n', 'utf-8');
        if (opts.withNodeModules) mkdirSync(join(dir, 'node_modules'), { recursive: true });
        return dir;
    }

    function meshWith(commands: Array<{ command: string; args?: string[]; category?: string }>): any {
        return {
            id: 'mesh-scope',
            policy: {
                refineConfig: {
                    version: 1,
                    validation: { required: true, bootstrap: 'skip', commands },
                },
            },
        };
    }

    it('(a) web-only impact skips daemon-scoped commands but still runs web + typecheck', async () => {
        const ws = workspace({ withNodeModules: true });
        const mesh = meshWith([
            { command: 'npm', args: ['run', 'typecheck'], category: 'typecheck' },
            { command: 'npm', args: ['run', 'test:web-core'], category: 'test' },
            { command: 'npm', args: ['run', 'test:daemon-core'], category: 'test' },
            { command: 'node', args: ['check-vendor-drift.mjs'], category: 'custom' },
        ]);

        const summary = await runMeshRefineValidationGate(mesh, ws, {
            changeImpact: { isDaemonAffecting: false, affectedPackages: ['web-core'] },
        });

        expect(summary.status).toBe('passed');
        const byCommand = new Map(summary.commandsRun.map((c: any) => [c.displayCommand, c]));
        // typecheck + web-core actually ran (not skipped).
        expect(byCommand.get('npm run typecheck')).toMatchObject({ passed: true });
        expect(byCommand.get('npm run typecheck')?.skipped).toBeUndefined();
        expect(byCommand.get('npm run test:web-core')).toMatchObject({ passed: true });
        expect(byCommand.get('npm run test:web-core')?.skipped).toBeUndefined();
        // daemon-core test + vendor-drift skipped as unaffected daemon scope, visibly.
        expect(byCommand.get('npm run test:daemon-core')).toMatchObject({ skipped: true, skipReason: 'unaffected_daemon_scope' });
        expect(byCommand.get('node check-vendor-drift.mjs')).toMatchObject({ skipped: true, skipReason: 'unaffected_daemon_scope' });
        expect(summary.changeImpact).toMatchObject({
            isDaemonAffecting: false,
            skippedDaemonCommands: ['npm run test:daemon-core', 'node check-vendor-drift.mjs'],
        });
    });

    it('(a) daemon-affecting impact runs the full command set (nothing skipped)', async () => {
        const ws = workspace({ withNodeModules: true });
        const mesh = meshWith([
            { command: 'npm', args: ['run', 'typecheck'], category: 'typecheck' },
            { command: 'npm', args: ['run', 'test:daemon-core'], category: 'test' },
            { command: 'node', args: ['check-vendor-drift.mjs'], category: 'custom' },
        ]);

        const summary = await runMeshRefineValidationGate(mesh, ws, {
            changeImpact: { isDaemonAffecting: true, affectedPackages: ['daemon-core'] },
        });

        expect(summary.status).toBe('passed');
        expect(summary.commandsRun.every((c: any) => !c.skipped)).toBe(true);
        expect(summary.commandsRun.map((c: any) => c.displayCommand)).toEqual([
            'npm run typecheck',
            'npm run test:daemon-core',
            'node check-vendor-drift.mjs',
        ]);
    });

    it('(b) a package-manager daemon command that would hit missing-deps is filtered out before the deps check, so a runnable web command still passes', async () => {
        // No node_modules → the daemon-scoped `npm run test:daemon-core` would hit the
        // missing-deps hard-block if it ran. Under web-only impact it is filtered out
        // BEFORE the deps check, so the runnable no-dep web command passes the gate.
        const ws = workspace({ withNodeModules: false });
        const mesh = meshWith([
            { command: 'npm', args: ['run', 'test:daemon-core'], category: 'test' },
            // A plain-node web-side check needs no node_modules and is not daemon-scoped.
            { command: 'node', args: ['ok.js'], category: 'test' },
        ]);

        const summary = await runMeshRefineValidationGate(mesh, ws, {
            changeImpact: { isDaemonAffecting: false, affectedPackages: ['web-core'] },
        });

        expect(summary.status).toBe('passed');
        const web = summary.commandsRun.find((c: any) => c.displayCommand === 'node ok.js');
        expect(web).toMatchObject({ passed: true });
        expect(web?.skipped).toBeUndefined();
        const daemon = summary.commandsRun.find((c: any) => c.displayCommand === 'npm run test:daemon-core');
        expect(daemon).toMatchObject({ skipped: true, skipReason: 'unaffected_daemon_scope' });
    });

    it('(b) a genuinely missing-deps command no longer aborts a following no-dep command; gate still fails missing_dependencies', async () => {
        // No change-impact → no scoping. typecheck needs deps that are absent (blocked),
        // but the following no-dep check must still run, and the gate surfaces the real
        // missing-deps block at the end.
        const ws = workspace({ withNodeModules: false });
        const mesh = meshWith([
            { command: 'npm', args: ['run', 'typecheck'], category: 'typecheck' },
            { command: 'node', args: ['check-vendor-drift.mjs'], category: 'custom' },
        ]);

        const summary = await runMeshRefineValidationGate(mesh, ws);

        expect(summary.status).toBe('failed');
        expect(summary.failureCode).toBe('missing_dependencies');
        const typecheck = summary.commandsRun.find((c: any) => c.displayCommand === 'npm run typecheck');
        expect(typecheck).toMatchObject({ skipped: true, failureKind: 'missing_dependencies' });
        // The no-dep command was NOT aborted — it ran to completion.
        const drift = summary.commandsRun.find((c: any) => c.displayCommand === 'node check-vendor-drift.mjs');
        expect(drift).toMatchObject({ passed: true });
    });

    it('fails open (runs full set) when no change-impact is provided', async () => {
        const ws = workspace({ withNodeModules: true });
        const mesh = meshWith([
            { command: 'npm', args: ['run', 'typecheck'], category: 'typecheck' },
            { command: 'npm', args: ['run', 'test:daemon-core'], category: 'test' },
        ]);

        const summary = await runMeshRefineValidationGate(mesh, ws);

        expect(summary.status).toBe('passed');
        expect(summary.commandsRun.every((c: any) => !c.skipped)).toBe(true);
        expect(summary.changeImpact).toBeUndefined();
    });

    // ── DOCS-ROOT: change-area (none|web|daemon) scoping ──────────────────────────

    it('DOCS-ROOT: a docs-only branch (changeArea=none) skips every un-scoped code command and runs only the docs-scoped profile', async () => {
        const ws = workspace({ withNodeModules: true });
        // Add a docs:verify script scoped to 'none' (docs-only). The code commands carry
        // no scopes → they run in web/daemon but NOT on a docs-only branch.
        writeFileSync(join(ws, 'package.json'), JSON.stringify({
            scripts: {
                typecheck: 'node ok.js',
                'test:web-core': 'node ok.js',
                'docs:verify': 'node ok.js',
            },
        }, null, 2), 'utf-8');
        const mesh = meshWith([
            { command: 'npm', args: ['run', 'typecheck'], category: 'typecheck' },
            { command: 'npm', args: ['run', 'test:web-core'], category: 'test' },
            { command: 'npm', args: ['run', 'docs:verify'], category: 'custom', scopes: ['none'] } as any,
        ]);

        const summary = await runMeshRefineValidationGate(mesh, ws, {
            changeImpact: { isDaemonAffecting: false, affectedPackages: [], changeArea: 'none' },
        });

        expect(summary.status).toBe('passed');
        const byCommand = new Map(summary.commandsRun.map((c: any) => [c.displayCommand, c]));
        // The docs-scoped command ran; the two un-scoped code commands were skipped.
        expect(byCommand.get('npm run docs:verify')).toMatchObject({ passed: true });
        expect(byCommand.get('npm run docs:verify')?.skipped).toBeUndefined();
        expect(byCommand.get('npm run typecheck')).toMatchObject({ skipped: true, skipReason: 'unaffected_change_scope', changeArea: 'none' });
        expect(byCommand.get('npm run test:web-core')).toMatchObject({ skipped: true, skipReason: 'unaffected_change_scope', changeArea: 'none' });
        expect(summary.changeImpact).toMatchObject({
            changeArea: 'none',
            skippedScopeCommands: ['npm run typecheck', 'npm run test:web-core'],
        });
    });

    it('DOCS-ROOT: a docs-only branch with no docs-scoped command runs nothing and passes trivially (no code validation)', async () => {
        const ws = workspace({ withNodeModules: true });
        const mesh = meshWith([
            { command: 'npm', args: ['run', 'typecheck'], category: 'typecheck' },
            { command: 'npm', args: ['run', 'test:web-core'], category: 'test' },
        ]);

        const summary = await runMeshRefineValidationGate(mesh, ws, {
            changeImpact: { isDaemonAffecting: false, affectedPackages: [], changeArea: 'none' },
        });

        // Nothing to validate on a docs-only branch → all commands skipped, gate passes.
        expect(summary.status).toBe('passed');
        expect(summary.commandsRun.every((c: any) => c.skipped === true && c.skipReason === 'unaffected_change_scope')).toBe(true);
    });

    it('DOCS-ROOT: an explicit scope excludes a command on a web branch, and a none-scoped docs command does not run on a web branch', async () => {
        const ws = workspace({ withNodeModules: true });
        writeFileSync(join(ws, 'package.json'), JSON.stringify({
            scripts: {
                typecheck: 'node ok.js',
                'docs:verify': 'node ok.js',
            },
        }, null, 2), 'utf-8');
        const mesh = meshWith([
            // Runs on web + daemon, never docs-only.
            { command: 'npm', args: ['run', 'typecheck'], category: 'typecheck', scopes: ['web', 'daemon'] } as any,
            // Docs-only command must NOT run on a web branch.
            { command: 'npm', args: ['run', 'docs:verify'], category: 'custom', scopes: ['none'] } as any,
        ]);

        const summary = await runMeshRefineValidationGate(mesh, ws, {
            changeImpact: { isDaemonAffecting: false, affectedPackages: ['web-core'], changeArea: 'web' },
        });

        expect(summary.status).toBe('passed');
        const byCommand = new Map(summary.commandsRun.map((c: any) => [c.displayCommand, c]));
        expect(byCommand.get('npm run typecheck')).toMatchObject({ passed: true });
        expect(byCommand.get('npm run typecheck')?.skipped).toBeUndefined();
        expect(byCommand.get('npm run docs:verify')).toMatchObject({ skipped: true, skipReason: 'unaffected_change_scope', changeArea: 'web' });
    });

    it('DOCS-ROOT: fail-open — unknown change area (no changeArea) runs the full set even with scopes present', async () => {
        const ws = workspace({ withNodeModules: true });
        writeFileSync(join(ws, 'package.json'), JSON.stringify({
            scripts: { typecheck: 'node ok.js', 'docs:verify': 'node ok.js' },
        }, null, 2), 'utf-8');
        const mesh = meshWith([
            { command: 'npm', args: ['run', 'typecheck'], category: 'typecheck', scopes: ['web', 'daemon'] } as any,
            { command: 'npm', args: ['run', 'docs:verify'], category: 'custom', scopes: ['none'] } as any,
        ]);

        // changeImpact provided WITHOUT changeArea → scope filtering is disabled (fail-open).
        const summary = await runMeshRefineValidationGate(mesh, ws, {
            changeImpact: { isDaemonAffecting: false, affectedPackages: [] } as any,
        });

        expect(summary.status).toBe('passed');
        expect(summary.commandsRun.every((c: any) => !c.skipped)).toBe(true);
    });

    // ── Single-value scope (['daemon'] or ['web'] alone) — the shape shipped in the
    // repo's own .adhdev/refine.json for daemon-core/daemon-cloud/mcp-server/seqscribe
    // vs. web-core/web-cloud commands. Distinct from the ['web','daemon'] pair already
    // covered above: a single-value scope must exclude the OTHER single change area,
    // not just 'none'.

    it("DOCS-ROOT: a command scoped ['daemon'] only is skipped on a web-only branch", async () => {
        const ws = workspace({ withNodeModules: true });
        const mesh = meshWith([
            { command: 'npm', args: ['run', 'test:web-core'], category: 'test', scopes: ['web'] } as any,
            { command: 'npm', args: ['run', 'test:daemon-core'], category: 'test', scopes: ['daemon'] } as any,
        ]);

        const summary = await runMeshRefineValidationGate(mesh, ws, {
            changeImpact: { isDaemonAffecting: false, affectedPackages: ['web-core'], changeArea: 'web' },
        });

        expect(summary.status).toBe('passed');
        const byCommand = new Map(summary.commandsRun.map((c: any) => [c.displayCommand, c]));
        expect(byCommand.get('npm run test:web-core')).toMatchObject({ passed: true });
        expect(byCommand.get('npm run test:web-core')?.skipped).toBeUndefined();
        expect(byCommand.get('npm run test:daemon-core')).toMatchObject({
            skipped: true,
            skipReason: 'unaffected_change_scope',
            changeArea: 'web',
        });
    });

    it("DOCS-ROOT: a command scoped ['web'] only is skipped on a daemon-affecting branch", async () => {
        const ws = workspace({ withNodeModules: true });
        const mesh = meshWith([
            { command: 'npm', args: ['run', 'test:web-core'], category: 'test', scopes: ['web'] } as any,
            { command: 'npm', args: ['run', 'test:daemon-core'], category: 'test', scopes: ['daemon'] } as any,
        ]);

        const summary = await runMeshRefineValidationGate(mesh, ws, {
            changeImpact: { isDaemonAffecting: true, affectedPackages: ['daemon-core'], changeArea: 'daemon' },
        });

        expect(summary.status).toBe('passed');
        const byCommand = new Map(summary.commandsRun.map((c: any) => [c.displayCommand, c]));
        expect(byCommand.get('npm run test:daemon-core')).toMatchObject({ passed: true });
        expect(byCommand.get('npm run test:daemon-core')?.skipped).toBeUndefined();
        expect(byCommand.get('npm run test:web-core')).toMatchObject({
            skipped: true,
            skipReason: 'unaffected_change_scope',
            changeArea: 'daemon',
        });
    });
});
