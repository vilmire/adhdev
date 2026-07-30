/**
 * RF-ROUTER MED family — coordinator-triggered daemon restart.
 *
 * restart_daemon_node exposes the daemon lifecycle paths (low-family
 * daemon_upgrade / daemon_restart) as a mesh command, so a coordinator can roll
 * a worker daemon onto a freshly deployed version — or just reset its state —
 * without a manual restart round-trip. It mirrors fast_forward_mesh_node's
 * remote-forward shape — resolve the target node, and if it belongs to a remote
 * daemon forward the command there so the owning daemon (not the coordinator)
 * restarts itself — and adds an idle-gate: a node with a generating /
 * waiting_approval / starting session is refused so an in-flight turn is never
 * killed mid-restart.
 *
 * Modes and gate overrides (all opt-in; a bare call behaves exactly like v1):
 *
 * - mode: 'upgrade' (default) reuses daemon_upgrade verbatim — update to the
 *   latest published version on the resolved channel, then detached-restart.
 *   Already-latest is a no-op (no restart), matching the dashboard button.
 *   mode: 'restart' uses daemon_restart — a pure re-spawn with no npm
 *   reinstall, so it restarts even when already latest and the downtime is
 *   just the detached re-spawn. Use it to reset wedged daemon state.
 *
 * - selfOnly: waives blocking sessions that are THIS mesh's own coordinator
 *   session (settings.meshCoordinatorFor === meshId). This breaks the
 *   structural deadlock where the coordinator can never restart its own
 *   daemon because its calling turn is always 'generating'. Other nodes'
 *   blocking sessions still refuse. Ad-hoc coordinator sessions launched
 *   without mesh_coordinator_launch carry no marker — use force for those.
 *
 * - force: bypasses the idle-gate entirely. Destructive: in-flight turns are
 *   killed and the in-memory pendingOutboundQueue is lost (it has no
 *   persistence/restore path). Audit-logged.
 *
 * - whenIdle: instead of refusing, schedule the restart and run it
 *   automatically once all blocking sessions go idle AND no session has
 *   pending outbound coordinator messages queued (the safest path — the
 *   pendingOutboundQueue is empty at that point). The schedule expires after
 *   timeoutMs (default 30 min) and is PERSISTED (state.json, keyed by
 *   mesh/node ownership) so it survives a daemon restart: boot re-arms every
 *   unexpired record and audits/drops the expired ones. cancelWhenIdle
 *   cancels exactly the schedule for the passed mesh/node (never a sibling
 *   mesh/node's); every response carries the current schedule under
 *   `deferredRestart` for visibility.
 *
 * - killSessionHost: also stop the session-host process, destroying EVERY
 *   hosted CLI session (no idle-gate — SessionHostServer.stop kills all PTYs).
 *   Mirrors what Windows already does on upgrade (conpty.node lock). Default
 *   off; POSIX daemons otherwise keep hosted sessions alive across a restart.
 */
import { daemonIdsEquivalent, meshNodeIdMatches } from '@adhdev/mesh-shared';
import { daemonLifecycleHandlers } from '../low-family/daemon-lifecycle.js';
import { LOG } from '../../logging/logger.js';
import { resolveSessionTurnPresentation, isRestartBlockingPresentation } from '../../mesh/mesh-turn-presentation.js';
import {
    clearDeferredRestartSchedule,
    deferredRestartScheduleKey,
    loadDeferredRestartSchedules,
    recordDeferredRestartSchedule,
} from '../../config/state-store.js';
import type { CommandRouterDeps, CommandRouterResult } from '../router.js';
import type { MedFamilyContext, MedFamilyHandler } from './types.js';

// Session states that must block a restart: an in-flight turn or a pending
// approval would be lost when the daemon exits to re-spawn. Mirrors the
// daemon-cloud mandatory-update idle-gate (hasBlockingSessionsForMandatoryUpdate).
const RESTART_BLOCKING_STATES = new Set(['generating', 'waiting_approval', 'waiting_choice', 'finalizing', 'starting']);

const DEFERRED_RESTART_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFERRED_RESTART_MAX_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const DEFERRED_RESTART_POLL_MS = 10_000;

type BlockingSession = {
    instanceId: string | null;
    status: string;
    /** True when this session is the calling mesh's own coordinator session. */
    selfCoordinator: boolean;
    /**
     * True when the session has queued outbound coordinator messages
     * (pendingOutboundQueue). Restart-blocking on its own — a restart would
     * permanently lose those messages — and never waived by selfOnly.
     */
    pendingOutbound: boolean;
};

function collectBlockingSessions(deps: CommandRouterDeps, meshId: string): BlockingSession[] {
    const blocking: BlockingSession[] = [];
    const states = deps.instanceManager.collectAllStates();
    const consider = (state: any) => {
        const status = String(state?.status || '');
        const instanceId = typeof state?.instanceId === 'string' ? state.instanceId : null;
        // OUTBOUND-QUEUE SAFETY: a session with queued outbound coordinator
        // messages blocks the restart even when its turn state reads idle —
        // the queue is in-memory only, so a restart now would silently drop
        // those messages. The deferred (whenIdle) poll re-checks this every
        // tick, so the restart fires only once the queue has drained.
        const pendingOutbound = typeof state?.pendingOutboundCount === 'number' && state.pendingOutboundCount > 0;
        // TURN-PRESENTATION (Stage 6): for mesh-owned work (a session with a turn
        // attempt), block on the AUTHORITATIVE nonterminal turn state — including
        // finalizing / waiting_approval / waiting_choice — not on a transient
        // provider idle sample. Equally, a provider sample stuck on 'generating'
        // must NOT block once the reducer committed the attempt terminal.
        // Sessions with no attempt keep the legacy sample verdict.
        const turn = resolveSessionTurnPresentation({
            sessionId: instanceId,
            legacyStatus: status,
            surface: 'restart_gate',
        });
        if (!pendingOutbound && !isRestartBlockingPresentation(turn, RESTART_BLOCKING_STATES.has(status))) return;
        blocking.push({
            instanceId,
            status: turn.authority === 'turn_reducer' ? turn.status : status,
            // The coordinator marker is stamped by mesh_coordinator_launch and
            // re-stamped on restore (cli-manager.restoreHostedSessions). Ad-hoc
            // coordinator sessions have no marker and are NOT waived by selfOnly.
            selfCoordinator: !!meshId && state?.settings?.meshCoordinatorFor === meshId,
            pendingOutbound,
        });
    };
    for (const state of states) {
        consider(state);
        const childStates = 'extensions' in state && Array.isArray((state as any).extensions)
            ? (state as any).extensions
            : [];
        for (const child of childStates) consider(child);
    }
    return blocking;
}

type RestartMode = 'upgrade' | 'restart';

type PendingDeferredRestart = {
    meshId: string;
    nodeId: string;
    mode: RestartMode;
    killSessionHost: boolean;
    scheduledAt: number;
    expiresAt: number;
    timer: NodeJS.Timeout;
};

// Scheduled restarts on THIS (owning) daemon, keyed by mesh/node ownership.
// The command is forwarded to the owning daemon before scheduling, which is
// also the process whose session states the poll inspects. Keying keeps a
// second mesh/node schedule from clobbering (or a cancel from cross-
// cancelling) the first; every entry is mirrored to state.json so a daemon
// restart does not silently drop the schedule.
const pendingDeferredRestarts = new Map<string, PendingDeferredRestart>();

function deferredRestartInfo(key: string): Record<string, unknown> | null {
    const record = pendingDeferredRestarts.get(key);
    if (!record) return null;
    return {
        meshId: record.meshId,
        nodeId: record.nodeId,
        mode: record.mode,
        killSessionHost: record.killSessionHost,
        scheduledAt: new Date(record.scheduledAt).toISOString(),
        expiresAt: new Date(record.expiresAt).toISOString(),
        runCondition: 'executes automatically once no session is generating / waiting_approval / starting and no outbound coordinator message is queued',
    };
}

/** Stop and forget exactly one schedule (timer + in-memory record + persisted record). */
function clearPendingDeferredRestart(key: string): void {
    const record = pendingDeferredRestarts.get(key);
    if (!record) return;
    clearInterval(record.timer);
    pendingDeferredRestarts.delete(key);
    try {
        clearDeferredRestartSchedule(record.meshId, record.nodeId);
    } catch { /* persistence cleanup is best-effort — the in-memory record is already gone */ }
}

/** Test hook: drop all in-memory schedules (timers included) without touching persisted state. */
export function __clearDeferredRestartsForTests(): void {
    for (const record of pendingDeferredRestarts.values()) clearInterval(record.timer);
    pendingDeferredRestarts.clear();
}

function normalizeRestartMode(value: unknown): RestartMode {
    return value === 'restart' ? 'restart' : 'upgrade';
}

function restartWarnings(args: { killSessionHost: boolean; forced: boolean }): string[] {
    const warnings: string[] = [];
    if (args.forced) {
        warnings.push('forced restart over active sessions — in-flight turns were interrupted and the in-memory pendingOutboundQueue is permanently lost (no persistence/restore path).');
    }
    if (args.killSessionHost) {
        warnings.push('killSessionHost: the session-host process was stopped — ALL hosted CLI sessions on this machine are destroyed (hard refresh).');
    }
    if (process.platform === 'win32') {
        warnings.push('Windows: the daemon restart/upgrade path stops the session-host regardless of options — all hosted sessions terminate.');
    } else {
        warnings.push('POSIX: hosted PTY sessions survive a plain daemon restart and rebind on next boot (unless killSessionHost was set).');
    }
    return warnings;
}

async function executeRestart(deps: CommandRouterDeps, args: any, opts: { forced: boolean }): Promise<CommandRouterResult> {
    const mode = normalizeRestartMode(args?.mode);
    const killSessionHost = args?.killSessionHost === true;
    const result = mode === 'restart'
        ? await daemonLifecycleHandlers.daemon_restart({ deps }, { killSessionHost })
        : await daemonLifecycleHandlers.daemon_upgrade({ deps }, args);
    const restarting = (result as any)?.restarting === true;
    return {
        ...result,
        mode,
        restarted: restarting,
        ...(restarting ? {
            warnings: restartWarnings({ killSessionHost, forced: opts.forced }),
            // MCP IPC has no automatic reconnect/retry — tell the caller when to
            // talk to this daemon again.
            clientHint: 'daemon restarting — retry your next call in ~10s',
        } : {}),
    } as CommandRouterResult;
}

function scheduleDeferredRestart(deps: CommandRouterDeps, args: any, meshId: string, nodeId: string): CommandRouterResult {
    const key = deferredRestartScheduleKey(meshId, nodeId);
    // Re-scheduling the same mesh/node replaces exactly that record; a
    // different mesh/node's schedule is untouched.
    clearPendingDeferredRestart(key);
    const requestedTimeout = typeof args?.timeoutMs === 'number' && Number.isFinite(args.timeoutMs)
        ? args.timeoutMs
        : DEFERRED_RESTART_DEFAULT_TIMEOUT_MS;
    const timeoutMs = Math.min(Math.max(requestedTimeout, DEFERRED_RESTART_POLL_MS), DEFERRED_RESTART_MAX_TIMEOUT_MS);
    const record: PendingDeferredRestart = {
        meshId,
        nodeId,
        mode: normalizeRestartMode(args?.mode),
        killSessionHost: args?.killSessionHost === true,
        scheduledAt: Date.now(),
        expiresAt: Date.now() + timeoutMs,
        timer: setInterval(() => { void deferredRestartTick(deps, key); }, DEFERRED_RESTART_POLL_MS),
    };
    record.timer.unref?.();
    pendingDeferredRestarts.set(key, record);
    try {
        recordDeferredRestartSchedule({
            meshId: record.meshId,
            nodeId: record.nodeId,
            mode: record.mode,
            killSessionHost: record.killSessionHost,
            scheduledAt: record.scheduledAt,
            expiresAt: record.expiresAt,
        });
    } catch (e: any) {
        LOG.warn('MeshRestart', `Failed to persist deferred restart for node ${nodeId} — it will NOT survive a daemon restart: ${e?.message || String(e)}`);
    }
    LOG.info('MeshRestart', `Deferred restart scheduled for node ${nodeId} (mode=${record.mode}, expires in ${Math.round(timeoutMs / 60000)}min)`);
    return {
        success: true,
        restarted: false,
        scheduled: true,
        code: 'restart_scheduled_when_idle',
        reason: 'Restart scheduled — it will execute automatically as soon as no session on this daemon is generating / waiting_approval / starting and no outbound coordinator message is queued. Running at an idle point also avoids pendingOutboundQueue loss, making this the safest restart path. The schedule is persisted and re-armed on daemon boot.',
        deferredRestart: deferredRestartInfo(key),
    } as CommandRouterResult;
}

async function deferredRestartTick(deps: CommandRouterDeps, key: string): Promise<void> {
    const record = pendingDeferredRestarts.get(key);
    if (!record) return;
    if (Date.now() >= record.expiresAt) {
        LOG.warn('MeshRestart', `Deferred restart for node ${record.nodeId} expired without reaching an idle point; dropping the schedule`);
        clearPendingDeferredRestart(key);
        return;
    }
    const blocking = collectBlockingSessions(deps, record.meshId);
    if (blocking.length > 0) return;
    LOG.info('MeshRestart', `Deferred restart for node ${record.nodeId} executing — daemon is idle`);
    clearPendingDeferredRestart(key);
    try {
        await executeRestart(deps, {
            meshId: record.meshId,
            nodeId: record.nodeId,
            mode: record.mode,
            killSessionHost: record.killSessionHost,
        }, { forced: false });
    } catch (e: any) {
        LOG.error('MeshRestart', `Deferred restart execution failed: ${e?.message || String(e)}`);
    }
}

/**
 * Boot path: re-arm every persisted, unexpired deferred-restart schedule this
 * daemon owns (the whenIdle schedule used to live only in memory, so a daemon
 * restart silently dropped it). Expired records are audit-logged and dropped
 * from disk. Idempotent: an already-armed key is left alone.
 */
export function rearmPersistedDeferredRestarts(deps: CommandRouterDeps): void {
    let persisted: ReturnType<typeof loadDeferredRestartSchedules>;
    try {
        persisted = loadDeferredRestartSchedules();
    } catch (e: any) {
        LOG.warn('MeshRestart', `Failed to load persisted deferred restarts: ${e?.message || String(e)}`);
        return;
    }
    const now = Date.now();
    for (const [key, record] of Object.entries(persisted)) {
        if (pendingDeferredRestarts.has(key)) continue;
        if (now >= record.expiresAt) {
            LOG.warn('MeshRestart', `Persisted deferred restart for node ${record.nodeId} (mesh ${record.meshId}) expired while the daemon was down (scheduled ${new Date(record.scheduledAt).toISOString()}, expired ${new Date(record.expiresAt).toISOString()}); dropping it without executing`);
            try {
                clearDeferredRestartSchedule(record.meshId, record.nodeId);
            } catch { /* best-effort cleanup */ }
            continue;
        }
        const rearmed: PendingDeferredRestart = {
            meshId: record.meshId,
            nodeId: record.nodeId,
            mode: record.mode === 'restart' ? 'restart' : 'upgrade',
            killSessionHost: record.killSessionHost === true,
            scheduledAt: record.scheduledAt,
            expiresAt: record.expiresAt,
            timer: setInterval(() => { void deferredRestartTick(deps, key); }, DEFERRED_RESTART_POLL_MS),
        };
        rearmed.timer.unref?.();
        pendingDeferredRestarts.set(key, rearmed);
        LOG.info('MeshRestart', `Re-armed persisted deferred restart for node ${record.nodeId} (mode=${rearmed.mode}, expires ${new Date(record.expiresAt).toISOString()})`);
    }
}

export const meshRestartHandlers: Record<string, MedFamilyHandler> = {
    restart_daemon_node: async (ctx: MedFamilyContext, args: any): Promise<CommandRouterResult> => {
        const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        const nodeId = typeof args?.nodeId === 'string' ? args.nodeId.trim() : '';

        // Resolve the target node's owning daemon so a command that lands on a
        // non-owner daemon is forwarded rather than restarting the wrong daemon.
        // preferInline so inline-cache-only worktree nodes still resolve.
        let nodeDaemonId: string | undefined;
        if (meshId && nodeId) {
            const meshRecord = await ctx.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
            const node = meshRecord?.mesh?.nodes?.find((n: any) => meshNodeIdMatches(n, nodeId));
            nodeDaemonId = typeof node?.daemonId === 'string' ? node.daemonId.trim() : undefined;
        }

        const selfDaemonId = ctx.deps.statusInstanceId;
        // daemonIdsEquivalent: a legacy-form daemonId resolving to this machine's
        // core is local — execute here instead of forwarding (and P2P self-dial).
        // Equivalent → local. _meshDirectDispatch prevents re-forwarding once the
        // call has landed on the owning daemon.
        const isRemote = nodeDaemonId && selfDaemonId && !daemonIdsEquivalent(nodeDaemonId, selfDaemonId);
        if (isRemote && ctx.deps.dispatchMeshCommand && !args?._meshDirectDispatch) {
            const forwarded = await ctx.deps.dispatchMeshCommand(nodeDaemonId!, 'restart_daemon_node', {
                ...(typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}),
                _meshDirectDispatch: true,
            });
            return (forwarded ?? { success: false, error: 'no response from remote node' }) as CommandRouterResult;
        }

        // Deferred-schedule management on the owning daemon. Cancellation and
        // status are scoped to the passed mesh/node key: a second mesh/node's
        // schedule is never cross-cancelled, and `cancelled` truthfully
        // reports whether THIS key had a live schedule.
        const scheduleKey = deferredRestartScheduleKey(meshId, nodeId);
        if (args?.cancelWhenIdle === true) {
            const had = pendingDeferredRestarts.has(scheduleKey);
            clearPendingDeferredRestart(scheduleKey);
            return { success: true, restarted: false, cancelled: had, deferredRestart: null } as CommandRouterResult;
        }
        if (args?.whenIdleStatus === true) {
            return { success: true, restarted: false, deferredRestart: deferredRestartInfo(scheduleKey) } as CommandRouterResult;
        }

        // Idle-gate: refuse if any session on THIS daemon is mid-turn / awaiting
        // approval / starting / holding queued outbound coordinator messages —
        // unless an explicit opt-in waives it.
        const blocking = collectBlockingSessions(ctx.deps, meshId);
        if (blocking.length > 0) {
            if (args?.force === true) {
                // Bypass the gate entirely. Audit-logged: this kills in-flight
                // turns and drops the unpersisted pendingOutboundQueue.
                LOG.warn('MeshRestart', `force restart over ${blocking.length} blocking session(s): ${blocking.map((b) => `${b.instanceId || '?'}(${b.status})`).join(', ')} — pendingOutboundQueue will be lost`);
                return executeRestart(ctx.deps, args, { forced: true });
            }
            // selfOnly waives ONLY the calling mesh's own coordinator sessions —
            // and never a pendingOutbound block: a queued outbound coordinator
            // message would be permanently lost by the restart, so that gate is
            // not waivable (use whenIdle and let the queue drain).
            const foreignBlocking = blocking.filter((b) => !b.selfCoordinator || b.pendingOutbound);
            if (args?.selfOnly === true && foreignBlocking.length === 0) {
                // Only the calling mesh's own coordinator session is blocking —
                // the structural self-deadlock case. Waive exactly those.
                LOG.info('MeshRestart', `selfOnly restart: waiving ${blocking.length} self-coordinator session(s) for mesh ${meshId}`);
                return executeRestart(ctx.deps, args, { forced: false });
            }
            if (args?.whenIdle === true) {
                return scheduleDeferredRestart(ctx.deps, args, meshId, nodeId);
            }
            return {
                success: false,
                restarted: false,
                code: 'blocking_sessions',
                reason: 'Daemon has an active session (generating / waiting_approval / starting) or queued outbound coordinator messages; restart refused to avoid interrupting in-flight work or losing queued messages. Retry when the node is idle.',
                blockingSessions: blocking,
                options: {
                    selfOnly: 'waive only this mesh\'s own coordinator session (settings.meshCoordinatorFor === meshId) — never waives queued outbound messages',
                    force: 'bypass the idle-gate entirely — kills in-flight turns and loses the unpersisted pendingOutboundQueue',
                    whenIdle: 'schedule the restart to run automatically once the daemon goes idle (safest)',
                },
                deferredRestart: deferredRestartInfo(scheduleKey),
            } as CommandRouterResult;
        }

        return executeRestart(ctx.deps, args, { forced: false });
    },
};
