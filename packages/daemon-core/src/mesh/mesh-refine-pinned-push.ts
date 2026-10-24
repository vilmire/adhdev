import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gitChildEnv, GIT_NETWORK_TIMEOUT_MS } from '../git/git-locale.js';
import type { RefineExecFileAsync } from './mesh-refine-gates.js';

/**
 * Normal non-force push with an exact old-OID fence on Git's own advertisement.
 * A preceding ls-remote alone cannot provide this: main can move between that
 * read and push's advertisement, even to an ancestor of the approved target.
 * Receive-pack then CASes this SAME advertised old OID when updating the ref.
 *
 * The temporary hook chains the repository's effective pre-push hook with its
 * original stdin/arguments and requires success. No installed hook is disabled
 * or replaced on disk; the hooksPath override exists only for this invocation.
 */
export async function pushRefineryPinnedCommit(repo: string, target: string, branch: string, base: string,
    run: RefineExecFileAsync = promisify(execFile) as unknown as RefineExecFileAsync) {
    if (![target, base].every(sha => /^[0-9a-f]{40,64}$/.test(sha))) throw new Error('invalid pinned push object');
    const env = gitChildEnv();
    const { stdout } = await run('git', ['rev-parse', '--git-path', 'hooks/pre-push'], { cwd: repo, encoding: 'utf8', windowsHide: true, env });
    const hookPath = stdout.replace(/\r?\n$/, '');
    const originalHook = isAbsolute(hookPath) ? hookPath : resolve(repo, hookPath);
    // A missing hook is Git's normal no-hook case. Other lookup errors fail closed.
    let existingHook: string | undefined;
    try { await access(originalHook); existingHook = originalHook; }
    catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
    const dir = await mkdtemp(join(tmpdir(), 'refinery-pinned-push-'));
    try {
        // Let Git's own shell runner execute the existing hook (including its
        // shebang on Windows). Unlike `git hook run` on older Git, a shell alias
        // preserves stdin. Quote the filesystem path; arguments remain argv.
        const hookCommand = existingHook ? "!exec '" + existingHook.replaceAll("'", "'\\''") + "'" : null;
        const fence = `#!/usr/bin/env node
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const input = fs.readFileSync(0, 'utf8');
const rows = input.trim().split('\\n').filter(Boolean).map(line => line.split(/\\s+/));
if (rows.length !== 1 || rows[0].length !== 4 || rows[0][1] !== ${JSON.stringify(target)} || rows[0][2] !== ${JSON.stringify(`refs/heads/${branch}`)} || rows[0][3] !== ${JSON.stringify(base)}) {
  process.stderr.write('Refinery integration base/target changed at push advertisement; refusing publication\\n');
  process.exit(1);
}
const command = ${JSON.stringify(hookCommand)};
if (command) {
  const result = spawnSync('git', ['-c', 'alias.refinery-preserved-hook=' + command, 'refinery-preserved-hook', ...process.argv.slice(2)], { input, encoding: 'utf8', windowsHide: true, timeout: ${GIT_NETWORK_TIMEOUT_MS}, env: process.env });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) process.exit(1);
}
`;
        await writeFile(join(dir, 'pre-push'), fence, { mode: 0o700 });
        return await run('git', ['-c', `core.hooksPath=${dir}`, 'push', 'origin', `${target}:refs/heads/${branch}`], {
            cwd: repo, encoding: 'utf8', windowsHide: true, env, timeout: GIT_NETWORK_TIMEOUT_MS,
        });
    } finally { await rm(dir, { recursive: true, force: true }); }
}
