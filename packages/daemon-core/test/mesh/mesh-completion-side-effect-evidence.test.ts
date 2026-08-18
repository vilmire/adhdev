import { describe, expect, it, vi, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Isolate all mesh file I/O to a per-run temp dir (same pattern as
// mesh-convergence-routing.test.ts) — a fixed machineId makes the node
// created below deterministically "local" to scheduleTaskCompletionSideEffectEvidence's
// resolveLocalDaemonIds() comparison.
const testTmpDir = join(tmpdir(), `adhdev-completion-side-effect-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' }),
}));

import { createMesh, addNode } from '../../src/config/mesh-config.js';
import { readLedgerEntries } from '../../src/mesh/mesh-ledger.js';
import {
    scheduleTaskCompletionSideEffectEvidence,
    checkGitEvidenceSync,
    resolveTaskModeEvidenceStrategy,
    TASK_MODE_EVIDENCE_STRATEGY,
} from '../../src/mesh/mesh-completion-side-effect-evidence.js';
import { MESH_TASK_MODES } from '../../src/mesh/mesh-work-queue.js';

function git(cwd: string, args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function tempRepo(name: string): string {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), `adhdev-ces-${name}-`)));
    git(repo, ['init']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'ADHDev Test']);
    writeFileSync(join(repo, 'README.md'), 'hello\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'initial']);
    return repo;
}

const components = {} as any;
const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    if (existsSync(testTmpDir)) rmSync(testTmpDir, { recursive: true, force: true });
});

function waitForLedgerEntry(meshId: string, taskId: string) {
    return vi.waitFor(() => {
        const entries = readLedgerEntries(meshId, { kind: ['task_completion_no_side_effects'] });
        const match = entries.find(e => e.taskId === taskId || e.payload?.taskId === taskId);
        expect(match).toBeDefined();
        return match!;
    }, { timeout: 5000, interval: 10 });
}

describe('scheduleTaskCompletionSideEffectEvidence', () => {
    it('case 1 — code_change WITH a dirty tree does not append a downgrade entry', async () => {
        const repo = tempRepo('with-commit');
        roots.push(repo);
        // A genuine, still-uncommitted change — getGitRepoStatus reports dirty:true,
        // the ordinary "has evidence" case that must NOT be downgraded.
        writeFileSync(join(repo, 'file.txt'), 'changed\n');

        const mesh = createMesh({ name: 'mesh-with-commit', repoIdentity: 'ces-with-commit' });
        const node = addNode(mesh.id, { workspace: repo, daemonId: 'daemon_test-machine' })!;
        const taskId = `task_${randomUUID().slice(0, 8)}`;

        scheduleTaskCompletionSideEffectEvidence(components, {
            meshId: mesh.id,
            taskId,
            taskMode: 'code_change',
            sessionId: 'sess_1',
            nodeId: node.id,
        });

        // Give the async fire-and-forget check a real chance to run before asserting absence —
        // otherwise a false negative (asserting too early) would look identical to a true pass.
        await new Promise(resolve => setTimeout(resolve, 300));
        const entries = readLedgerEntries(mesh.id, { kind: ['task_completion_no_side_effects'] });
        expect(entries.find(e => e.taskId === taskId)).toBeUndefined();
    });

    it('case 2 — code_change with a CLEAN tree appends a downgrade entry but is purely additive', async () => {
        const repo = tempRepo('clean');
        roots.push(repo);
        // No changes since the initial commit — the "diff 0" completion.

        const mesh = createMesh({ name: 'mesh-clean', repoIdentity: 'ces-clean' });
        const node = addNode(mesh.id, { workspace: repo, daemonId: 'daemon_test-machine' })!;
        const taskId = `task_${randomUUID().slice(0, 8)}`;

        scheduleTaskCompletionSideEffectEvidence(components, {
            meshId: mesh.id,
            taskId,
            taskMode: 'code_change',
            sessionId: 'sess_2',
            nodeId: node.id,
        });

        const entry = await waitForLedgerEntry(mesh.id, taskId);
        expect(entry.payload.gitDirty).toBe(false);
        expect(entry.payload.reason).toBe('no_side_effects');
        expect(entry.payload.workspace).toBe(repo);
        // Diagnostic-only: never its own task-lifecycle kind, never task_completed/task_failed.
        expect(entry.kind).toBe('task_completion_no_side_effects');
    });

    it('case 3 — live_debug_readonly never triggers a git status check at all', async () => {
        const repo = tempRepo('readonly');
        roots.push(repo);

        const mesh = createMesh({ name: 'mesh-readonly', repoIdentity: 'ces-readonly' });
        const node = addNode(mesh.id, { workspace: repo, daemonId: 'daemon_test-machine' })!;
        const taskId = `task_${randomUUID().slice(0, 8)}`;

        scheduleTaskCompletionSideEffectEvidence(components, {
            meshId: mesh.id,
            taskId,
            taskMode: 'live_debug_readonly',
            sessionId: 'sess_3',
            nodeId: node.id,
        });

        await new Promise(resolve => setTimeout(resolve, 300));
        const entries = readLedgerEntries(mesh.id, { kind: ['task_completion_no_side_effects'] });
        expect(entries.find(e => e.taskId === taskId)).toBeUndefined();
    });

    it('skips (fail-open) a node whose daemonId is not this daemon (remote — no P2P from this path)', async () => {
        const repo = tempRepo('remote');
        roots.push(repo);

        const mesh = createMesh({ name: 'mesh-remote', repoIdentity: 'ces-remote' });
        const node = addNode(mesh.id, { workspace: repo, daemonId: 'daemon_some-other-machine' })!;
        const taskId = `task_${randomUUID().slice(0, 8)}`;

        scheduleTaskCompletionSideEffectEvidence(components, {
            meshId: mesh.id,
            taskId,
            taskMode: 'code_change',
            sessionId: 'sess_4',
            nodeId: node.id,
        });

        await new Promise(resolve => setTimeout(resolve, 300));
        const entries = readLedgerEntries(mesh.id, { kind: ['task_completion_no_side_effects'] });
        expect(entries.find(e => e.taskId === taskId)).toBeUndefined();
    });
});

describe('TASK_MODE_EVIDENCE_STRATEGY (structural per-mode registry)', () => {
    it('has an entry for every MeshTaskMode — the module-load-time exhaustiveness assert already ran (this is a redundant, explicit pin)', () => {
        for (const mode of MESH_TASK_MODES) {
            expect(TASK_MODE_EVIDENCE_STRATEGY[mode]).toBeDefined();
            expect(TASK_MODE_EVIDENCE_STRATEGY[mode].mode).toBe(mode);
            expect(typeof TASK_MODE_EVIDENCE_STRATEGY[mode].reason).toBe('string');
            expect(TASK_MODE_EVIDENCE_STRATEGY[mode].reason.length).toBeGreaterThan(0);
        }
    });

    it('code_change is checkable; live_debug_readonly expects no evidence; validation/launch_app/convergence are not_applicable_today', () => {
        expect(TASK_MODE_EVIDENCE_STRATEGY.code_change.kind).toBe('checkable');
        expect(TASK_MODE_EVIDENCE_STRATEGY.live_debug_readonly.kind).toBe('no_evidence_expected');
        expect(TASK_MODE_EVIDENCE_STRATEGY.validation.kind).toBe('not_applicable_today');
        expect(TASK_MODE_EVIDENCE_STRATEGY.launch_app.kind).toBe('not_applicable_today');
        expect(TASK_MODE_EVIDENCE_STRATEGY.convergence.kind).toBe('not_applicable_today');
    });

    it('no registered mode sets notifyOnUnverified — flagging every completion of an entire unverifiable mode would be routine noise (owner-decided)', () => {
        for (const mode of MESH_TASK_MODES) {
            expect(TASK_MODE_EVIDENCE_STRATEGY[mode].notifyOnUnverified).toBe(false);
        }
    });

    it('resolveTaskModeEvidenceStrategy defaults an unrecognized/legacy mode string to not_applicable_today (never silently "verified")', () => {
        const resolved = resolveTaskModeEvidenceStrategy('some_future_mode_not_yet_registered');
        expect(resolved.kind).toBe('not_applicable_today');
        expect(resolved.notifyOnUnverified).toBe(false);
    });

    it('resolveTaskModeEvidenceStrategy defaults an absent mode to not_applicable_today too', () => {
        const resolved = resolveTaskModeEvidenceStrategy(undefined);
        expect(resolved.kind).toBe('not_applicable_today');
    });
});

describe('checkGitEvidenceSync (gap 2 — deeper than clean/dirty)', () => {
    it('reports noEvidenceSinceDispatch:false for a dirty file with no sinceIso reference (falls back to bare dirty check)', () => {
        const repo = tempRepo('sync-no-since');
        roots.push(repo);
        writeFileSync(join(repo, 'file.txt'), 'changed\n');
        const result = checkGitEvidenceSync(repo, undefined, 3000);
        expect(result.checked).toBe(true);
        expect(result.noEvidenceSinceDispatch).toBe(false);
        expect(result.detail.dirty).toBe(true);
    });

    it('reports noEvidenceSinceDispatch:true for a clean, uncommitted-since repo (the base "nothing happened" case)', () => {
        const repo = tempRepo('sync-clean');
        roots.push(repo);
        const result = checkGitEvidenceSync(repo, new Date().toISOString(), 3000);
        expect(result.checked).toBe(true);
        expect(result.noEvidenceSinceDispatch).toBe(true);
        expect(result.detail.dirty).toBe(false);
        expect(result.detail.newCommitSinceDispatch).toBe(false);
    });

    it('fails open (checked:false) for a non-git-repo workspace', () => {
        const dir = join(tmpdir(), `adhdev-ces-not-a-repo-${randomUUID().slice(0, 8)}`);
        mkdirSync(dir, { recursive: true });
        roots.push(dir);
        const result = checkGitEvidenceSync(dir, undefined, 3000);
        expect(result.checked).toBe(false);
    });

    // MTIME SLANT regression (CI-observed 2026-08-18): on Linux kernels with
    // multigrain/coarse file timestamps (ubuntu-latest CI runners) a file written
    // immediately AFTER dispatch can report an mtime slightly BEFORE the fine-grained
    // dispatch timestamp — a strict mtime>=since comparison then false-verdicts
    // "no evidence" (false reviewRecommended on code_change; missed readonly-contract
    // violations). The slant must absorb sub-second clock-source skew...
    it('still attributes a dirty file whose mtime reads slightly BEFORE sinceIso (coarse kernel/fs timestamp skew)', () => {
        const repo = tempRepo('sync-slant');
        roots.push(repo);
        const file = join(repo, 'file.txt');
        writeFileSync(file, 'changed\n');
        // Simulate a coarse-timestamp kernel/fs: the write lands after dispatch, but
        // the observed mtime lags the fine realtime clock (here: 500ms, inside the 1s
        // slant; multigrain tick lag is ~4-10ms, 1s-granularity mounts up to ~1s).
        const past = new Date(Date.now() - 500);
        utimesSync(file, past, past);
        const result = checkGitEvidenceSync(repo, new Date().toISOString(), 3000);
        expect(result.checked).toBe(true);
        expect(result.detail.dirty).toBe(true);
        expect(result.noEvidenceSinceDispatch).toBe(false);
    });

    // ...while a genuinely stale leftover (the tests pin 60s) must remain
    // unattributable — the slant must NOT resurrect it as this task's evidence.
    it('does NOT attribute a dirty file backdated well beyond the slant (stale leftover stays stale)', () => {
        const repo = tempRepo('sync-slant-stale');
        roots.push(repo);
        const file = join(repo, 'stale.txt');
        writeFileSync(file, 'leftover\n');
        const past = new Date(Date.now() - 60_000);
        utimesSync(file, past, past);
        const result = checkGitEvidenceSync(repo, new Date().toISOString(), 3000);
        expect(result.checked).toBe(true);
        expect(result.detail.dirty).toBe(true);
        expect(result.noEvidenceSinceDispatch).toBe(true);
    });
});
