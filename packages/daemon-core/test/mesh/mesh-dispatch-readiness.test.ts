/**
 * DISPATCH-READINESS (src/mesh/mesh-dispatch-readiness.ts): before a queue claim opens
 * an attempt on a local worktree node, the workspace is diagnosed without spawning or
 * writing anything; a missing declared build output is prepared by the repo's own
 * bootstrap under the workspace mutation lease (bounded, single-flight, cancellable,
 * refused on lease conflict); readiness is re-derived when source/config changes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    __resetDispatchReadinessForTests,
    currentDispatchReadiness,
    diagnoseDispatchReadiness,
    dispatchReadinessClaimVerdict,
    DISPATCH_READINESS_FRESH_LOCK_MS,
    isDispatchPreparationInFlight,
    prepareDispatchReadiness,
} from '../../src/mesh/mesh-dispatch-readiness.js';
import { isWorkspaceAutoFastForwardInFlight, releaseWorkspaceMutationLease, tryAcquireWorkspaceMutationLease, __resetIdleAutoFastForwardForTests } from '../../src/mesh/mesh-auto-fast-forward.js';
import { validateMeshWorktreeBootstrapConfig } from '../../src/mesh/worktree-bootstrap-config.js';

const OUTPUT = 'packages/core/dist/index.js';
const dirs: string[] = [];

function workspace(opts: { readyOutputs?: string[] | null; originUrl?: string | null } = {}): string {
    const dir = mkdtempSync(join(tmpdir(), 'adhdev-dispatch-readiness-'));
    dirs.push(dir);
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/feature/x\n');
    const url = opts.originUrl === undefined ? 'https://github.com/acme/repo.git' : opts.originUrl;
    writeFileSync(join(dir, '.git', 'config'), `[core]\n\tbare = false\n${url ? `[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n` : ''}`);
    writeFileSync(join(dir, 'package-lock.json'), '{}');
    mkdirSync(join(dir, '.adhdev'), { recursive: true });
    const readyOutputs = opts.readyOutputs === undefined ? [OUTPUT] : opts.readyOutputs;
    writeFileSync(join(dir, '.adhdev', 'worktree_bootstrap.json'), JSON.stringify({
        version: 1, enabled: true, runOnClone: true, required: true,
        staleInputs: ['package-lock.json'],
        ...(readyOutputs ? { readyOutputs } : {}),
        commands: [{ command: 'node', args: ['-e', '0'], category: 'custom', timeoutMs: 60000 }],
    }));
    return dir;
}

function build(dir: string): void {
    mkdirSync(join(dir, 'packages/core/dist'), { recursive: true });
    writeFileSync(join(dir, OUTPUT), 'module.exports = {}');
}

function deferred<T = void>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return { promise, resolve };
}

const flush = () => new Promise(r => setImmediate(r));

beforeEach(() => { __resetDispatchReadinessForTests(); __resetIdleAutoFastForwardForTests(); });
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('diagnosis — read-only, spawn-free', () => {
    it('a missing declared output is a preparable blocker; once present the workspace is ready', () => {
        const dir = workspace();
        const missing = diagnoseDispatchReadiness(dir, { readyOutputs: [OUTPUT] });
        expect(missing.ready).toBe(false);
        expect(missing.blockers).toEqual([expect.objectContaining({ kind: 'missing_build', preparable: true })]);
        build(dir);
        expect(diagnoseDispatchReadiness(dir, { readyOutputs: [OUTPUT] }).ready).toBe(true);
    });

    it('git transport oddities are reported, never held for', () => {
        for (const [url, detail] of [[null, 'no origin remote url'], ['ext::sh -c evil', 'unsupported transport ext::']] as const) {
            const dir = workspace({ originUrl: url });
            build(dir);
            const d = diagnoseDispatchReadiness(dir, { readyOutputs: [OUTPUT] });
            expect(d.ready).toBe(true);
            expect(d.blockers).toEqual([expect.objectContaining({ kind: 'git_transport', detail, preparable: false, transient: false })]);
        }
    });

    it('a fresh index.lock defers (another git is writing); an old one is only reported', () => {
        const dir = workspace();
        build(dir);
        const lock = join(dir, '.git', 'index.lock');
        writeFileSync(lock, '');
        const fresh = diagnoseDispatchReadiness(dir, { readyOutputs: [OUTPUT] });
        expect(fresh.ready).toBe(false);
        expect(fresh.blockers).toEqual([expect.objectContaining({ kind: 'git_locked', transient: true })]);
        const old = (Date.now() - DISPATCH_READINESS_FRESH_LOCK_MS - 60_000) / 1000;
        utimesSync(lock, old, old);
        const stale = diagnoseDispatchReadiness(dir, { readyOutputs: [OUTPUT] });
        expect(stale.ready).toBe(true);
        expect(stale.blockers).toEqual([expect.objectContaining({ kind: 'stale_index_lock' })]);
    });

    it('resolves a linked worktree (.git file → gitdir, commondir)', () => {
        const main = workspace();
        const wt = mkdtempSync(join(tmpdir(), 'adhdev-dispatch-readiness-wt-'));
        dirs.push(wt);
        const wtGit = join(main, '.git', 'worktrees', 'wt');
        mkdirSync(wtGit, { recursive: true });
        writeFileSync(join(wtGit, 'HEAD'), 'ref: refs/heads/wt\n');
        writeFileSync(join(wtGit, 'commondir'), '../..\n');
        writeFileSync(join(wt, '.git'), `gitdir: ${wtGit}\n`);
        writeFileSync(join(wtGit, 'index.lock'), '');
        const d = diagnoseDispatchReadiness(wt);
        expect(d.blockers.map(b => b.kind)).toEqual(['git_locked']); // origin found via commondir config
    });
});

describe('invalidation — readiness follows source/config changes', () => {
    it('reuses the verdict for an unchanged workspace and re-derives it when a staleInput, the bootstrap config or the branch changes', () => {
        const dir = workspace();
        const first = currentDispatchReadiness(undefined, dir);
        expect(currentDispatchReadiness(undefined, dir)).toBe(first);
        const later = (Date.now() + 5_000) / 1000;
        writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion":3}');
        utimesSync(join(dir, 'package-lock.json'), later, later);
        const afterLock = currentDispatchReadiness(undefined, dir);
        expect(afterLock).not.toBe(first);
        expect(afterLock.diagnosis.fingerprint).not.toBe(first.diagnosis.fingerprint);
        writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/other\n');
        expect(currentDispatchReadiness(undefined, dir).diagnosis.fingerprint).not.toBe(afterLock.diagnosis.fingerprint);
    });

    it('a worker commit on the same branch does not change the fingerprint (no re-bootstrap per commit)', () => {
        const dir = workspace();
        const before = currentDispatchReadiness(undefined, dir).diagnosis.fingerprint;
        mkdirSync(join(dir, '.git', 'refs', 'heads', 'feature'), { recursive: true });
        writeFileSync(join(dir, '.git', 'refs', 'heads', 'feature', 'x'), 'a'.repeat(40) + '\n');
        expect(currentDispatchReadiness(undefined, dir).diagnosis.fingerprint).toBe(before);
    });
});

describe('preparation — bounded, under the workspace lease', () => {
    it('runs the bootstrap once under the lease (claims defer meanwhile) and releases it after', async () => {
        const dir = workspace();
        const gate = deferred();
        let runs = 0;
        const runner = async () => { runs += 1; await gate.promise; build(dir); return { status: 'ready' }; };
        const verdict = dispatchReadinessClaimVerdict(undefined, dir, { runner });
        expect(verdict.defer).toBe(true);
        expect(verdict.reason).toMatch(/^dispatch_readiness_preparing: missing build output/);
        expect(isWorkspaceAutoFastForwardInFlight(dir)).toBe(true); // the shared lease blocks claims + auto ff
        expect(dispatchReadinessClaimVerdict(undefined, dir, { runner })).toMatchObject({ defer: true, reason: 'dispatch_readiness_preparing' });
        gate.resolve();
        await flush(); await flush(); await flush();
        expect(runs).toBe(1);
        expect(isDispatchPreparationInFlight(dir)).toBe(false);
        expect(isWorkspaceAutoFastForwardInFlight(dir)).toBe(false);
        expect(dispatchReadinessClaimVerdict(undefined, dir, { runner }).defer).toBe(false);
    });

    it('concurrent preparations of one workspace share a single run', async () => {
        const dir = workspace();
        const gate = deferred();
        let runs = 0;
        const runner = async () => { runs += 1; await gate.promise; build(dir); return { status: 'ready' }; };
        const a = prepareDispatchReadiness(undefined, dir, { runner });
        const b = prepareDispatchReadiness(undefined, dir, { runner });
        gate.resolve();
        expect((await a).outcome).toBe('ready');
        expect((await b).outcome).toBe('ready');
        expect(runs).toBe(1);
    });

    it('a held lease (auto fast-forward) is a conflict: no work at all', async () => {
        const dir = workspace();
        let runs = 0;
        expect(tryAcquireWorkspaceMutationLease(dir)).toBe(true);
        try {
            const result = await prepareDispatchReadiness(undefined, dir, { runner: async () => { runs += 1; return {}; } });
            expect(result.outcome).toBe('conflict');
            expect(runs).toBe(0);
        } finally {
            releaseWorkspaceMutationLease(dir);
        }
    });

    it('cancel stops the wait, but the lease and the claim deferral last until the run itself settles', async () => {
        const dir = workspace();
        const gate = deferred();
        const ac = new AbortController();
        const pending = prepareDispatchReadiness(undefined, dir, { signal: ac.signal, runner: async () => { await gate.promise; return { status: 'failed' }; } });
        ac.abort();
        expect((await pending).outcome).toBe('cancelled');
        expect(isWorkspaceAutoFastForwardInFlight(dir)).toBe(true);
        expect(dispatchReadinessClaimVerdict(undefined, dir).defer).toBe(true);
        gate.resolve();
        await flush(); await flush(); await flush();
        expect(isWorkspaceAutoFastForwardInFlight(dir)).toBe(false);
        // An already-aborted signal does no work.
        let runs = 0;
        const pre = new AbortController(); pre.abort();
        expect((await prepareDispatchReadiness(undefined, dir, { signal: pre.signal, runner: async () => { runs += 1; return {}; } })).outcome).toBe('cancelled');
        expect(runs).toBe(0);
    });

    it('a preparation exceeding its bound fails; the run still holds the lease until it settles', async () => {
        const dir = workspace();
        const gate = deferred();
        const result = await prepareDispatchReadiness(undefined, dir, { maxMs: 10, runner: async () => { await gate.promise; return {}; } });
        expect(result).toMatchObject({ outcome: 'failed', detail: 'preparation exceeded its bound' });
        expect(isWorkspaceAutoFastForwardInFlight(dir)).toBe(true);
        gate.resolve();
        await flush(); await flush(); await flush();
        expect(isWorkspaceAutoFastForwardInFlight(dir)).toBe(false);
    });

    it('a failed preparation fails open for that workspace state — never a re-run loop — until the state changes', async () => {
        const dir = workspace();
        let runs = 0;
        const runner = async () => { runs += 1; return { status: 'failed', error: 'npm ci exited 1' }; };
        expect(dispatchReadinessClaimVerdict(undefined, dir, { runner }).defer).toBe(true);
        await flush(); await flush(); await flush();
        const open = dispatchReadinessClaimVerdict(undefined, dir, { runner });
        expect(open.defer).toBe(false);
        expect(open.reason).toMatch(/^dispatch_readiness_preparation_failed: bootstrap failed: npm ci exited 1/);
        dispatchReadinessClaimVerdict(undefined, dir, { runner });
        expect(runs).toBe(1);
        const later = (Date.now() + 5_000) / 1000;
        writeFileSync(join(dir, 'package-lock.json'), '{"changed":true}');
        utimesSync(join(dir, 'package-lock.json'), later, later);
        expect(dispatchReadinessClaimVerdict(undefined, dir, { runner }).defer).toBe(true);
        await flush(); await flush(); await flush();
        expect(runs).toBe(2);
    });

    it('a repo that declares no readyOutputs is never deferred or prepared', async () => {
        const dir = workspace({ readyOutputs: null });
        let runs = 0;
        expect(dispatchReadinessClaimVerdict(undefined, dir, { runner: async () => { runs += 1; return {}; } }).defer).toBe(false);
        expect((await prepareDispatchReadiness(undefined, dir, { runner: async () => { runs += 1; return {}; } })).outcome).not.toBe('ready');
        expect(runs).toBe(0);
    });
});

describe('config', () => {
    it('readyOutputs must be workspace-relative', () => {
        const base = { version: 1, commands: [{ command: 'node', args: ['-e', '0'] }] };
        expect(validateMeshWorktreeBootstrapConfig({ ...base, readyOutputs: [OUTPUT] }).valid).toBe(true);
        for (const bad of [['../outside'], ['/abs/path'], ['C:/x'], [''], 'dist/x']) {
            expect(validateMeshWorktreeBootstrapConfig({ ...base, readyOutputs: bad }).valid).toBe(false);
        }
    });
});

describe('claim-path wiring', () => {
    it('tryAssignQueueTask consults readiness for local worktree nodes BEFORE claiming a task or opening an attempt', async () => {
        const { readFileSync } = await import('node:fs');
        const src = readFileSync(join(__dirname, '../../src/mesh/mesh-queue-assignment.ts'), 'utf8');
        const body = src.slice(src.indexOf('export function tryAssignQueueTask('));
        const gate = body.indexOf('dispatchReadinessClaimVerdict(');
        expect(gate).toBeGreaterThan(0);
        expect(body.slice(Math.max(0, gate - 400), gate)).toContain('node?.isLocalWorktree === true');
        expect(gate).toBeLessThan(body.indexOf('claimNextTask('));
        expect(gate).toBeLessThan(body.indexOf('openClaimAttempt('));
    });
});
