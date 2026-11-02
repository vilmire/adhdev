/**
 * Ending a light task's worker session. Split out of light-task-result.ts so the terminal choke point
 * (mesh-task-terminal.ts) can stop the session of a CANCELLED light task without importing the capture module.
 */
import { LOG } from '../logging/logger.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';

/**
 * Ends the light worker's session once its task is terminal and the result is captured. Installed at boot with the
 * daemon's operator session-stop path (`cleanupMeshSessions` mode 'stop', which records an intentional stop). The
 * workspace stays — it holds the branch until land/discard; only the session ends.
 */
export type LightSessionStopper = (input: { meshId: string; taskId: string; sessionId: string }) => Promise<void>;
let lightSessionStopper: LightSessionStopper | null = null;
export function setLightSessionStopper(fn: LightSessionStopper | null): void { lightSessionStopper = fn; }

const TERMINAL = new Set(['completed', 'failed', 'blocked', 'cancelled']);

/**
 * Best-effort: a failed stop leaves the session to the idle reaper (it can never claim other work anyway).
 * The session to stop comes only from the light row itself (the dispatcher pins `targetSessionId`), never
 * from a caller-supplied id. With `onlyStatus`, the row's state is checked in the same read that resolves the
 * session: only a light row in one of those terminal statuses at that moment has its session stopped.
 */
export async function stopLightWorkerSession(meshId: string, taskId: string, onlyStatus?: readonly string[]): Promise<boolean> {
    try {
        const task = MeshRuntimeStore.getInstance().findQueueEntryById(meshId, taskId);
        // The capture path calls this right after its own capture, before the terminal commit lands, so the state
        // gate applies only when a caller names the statuses it acts on (the cancel path).
        if (!task?.light || (onlyStatus && !(TERMINAL.has(task.status) && onlyStatus.includes(task.status)))) return false;
        const sessionId = task.targetSessionId || task.assignedSessionId;
        if (!sessionId || !lightSessionStopper) return false;
        await lightSessionStopper({ meshId, taskId, sessionId });
        return true;
    } catch (e: any) {
        LOG.warn('LightTask', `could not stop the light session of ${taskId}: ${e?.message || e}`);
        return false;
    }
}
