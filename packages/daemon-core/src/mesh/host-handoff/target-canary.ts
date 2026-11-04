/** A canary is a registered provider invocation, never a command supplied by
 * a peer. Auth stays in the target's native context; no credential is exported.
 * The host kills the private process group at 15s and at the output-byte limit.
 * Evidence must not claim a native turn or output-token cap. */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describeCanaryContract, HANDOFF_CANARY_HOST_MAX_OUTPUT_BYTES, HANDOFF_CANARY_HOST_TIMEOUT_MS, type HostHandoffCanarySpec } from '../../shared/host-handoff-canary-contract.js';

export { describeCanaryContract };
export const HANDOFF_CANARY_PROMPT = 'Reply exactly ADHDEV_HANDOFF_READY. Do not use tools, read files, run commands, or modify any state.';
export const HANDOFF_CANARY_OUTPUT = 'ADHDEV_HANDOFF_READY';
export const HANDOFF_CANARY_TIMEOUT_MS = HANDOFF_CANARY_HOST_TIMEOUT_MS;
export interface CanarySelection { provider: string; model?: string; thinkingLevel?: string }
export interface RegisteredCanaryProvider {
    type: string;
    spawn: { command: string };
    /** Local installed-provider contract, not accepted in wire arguments. */
    hostHandoffCanary?: HostHandoffCanarySpec;
}
export interface CanaryEvidence {
    ok: boolean;
    code?: string;
    /** Stable refusal text. The code stays `canary_contract_unsupported`; this names the missing binding. */
    detail?: string;
    canaryId: string;
    provider: string;
    selection: CanarySelection;
    terminated: boolean;
    startedAt: number;
    finishedAt: number;
    enforcement: 'host';
    hostTimeoutMs: typeof HANDOFF_CANARY_HOST_TIMEOUT_MS;
    hostMaxOutputBytes: typeof HANDOFF_CANARY_HOST_MAX_OUTPUT_BYTES;
    nativeTurnCap: false;
    nativeOutputTokenCap: false;
}

function substituteCanaryArgs(spec: HostHandoffCanarySpec, selection: CanarySelection, workspace: string, config: string): string[] {
    const level = selection.thinkingLevel;
    const templates = [...spec.args];
    if (typeof level === 'string' && level.length > 0) {
        const promptAt = templates.findIndex(arg => arg.includes('{{prompt}}'));
        templates.splice(promptAt < 0 ? templates.length : promptAt, 0, ...(spec.thinkingArgs ?? []));
    }
    const substitutions: Record<string, string> = {
        prompt: HANDOFF_CANARY_PROMPT, model: selection.model ?? '', thinkingLevel: level ?? '', workspace, configDir: config,
    };
    return templates.map(arg => arg.replace(/\{\{([A-Za-z]+)\}\}/g, (_, key: string) => {
        if (!Object.prototype.hasOwnProperty.call(substitutions, key)) throw new Error('unknown registered canary substitution');
        return substitutions[key]!;
    }));
}

/** The same selection on the same provider command, proved within `maxAgeMs`. In-process only:
 * a restart or an unknown result simply bills one more bounded probe. */
const recentProofs = new Map<string, { evidence: CanaryEvidence; at: number }>();
const proofKey = (provider: RegisteredCanaryProvider, selection: CanarySelection) => JSON.stringify([provider.type, provider.spawn.command, selection.provider, selection.model ?? '', selection.thinkingLevel ?? '']);
export function recentCanaryProof(provider: RegisteredCanaryProvider, selection: CanarySelection, maxAgeMs: number): CanaryEvidence | undefined {
    const hit = recentProofs.get(proofKey(provider, selection));
    return hit && Date.now() - hit.at <= maxAgeMs ? hit.evidence : undefined;
}
export async function runTargetCanaryCached(provider: RegisteredCanaryProvider, selection: CanarySelection): Promise<CanaryEvidence> {
    const evidence = await runTargetCanary(provider, selection);
    if (evidence.ok) recentProofs.set(proofKey(provider, selection), { evidence, at: Date.now() });
    return evidence;
}

export async function runTargetCanary(provider: RegisteredCanaryProvider, selection: CanarySelection,
    options: { env?: NodeJS.ProcessEnv; timeoutMs?: number; parentDir?: string } = {}): Promise<CanaryEvidence> {
    const startedAt = Date.now(), canaryId = randomUUID();
    const bounds = { enforcement: 'host', hostTimeoutMs: HANDOFF_CANARY_HOST_TIMEOUT_MS, hostMaxOutputBytes: HANDOFF_CANARY_HOST_MAX_OUTPUT_BYTES, nativeTurnCap: false, nativeOutputTokenCap: false } as const;
    const result = (ok: boolean, terminated: boolean, code?: string, detail?: string): CanaryEvidence => ({ ok, terminated, ...(code ? { code } : {}), ...(detail ? { detail } : {}),
        canaryId, provider: selection.provider, selection, startedAt, finishedAt: Date.now(), ...bounds });
    if (process.platform === 'win32') return result(false, true, 'canary_process_group_unsupported');
    const refusal = describeCanaryContract(provider, selection);
    if (refusal) return result(false, true, 'canary_contract_unsupported', refusal);
    const spec = provider.hostHandoffCanary!;
    const root = mkdtempSync(join(options.parentDir ?? tmpdir(), 'adhdev-host-canary-'));
    const config = join(root, 'config'), workspace = join(root, 'workspace');
    mkdirSync(config, { mode: 0o700 }); mkdirSync(workspace, { mode: 0o700 });
    let args: string[];
    try { args = substituteCanaryArgs(spec, selection, workspace, config); }
    catch { return result(false, true, 'canary_contract_unsupported', 'canary_contract_unsupported: unknown_substitution'); }
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
            if (bytes > HANDOFF_CANARY_HOST_MAX_OUTPUT_BYTES) { failure = 'canary_output_limit'; terminate(); }
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
