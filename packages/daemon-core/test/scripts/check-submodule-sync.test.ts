/**
 * Submodule sync gate — classification rules and end-to-end drift detection.
 *
 * Why this gate exists: when a submodule checkout drifts from the gitlink the
 * superproject records, every test runs against files from a different commit
 * than the branch under test. Failures then get misattributed to the branch. On
 * 2026-08-03 that misattribution cost half a day.
 *
 * Two of these cases are deliberately adversarial — they exist to kill plausible
 * but wrong implementations rather than to describe the happy path:
 *   - "all in sync" kills an always-fail gate.
 *   - "same SHA, different branch labels" kills a gate that compares branch
 *     names instead of SHAs. That is the exact axis the 2026-08-03 incident was
 *     misdiagnosed on, and a label-comparing gate would false-positive on this
 *     very repository today (oss reports `remotes/origin/HEAD` here and
 *     `heads/main` in some worktrees, at an identical commit).
 *
 * The integration case spawns real `git` in a temp dir — this file is therefore
 * registered in vitest.git-suites.mts.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateSubmoduleSync } from '../../../../../scripts/check-submodule-sync.mjs';

const GATE = resolve(
  fileURLToPath(new URL('../../../../../scripts/check-submodule-sync.mjs', import.meta.url)),
);

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

describe('evaluateSubmoduleSync', () => {
  it('(a) reports ok when every checkout matches its gitlink', () => {
    const result = evaluateSubmoduleSync([
      { path: 'oss', gitlinkSha: SHA_A, headSha: SHA_A, branchLabel: 'heads/main' },
      { path: 'adhdev-providers', gitlinkSha: SHA_B, headSha: SHA_B, branchLabel: 'heads/main' },
    ]);

    expect(result.ok).toBe(true);
    expect(result.drifted).toHaveLength(0);
    expect(result.uninitialized).toHaveLength(0);
    expect(result.inSync).toHaveLength(2);
  });

  it('(b) flags a drifted submodule and carries BOTH SHAs for the message', () => {
    const result = evaluateSubmoduleSync([
      { path: 'oss', gitlinkSha: SHA_A, headSha: SHA_A, branchLabel: 'heads/main' },
      // The 2026-08-03 shape: providers sitting on a feature branch.
      { path: 'adhdev-providers', gitlinkSha: SHA_B, headSha: SHA_C, branchLabel: 'heads/feat/kimi' },
    ]);

    expect(result.ok).toBe(false);
    expect(result.drifted).toHaveLength(1);

    const drifted = result.drifted[0];
    expect(drifted.path).toBe('adhdev-providers');
    // An operator cannot act on "these differ" — both commits must be reported.
    expect(drifted.headSha).toBe(SHA_C);
    expect(drifted.gitlinkSha).toBe(SHA_B);
    expect(drifted.branchLabel).toBe('heads/feat/kimi');

    // The in-sync sibling must not be dragged into the failure.
    expect(result.inSync.map((e: { path: string }) => e.path)).toEqual(['oss']);
  });

  it('(c) classifies a missing checkout as uninitialized, not drift', () => {
    const result = evaluateSubmoduleSync([
      { path: 'oss', gitlinkSha: SHA_A, headSha: null, branchLabel: null },
    ]);

    // An absent checkout is a setup step; drift is actively misleading test
    // results. Collapsing the two would send operators down the wrong recovery.
    expect(result.drifted).toHaveLength(0);
    expect(result.uninitialized).toHaveLength(1);
    expect(result.uninitialized[0].path).toBe('oss');
    expect(result.ok).toBe(true);
  });

  it('(d) accepts identical SHAs carrying different branch labels', () => {
    // TRAP GUARD: the same commit is legitimately labelled differently across
    // checkouts. A branch-name comparison fails here while the tree is perfectly
    // correct — which is how the 2026-08-03 incident was misdiagnosed.
    const result = evaluateSubmoduleSync([
      { path: 'oss', gitlinkSha: SHA_A, headSha: SHA_A, branchLabel: 'heads/main' },
      {
        path: 'adhdev-providers',
        gitlinkSha: SHA_B,
        headSha: SHA_B,
        branchLabel: 'remotes/origin/HEAD',
      },
    ]);

    expect(result.ok).toBe(true);
    expect(result.drifted).toHaveLength(0);
  });

  it('(e) reports every drifted submodule, not just the first', () => {
    const result = evaluateSubmoduleSync([
      { path: 'oss', gitlinkSha: SHA_A, headSha: SHA_C, branchLabel: 'heads/other' },
      { path: 'adhdev-providers', gitlinkSha: SHA_B, headSha: SHA_C, branchLabel: 'heads/feat/kimi' },
    ]);

    expect(result.ok).toBe(false);
    expect(result.drifted.map((e: { path: string }) => e.path).sort()).toEqual([
      'adhdev-providers',
      'oss',
    ]);
  });

  it('treats a dirty-but-aligned submodule as in sync', () => {
    // Local modifications inside a submodule do not change its HEAD. The gate
    // asserts only "is the right commit checked out", so this must pass — the
    // repository itself is in this state routinely (untracked files make the
    // superproject print ` M oss` while the gitlink matches exactly).
    const result = evaluateSubmoduleSync([
      { path: 'oss', gitlinkSha: SHA_A, headSha: SHA_A, branchLabel: 'heads/main' },
    ]);

    expect(result.ok).toBe(true);
    expect(result.inSync).toHaveLength(1);
  });
});

describe('check-submodule-sync CLI (real git)', () => {
  const git = (args: string[], cwd: string) =>
    execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  const initRepo = (dir: string) => {
    git(['init', '-q', '-b', 'main', '.'], dir);
    git(['config', 'user.email', 'gate@test.local'], dir);
    git(['config', 'user.name', 'gate test'], dir);
    git(['config', 'protocol.file.allow', 'always'], dir);
  };

  it('exits non-zero with a submodule_drift marker when a checkout drifts', () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-subgate-'));
    try {
      // A real submodule origin with two distinct commits, so the child can be
      // moved off the commit the parent records.
      const child = join(root, 'child-origin');
      execFileSync('mkdir', ['-p', child]);
      initRepo(child);
      writeFileSync(join(child, 'a.txt'), 'first\n');
      git(['add', '.'], child);
      git(['commit', '-q', '-m', 'first'], child);
      const firstSha = git(['rev-parse', 'HEAD'], child);
      writeFileSync(join(child, 'a.txt'), 'second\n');
      git(['add', '.'], child);
      git(['commit', '-q', '-m', 'second'], child);
      const secondSha = git(['rev-parse', 'HEAD'], child);

      const parent = join(root, 'parent');
      execFileSync('mkdir', ['-p', parent]);
      initRepo(parent);
      writeFileSync(join(parent, 'README.md'), 'parent\n');
      git(['add', '.'], parent);
      git(['commit', '-q', '-m', 'init'], parent);
      git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, 'vendor'], parent);
      git(['commit', '-q', '-m', 'add submodule'], parent);

      // Parent records `secondSha`; force the checkout back to `firstSha`.
      expect(git(['rev-parse', 'HEAD'], join(parent, 'vendor'))).toBe(secondSha);
      git(['checkout', '-q', firstSha], join(parent, 'vendor'));

      // Drive the real CLI against the drifted fixture.
      let exitCode = 0;
      let stdout = '';
      try {
        stdout = execFileSync('node', [GATE, '--json', '--repo-root', parent], {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error: any) {
        exitCode = error.status ?? 1;
        stdout = error.stdout ?? '';
      }

      expect(exitCode).not.toBe(0);

      const payload = JSON.parse(stdout);
      expect(payload.ok).toBe(false);
      // Tests assert the stable marker, never prose.
      expect(payload.reason).toBe('submodule_drift');
      expect(payload.drifted).toHaveLength(1);
      expect(payload.drifted[0].path).toBe('vendor');
      expect(payload.drifted[0].gitlinkSha).toBe(secondSha);
      expect(payload.drifted[0].headSha).toBe(firstSha);

      // Human mode must name both commits so the operator can act.
      let humanOut = '';
      try {
        execFileSync('node', [GATE, '--repo-root', parent], {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error: any) {
        humanOut = error.stderr ?? '';
      }
      expect(humanOut).toContain(secondSha);
      expect(humanOut).toContain(firstSha);
      expect(humanOut).toContain('ENVIRONMENT problem');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports ok:true with a stable JSON shape on the real repository', () => {
    const stdout = execFileSync('node', [GATE, '--json'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const payload = JSON.parse(stdout);

    expect(payload.ok).toBe(true);
    expect(payload.reason).toBe('in_sync');
    expect(Array.isArray(payload.inSync)).toBe(true);
    // Both declared submodules must be evaluated, not silently skipped.
    expect(payload.inSync.map((e: { path: string }) => e.path).sort()).toEqual([
      'adhdev-providers',
      'oss',
    ]);
  });
});
