/** Fixed GitHub checkout operation. No shell, caller paths, credentials or raw child errors. */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
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
    constructor(readonly code: string, readonly stage: string, readonly action: string, readonly preserveCheckout = false) { super(code); }
}
export const refusal = (e: unknown) => e instanceof AttachFailure
    ? { success: false, code: e.code, stage: e.stage, action: e.action, attached: false }
    : { success: false, code: 'ATTACH_FAILED', stage: 'checkout', action: 'Inspect the selected daemon locally before retrying. Existing files were preserved.', attached: false };
export async function git(workspace: string, args: string[]): Promise<string> {
    const isClone = args[0] === 'clone';
    const timeout = isClone ? REMOTE_GIT_CLONE_TIMEOUT_MS : REMOTE_GIT_TIMEOUT_MS;
    try {
        const out = await new Promise<string>((resolveOut, rejectOut) => {
            // Own the buffers and deadlines: execFile's maxBuffer/timeout kill only
            // the root before its callback, making Windows helper cleanup too late.
            const child = spawn('git', ['-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', '-c', 'http.followRedirects=false', '-C', workspace, ...args], {
                cwd: getConfigDir(), shell: false, windowsHide: true, detached: process.platform !== 'win32',
                env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
            });
            let stdout = '', stderr = '', bytes = 0;
            let error: any;
            let stopping: Promise<void> | undefined;
            let watchdog: ReturnType<typeof setTimeout> | undefined;
            let closeChild!: () => void;
            const close = new Promise<void>(r => { closeChild = r; });
            const waitForClose = async (ms: number) => {
                let timer: ReturnType<typeof setTimeout> | undefined;
                try { return await Promise.race([close.then(() => true), new Promise<false>(r => { timer = setTimeout(() => r(false), ms); })]); }
                finally { if (timer) clearTimeout(timer); }
            };
            const signalGroup = (signal: NodeJS.Signals) => {
                if (!child.pid) return;
                try { process.kill(-child.pid, signal); }
                catch (e: any) { if (e?.code !== 'ESRCH') throw e; }
            };
            const terminate = async () => {
                try {
                    if (process.platform === 'win32' && child.pid) {
                        // Keep the root alive until taskkill has enumerated its children.
                        await new Promise<void>((done, fail) => {
                            const deadline = setTimeout(() => fail(new Error('Tree termination unconfirmed')), 5000);
                            execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, timeout: 5000 }, err => { clearTimeout(deadline); if (err) fail(err); else done(); });
                        });
                    } else {
                        signalGroup('SIGTERM');
                        await waitForClose(2000);
                        // A helper may ignore TERM even when the root has closed.
                        signalGroup('SIGKILL');
                    }
                    if (!await waitForClose(5000)) throw new Error('Child close not confirmed');
                } catch {
                    // Never authorize cleanup or lock release while termination is uncertain.
                    throw new AttachFailure('CHECKOUT_RECOVERY_REQUIRED', 'checkout', 'Process termination could not be confirmed. Preserve the checkout and lock; inspect the selected daemon locally.', true);
                }
            };
            const stop = (reason: any) => {
                if (stopping) return;
                error = reason;
                clearTimeout(wall);
                if (watchdog) clearTimeout(watchdog);
                stopping = terminate();
                void stopping.then(() => rejectOut(error), rejectOut);
            };
            const wall = setTimeout(() => stop({ killed: true }), timeout);
            const armWatchdog = () => {
                if (!isClone || stopping) return;
                if (watchdog) clearTimeout(watchdog);
                watchdog = setTimeout(() => stop({ killed: true }), REMOTE_GIT_CLONE_WATCHDOG_MS);
            };
            const collect = (stream: 'stdout' | 'stderr', chunk: Buffer | string) => {
                if (stopping) return;
                bytes += Buffer.byteLength(chunk);
                if (bytes > 1024 * 1024) { stop({ code: 'ENOBUFS' }); return; }
                if (stream === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
                armWatchdog();
            };
            child.stdout.on('data', chunk => collect('stdout', chunk));
            child.stderr.on('data', chunk => collect('stderr', chunk));
            child.once('error', e => { error = e; });
            child.once('close', code => {
                closeChild();
                clearTimeout(wall);
                if (watchdog) clearTimeout(watchdog);
                if (stopping) return;
                if (error || code !== 0) rejectOut(error ?? { code, stderr });
                else resolveOut(stdout);
            });
            armWatchdog();
        });
        return out.trim();
    } catch (e: any) {
        if (e instanceof AttachFailure) throw e;
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
interface CheckoutOwner { pid: number; nonce: string }
const busy = () => new AttachFailure('ATTACH_IN_PROGRESS', 'checkout', 'Wait for the current attachment result; do not retry repeatedly.');
const recovery = () => new AttachFailure('CHECKOUT_RECOVERY_REQUIRED', 'checkout', 'Preserve the checkout and lock. Inspect the previous attempt locally before retrying.');
async function readOwner(lockPath: string): Promise<CheckoutOwner> {
    const info = await lstat(lockPath);
    if (!info.isFile() || info.isSymbolicLink()) throw recovery();
    let owner: CheckoutOwner;
    try { owner = JSON.parse(await readFile(lockPath, 'utf-8')); } catch { throw recovery(); }
    if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0 || typeof owner.nonce !== 'string' || !/^[0-9a-f-]{36}$/.test(owner.nonce)) throw recovery();
    return owner;
}
async function lockMutation<T>(lockPath: string, action: () => Promise<T>): Promise<T> {
    // All cooperating initializers/reclaimers/releasers use this atomic guard.
    // A crash during mutation leaves the guard behind: fail closed for local
    // recovery, never guess that an empty/partially initialized lock is stale.
    const guard = `${lockPath}.guard`;
    try { await mkdir(guard); } catch (e: any) { if (e.code === 'EEXIST') throw busy(); throw e; }
    try { return await action(); } finally { await rmdir(guard); }
}
async function acquireLock(lockPath: string): Promise<CheckoutOwner> {
    return lockMutation(lockPath, async () => {
        if (await present(lockPath)) {
            const old = await readOwner(lockPath);
            if (pidAlive(old.pid)) throw busy();
            // Guard excludes replacement by another cooperating reclaimer.
            const current = await readOwner(lockPath);
            if (current.nonce !== old.nonce || current.pid !== old.pid) throw recovery();
            await rm(lockPath);
        }
        const owner = { pid: process.pid, nonce: randomUUID() };
        await writeFile(lockPath, JSON.stringify(owner), { flag: 'wx' });
        return owner;
    });
}
async function releaseLock(lockPath: string, owner: CheckoutOwner): Promise<void> {
    await lockMutation(lockPath, async () => {
        const current = await readOwner(lockPath);
        if (current.nonce !== owner.nonce || current.pid !== owner.pid) throw recovery();
        await rm(lockPath);
    });
}
async function completedStaging(staging: string, meshId: string, identity: string): Promise<void> {
    const marker = `${staging}.complete`;
    const info = await lstat(marker);
    if (!info.isFile() || info.isSymbolicLink()) throw recovery();
    const evidence = JSON.parse(await readFile(marker, 'utf-8'));
    const dir = await lstat(staging);
    if (evidence.meshId !== meshId || evidence.identity !== identity || evidence.dev !== dir.dev || evidence.ino !== dir.ino || !/^[0-9a-f-]{36}$/.test(evidence.nonce)) throw recovery();
    await verifyCheckout(staging, identity);
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
    inFlight.add(workspace);
    let owner: CheckoutOwner | undefined;
    let cleanupSafe = true;
    try {
        owner = await acquireLock(lockPath);
        // Actual access, never inferred from daemon online status or a claimed URL.
        await git(getConfigDir(), ['ls-remote', '--exit-code', remote.url, 'HEAD']);
        let reused = await present(workspace);
        if (!reused) {
            const staging = `${workspace}.pending`;
            let claimed = false;
            try { await mkdir(staging); claimed = true; } catch (e: any) { if (e?.code !== 'EEXIST') throw e; }
            if (!claimed) {
                // Fixed staging name permits adopting a finished crash-left checkout or preserving an incomplete one.
                try { await completedStaging(staging, meshId, remote.identity); }
                catch (e) {
                    if (e instanceof AttachFailure && e.preserveCheckout) throw e;
                    throw new AttachFailure('CHECKOUT_RECOVERY_REQUIRED', 'checkout', 'A previous checkout is preserved in the .pending directory. Inspect it locally before retrying.');
                }
                if (await present(workspace)) throw new AttachFailure('PATH_CONFLICT', 'checkout', 'A destination appeared during checkout; both paths were preserved.');
                await renameWithRetry(staging, workspace);
                await rm(`${staging}.complete`);
                reused = true;
            } else {
                try {
                    // --progress: without a TTY git is silent until the clone ends, so the output-reset idle
                    // watchdog would kill every clone that runs longer than its idle window.
                    await git(getConfigDir(), ['clone', '--progress', '--origin', 'origin', '--', remote.url, staging]);
                } catch (e) {
                    // Only remove staging when this attempt claimed it.
                    if (!(e instanceof AttachFailure && e.preserveCheckout)) await rm(staging, { recursive: true, force: true }).catch(() => {});
                    throw e;
                }
                await verifyCheckout(staging, remote.identity);
                const dir = await lstat(staging);
                // Outside the clone: repository content cannot supply completion evidence.
                // Published only after git has closed successfully and verification passes.
                await writeFile(`${staging}.complete`, JSON.stringify({ meshId, identity: remote.identity, nonce: owner.nonce, dev: dir.dev, ino: dir.ino }), { flag: 'wx' });
                if (await present(workspace)) throw new AttachFailure('PATH_CONFLICT', 'checkout', 'A destination appeared during checkout; both paths were preserved.');
                await renameWithRetry(staging, workspace);
                await rm(`${staging}.complete`);
            }
        }
        await verifyCheckout(workspace, remote.identity);
        // Never fetch/reset/checkout an existing checkout: dirty work and local commits survive.
        return { workspace, reused };
    } catch (e) {
        if (e instanceof AttachFailure && e.preserveCheckout) cleanupSafe = false;
        throw e;
    } finally {
        // Release BEFORE dropping the in-flight entry. Dropping it first let a same-process
        // attempt slip in and take the mutation guard, so this release failed as busy and
        // stranded the lock on our own live pid (every later attach: ATTACH_IN_PROGRESS).
        // A release refusal (lock replaced by another owner) still propagates on purpose.
        try {
            if (owner && cleanupSafe) await releaseLock(lockPath, owner);
        } finally {
            inFlight.delete(workspace);
        }
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
