/** A canary is a registered provider invocation, never a command supplied by
 * a peer. Auth stays in the target's native context; no credential is exported.
 * Providers without a reviewed private-context/one-turn budget contract refuse. */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const HANDOFF_CANARY_PROMPT = 'Reply exactly ADHDEV_HANDOFF_READY. Do not use tools, read files, run commands, or modify any state.';
export const HANDOFF_CANARY_OUTPUT = 'ADHDEV_HANDOFF_READY';
export const HANDOFF_CANARY_TIMEOUT_MS = 15_000;
export const HANDOFF_CANARY_MAX_OUTPUT_TOKENS = 32;
export interface CanarySelection { provider: string; model?: string; thinkingLevel?: string }
export interface RegisteredCanaryProvider {
    type: string;
    spawn: { command: string };
    /** Local installed-provider contract, not accepted in wire arguments. */
    hostHandoffCanary?: {
        version: 1;
        privateContextDisabled: true;
        toolsDisabled: true;
        /** Must contain all fixed budget/prompt substitutions. No shell/interpolation. */
        args: string[];
    };
}
export interface CanaryEvidence {
    ok: boolean;
    code?: string;
    canaryId: string;
    provider: string;
    selection: CanarySelection;
    terminated: boolean;
    startedAt: number;
    finishedAt: number;
    maxTurns: 1;
    maxOutputTokens: 32;
}

export async function runTargetCanary(provider: RegisteredCanaryProvider, selection: CanarySelection,
    options: { env?: NodeJS.ProcessEnv; timeoutMs?: number; parentDir?: string } = {}): Promise<CanaryEvidence> {
    const startedAt = Date.now(), canaryId = randomUUID();
    const result = (ok: boolean, terminated: boolean, code?: string): CanaryEvidence => ({ ok, terminated, ...(code ? { code } : {}),
        canaryId, provider: selection.provider, selection, startedAt, finishedAt: Date.now(), maxTurns: 1, maxOutputTokens: 32 });
    const spec = provider.hostHandoffCanary;
    if (process.platform === 'win32') return result(false, true, 'canary_process_group_unsupported');
    if (provider.type !== selection.provider || !spec || spec.version !== 1 || spec.privateContextDisabled !== true || spec.toolsDisabled !== true
        || !Array.isArray(spec.args) || spec.args.some(a => typeof a !== 'string' || a.includes('\0')) || !provider.spawn?.command
        || (selection.model !== undefined && !spec.args.some(a => a.includes('{{model}}')))
        || (selection.thinkingLevel !== undefined && !spec.args.some(a => a.includes('{{thinkingLevel}}')))
        || !['{{prompt}}', '{{maxTurns}}', '{{maxOutputTokens}}'].every(token => spec.args.some(a => a.includes(token)))) {
        return result(false, true, 'canary_contract_unsupported');
    }
    const root = mkdtempSync(join(options.parentDir ?? tmpdir(), 'adhdev-host-canary-'));
    const config = join(root, 'config'), workspace = join(root, 'workspace');
    mkdirSync(config, { mode: 0o700 }); mkdirSync(workspace, { mode: 0o700 });
    const substitutions: Record<string, string> = { prompt: HANDOFF_CANARY_PROMPT, maxTurns: '1', maxOutputTokens: '32',
        model: selection.model ?? '', thinkingLevel: selection.thinkingLevel ?? '', workspace, configDir: config };
    const args = spec.args.map(arg => arg.replace(/\{\{([A-Za-z]+)\}\}/g, (_, key: string) => {
        if (!(key in substitutions)) throw new Error('unknown registered canary substitution');
        return substitutions[key]!;
    }));
    // Target-local auth environment remains native. Remove ADHDev routing/MCP
    // credentials so the canary cannot attach to a live daemon or agent session.
    const env = Object.fromEntries(Object.entries(options.env ?? process.env).filter(([key]) => !key.startsWith('ADHDEV_')));
    Object.assign(env, { ADHDEV_CONFIG_DIR: config, ADHDEV_SESSION_HOST_NAME: `canary-${canaryId}`, PWD: workspace, INIT_CWD: workspace });
    return new Promise(resolve => {
        const child = spawn(provider.spawn.command, args, { cwd: workspace, env, detached: true, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '', bytes = 0, failure: string | undefined, finished = false;
        const groupAlive = (): boolean | null => {
            if (!child.pid) return false;
            try { process.kill(-child.pid, 0); return true; }
            catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH' ? false : null; }
        };
        const terminate = () => {
            // Only the newly spawned private process group is ever signalled.
            if (child.pid && groupAlive() === true) {
                try { process.kill(-child.pid, 'SIGKILL'); } catch { /* final census decides */ }
            }
        };
        const timer = setTimeout(() => { failure = 'canary_timeout'; terminate(); }, Math.max(1, Math.min(options.timeoutMs ?? HANDOFF_CANARY_TIMEOUT_MS, HANDOFF_CANARY_TIMEOUT_MS)));
        const read = (data: Buffer, capture: boolean) => {
            bytes += data.length;
            if (bytes > 16 * 1024) { failure = 'canary_output_limit'; terminate(); }
            else if (capture) output += data.toString('utf8');
        };
        child.stdout.on('data', data => read(data, true));
        child.stderr.on('data', data => read(data, false));
        let cleaning = false;
        const finish = (code: number | null) => {
            if (finished) return;
            if (groupAlive() !== false && !cleaning) {
                cleaning = true;
                failure ??= 'canary_descendants';
                terminate();
                const deadline = Date.now() + 2_000;
                const check = () => {
                    if (groupAlive() === false || Date.now() >= deadline) finish(code);
                    else setTimeout(check, 10);
                };
                setTimeout(check, 10);
                return;
            }
            finished = true; clearTimeout(timer);
            const terminated = groupAlive() === false;
            resolve(result(!failure && code === 0 && output.trim() === HANDOFF_CANARY_OUTPUT && terminated, terminated,
                !terminated ? 'canary_cleanup_unconfirmed' : failure ?? (code !== 0 ? 'canary_failed' : output.trim() !== HANDOFF_CANARY_OUTPUT ? 'canary_reply_mismatch' : undefined)));
        };
        child.on('error', () => { failure = 'canary_start_failed'; finish(null); });
        child.on('close', finish);
        // SIGKILL must close the root promptly. Missing/uncertain close cannot
        // turn into readiness, even if an RPC caller has already timed out.
        const cleanupDeadline = setTimeout(() => {
            if (!finished) { failure ??= 'canary_cleanup_unconfirmed'; terminate(); finish(null); }
        }, Math.max(1, Math.min(options.timeoutMs ?? HANDOFF_CANARY_TIMEOUT_MS, HANDOFF_CANARY_TIMEOUT_MS)) + 2_000);
        child.once('close', () => clearTimeout(cleanupDeadline));
        child.once('error', () => clearTimeout(cleanupDeadline));
    });
}
