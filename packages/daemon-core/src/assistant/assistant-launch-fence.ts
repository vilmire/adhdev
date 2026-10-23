/** Process-local cancellation authority, keyed by the pre-minted runtime UUID.
 * It is never supplied by command JSON. Keep cancelled entries until dispatch
 * settles, so an old continuation cannot lose its cancellation evidence. */
export class AssistantLaunchFence {
    aborted = false;
    dispatched = false;
    cleanupPending = false;
    sessionId?: string;
    onCleanupAcknowledged?: () => void;
    private spawning = false;

    /** Synchronous acknowledgement: all future spawn entries consult this fence.
     * Once registration/spawning starts we cannot prove cancellation; keep the
     * account lock until the dispatched operation and cleanup have settled. */
    cancelBeforeSpawn(): boolean {
        if (this.spawning) return false;
        this.aborted = true;
        return true;
    }

    get spawnStarted(): boolean { return this.spawning; }

    beginSpawn(): void {
        if (this.aborted) throw Object.assign(new Error('assistant_launch_cancelled'), { code: 'assistant_launch_cancelled' });
        this.spawning = true;
    }
}

const dispatches = new Map<string, AssistantLaunchFence>();

export function registerAssistantLaunchFence(sessionId: string, fence: AssistantLaunchFence): void {
    fence.sessionId = sessionId;
    dispatches.set(sessionId, fence);
}

export function beginAssistantSpawn(sessionId: string): void {
    dispatches.get(sessionId)?.beginSpawn();
}

export function retireAssistantLaunchFence(fence: AssistantLaunchFence): void {
    if (fence.sessionId && dispatches.get(fence.sessionId) === fence) dispatches.delete(fence.sessionId);
}
