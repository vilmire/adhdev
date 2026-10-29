import type { TurnAttemptRef } from '@adhdev/mesh-shared';
import type { CompletedDebouncePending } from '../cli-provider-instance-types.js';
import { selectTurnTerminalMarker, type NativeTurnTerminalMarker } from '../../chat/native-turn-signal.js';

export interface CompletionBindingHost {
    instanceId: string;
    providerSessionId?: string;
    generatingStartedAt: number;
    lastAcknowledgedUserInputAt: number;
    lastAcknowledgedInputDigest?: string;
    disposed?: boolean;
    completingTurnTaskId?(): string | undefined;
    currentAttemptRef?(): TurnAttemptRef | null;
    lastNativeTurnTerminalMarkers?: NativeTurnTerminalMarker[] | null;
}
export function captureCompletionIdentity(host: CompletionBindingHost, pending: CompletedDebouncePending): void {
    if (pending.capturedAttemptRef === undefined) {
        const current = host.currentAttemptRef?.();
        pending.capturedAttemptRef = current ? { ...current } : null;
        if (host.lastAcknowledgedInputDigest) pending.capturedCompletionInput = {
            inputAt: host.lastAcknowledgedUserInputAt, inputDigest: host.lastAcknowledgedInputDigest,
            taskId: host.completingTurnTaskId?.(),
        };
    }
    const input = pending.capturedCompletionInput;
    if (pending.completionBinding || !input || !host.providerSessionId || !pending.turnStartedAt
        || host.disposed || pending.turnStartedAt !== host.generatingStartedAt
        || input.inputAt !== host.lastAcknowledgedUserInputAt || input.inputDigest !== host.lastAcknowledgedInputDigest
        || input.taskId !== host.completingTurnTaskId?.()
        || JSON.stringify(pending.capturedAttemptRef) !== JSON.stringify(host.currentAttemptRef?.() ?? null)
        || !(input.inputAt > 0 && input.inputAt <= pending.turnStartedAt)) return;
    pending.completionBinding = { sessionId: host.instanceId, nativeSessionId: host.providerSessionId,
        turnStartedAt: pending.turnStartedAt, inputAt: input.inputAt,
        inputDigest: input.inputDigest, attemptRef: pending.capturedAttemptRef };

}
export function completionIdentityCurrent(host: CompletionBindingHost, pending: CompletedDebouncePending): boolean {
    const b = pending.completionBinding;
    return !!b && !host.disposed && b.sessionId === host.instanceId && b.nativeSessionId === host.providerSessionId
        && b.turnStartedAt === host.generatingStartedAt && b.inputAt === host.lastAcknowledgedUserInputAt
        && b.inputDigest === host.lastAcknowledgedInputDigest
        && (!pending.taskId || !host.completingTurnTaskId || host.completingTurnTaskId() === pending.taskId)
        && JSON.stringify(b.attemptRef) === JSON.stringify(host.currentAttemptRef?.() ?? null);
}
export function boundCompletionMarker(host: CompletionBindingHost, pending: CompletedDebouncePending): NativeTurnTerminalMarker | null {
    captureCompletionIdentity(host, pending);
    if (!completionIdentityCurrent(host, pending)) return null;
    const marker = selectTurnTerminalMarker(host.lastNativeTurnTerminalMarkers, pending.turnStartedAt, pending.completionBinding);
    if (marker && marker.receivedAt > Date.now()) return null;
    if (marker) pending.completionBinding!.nativeTurnId = marker.turnId;
    return marker;
}
