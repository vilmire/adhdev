import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { useSyntheticPublicPushPatterns } from '../helpers/public-push-patterns.js';

useSyntheticPublicPushPatterns();
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it.skipIf(process.platform === 'win32')('local git replaces the dispatcher process and preserves quoted argv and relative -C', async () => {
    const root = mkdtempSync(join(tmpdir(), "git dispatch 'quoted'-")); roots.push(root);
    const repo = join(root, "repo 'with spaces'"); mkdirSync(repo);
    execFileSync('git', ['init', '-q', repo]);
    // A shell alias's PPID is the real Git process. A Node wrapper would instead
    // return the wrapper PID to execFile and launch Git as an additional child.
    const result = await new Promise<{ gitPid: number; dispatcherPid: number }>((resolve, reject) => {
        const child = execFile('git', ['-C', root, '-C', "repo 'with spaces'", '-c', 'alias.dispatch-parent=!printf "%s" "$PPID"', 'dispatch-parent'],
            { encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve({ gitPid: Number(stdout), dispatcherPid: child.pid! }));
    });
    expect(result.gitPid).toBe(result.dispatcherPid);
});

it.each(['push', 'fetch', 'ls-remote', 'clone'])('unmapped %s still fails closed before any network operation', verb => {
    let error: any;
    try { execFileSync('git', [verb, 'https://unmapped.invalid/fixture.git'], { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (caught) { error = caught; }
    expect(error?.status).toBe(1);
    expect(error?.stderr.toString()).toContain('Unmapped synthetic network destination refused');
});
