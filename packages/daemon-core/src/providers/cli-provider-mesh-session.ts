/**
 * Mesh-session facets of a CLI provider instance: whether the session is a
 * delegated worker / autonomous mesh session, the per-turn task attribution
 * the completion path stamps, and the mesh-only raw terminal read / key
 * injection gates.
 *
 * Split out of cli-provider-instance.ts (file-size gate). Functions take the
 * instance through the compiler-checked {@link MeshSessionHost} view.
 */
import type { MeshSendKeyItem, MeshSendKeyName } from '../cli-adapters/provider-cli-shared.js';
import { isWorkerMcpEnabled } from '../runtime-defaults.js';
import { meshTaskAttachments, resolveCompletingTaskId } from './mesh-task-attachment.js';
import { runMeshStallTick, type MeshStallHost } from './completion/mesh-stall-watchdog.js';
import type { CliProviderInstance } from './cli-provider-instance.js';

/** The CliProviderInstance members these functions read or call (compiler-checked; no cast). */
export type MeshSessionHost = Pick<CliProviderInstance, 'adapter' | 'completingTurnTaskId' | 'instanceId' | 'isMeshWorkerSession' | 'meshTaskAttachmentHistory' | 'meshTaskInjectedAt' | 'settings'>;

// EVTTRACE (observation-only): is this a mesh worker session whose completion
// events must route to a coordinator? Used purely to gate trace logging so a
// non-mesh CLI session's completions don't add EvtTrace noise. No decision logic.
export function isMeshWorkerSession(host: MeshSessionHost): boolean {
    return !!(host.settings.meshNodeFor || host.settings.meshActiveTaskId
        || host.settings.meshNodeId || host.settings.launchedByCoordinator);
}

/**
 * MESH-READ-TERMINAL (feature 2: RAW terminal read). Public read of the
 * CURRENT rendered PTY viewport for the mesh_read_terminal tool, delegating to
 * the adapter's narrow getTerminalScreenSnapshot() (viewport + cursor + size
 * only; no debug buffers / parser state / history; byte-bounded, bottom-tail
 * preserved).
 *
 * Gated on isMeshWorkerSession(): this raw viewport can expose tokens /
 * command args / env / user data, so only a coordinator-spawned worker session
 * is readable. The MCP layer ALSO cross-checks mesh/session/node ownership
 * (isMeshOwnedDelegateSession) — isMeshWorkerSession alone is a broad
 * "delegated" gate, so the two together block cross-mesh access. Returns null
 * for a non-mesh session so the daemon command surfaces a clean refusal.
 */
export function getTerminalScreenSnapshot(host: MeshSessionHost, maxBytes?: number): {
        text: string;
        cursor: { col: number; row: number };
        cols: number;
        rows: number;
        truncated: boolean;
        originalBytes: number;
        returnedBytes: number;
        hash: string;
    } | null {
    if (!host.isMeshWorkerSession()) return null;
    return host.adapter.getTerminalScreenSnapshot(maxBytes);
}

/**
 * MESH-SEND-KEYS (feature 3: key injection). Public entry for the
 * mesh_send_keys tool, delegating to the adapter's injectKeys() (structured
 * key encoding + atomic write + submit-race recheck + modal fail-closed).
 *
 * Gated on isMeshWorkerSession(): PTY input into a worker is a
 * coordinator-only capability. The MCP layer ALSO cross-checks mesh/session/
 * node ownership (isMeshOwnedDelegateSession) and owns the destructive-key
 * double gate (confirm_destructive + policy) and the audit ledger. Returns a
 * refusal object for a non-mesh session so the daemon command surfaces a clean
 * error (never silently writes to a non-worker PTY).
 */
export async function injectKeys(host: MeshSessionHost, items: MeshSendKeyItem[], opts: { allowModalOverride?: boolean } = {}): Promise<
        | { ok: true; keys: MeshSendKeyName[]; hasDestructive: boolean; submits: boolean; bytes: number }
        | { ok: false; refused: 'submit_race' | 'actionable_modal' | 'generating' | 'not_mesh_worker'; keys: MeshSendKeyName[]; hasDestructive: boolean; message?: string }
    > {
    if (!host.isMeshWorkerSession()) {
        return { ok: false, refused: 'not_mesh_worker', keys: [], hasDestructive: false };
    }
    return host.adapter.injectKeys(items, opts);
}

/**
 * AUTOAPPROVE-FLAP-RECUR (Fix A+B): how long a busy blip / modal scroll-out may
 * persist before the in-progress settle gate is torn down. For a delegated
 * worker whose auto-approve episode is genuinely still cycling (mask clock
 * alive), the FSM's full waiting_approval → busy → waiting_approval flap runs
 * on a multi-second period, so the settle continuity window is extended to
 * AUTO_APPROVE_FLAP_CONTINUITY_MS to bridge it (still bounded, and still capped
 * by AUTO_APPROVE_MASK_STALL_MS). Every other case — foreground/attended
 * session, or no active mask episode — keeps the tight default hysteresis so a
 * genuine resolution frees the gate promptly.
 */

// FALSE-IDLE (self-coordinator settle): an autonomously-progressing mesh session
// is either a delegated worker (isMeshWorkerSession) OR the coordinator's OWN
// claude-cli session (meshCoordinatorFor). Both run auto-approved tool turns whose
// inter-approval valley (busy→idle blip→generating re-entry ~0.5s later) must be
// absorbed by the completedDebounce settle window, not flushed on the first idle
// sample. The worker branch already gets NATIVE_HISTORY_MESH_IDLE_SETTLE_MS; the
// self-coordinator session (worker markers absent, meshCoordinatorFor present) was
// taking flushDelay=0 — no settle window — so its busyEpoch/lastOutputAt continuity
// guard had no window to observe the valley and fired mid-turn "next-step" previews
// as a finalSummary. Mirrors the isAutonomousMeshSession notion in isTransientToolConsent.
export function isAutonomousMeshSession(host: MeshSessionHost): boolean {
    return host.isMeshWorkerSession() || !!host.settings.meshCoordinatorFor;
}

/**
 * The taskId to attribute the CURRENTLY-completing turn to: the attachment
 * history's pending entry when the worker-MCP flag is on, else the session scalar
 * (settings.meshActiveTaskId). Returns undefined for a non-task ad-hoc turn.
 */
export function completingTurnTaskId(host: MeshSessionHost): string | undefined { // WORKER-MCP T2 precursor (mesh-task-attachment.ts): flag-on, a pending entry wins over the binding+scalar below.
    const fromHistory = isWorkerMcpEnabled() ? resolveCompletingTaskId(meshTaskAttachments(host.meshTaskAttachmentHistory)) : undefined; if (fromHistory) return fromHistory;
    const scalar = host.settings.meshActiveTaskId;
    return typeof scalar === 'string' && scalar.trim() ? scalar : undefined;
}

// EVTTRACE correlation context for this session's completion lifecycle. taskId is
// the primary grep anchor; instanceId is the session fallback.
export function meshTraceCtx(host: MeshSessionHost, event = 'agent:generating_completed'): Record<string, unknown> {
    return {
        // ARCH-REFACTOR R1: trace the per-turn taskId (falling back to the scalar) so
        // EvtTrace anchors on the same id the completion event actually carries.
        taskId: host.completingTurnTaskId(),
        sessionId: host.instanceId,
        nodeId: host.settings.meshNodeId,
        meshId: host.settings.meshNodeFor,
        event,
    };
}

/**
 * MESH-STALL-WATCH (feature 1: STALL detection). Status-agnostic stall
 * watchdog for coordinator-spawned mesh worker sessions. Driven by the
 * ProviderInstanceManager's existing 5s onTick loop (NO new timer) — see
 * ProviderInstanceManager.startTicking. Reuses the adapter's raw-PTY-output
 * clock (lastOutputAt, bumped on every output chunk) as the sole signal: if a
 * live worker's screen has been byte-for-byte unchanged past the turn-scoped
 * threshold (below), fire ONE informational monitor:no_progress event down the
 * existing task_stalled ledger + pendingCoordinatorEvent path.
 *
 * The reported status is read for TWO bounded purposes only — it does NOT
 * suppress the fire (sticky-status blindness would hide a real wedge):
 *   • Fix B (anchor re-arm on turn end): the FSM's completion/idle transition
 *     never touches the stall anchor, so a completed worker that goes idle would
 *     otherwise keep counting from its LAST pre-completion output and false-fire
 *     in the quiet valley right after finishing. We detect the turn-active edge
 *     (hasAdapterPendingResponse()) and, on active → inactive, re-arm the anchor
 *     to `now` so the post-completion idle valley starts a fresh clock.
 *   • Fix C (turn-scoped threshold): while a turn is genuinely in flight the bar
 *     is raised (MESH_WORKER_STALL_TURN_THRESHOLD_MS) to absorb long normal
 *     thinking gaps; outside a turn the tighter idle bound applies. This is a
 *     RAISE, not a skip — a real mid-turn wedge still fires late at the turn bound.
 *
 * Anchoring: the episode arms against the current lastOutputAt; a worker that
 * has emitted nothing yet (lastOutputAt === 0) anchors on this.startedAt (spawn
 * time) so a silent spawn is still caught. Any new output re-arms the anchor
 * and clears the emitted flag, so one continuous stall emits at most once and a
 * later stall re-arms cleanly. Fix E adds a per-session refire cooldown so a
 * dribble of one-byte-per-few-minutes output cannot page the coordinator on
 * every re-arm.
 */
export function checkMeshWorkerStall(host: MeshStallHost, now: number): void {
    runMeshStallTick(host, now);
}
