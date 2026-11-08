import { createHash } from 'node:crypto';
import { noteWriterStopPending } from '../mesh/mesh-writer-stop-diagnostics.js';
import { pinnedMeshNodeIdMatches } from '../mesh/mesh-pinned-node-identity.js';
/** Exact mesh stop. An RPC acknowledgement or disappearing adapter is never
 * quiescence. Keep owner authority unless the captured native tree is gone. */
import { captureWriterStop, readWriterStopCapture, markWriterStopQuiescent } from './mesh-writer-stop-journal.js';
import { hiddenExecFileAsync } from '../process/hidden-spawn.js';
import { readSystemProcessTableAsync } from '../process/process-table-snapshot.js';
import type { ProcessNodeInfo } from '../process/session-process-tree.js';
import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { resolveHostBootId } from '@adhdev/session-host-core';
import type { CancelDispatchRequest } from '../mesh/turn-ledger/effects.js';
import type { DaemonCliManager } from './cli-manager.js';
import { nativeMeshAssignmentMeta } from '../providers/cli-provider-mesh-assignment.js';

type WriterStopHostControl = NonNullable<DaemonCliManager['deps']['idleSessionLifetimeControl']>;

/** The session host's boot id (same resolution order as idle-lifetime/operator cleanup), or null when unknowable. */
async function writerStopHostBootId(control: WriterStopHostControl | undefined): Promise<string | null> {
    if (!control) return null;
    try {
        if (typeof control.resolveHostBootId === 'function') return (await control.resolveHostBootId()) || null;
        if (typeof control.getDiagnostics !== 'function') return null;
        const diagnostics = await control.getDiagnostics({});
        if (typeof diagnostics.hostBootId === 'string' && diagnostics.hostBootId) return diagnostics.hostBootId;
        return resolveHostBootId({ hostStartedAt: diagnostics.hostStartedAt }) || null;
    } catch { return null; }
}

const UNBOUND_BUSY_STATUSES: ReadonlySet<string> = new Set(['generating', 'starting', 'waiting_approval', 'waiting_choice']);

/** Stops only if the host still sees this exact incarnation with no task bound. A host refusal is an unconfirmed stop. */
async function stopUnboundWriter(control: WriterStopHostControl | undefined, sessionId: string, runtimeKey: string, startedAt: number): Promise<boolean> {
    const hostBootId = await writerStopHostBootId(control);
    if (!hostBootId || typeof control?.stopSessionIfExpected !== 'function') return false;
    const stopped = await control.stopSessionIfExpected(sessionId,
        { sessionId, hostBootId, runtimeKey, startedAt, taskId: null, attemptId: null, generation: null, dispatchNonce: null });
    return stopped?.lifecycle === 'stopped' || stopped?.lifecycle === 'stopping';
}

/**
 * Force-end: stop this writer's session through the host's compare-and-stop, built from the host's
 * own record of the running incarnation. Still refuses a session that is not this mesh's worker or
 * that a different attempt currently owns; it no longer refuses on process-tree ambiguity.
 */
async function forceEndHostedWriter(
    host: Pick<DaemonCliManager, 'adapters' | 'deps'>,
    request: CancelDispatchRequest,
    pending: (reason: string) => { success: boolean; [key: string]: unknown },
): Promise<{ success: boolean; [key: string]: unknown }> {
    const control = host.deps.idleSessionLifetimeControl;
    const hostBootId = await writerStopHostBootId(control);
    if (!control || !hostBootId || typeof control.stopSessionIfExpected !== 'function') return pending('force_host_unavailable');
    const receipt = (extra: Record<string, unknown>) => ({ ...request, success: true, quiescent: true, forced: true,
        incarnation: createHash('sha256').update(JSON.stringify([request.stopRequestId, request.sessionId, extra])).digest('hex'), ...extra });
    try {
        const record = (await control.listSessions()).find(r => r.sessionId === request.sessionId);
        if (!record) return receipt({ evidence: { kind: 'host_session_absent', sessionId: request.sessionId, hostBootId, observedAt: Date.now() } });
        const meta = (record.meta ?? {}) as Record<string, any>;
        const active = meta.meshActiveAssignment as Record<string, unknown> | undefined;
        const bound = typeof active?.taskId === 'string' && !!active.taskId;
        if (meta.meshNodeFor !== request.meshId || meta.assistant === true || meta.meshCoordinatorFor
            || (bound ? active!.attemptId !== request.attemptId : meta.launchedByCoordinator !== true)) {
            return pending('foreign_or_unbound_writer');
        }
        if (record.lifecycle === 'stopped') return receipt({ evidence: { kind: 'host_session_absent', sessionId: request.sessionId, hostBootId, observedAt: Date.now() } });
        if (!record.runtimeKey || !record.startedAt) return pending('native_incarnation_unknown');
        const stopped = await control.stopSessionIfExpected(request.sessionId, {
            sessionId: request.sessionId, hostBootId, runtimeKey: record.runtimeKey, startedAt: record.startedAt,
            taskId: bound ? String(active!.taskId) : null,
            attemptId: bound ? (active!.attemptId as string | null) ?? null : null,
            generation: bound ? (active!.generation as number | null) ?? null : null,
            dispatchNonce: bound ? (active!.dispatchNonce as number | null) ?? null : null,
        });
        if (stopped?.lifecycle !== 'stopped' && stopped?.lifecycle !== 'stopping') return pending('force_stop_unconfirmed');
        return receipt({});
    } catch { return pending('force_stop_failed'); }
}

/** Inspection answer: this writer is live and no exact stop has reached it, so the owner may send one. */
export const WRITER_STOP_NEVER_ATTEMPTED = 'exact_stop_never_attempted';

/** `pgid` is null where the OS has no process groups (Windows): containment is then the parent tree alone. */
export interface NativeWriterProcess { pid: number; ppid: number; pgid: number | null; birth: string; uid: number }
const inWriterGroup = (p: NativeWriterProcess, root: NativeWriterProcess) => root.pgid !== null && p.pgid === root.pgid;
/** Windows records the creation time a moment before the session host stamps `startedAt`. */
const birthToleranceMs = (root: NativeWriterProcess) => root.pgid === null ? 5_000 : 1_000;

/** A table with an unknown start time cannot rule out PID reuse, so it is no observation at all. */
export function nativeProcessesFromWindowsTable(rows: readonly ProcessNodeInfo[] | null): NativeWriterProcess[] | null {
    if (!rows?.length) return null;
    const out: NativeWriterProcess[] = [];
    for (const row of rows) {
        if (typeof row.startedAtMs !== 'number') {
            // The System Idle and System processes report no creation time and are never a writer.
            if (row.pid <= 4) continue;
            return null;
        }
        out.push({ pid: row.pid, ppid: row.ppid, pgid: null, uid: 0, birth: new Date(row.startedAtMs).toString() });
    }
    return out.length ? out : null;
}
export interface WriterStopPorts {
    read(): Promise<NativeWriterProcess[] | null>;
    pause(): Promise<void>;
    /** Signal a process group (POSIX). Used only for the writer's own detached descendants. */
    signalGroup?(pgid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
}
/** One unreadable row voids the table: a process we cannot read could be the writer. */
export function parseNativeProcessTable(stdout: string): NativeWriterProcess[] | null {
    const rows: NativeWriterProcess[] = [];
    for (const line of stdout.split('\n').filter(x => x.trim())) {
        // macOS runs some daemons as `nobody`, whose uid prints as -2.
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(.+)$/);
        if (!m || !Number.isFinite(Date.parse(m[5]))) return null;
        rows.push({ pid: +m[1], ppid: +m[2], pgid: +m[3], uid: +m[4], birth: m[5].replace(/\s+/g, ' ') });
    }
    return rows.length ? rows : null;
}

export const nativeWriterStopPorts: WriterStopPorts = {
    async read() {
        if (process.platform === 'win32') return nativeProcessesFromWindowsTable(await readSystemProcessTableAsync('win32'));
        const { stdout } = await hiddenExecFileAsync('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid=,uid=,lstart='],
            { encoding: 'utf8', timeout: 2000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
        return parseNativeProcessTable(String(stdout));
    },
    pause: () => new Promise(resolve => setTimeout(resolve, 100)),
    signalGroup(pgid, signal) {
        if (process.platform === 'win32' || !(pgid > 1)) return;
        try { process.kill(-pgid, signal); } catch { /* already gone */ }
    },
};
let testPorts: WriterStopPorts | undefined;
export function __setWriterStopPortsForTests(ports: WriterStopPorts | undefined): void { testPorts = ports; }

export async function stopExactMeshWriter(
    host: Pick<DaemonCliManager, 'adapters' | 'deps'>,
    request: CancelDispatchRequest,
    ports: WriterStopPorts = testPorts ?? nativeWriterStopPorts,
): Promise<{ success: boolean; [key: string]: unknown }> {
    const pending = (reason: string) => { noteWriterStopPending(request.sessionId, reason); return { success: false, code: 'writer_checkpoint_pending', reason }; };
    if (typeof request.stopRequestId !== 'string' || !request.stopRequestId || request.stopRequestId.length > 512
        || !request.providerType || !request.ownerDaemonId || !request.meshId || !request.taskId) return pending('missing_identity');
    const live = host.deps.getInstanceManager()?.getInstance(request.sessionId)?.getState().settings;
    const launch = host.deps.getSessionRegistry?.()?.get(request.sessionId)?.launch;
    if (live?.assistant || live?.meshCoordinatorFor || launch?.launchedBy === 'assistant' || launch?.roleLaunch) return pending('protected_role');
    // Owner decision: past the ledger's force bound the stop must end. The session host's exact
    // compare-and-stop is the authority; the tree-ambiguity refusals below are skipped.
    if (request.force === true && request.inspectOnly !== true) return forceEndHostedWriter(host, request, pending);
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
            if (!table.some(p => inWriterGroup(p, previous.root) || previous.tree.some(old => old.pid === p.pid))) {
                markWriterStopQuiescent(request);
                return { ...request, success: true, quiescent: true, incarnation: previous.incarnation };
            }
        } catch { return pending('native_observation_unknown'); }
    }
    // A restored daemon can have neither adapter nor native capture for a
    // session that already exited. Only the session's HOST can attest absence;
    // an empty local adapter map or an unreachable host is not evidence.
    if (!previous && !host.adapters.has(request.sessionId)) {
        try {
            if (!host.deps.listHostedCliRuntimes) return pending('unknown, cannot prove dead: host inventory unavailable');
            // The census is only meaningful for ONE host incarnation: bind it to the
            // host boot id read before AND after the listing. An unknown or changed
            // boot id (host restarted mid-census, older host) stays pending.
            const control = host.deps.idleSessionLifetimeControl;
            const bootBefore = await writerStopHostBootId(control);
            const records = await host.deps.listHostedCliRuntimes();
            if (host.adapters.has(request.sessionId)) return pending('writer_reappeared');
            if (!records.some(r => r.runtimeId === request.sessionId)) {
                const hostBootId = await writerStopHostBootId(control);
                if (!bootBefore || !hostBootId || bootBefore !== hostBootId) return pending('unknown, cannot prove dead: host boot id unavailable or changed');
                const evidence = { kind: 'host_session_absent', sessionId: request.sessionId, hostBootId, observedAt: Date.now() };
                return { ...request, success: true, quiescent: true, evidence,
                    incarnation: createHash('sha256').update(JSON.stringify([request, evidence])).digest('hex') };
            }
            return pending('unknown, cannot prove dead: host still reports session');
        } catch { return pending('unknown, cannot prove dead: host unreachable'); }
    }
    // No capture means no exact stop ever reached this writer (it is written right
    // before the stop): the owner's bounded tries may all have died in transport.
    if (request.inspectOnly) return pending(previous ? 'quiescence_not_confirmed' : WRITER_STOP_NEVER_ATTEMPTED);
    const adapter = host.adapters.get(request.sessionId);
    const instance = host.deps.getInstanceManager()?.getInstance(request.sessionId);
    // A daemon restart restores the attempt ref but never the task id or nonce. The
    // attempt ref still names this writer; the session host's own persisted assignment
    // is then the authority for the task and nonce (verified below, exact).
    const restoredBinding = (s: Record<string, any> | undefined) => !s?.meshActiveTaskId && s?.meshActiveDispatchNonce === undefined;
    const matches = () => {
        const s = instance?.getState().settings;
        return host.adapters.get(request.sessionId) === adapter && adapter?.cliType === request.providerType
            && s?.assistant !== true && !s?.meshCoordinatorFor
            && s?.meshNodeFor === request.meshId
            && s?.meshActiveAttemptId === request.attemptId && (s?.meshActiveAttemptGeneration ?? 0) === request.generation
            && (restoredBinding(s) || (s?.meshActiveTaskId === request.taskId && (s?.meshActiveDispatchNonce ?? 0) === (request.dispatchNonce ?? 0)))
            && (!request.nodeId || pinnedMeshNodeIdMatches(s?.meshNodeId, request.nodeId))
            && typeof s?.meshCoordinatorDaemonId === 'string' && daemonIdsEquivalent(s.meshCoordinatorDaemonId, request.ownerDaemonId!);
    };
    // The session's own idle edge can clear its stamp while the owner still waits on
    // this attempt. It is still the attempt's exact session, so a worker the coordinator
    // launched can be stopped through the host's compare-and-stop for an unbound session.
    // A session the user started only carried this task, and is never ours to stop.
    const unboundWorker = () => {
        const s = instance?.getState().settings;
        return host.adapters.get(request.sessionId) === adapter && adapter?.cliType === request.providerType
            && s?.assistant !== true && !s?.meshCoordinatorFor && s?.launchedByCoordinator === true
            && s?.meshNodeFor === request.meshId && !s?.meshActiveTaskId && !s?.meshActiveAttemptId
            && (!request.nodeId || pinnedMeshNodeIdMatches(s?.meshNodeId, request.nodeId))
            && typeof s?.meshCoordinatorDaemonId === 'string' && daemonIdsEquivalent(s.meshCoordinatorDaemonId, request.ownerDaemonId!);
    };
    const unbound = unboundWorker();
    const current = () => unbound ? unboundWorker() : matches();
    if (!adapter || !instance || !current()) return pending('foreign_or_unbound_writer');
    if (unbound && UNBOUND_BUSY_STATUSES.has(String(instance.getState().status))) return pending('unbound_writer_busy');
    const meta = adapter.getRuntimeMetadata?.() as { runtimeId?: string; runtimeKey?: string; osPid?: number; startedAt?: number; lifecycle?: string } | undefined;
    if (meta?.runtimeId !== request.sessionId || !meta.runtimeKey || !meta.osPid || !meta.startedAt || meta.lifecycle !== 'running') return pending('native_incarnation_unknown');
    const captured = { ...meta };
    try {
        const settings = instance.getState().settings as Record<string, any>;
        const assignmentMeta = nativeMeshAssignmentMeta(restoredBinding(settings)
            ? { ...settings, meshActiveTaskId: request.taskId, meshActiveDispatchNonce: request.dispatchNonce ?? 0 } : settings);
        if (!unbound && !await adapter.verifyRuntimeMeta?.(assignmentMeta)) return pending('native_ownership_unconfirmed');
        if (!current()) return pending('native_ownership_unconfirmed');
        const before = await ports.read();
        const root = before?.find(p => p.pid === captured.osPid);
        if (!before || !root || (root.pgid !== null && root.pgid !== root.pid) || Math.abs(Date.parse(root.birth) - captured.startedAt!) > birthToleranceMs(root) || !current()) return pending('native_identity_drift');
        const tree = new Set([root.pid]);
        for (let pass = 0; pass < before.length; pass++) {
            const old = tree.size;
            // Windows reuses PIDs and keeps a dead parent's id on its children, so a
            // "child" older than the parent it names is not a child of it.
            for (const p of before) if (tree.has(p.ppid) && (root.pgid !== null || Date.parse(p.birth) >= Date.parse(before.find(x => x.pid === p.ppid)!.birth))) tree.add(p.pid);
            if (old === tree.size) break;
        }
        // A foreign member of the writer's group, or a descendant running as another user, makes
        // containment ambiguous. A descendant that moved to its OWN process group is still the
        // writer's (proven by the parent chain and birth order above) — CLIs such as codex run every
        // tool command that way. Refusing it left a finished worker's report held forever (live
        // 2026-11-08: one member 840+ refusals, the mesh host 1h+). Such groups are stopped with the writer below.
        if (root.pgid !== null && before.some(p => (tree.has(p.pid) && p.uid !== root.uid)
            || (p.pgid === root.pgid && !tree.has(p.pid)))) return pending('ambiguous_worker_tree');
        // Detached groups: led by a tree member and holding only tree members (a group that also
        // holds foreign processes is not ours to signal).
        const detachedGroups = root.pgid === null ? [] : [...new Set(before
            .filter(p => tree.has(p.pid) && p.pgid !== null && p.pgid !== root.pgid)
            .map(p => p.pgid as number))];
        if (detachedGroups.some(g => before.some(p => p.pgid === g && !tree.has(p.pid)))) return pending('ambiguous_worker_tree');
        const held = before.filter(p => tree.has(p.pid));
        const capture = captureWriterStop(request, root, held, captured.runtimeKey!, captured.startedAt!);
        // Recheck the source claim immediately before the exact adapter stop.
        if (!current()) return pending('claim_changed');
        const stopped = unbound
            ? await stopUnboundWriter(host.deps.idleSessionLifetimeControl, request.sessionId, captured.runtimeKey!, captured.startedAt!)
            : await adapter.stopMeshWriter?.({ runtimeKey: captured.runtimeKey!, startedAt: captured.startedAt!,
                osPid: captured.osPid!, providerType: request.providerType,
                assignment: assignmentMeta.meshActiveAssignment as import('@adhdev/session-host-core').MeshWriterAssignment });
        if (!stopped) return pending('native_exact_stop_unconfirmed');
        for (let pass = 0; pass < 10; pass++) {
            await ports.pause();
            const after = await ports.read();
            if (!after) return pending('native_observation_unknown');
            // PID reuse is ambiguous, never a proof that our captured tree died.
            if (after.some(p => held.some(old => old.pid === p.pid && old.birth !== p.birth))) return pending('pid_reused');
            // Stop the writer's detached descendants: a group still led by the SAME process (pid AND
            // birth match the capture) is signalled — TERM first, KILL from the fourth pass.
            for (const g of detachedGroups) {
                const leader = held.find(h => h.pid === g);
                const alive = after.some(p => p.pgid === g && held.some(h => h.pid === p.pid && h.birth === p.birth));
                if (!alive || (leader && !after.some(p => p.pid === g && p.birth === leader.birth) && after.some(p => p.pid === g))) continue;
                ports.signalGroup?.(g, pass < 3 ? 'SIGTERM' : 'SIGKILL');
            }
            if (!after.some(p => inWriterGroup(p, root) || tree.has(p.pid))) {
                markWriterStopQuiescent(request);
                return { ...request, success: true, quiescent: true,
                    incarnation: capture.incarnation };
            }
        }
        return pending('worker_tree_still_live');
    } catch { return pending('stop_or_native_read_failed'); }
}
