/** Fixed GitHub checkout operation. No shell, caller paths, credentials or raw child errors. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath, rename, rm } from 'node:fs/promises';
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
    try {
        const out = await exec('git', ['-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', '-c', 'http.followRedirects=false', ...args], {
            cwd: workspace, shell: false, windowsHide: true, timeout: REMOTE_GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
        });
        return out.stdout.trim();
    } catch (e: any) {
        // Child stderr can contain helper credentials or URLs. Classify only; never retain it.
        if (e?.code === 'ENOENT') throw new AttachFailure('GIT_UNAVAILABLE', 'repository_access', 'Install Git on the selected daemon, then explicitly retry.');
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
const inFlight = new Set<string>();
export async function checkoutRemote(meshId: string, remote: { identity: string; url: string }) {
    const workspace = await managedCheckoutPath(meshId, remote.identity);
    if (inFlight.has(workspace)) throw new AttachFailure('ATTACH_IN_PROGRESS', 'checkout', 'Wait for the current attachment result; do not retry repeatedly.');
    inFlight.add(workspace);
    try {
        // Actual access, never inferred from daemon online status or a claimed URL.
        await git(getConfigDir(), ['ls-remote', '--exit-code', remote.url, 'HEAD']);
        let reused = await present(workspace);
        if (!reused) {
            const staging = `${workspace}.pending`;
            // Fixed staging name permits a truthful, non-destructive recovery after a crash.
            if (await present(staging)) throw new AttachFailure('CHECKOUT_RECOVERY_REQUIRED', 'checkout', 'A previous checkout is preserved in the .pending directory. Inspect it locally before retrying.');
            try {
                await git(getConfigDir(), ['clone', '--origin', 'origin', '--', remote.url, staging]);
            } catch (e) {
                // The staging path was absent before this clone, so whatever is there now is
                // this attempt's partial clone: removing it keeps an explicit retry idempotent.
                await rm(staging, { recursive: true, force: true }).catch(() => {});
                throw e;
            }
            await verifyCheckout(staging, remote.identity);
            if (await present(workspace)) throw new AttachFailure('PATH_CONFLICT', 'checkout', 'A destination appeared during checkout; both paths were preserved.');
            await rename(staging, workspace);
        }
        await verifyCheckout(workspace, remote.identity);
        // Never fetch/reset/checkout an existing checkout: dirty work and local commits survive.
        return { workspace, reused };
    } finally { inFlight.delete(workspace); }
}
export async function pythonResourcePreflight(): Promise<{ ready: boolean; code: string; action?: string }> {
    const commands: [string, string[]][] = process.platform === 'win32' ? [['py', ['-3']], ['python', []], ['python3', []]] : [['python3', []], ['python', []]];
    for (const [cmd, prefix] of commands) try {
        await exec(cmd, [...prefix, '-c', 'import git; print("gitpython-ready")'], { shell: false, windowsHide: true, timeout: 10000, maxBuffer: 4096 });
        return { ready: true, code: 'RESOURCE_READY' };
    } catch { /* No child output leaves the process. */ }
    return { ready: false, code: 'GITPYTHON_UNAVAILABLE', action: 'Configure Python and GitPython on the selected machine, then rerun the readiness check. No packages were installed.' };
}
