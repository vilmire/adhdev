/**
 * Regression: the patch-equivalence gate must not be capped by the size of the
 * patch it inspects.
 *
 * `computeGitPatchId` used to buffer the full `git diff` output in this process
 * (execFileSync with maxBuffer = REFINE_PATCH_EQUIVALENCE_OUTPUT_LIMIT_BYTES,
 * 4 MB) before piping it into `git patch-id`. A vendored bundle pushed the diff
 * to ~26 MB, execFileSync threw ENOBUFS, and the gate's outer catch converted
 * that pure I/O failure into `status: 'failed'` — reporting a genuinely
 * patch-equivalent branch as a divergence, with no cause recorded in the daemon
 * log. Two consecutive root convergences were false-blocked this way.
 *
 * The patch is now streamed via a temp file so only the ~50-byte patch-id
 * crosses the process boundary. These tests pin both halves of the contract:
 * a large-but-equivalent branch passes, and a genuinely inequivalent one still
 * fails (the gate must not be weakened into always-passing).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runMeshRefinePatchEquivalenceGate } from '../../src/mesh/mesh-refine-gates.js';

const REPOS: string[] = [];

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function initRepo(): string {
    const repo = mkdtempSync(join(tmpdir(), 'adhdev-pe-large-'));
    REPOS.push(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'test');
    return repo;
}

afterEach(() => {
    while (REPOS.length > 0) rmSync(REPOS.pop()!, { recursive: true, force: true });
});

describe('patch-equivalence gate — large diffs', () => {
    it('passes an equivalent branch whose diff far exceeds the 4 MB output buffer', async () => {
        const repo = initRepo();
        writeFileSync(join(repo, 'seed.txt'), 'seed\n');
        git(repo, 'add', '.');
        git(repo, 'commit', '-qm', 'base');
        const baseHead = git(repo, 'rev-parse', 'HEAD').trim();

        // ~12 MB of added lines: comfortably over the 4 MB maxBuffer that used
        // to make this throw ENOBUFS, while staying quick to generate.
        git(repo, 'checkout', '-qb', 'feat');
        const bulk = Array.from({ length: 200_000 }, (_, i) => `line ${i} ${'x'.repeat(50)}`).join('\n');
        writeFileSync(join(repo, 'vendor-bundle.js'), `${bulk}\n`);
        git(repo, 'add', '.');
        git(repo, 'commit', '-qm', 'add large vendored bundle');
        const branchHead = git(repo, 'rev-parse', 'HEAD').trim();

        // Sanity: the diff really is bigger than the old cap, otherwise this
        // test would pass even against the buffered implementation.
        const diffBytes = Buffer.byteLength(
            git(repo, 'diff', '--patch', '--full-index', baseHead, branchHead),
        );
        expect(diffBytes).toBeGreaterThan(4 * 1024 * 1024);

        const r = await runMeshRefinePatchEquivalenceGate(repo, baseHead, branchHead);
        expect(r.error).toBeUndefined();
        expect(r.status).toBe('passed');
        expect(r.equivalent).toBe(true);
        expect(r.expectedPatchId).toBeTruthy();
        expect(r.expectedPatchId).toBe(r.actualPatchId);
    }, 120_000);

    it('still fails a branch that is NOT patch-equivalent (gate not weakened)', async () => {
        const repo = initRepo();
        writeFileSync(join(repo, 'a.txt'), 'a\n');
        git(repo, 'add', '.');
        git(repo, 'commit', '-qm', 'base');

        git(repo, 'checkout', '-qb', 'feat');
        writeFileSync(join(repo, 'a.txt'), 'a-modified-by-branch\n');
        git(repo, 'commit', '-qam', 'branch edits a');
        const branchHead = git(repo, 'rev-parse', 'HEAD').trim();

        // Base independently lands the same edit, so merging the branch is a
        // no-op: base->merged is empty while mergeBase->branch is not.
        git(repo, 'checkout', '-q', 'main');
        writeFileSync(join(repo, 'a.txt'), 'a-modified-by-branch\n');
        writeFileSync(join(repo, 'b.txt'), 'b\n');
        git(repo, 'add', '.');
        git(repo, 'commit', '-qm', 'base lands the same edit');
        const baseHead = git(repo, 'rev-parse', 'HEAD').trim();

        const r = await runMeshRefinePatchEquivalenceGate(repo, baseHead, branchHead);
        expect(r.status).toBe('failed');
        expect(r.equivalent).toBe(false);
        expect(r.expectedPatchId).not.toBe(r.actualPatchId);
    }, 60_000);
});
