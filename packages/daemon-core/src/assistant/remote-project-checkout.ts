/** Fixed GitHub checkout operation. No shell, caller paths, credentials or raw child errors. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getConfigDir } from '../config/config.js';
const exec = promisify(execFile);
/**
 * Longer than the server's 60s per-command relay wait on purpose: a large clone may
 * outlive that wait, the server then reports ATTACH_PENDING, and the clone finishes
 * here. Only the checkout can land late — registration needs another explicit call,
 * which reuses the finished checkout (or answers ATTACH_IN_PROGRESS while it runs).
 */
export const REMOTE_GIT_TIMEOUT_MS = 120_000;
export const REMOTE_GIT_CLONE_TIMEOUT_MS = 18 * 60_000;
export const REMOTE_GIT_CLONE_WATCHDOG_MS = 120_000;
export function githubRemote(value: unknown): { identity: string; url: string } | null {
    if (typeof value !== 'string') return null;
    const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?$/.exec(value);
    if (!match || match[2] === '.' || match[2] === '..') return null;
    const identity = `github.com/${match[1]}/${match[2]}`.toLowerCase();
    return { identity, url: `https://${identity}.git` };
}
export class AttachFailure extends Error {
    constructor(readonly code: string, readonly stage: string, readonly action: string) { super(code); }
}
export const refusal = (e: unknown) => e instanceof AttachFailure
    ? { success: false, code: e.code, stage: e.stage, action: e.action, attached: false }
    : { success: false, code: 'ATTACH_FAILED', stage: 'checkout', action: 'Inspect the selected daemon locally before retrying. Existing files were preserved.', attached: false };
export async function git(workspace: string, args: string[]): Promise<string> {
    const isClone = args[0] === 'clone';
    const timeout = isClone ? REMOTE_GIT_CLONE_TIMEOUT_MS : REMOTE_GIT_TIMEOUT_MS;
    try {
        const out = await new Promise<string>((resolveOut, rejectOut) => {
            let timedOut = false;
            let watchdog: ReturnType<typeof setTimeout> | undefined;
            let child: ReturnType<typeof execFile> | undefined;
            const killTree = () => {
                timedOut = true;
                if (process.platform === 'win32' && child?.pid) {
                    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true }, () => {});
                }
                try { child?.kill?.('SIGTERM'); } catch { /* ignore */ }
            };
            const armWatchdog = () => {
                if (!isClone) return;
                if (watchdog) clearTimeout(watchdog);
                watchdog = setTimeout(() => {
                    killTree();
                    rejectOut(Object.assign(new Error('clone watchdog timeout'), { killed: true, signal: 'SIGTERM' }));
                }, REMOTE_GIT_CLONE_WATCHDOG_MS);
                watchdog.unref?.();
            };
            armWatchdog();
            child = execFile('git', ['-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', '-c', 'http.followRedirects=false', '-C', workspace, ...args], {
                cwd: getConfigDir(), shell: false, windowsHide: true, timeout, maxBuffer: 1024 * 1024,
                env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
            }, (err, stdout) => {
                if (watchdog) clearTimeout(watchdog);
                if (err) {
                    if ((err as any).killed && (err as any).code !== 'ENOBUFS' && (err as any).code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && process.platform === 'win32' && child?.pid && !timedOut) {
                        execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true }, () => {});
                    }
                    rejectOut(err);
                    return;
                }
                resolveOut(typeof stdout === 'string' ? stdout : String((stdout as any)?.stdout ?? ''));
            });
            child?.stdout?.on?.('data', armWatchdog);
            child?.stderr?.on?.('data', armWatchdog);
        });
        return out.trim();
    } catch (e: any) {
        // Child stderr can contain helper credentials or URLs. Classify only; never retain it.
        if (e?.code === 'ENOENT') throw new AttachFailure('GIT_UNAVAILABLE', 'repository_access', 'Install Git on the selected daemon, then explicitly retry.');
        if (e?.code === 'ENOBUFS' || e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new AttachFailure('ENOBUFS', 'repository_access', 'Git output exceeded the safety buffer. Inspect the repository on the selected daemon.');
        if (e?.killed === true) throw new AttachFailure('GIT_TIMEOUT', 'repository_access', 'Git did not finish in time. Check the selected daemon network and repository size, then explicitly retry.');
        const auth = /authentication|could not read username|terminal prompts disabled|403|401|repository not found/i.test(String(e?.stderr ?? ''));
        throw new AttachFailure(auth ? 'GIT_AUTH_REQUIRED' : 'REPOSITORY_ACCESS_FAILED', 'repository_access', 'Configure Git access to this private GitHub repository on the selected daemon, then explicitly retry.');
    }
}
export async function managedCheckoutPath(meshId: string, identity: string): Promise<string> {
    const config = await realpath(getConfigDir());
    const root = join(config, 'remote-projects');
    try { await mkdir(root); } catch (e: any) { if (e.code !== 'EEXIST') throw e; }
    if ((await lstat(root)).isSymbolicLink() || await realpath(root) !== resolve(root)) throw new AttachFailure('PATH_CONFLICT', 'checkout', 'The managed remote-projects directory must be a real directory.');
    const key = createHash('sha256').update(`${meshId}\0${identity}`).digest('hex').slice(0, 24);
    return join(root, key);
}
export async function verifyCheckout(workspace: string, identity: string): Promise<void> {
    const info = await lstat(workspace);
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(workspace) !== resolve(workspace)) throw new AttachFailure('PATH_CONFLICT', 'checkout', 'Preserve the existing path and choose a separate managed checkout.');
    const root = await git(workspace, ['rev-parse', '--show-toplevel']);
    if (await realpath(root) !== await realpath(workspace)) throw new AttachFailure('PATH_CONFLICT', 'checkout', 'Existing path is not the repository root.');
    const remote = githubRemote(await git(workspace, ['remote', 'get-url', 'origin']));
    if (remote?.identity !== identity) throw new AttachFailure('REMOTE_IDENTITY_MISMATCH', 'checkout', 'Existing checkout origin differs from the verified project. Preserve it and resolve the conflict locally.');
}
async function present(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (e: any) { if (e.code === 'ENOENT') return false; throw e; } }
function pidAlive(pid: unknown): boolean {
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; }
}
async function acquireLock(lockPath: string): Promise<void> {
    const payload = JSON.stringify({ pid: process.pid });
    try { await writeFile(lockPath, payload, { flag: 'wx' }); return; } catch (e: any) { if (e?.code !== 'EEXIST') throw e; }
    let existingPid: unknown;
    try { existingPid = JSON.parse(await readFile(lockPath, 'utf-8'))?.pid; } catch { /* stale or partial lock */ }
    if (pidAlive(existingPid)) throw new AttachFailure('ATTACH_IN_PROGRESS', 'checkout', 'Wait for the current attachment result; do not retry repeatedly.');
    await rm(lockPath, { force: true }).catch(() => {});
    try { await writeFile(lockPath, payload, { flag: 'wx' }); } catch { throw new AttachFailure('ATTACH_IN_PROGRESS', 'checkout', 'Wait for the current attachment result; do not retry repeatedly.'); }
}
async function renameWithRetry(from: string, to: string): Promise<void> {
    for (let i = 0; ; i++) {
        try { await rename(from, to); return; }
        catch (e: any) {
            if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) throw e;
            await new Promise(r => setTimeout(r, 200));
        }
    }
}
const inFlight = new Set<string>();
export async function checkoutRemote(meshId: string, remote: { identity: string; url: string }) {
    const workspace = await managedCheckoutPath(meshId, remote.identity);
    if (inFlight.has(workspace)) throw new AttachFailure('ATTACH_IN_PROGRESS', 'checkout', 'Wait for the current attachment result; do not retry repeatedly.');
    const lockPath = `${workspace}.lock`;
    await acquireLock(lockPath);
    inFlight.add(workspace);
    try {
        // Actual access, never inferred from daemon online status or a claimed URL.
        await git(getConfigDir(), ['ls-remote', '--exit-code', remote.url, 'HEAD']);
        let reused = await present(workspace);
        if (!reused) {
            const staging = `${workspace}.pending`;
            let claimed = false;
            try { await mkdir(staging); claimed = true; } catch (e: any) { if (e?.code !== 'EEXIST') throw e; }
            if (!claimed) {
                // Fixed staging name permits adopting a finished crash-left checkout or preserving an incomplete one.
                try { await verifyCheckout(staging, remote.identity); }
                catch { throw new AttachFailure('CHECKOUT_RECOVERY_REQUIRED', 'checkout', 'A previous checkout is preserved in the .pending directory. Inspect it locally before retrying.'); }
                if (await present(workspace)) throw new AttachFailure('PATH_CONFLICT', 'checkout', 'A destination appeared during checkout; both paths were preserved.');
                await renameWithRetry(staging, workspace);
                reused = true;
            } else {
                try {
                    await git(getConfigDir(), ['clone', '--origin', 'origin', '--', remote.url, staging]);
                } catch (e) {
                    // Only remove staging when this attempt claimed it.
                    if (claimed) await rm(staging, { recursive: true, force: true }).catch(() => {});
                    throw e;
                }
                await verifyCheckout(staging, remote.identity);
                if (await present(workspace)) throw new AttachFailure('PATH_CONFLICT', 'checkout', 'A destination appeared during checkout; both paths were preserved.');
                await renameWithRetry(staging, workspace);
            }
        }
        await verifyCheckout(workspace, remote.identity);
        // Never fetch/reset/checkout an existing checkout: dirty work and local commits survive.
        return { workspace, reused };
    } finally {
        inFlight.delete(workspace);
        await rm(lockPath, { force: true }).catch(() => {});
    }
}
export async function pythonResourcePreflight(): Promise<{ ready: boolean; code: string; action?: string }> {
    const commands: [string, string[]][] = process.platform === 'win32' ? [['py', ['-3']], ['python', []], ['python3', []]] : [['python3', []], ['python', []]];
    for (const [cmd, prefix] of commands) try {
        await exec(cmd, [...prefix, '-c', 'import git; print("gitpython-ready")'], {
            cwd: getConfigDir(), shell: false, windowsHide: true, timeout: 10000, maxBuffer: 4096,
            env: { ...process.env, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' },
        });
        return { ready: true, code: 'RESOURCE_READY' };
    } catch { /* No child output leaves the process. */ }
    return { ready: false, code: 'GITPYTHON_UNAVAILABLE', action: 'Configure Python and GitPython on the selected machine, then rerun the readiness check. No packages were installed.' };
}
