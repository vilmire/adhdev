/** Read-only target inspection plus the target-installed bounded canary. No
 * peer-supplied commands, source paths, bootstrap scripts or auth files. */
import { execFile } from 'node:child_process';
import { realpathSync, statSync, accessSync, constants } from 'node:fs';
import { promisify } from 'node:util';
import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { normalizeRepoIdentity } from '../../config/mesh-config-store.js';
import { runTargetCanary, type RegisteredCanaryProvider } from './target-canary.js';
import type { HandoffLaunchPlan } from './types.js';

export interface ReadinessCheck { id: string; ok: boolean; detail?: string }
export interface ReadinessMesh { id: string; repoIdentity?: string; nodes?: Array<{ id: string; daemonId?: string; workspace?: string }> }
export interface ReadinessPorts {
    selfDaemonId: string;
    mesh: ReadinessMesh;
    plan?: HandoffLaunchPlan;
    validateSelection(plan: HandoffLaunchPlan): boolean;
    provider(plan: HandoffLaunchPlan): RegisteredCanaryProvider | undefined;
    coordinatorCapable(plan: HandoffLaunchPlan, workspace: string): boolean;
    census(): Promise<unknown[]>;
}
const exec = promisify(execFile);
export async function inspectTargetReadiness(p: ReadinessPorts): Promise<{ ok: boolean; checks: ReadinessCheck[] }> {
    const checks: ReadinessCheck[] = [];
    const add = (id: string, ok: boolean, detail?: string) => checks.push({ id, ok, ...(detail ? { detail } : {}) });
    const plan = p.plan;
    add('launch_selection', !!plan && p.validateSelection(plan));
    const nodes = (p.mesh.nodes ?? []).filter(n => n.daemonId && daemonIdsEquivalent(n.daemonId, p.selfDaemonId));
    const node = plan?.targetNodeId ? nodes.find(n => n.id === plan.targetNodeId) : nodes.length === 1 ? nodes[0] : undefined;
    // An explicit node binding is required; an ambiguous or stale roster cannot
    // let the ordinary launch default select a different machine/workspace.
    add('target_workspace_binding', !!node && !!plan?.targetNodeId);
    let workspace: string | undefined;
    if (node?.workspace) {
        try {
            workspace = realpathSync(node.workspace);
            if (!statSync(workspace).isDirectory()) workspace = undefined;
            else accessSync(workspace, constants.R_OK | constants.W_OK | constants.X_OK);
        } catch { workspace = undefined; }
    }
    add('workspace_access', !!workspace);
    if (workspace) {
        try {
            const git = (args: string[]) => exec('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args],
                { cwd: workspace, timeout: 3_000, maxBuffer: 64 * 1024, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } });
            const root = (await git(['rev-parse', '--show-toplevel'])).stdout.trim();
            const remote = (await git(['config', '--get', 'remote.origin.url'])).stdout.trim();
            add('repository_identity', realpathSync(root) === workspace && !!p.mesh.repoIdentity
                && normalizeRepoIdentity(remote) === normalizeRepoIdentity(p.mesh.repoIdentity));
        } catch { add('repository_identity', false, 'A registered repository with matching identity is required.'); }
    } else add('repository_identity', false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const rows = await Promise.race([p.census(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('runtime timeout')), 3_000); })]);
        add('session_runtime', Array.isArray(rows) && rows.every(r => r && typeof r === 'object' && typeof (r as { sessionId?: unknown }).sessionId === 'string'));
    } catch { add('session_runtime', false); }
    finally { if (timer) clearTimeout(timer); }
    const provider = plan ? p.provider(plan) : undefined;
    add('provider_installed', !!provider && provider.type === plan?.provider);
    add('coordinator_capability', !!plan && !!workspace && p.coordinatorCapable(plan, workspace));
    if (checks.every(c => c.ok) && provider && plan) {
        try {
            const evidence = await runTargetCanary(provider, plan);
            add('provider_auth_canary', evidence.ok && evidence.terminated, evidence.ok
                ? `host-enforced ${evidence.hostTimeoutMs}ms ${evidence.hostMaxOutputBytes} output bytes; nativeTurnCap false; nativeOutputTokenCap false; canary ${evidence.canaryId}; terminated`
                : (evidence.detail ?? evidence.code));
        } catch { add('provider_auth_canary', false, 'Canary could not be verified.'); }
    } else add('provider_auth_canary', false, 'Prerequisites must pass before running a canary.');
    return { ok: checks.every(c => c.ok), checks };
}
