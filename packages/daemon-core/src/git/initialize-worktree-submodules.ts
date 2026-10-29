import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runGit } from './git-executor.js';
import { gitChildEnv } from './git-locale.js';

/** Initialize once, before bootstrap, using the repository's policy when present. */
export async function initializeWorktreeSubmodules(worktreePath: string): Promise<void> {
    const initializer = join(worktreePath, 'scripts/bootstrap-submodules.mjs');
    if (existsSync(initializer)) {
        // Use the validated sibling-source/exact-pin initializer FIRST. A failed
        // raw clone can leave HEAD but no index/files, which later bootstrap
        // correctly refuses. Never fall back after a helper's policy refusal.
        await promisify(execFile)(process.execPath, [initializer], {
            cwd: worktreePath, env: gitChildEnv(), timeout: 120_000, windowsHide: true,
        });
        return;
    }
    await runGit(
        { workspace: worktreePath, repoRoot: worktreePath, isGitRepo: true },
        ['submodule', 'update', '--init', '--recursive'],
        { timeoutMs: 120000 },
    );
}
