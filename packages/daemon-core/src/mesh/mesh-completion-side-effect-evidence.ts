// COMPLETION-SIDE-EFFECT-EVIDENCE
//
// A `code_change` task's completion notification is built entirely from the
// worker's OWN self-reported transcript shape (final_assistant present? a JSON
// answer parsed?) — never from whether the workspace actually changed. A worker
// that delegates the real work to a subagent and returns can self-report a
// "genuine" completion with zero commits. The ASYNC path below is a best-effort,
// diagnostic-only follow-up: it runs strictly AFTER the synchronous
// task_completed ledger append + coordinator notification that
// mesh-event-forwarding.ts already performs (that whole event-forwarding
// pipeline is synchronous end to end, invoked from a plain EventEmitter
// callback with no request awaiting its result — see injectMeshSystemMessage),
// so it can only ever ADD a follow-up ledger entry, never delay or block
// delivery of the completion itself.
//
// checkCodeChangeWorkspaceCleanSync (below) is the WIRED-INTO-STATE counterpart:
// mesh-event-forwarding.ts's markSessionTerminal calls it SYNCHRONOUSLY, before
// the queue-row status flip, so a clean-tree code_change completion can be
// flagged for review in the SAME state transition instead of only via a
// trailing ledger entry nothing re-reads. It reuses the exact local-node +
// workspace resolution this file already uses for the async path, but shells
// out to git synchronously (execFileSync) with a short, caller-bounded timeout
// — the async getGitRepoStatus() has no sync form, and turning the whole
// event-forwarding pipeline async to await it would be a much larger, riskier
// change than this file's narrow ownership allows. Any failure (timeout,
// git error, not-a-repo) fails OPEN — `checked:false` — so a slow/broken git
// call degrades to exactly today's behavior (no review flag), never to a
// stuck or delayed completion.
//
// Deliberately LOCAL-ONLY (both the async and sync checks): a REMOTE node's
// status is only reachable via a P2P round trip issued from the MCP/coordinator
// layer (mesh_git_status), which this daemon-core event-processing path has no
// handle to. Checking the completing node's OWN daemon only (no P2P) keeps this
// a pure local filesystem read — cheap, no network. A remote node's completion
// is left unchecked (fails open) by resolveLocalCodeChangeWorkspace's isLocal guard.
import { execFileSync } from 'node:child_process';
import type { DaemonComponents } from '../boot/daemon-lifecycle.js';
import { resolveWin32Executable } from '../cli-adapters/resolve-executable.js';
import { loadConfig } from '../config/config.js';
import { getMesh } from '../config/mesh-config.js';
import { getGitRepoStatus } from '../git/git-status.js';
import { LOG } from '../logging/logger.js';
import { daemonIdsEquivalent, expandDaemonIdForms, meshNodeIdMatches } from '@adhdev/mesh-shared';
import { appendLedgerEntry } from './mesh-ledger.js';
import { readMeshNodeDaemonId } from './mesh-node-identity.js';

const GIT = process.platform === 'win32' ? resolveWin32Executable('git') : 'git';

function readNonEmptyString(value: unknown): string {
    return typeof value === 'string' && value.trim() ? value.trim() : '';
}

// Mirrors resolveCoordinatorDrainDaemonIds in mesh-event-forwarding.ts: every
// id form this daemon answers to, so a node's daemonId can be compared for
// local-machine equivalence regardless of which form it was stamped in.
function resolveLocalDaemonIds(components: DaemonComponents): string[] {
    const statusInstanceId = readNonEmptyString((components as { statusInstanceId?: string }).statusInstanceId);
    const machineId = readNonEmptyString(loadConfig().machineId);
    return expandDaemonIdForms([statusInstanceId, machineId]);
}

/**
 * Resolve a code_change task's node to a LOCAL workspace path, or undefined if
 * the node is unresolvable, has no workspace, or is not this daemon (remote —
 * no local filesystem access, no P2P transport on this path). Shared by the
 * async diagnostic scheduler and the sync state-gating check so the two can
 * never disagree about which nodes are in scope.
 */
export function resolveLocalCodeChangeWorkspace(
    components: DaemonComponents,
    meshId: string,
    nodeId: string | undefined,
): string | undefined {
    if (!nodeId) return undefined;
    const mesh = getMesh(meshId);
    const node = mesh?.nodes.find((n: any) => meshNodeIdMatches(n, nodeId));
    const workspace = readNonEmptyString(node?.workspace);
    if (!workspace) return undefined;

    const nodeDaemonId = node ? readMeshNodeDaemonId(node as unknown as Record<string, unknown>) : undefined;
    if (nodeDaemonId) {
        const localDaemonIds = resolveLocalDaemonIds(components);
        const isLocal = localDaemonIds.some((id) => daemonIdsEquivalent(id, nodeDaemonId));
        if (!isLocal) return undefined;
    }
    return workspace;
}

export interface SyncGitCleanCheckResult {
    /** True when the check actually ran to completion (repo resolved, status read). */
    checked: boolean;
    /** Only meaningful when checked===true: true when the working tree has no diff. */
    clean: boolean;
}

/**
 * Bounded, synchronous, fail-open "is this workspace a clean git repo" check.
 * Used ONLY by mesh-event-forwarding.ts's markSessionTerminal to gate the
 * terminal state decision itself (see the file-header note above for why this
 * needs a sync form distinct from the async getGitRepoStatus()).
 *
 * Fails open (`{checked:false, clean:false}`, clean is meaningless here) on ANY
 * git error, non-zero exit, or timeout — including a workspace that is not a
 * git repository. Callers MUST treat checked:false as "no evidence either way",
 * never as "dirty" or "clean". `timeoutMs` bounds the worst case this can add
 * to the synchronous completion path; keep it short (this runs on the hot
 * completion path, unlike the async diagnostic which has no such constraint).
 */
export function checkCodeChangeWorkspaceCleanSync(workspace: string, timeoutMs: number): SyncGitCleanCheckResult {
    try {
        const output = execFileSync(GIT, ['status', '--porcelain=v2'], {
            cwd: workspace,
            encoding: 'utf8',
            timeout: timeoutMs,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        return { checked: true, clean: output.trim().length === 0 };
    } catch (e: any) {
        LOG.warn('MeshLedger', `Sync git-clean check skipped for workspace ${workspace}: ${e?.message || e}`);
        return { checked: false, clean: false };
    }
}

export function scheduleTaskCompletionSideEffectEvidence(
    components: DaemonComponents,
    args: {
        meshId: string;
        taskId?: string;
        taskMode?: string;
        sessionId?: string;
        nodeId?: string;
    },
): void {
    if (args.taskMode !== 'code_change') return;
    if (!args.taskId) return;
    const nodeId = args.nodeId;
    if (!nodeId) return;

    setImmediate(() => {
        (async () => {
            try {
                // Fail-open, local-only: a node whose daemonId isn't one of THIS daemon's
                // own forms is remote — skip rather than attempt a P2P round trip this path
                // has no transport for (cost guard: never block/slow completion delivery).
                const workspace = resolveLocalCodeChangeWorkspace(components, args.meshId, nodeId);
                if (!workspace) return;

                const status = await getGitRepoStatus(workspace, { includeSubmodules: false });
                if (!status.isGitRepo) return;
                if (status.dirty) return; // has a diff — evidence is already consistent, nothing to downgrade

                appendLedgerEntry(args.meshId, {
                    kind: 'task_completion_no_side_effects',
                    nodeId,
                    sessionId: args.sessionId,
                    taskId: args.taskId,
                    payload: {
                        taskId: args.taskId,
                        sessionId: args.sessionId,
                        nodeId,
                        workspace,
                        gitDirty: false,
                        changedFiles: 0,
                        reason: 'no_side_effects',
                    },
                });
            } catch (e: any) {
                // Fail-open: this is purely diagnostic. Never let a git error surface as a
                // task failure or slow down/interrupt the completion path.
                LOG.warn('MeshLedger', `Skipped completion side-effect evidence check for task ${args.taskId}: ${e?.message || e}`);
            }
        })();
    });
}
