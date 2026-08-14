import { describe, expect, it, vi, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
import { scheduleTaskCompletionSideEffectEvidence } from '../../src/mesh/mesh-completion-side-effect-evidence.js';

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
