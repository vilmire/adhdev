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

/** Best-effort: a failed stop leaves the session to the idle reaper (it can never claim other work anyway). */
export async function stopLightWorkerSession(meshId: string, taskId: string, sessionIdHint?: string): Promise<boolean> {
    try {
        const task = MeshRuntimeStore.getInstance().findQueueEntryById(meshId, taskId);
        const sessionId = task?.light ? (task.targetSessionId || task.assignedSessionId || sessionIdHint) : undefined;
        if (!sessionId || !lightSessionStopper) return false;
        await lightSessionStopper({ meshId, taskId, sessionId });
        return true;
    } catch (e: any) {
        LOG.warn('LightTask', `could not stop the light session of ${taskId}: ${e?.message || e}`);
        return false;
    }
}

