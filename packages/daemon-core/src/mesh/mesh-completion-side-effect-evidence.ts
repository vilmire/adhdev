// COMPLETION-SIDE-EFFECT-EVIDENCE
//
// A `code_change` task's completion notification is built entirely from the
// worker's OWN self-reported transcript shape (final_assistant present? a JSON
// answer parsed?) — never from whether the workspace actually changed. A worker
// that delegates the real work to a subagent and returns can self-report a
// "genuine" completion with zero commits. This is a best-effort, ASYNC,
// diagnostic-only follow-up: it runs strictly AFTER the synchronous
// task_completed ledger append + coordinator notification that
// mesh-event-forwarding.ts already performs (that whole event-forwarding
// pipeline is synchronous end to end, invoked from a plain EventEmitter
// callback with no request awaiting its result — see injectMeshSystemMessage),
// so this can only ever ADD a follow-up ledger entry, never delay or block
// delivery of the completion itself.
//
// Deliberately LOCAL-ONLY: git status has no synchronous form (git is always an
// async subprocess spawn) and a REMOTE node's status is only reachable via a
// P2P round trip issued from the MCP/coordinator layer (mesh_git_status), which
// this daemon-core event-processing path has no handle to. Checking the
// completing node's OWN daemon only (no P2P) keeps this a pure local
// filesystem read — cheap, no network, and safe to run on every code_change
// completion instead of needing its own throttle.
import type { DaemonComponents } from '../boot/daemon-lifecycle.js';
import { loadConfig } from '../config/config.js';
import { getMesh } from '../config/mesh-config.js';
import { getGitRepoStatus } from '../git/git-status.js';
import { LOG } from '../logging/logger.js';
import { daemonIdsEquivalent, expandDaemonIdForms, meshNodeIdMatches } from '@adhdev/mesh-shared';
import { appendLedgerEntry } from './mesh-ledger.js';
import { readMeshNodeDaemonId } from './mesh-node-identity.js';

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
                const mesh = getMesh(args.meshId);
                const node = mesh?.nodes.find((n: any) => meshNodeIdMatches(n, nodeId));
                const workspace = readNonEmptyString(node?.workspace);
                if (!workspace) return;

                // Fail-open, local-only: a node whose daemonId isn't one of THIS daemon's
                // own forms is remote — skip rather than attempt a P2P round trip this path
                // has no transport for (cost guard: never block/slow completion delivery).
                const nodeDaemonId = node ? readMeshNodeDaemonId(node as unknown as Record<string, unknown>) : undefined;
                if (nodeDaemonId) {
                    const localDaemonIds = resolveLocalDaemonIds(components);
                    const isLocal = localDaemonIds.some((id) => daemonIdsEquivalent(id, nodeDaemonId));
                    if (!isLocal) return;
                }

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
