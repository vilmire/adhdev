/** Exact mesh stop. An RPC acknowledgement or disappearing adapter is never
 * quiescence. Keep owner authority unless the captured native tree is gone. */
import { captureWriterStop, readWriterStopCapture, markWriterStopQuiescent } from './mesh-writer-stop-journal.js';
import { hiddenExecFileAsync } from '../process/hidden-spawn.js';
import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import type { CancelDispatchRequest } from '../mesh/turn-ledger/effects.js';
import type { DaemonCliManager } from './cli-manager.js';
import { nativeMeshAssignmentMeta } from '../providers/cli-provider-mesh-assignment.js';

export interface NativeWriterProcess { pid: number; ppid: number; pgid: number; birth: string; uid: number }
export interface WriterStopPorts {
    read(): Promise<NativeWriterProcess[] | null>;
    pause(): Promise<void>;
}
export const nativeWriterStopPorts: WriterStopPorts = {
    async read() {
        if (process.platform === 'win32') return null;
        const { stdout } = await hiddenExecFileAsync('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid=,uid=,lstart='],
            { encoding: 'utf8', timeout: 2000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
        const rows: NativeWriterProcess[] = [];
        for (const line of String(stdout).split('\n').filter(x => x.trim())) {
            const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
            if (!m || !Number.isFinite(Date.parse(m[5]))) return null;
            rows.push({ pid: +m[1], ppid: +m[2], pgid: +m[3], uid: +m[4], birth: m[5].replace(/\s+/g, ' ') });
        }
        return rows.length ? rows : null;
    },
    pause: () => new Promise(resolve => setTimeout(resolve, 100)),
};
let testPorts: WriterStopPorts | undefined;
export function __setWriterStopPortsForTests(ports: WriterStopPorts | undefined): void { testPorts = ports; }

export async function stopExactMeshWriter(
    host: Pick<DaemonCliManager, 'adapters' | 'deps'>,
    request: CancelDispatchRequest,
    ports: WriterStopPorts = testPorts ?? nativeWriterStopPorts,
): Promise<{ success: boolean; [key: string]: unknown }> {
    const pending = (reason: string) => ({ success: false, code: 'writer_checkpoint_pending', reason });
    if (typeof request.stopRequestId !== 'string' || !request.stopRequestId || request.stopRequestId.length > 512
        || !request.providerType || !request.ownerDaemonId || !request.meshId || !request.taskId) return pending('missing_identity');
    const live = host.deps.getInstanceManager()?.getInstance(request.sessionId)?.getState().settings;
    const launch = host.deps.getSessionRegistry?.()?.get(request.sessionId)?.launch;
    if (live?.assistant || live?.meshCoordinatorFor || launch?.launchedBy === 'assistant' || launch?.roleLaunch) return pending('protected_role');
    let previous;
    try { previous = readWriterStopCapture(request); } catch { return pending('capture_identity_mismatch'); }
    if (previous) {
        try {
            const table = await ports.read();
            if (!table) return pending('native_observation_unknown');
            const current = host.adapters.get(request.sessionId)?.getRuntimeMetadata?.() as { runtimeKey?: string; osPid?: number; startedAt?: number } | undefined;
            if (current && (current.osPid !== previous.root.pid || current.runtimeKey !== previous.runtimeKey
                || current.startedAt !== previous.startedAt)) return pending('native_identity_drift');
            if (table.some(p => previous.tree.some(old => old.pid === p.pid && old.birth !== p.birth))) return pending('pid_reused');
            if (!table.some(p => p.pgid === previous.root.pgid || previous.tree.some(old => old.pid === p.pid))) {
                markWriterStopQuiescent(request);
                return { ...request, success: true, quiescent: true, incarnation: previous.incarnation };
            }
        } catch { return pending('native_observation_unknown'); }
    }
    if (request.inspectOnly) return pending('quiescence_not_confirmed');
    const adapter = host.adapters.get(request.sessionId);
    const instance = host.deps.getInstanceManager()?.getInstance(request.sessionId);
    const matches = () => {
        const s = instance?.getState().settings;
        return host.adapters.get(request.sessionId) === adapter && adapter?.cliType === request.providerType
            && s?.assistant !== true && !s?.meshCoordinatorFor
            && s?.meshNodeFor === request.meshId && s?.meshActiveTaskId === request.taskId
            && s?.meshActiveAttemptId === request.attemptId && (s?.meshActiveAttemptGeneration ?? 0) === request.generation
            && (s?.meshActiveDispatchNonce ?? 0) === (request.dispatchNonce ?? 0)
            && (!request.nodeId || s?.meshNodeId === request.nodeId)
            && typeof s?.meshCoordinatorDaemonId === 'string' && daemonIdsEquivalent(s.meshCoordinatorDaemonId, request.ownerDaemonId!);
    };
    if (!adapter || !instance || !matches()) return pending('foreign_or_unbound_writer');
    const meta = adapter.getRuntimeMetadata?.() as { runtimeId?: string; runtimeKey?: string; osPid?: number; startedAt?: number; lifecycle?: string } | undefined;
    if (meta?.runtimeId !== request.sessionId || !meta.runtimeKey || !meta.osPid || !meta.startedAt || meta.lifecycle !== 'running') return pending('native_incarnation_unknown');
    const captured = { ...meta };
    try {
        const assignmentMeta = nativeMeshAssignmentMeta(instance.getState().settings as Record<string, any>);
        if (!await adapter.verifyRuntimeMeta?.(assignmentMeta) || !matches()) return pending('native_ownership_unconfirmed');
        const before = await ports.read();
        const root = before?.find(p => p.pid === captured.osPid);
        if (!before || !root || root.pgid !== root.pid || Math.abs(Date.parse(root.birth) - captured.startedAt!) > 1000 || !matches()) return pending('native_identity_drift');
        const tree = new Set([root.pid]);
        for (let pass = 0; pass < before.length; pass++) {
            const old = tree.size;
            for (const p of before) if (tree.has(p.ppid)) tree.add(p.pid);
            if (old === tree.size) break;
        }
        // A detached descendant or foreign member makes containment ambiguous.
        if (before.some(p => (tree.has(p.pid) && (p.pgid !== root.pgid || p.uid !== root.uid))
            || (p.pgid === root.pgid && !tree.has(p.pid)))) return pending('ambiguous_worker_tree');
        const held = before.filter(p => tree.has(p.pid));
        const capture = captureWriterStop(request, root, held, captured.runtimeKey!, captured.startedAt!);
        // Recheck the source claim immediately before the exact adapter stop.
        if (!matches()) return pending('claim_changed');
        const stopped = await adapter.stopMeshWriter?.({ runtimeKey: captured.runtimeKey!, startedAt: captured.startedAt!,
            osPid: captured.osPid!, providerType: request.providerType,
            assignment: assignmentMeta.meshActiveAssignment as import('@adhdev/session-host-core').MeshWriterAssignment });
        if (!stopped) return pending('native_exact_stop_unconfirmed');
        for (let pass = 0; pass < 10; pass++) {
            await ports.pause();
            const after = await ports.read();
            if (!after) return pending('native_observation_unknown');
            // PID reuse is ambiguous, never a proof that our captured tree died.
            if (after.some(p => held.some(old => old.pid === p.pid && old.birth !== p.birth))) return pending('pid_reused');
            if (!after.some(p => p.pgid === root.pgid || tree.has(p.pid))) {
                markWriterStopQuiescent(request);
                return { ...request, success: true, quiescent: true,
                    incarnation: capture.incarnation };
            }
        }
        return pending('worker_tree_still_live');
    } catch { return pending('stop_or_native_read_failed'); }
}
