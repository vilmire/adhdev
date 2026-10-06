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
 *     and the fixed two-line extra system prompt, then hide its tab
 *     (`set_conversation_prefs hidden`). A launch failure returns the launch
 *     command's own code/error unchanged (§4.8: no automatic fallback CLI).
 *
 * Only the selection and the mutex live here; the ports are bound to the
 * daemon's commands by the caller (commands/high-family/assistant.ts). The
 * idle reaper for managed coordinators (§4.3) is not implemented yet.
 */

/** The fixed addition to a coordinator the assistant launches (§4.3 step 2). */
export const ASSISTANT_COORDINATOR_EXTRA_PROMPT = [
    "Instructions arrive from the user's assistant; your final message of each turn is relayed to the user.",
    'Ask questions by ending your turn with them.',
].join('\n');

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
    /** cliType to launch with (mesh's last registry cliType, else the assistant default); null → the launch command decides. */
    cliTypeFor(meshId: string): string | null;
    /** In-process `launch_mesh_coordinator`. */
    launch(input: { meshId: string; cliType: string | null; extraSystemPrompt: string; managedByAssistant: true }): Promise<CoordinatorLaunchOutcome>;
    /** `set_conversation_prefs { hidden: true }` — best-effort. */
    hide(sessionId: string): Promise<void>;
}

export type EnsureCoordinatorResult =
    | { ok: true; sessionId: string; launched: boolean; managedByAssistant: boolean }
    | { ok: false; code: string; error: string; detail: Record<string, unknown> };

/** managedByAssistant → idle → most recently started (registry order breaks remaining ties). */
export function pickCoordinator(views: readonly AssistantCoordinatorView[]): AssistantCoordinatorView | null {
    if (views.length === 0) return null;
    const rank = (v: AssistantCoordinatorView) => (v.managedByAssistant ? 2 : 0) + (v.idle ? 1 : 0);
    return [...views].sort((a, b) => rank(b) - rank(a) || (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
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
        const launched = await ports.launch({
            meshId,
            cliType: ports.cliTypeFor(meshId),
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
