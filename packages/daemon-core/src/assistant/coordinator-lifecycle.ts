/**
 * Coordinator lifecycle for the assistant layer (design
 * docs/design/2026-10-07-assistant-layer.md §4.3 step 2, "비서가 띄운 코디 회수").
 *
 * `ensureCoordinator(meshId)` — the project_send precondition:
 *   - one async mutex per mesh, so two sends in the same assistant turn never
 *     launch two coordinators;
 *   - pick among this daemon's live coordinators of the mesh, in order:
 *     `managedByAssistant` → idle → most recently started;
 *   - none live → launch through the existing in-process
 *     `launch_mesh_coordinator` (ports.launch) with `managedByAssistant: true`
 *     (assistant guidance rides in the base coordinator prompt), then hide its tab
 *     (`set_conversation_prefs hidden`). A launch failure returns the launch
 *     command's own code/error unchanged (§4.8: no automatic fallback CLI).
 *
 * Only the selection and the mutex live here; the ports are bound to the
 * daemon's commands by the caller (commands/high-family/assistant.ts). The
 * idle reaper for managed coordinators (§4.3) is not implemented yet.
 */

import { isSessionHostLiveRuntime, isTerminalRecord, type SessionHostSurfaceRecordLike } from '@adhdev/session-host-core';

/**
 * The launch-scoped addition to a coordinator the assistant launches (§4.3 step 2).
 * Intentionally empty: the guidance it used to carry (relayed instructions, a
 * self-contained final message, questions at the end of the turn) now lives in
 * the BASE coordinator prompt (mesh/coordinator-prompt.ts ASSISTANT_RELAY_SECTION),
 * because pickCoordinator also reuses coordinators the user started, which never
 * saw a launch-only addition. An empty string renders no "Additional Context".
 */
export const ASSISTANT_COORDINATOR_EXTRA_PROMPT = '';

const TERMINAL_STATUSES = new Set(['exited', 'stopped', 'terminated']);
const TERMINAL_RAW_ADAPTER_STATUSES = new Set(['exited', 'stopped', 'terminated', 'error']);
const TERMINAL_RUNTIME_LIFECYCLES = new Set(['exited', 'stopped', 'terminated', 'failed']);

function readText(v: unknown): string {
    return typeof v === 'string' ? v.trim() : '';
}

export function hasSessionHostRuntimeEvidence(runtime: unknown): runtime is Record<string, unknown> {
    if (!runtime || typeof runtime !== 'object') return false;
    const rec = runtime as Record<string, unknown>;
    return rec.surfaceKind != null || rec.lifecycle != null || rec.termination != null;
}

/**
 * True when runtime metadata carries real live session-host runtime evidence
 * (never a static SpecCliAdapter stub with null/absent lifecycle & surfaceKind,
 * and never a stopped/failed/recovery_snapshot/inactive_record surface).
 */
export function isLiveSessionHostRuntimeMetadata(runtime: unknown): boolean {
    if (!runtime || typeof runtime !== 'object') return false;
    const rec = runtime as Record<string, unknown>;
    const lifecycle = readText(rec.lifecycle).toLowerCase();
    if (TERMINAL_RUNTIME_LIFECYCLES.has(lifecycle)) return false;
    if (isTerminalRecord(rec as SessionHostSurfaceRecordLike)) return false;
    return isSessionHostLiveRuntime(rec as SessionHostSurfaceRecordLike);
}

/**
 * Exclude only confirmed terminal runtimes:
 * - disposed === true
 * - state.connected === false
 * - status / drainStatus in {'exited', 'stopped', 'terminated'}
 * - raw adapter status from getStatus({ allowParse: false }) in {'stopped', 'error', 'exited', 'terminated'}
 * - adapter.isAlive() === false
 * - non-live session-host runtime metadata
 * - explicit sessionRegistry termination
 *
 * A live PTY with a parse_error overlay (`status === 'error'`, `errorReason === 'parse_error'`)
 * stays selectable.
 */
export function isConfirmedTerminalCoordinator(
    candidate: unknown,
    sessionRegistry?: { wasInstanceTerminated?: (instanceKey: string) => boolean } | null,
): boolean {
    if (!candidate || typeof candidate !== 'object') return true;
    const inst = candidate as Record<string, any>;
    if (inst.disposed === true || inst.terminal === true) return true;

    const state = typeof inst.getState === 'function' ? inst.getState() : inst;
    if (state?.connected === false || inst.connected === false) return true;

    const sessionId = readText(state?.instanceId ?? inst.sessionId);
    if (sessionId && sessionRegistry?.wasInstanceTerminated?.(sessionId)) return true;

    const rawStatus = readText(state?.status ?? inst.status).toLowerCase();
    const drainStatus = typeof inst.getDrainStatus === 'function' ? readText(inst.getDrainStatus()).toLowerCase() : '';
    if (TERMINAL_STATUSES.has(rawStatus) || TERMINAL_STATUSES.has(drainStatus)) return true;

    const adapter = inst.adapter ?? (typeof inst.getAdapter === 'function' ? inst.getAdapter() : undefined);
    if (inst.adapterAlive === false || (typeof adapter?.isAlive === 'function' && adapter.isAlive() === false)) {
        return true;
    }

    const rawAdapterStatus = readText(
        inst.rawAdapterStatus ?? adapter?.getStatus?.({ allowParse: false })?.status,
    ).toLowerCase();
    if (TERMINAL_RAW_ADAPTER_STATUSES.has(rawAdapterStatus)) {
        return true;
    }

    const stateRuntime = state?.runtime ?? inst.runtime;
    if (hasSessionHostRuntimeEvidence(stateRuntime) && !isLiveSessionHostRuntimeMetadata(stateRuntime)) {
        return true;
    }
    const adapterRuntime = typeof adapter?.getRuntimeMetadata === 'function' ? adapter.getRuntimeMetadata() : undefined;
    if (hasSessionHostRuntimeEvidence(adapterRuntime) && !isLiveSessionHostRuntimeMetadata(adapterRuntime)) {
        return true;
    }

    return false;
}

export interface AssistantCoordinatorView {
    sessionId: string;
    idle: boolean;
    modalParked: boolean;
    managedByAssistant: boolean;
    /** Registry start time (ms) when known; ordering only. */
    startedAt?: number;
}

export interface CoordinatorLaunchOutcome {
    success: boolean;
    sessionId?: string;
    code?: string;
    error?: string;
    [key: string]: unknown;
}

export interface EnsureCoordinatorPorts {
    /** This daemon's live coordinator sessions of the mesh. */
    coordinators(meshId: string): AssistantCoordinatorView[];
    /** Optional gate invoked inside the per-mesh lock right before launching when no live coordinator was found. */
    beforeLaunch?(meshId: string): Promise<CoordinatorLaunchOutcome | void> | CoordinatorLaunchOutcome | void;
    /** In-process `launch_mesh_coordinator`. */
    launch(input: { meshId: string; extraSystemPrompt: string; managedByAssistant: true }): Promise<CoordinatorLaunchOutcome>;
    /** `set_conversation_prefs { hidden: true }` — best-effort. */
    hide(sessionId: string): Promise<void>;
}

export type EnsureCoordinatorResult =
    | { ok: true; sessionId: string; launched: boolean; managedByAssistant: boolean }
    | { ok: false; code: string; error: string; detail: Record<string, unknown> };

/** managedByAssistant → idle → most recently started (registry order breaks remaining ties). */
export function pickCoordinator(views: readonly AssistantCoordinatorView[]): AssistantCoordinatorView | null {
    const liveViews = views.filter((v) => !isConfirmedTerminalCoordinator(v));
    if (liveViews.length === 0) return null;
    const rank = (v: AssistantCoordinatorView) => (v.managedByAssistant ? 2 : 0) + (v.idle ? 1 : 0);
    return [...liveViews].sort((a, b) => rank(b) - rank(a) || (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
}

const meshLocks = new Map<string, Promise<unknown>>();

/** Run `fn` strictly after any earlier holder for the same mesh settled. */
export function withMeshLock<T>(meshId: string, fn: () => Promise<T>): Promise<T> {
    const prior = meshLocks.get(meshId) ?? Promise.resolve();
    const next = prior.then(fn, fn);
    const settled = next.catch(() => undefined);
    meshLocks.set(meshId, settled);
    void settled.then(() => {
        if (meshLocks.get(meshId) === settled) meshLocks.delete(meshId);
    });
    return next;
}

export function ensureCoordinator(meshId: string, ports: EnsureCoordinatorPorts): Promise<EnsureCoordinatorResult> {
    return withMeshLock(meshId, async (): Promise<EnsureCoordinatorResult> => {
        const live = pickCoordinator(ports.coordinators(meshId));
        if (live) return { ok: true, sessionId: live.sessionId, launched: false, managedByAssistant: live.managedByAssistant };
        if (typeof ports.beforeLaunch === 'function') {
            const gate = await ports.beforeLaunch(meshId);
            if (gate && gate.success === false) {
                const code = typeof gate.code === 'string' && gate.code ? gate.code : 'coordinator_launch_denied';
                const error = typeof gate.error === 'string' && gate.error ? gate.error : code;
                const detail: Record<string, unknown> = {};
                for (const [k, v] of Object.entries(gate)) {
                    if (k !== 'success' && k !== 'code' && k !== 'error') detail[k] = v;
                }
                return { ok: false, code, error, detail };
            }
        }
        const launched = await ports.launch({
            meshId,
            extraSystemPrompt: ASSISTANT_COORDINATOR_EXTRA_PROMPT,
            managedByAssistant: true,
        });
        const sessionId = typeof launched?.sessionId === 'string' ? launched.sessionId : '';
        if (!launched?.success || !sessionId) {
            const code = typeof launched?.code === 'string' && launched.code ? launched.code : 'coordinator_launch_failed';
            const error = typeof launched?.error === 'string' && launched.error ? launched.error : code;
            const detail: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(launched ?? {})) {
                if (k !== 'success' && k !== 'code' && k !== 'error') detail[k] = v;
            }
            return { ok: false, code, error, detail };
        }
        try {
            await ports.hide(sessionId);
        } catch { /* best-effort — a visible tab is not a failure */ }
        return { ok: true, sessionId, launched: true, managedByAssistant: true };
    });
}
