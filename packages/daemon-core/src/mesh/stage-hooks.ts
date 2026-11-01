// Review-in-task: late-bound hooks from the terminal choke point to the stage runtime.
// mesh-task-terminal.ts must not import the runtime (cycle + boot order), so the runtime registers itself here.
// Unregistered (tests, standalone tools) = no-ops: a held terminal then simply stays held until the next tick.

export interface StageHookTarget {
    onImplCompleted(meshId: string, parentId: string, attemptId?: string): Promise<void>;
    onChildTerminal(meshId: string, childId: string): Promise<void>;
    onChildClaimed(meshId: string, childId: string): Promise<void>;
}

let target: StageHookTarget | null = null;

export function setStageHookTarget(next: StageHookTarget | null): void { target = next; }

export function notifyStageImplCompleted(meshId: string, parentId: string, attemptId?: string): void {
    if (target) void target.onImplCompleted(meshId, parentId, attemptId).catch(() => undefined);
}

export function notifyStageChildTerminal(meshId: string, taskId: string): void {
    if (target) void target.onChildTerminal(meshId, taskId).catch(() => undefined);
}

/** A review child was claimed (assigned): the parent moves awaiting_review → reviewing. */
export function notifyStageChildClaimed(meshId: string, taskId: string): void {
    if (target) void target.onChildClaimed(meshId, taskId).catch(() => undefined);
}
