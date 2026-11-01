/** LIGHT-TASK: tiny git runner shared by the light result / fingerprint / land modules (windowsHide, pinned locale). */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gitChildEnv } from '../git/git-locale.js';

const execFileAsync = promisify(execFile);

export interface LightGitResult { code: number; stdout: string; stderr: string }

/** Never throws on a non-zero exit; `code` carries it (-1 = spawn/timeout failure). */
export async function lightGit(cwd: string, args: string[], opts: { timeoutMs?: number; input?: string } = {}): Promise<LightGitResult> {
    try {
        const p = execFileAsync('git', args, {
            cwd, encoding: 'utf8', timeout: opts.timeoutMs ?? 30_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true, env: gitChildEnv(),
        });
        if (opts.input !== undefined) (p as any).child?.stdin?.end(opts.input);
        const { stdout, stderr } = await p;
        return { code: 0, stdout, stderr };
    } catch (e: any) {
        return { code: typeof e?.code === 'number' ? e.code : -1, stdout: typeof e?.stdout === 'string' ? e.stdout : '', stderr: typeof e?.stderr === 'string' ? e.stderr : String(e?.message ?? e) };
    }
}

export async function lightGitOk(cwd: string, args: string[], timeoutMs?: number): Promise<string | null> {
    const r = await lightGit(cwd, args, { timeoutMs });
    return r.code === 0 ? r.stdout.trim() : null;
}
