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
    const current = host.currentAttemptRef?.();
    pending.capturedAttemptRef = current ? { ...current } : null;
    if (!host.providerSessionId || !host.lastAcknowledgedInputDigest || !pending.turnStartedAt
        || !(host.lastAcknowledgedUserInputAt > 0 && host.lastAcknowledgedUserInputAt <= pending.turnStartedAt)) return;
    pending.completionBinding = { sessionId: host.instanceId, nativeSessionId: host.providerSessionId,
        turnStartedAt: pending.turnStartedAt, inputAt: host.lastAcknowledgedUserInputAt,
        inputDigest: host.lastAcknowledgedInputDigest, attemptRef: pending.capturedAttemptRef };
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
    if (!completionIdentityCurrent(host, pending)) return null;
    const marker = selectTurnTerminalMarker(host.lastNativeTurnTerminalMarkers, pending.turnStartedAt, pending.completionBinding);
    if (marker && marker.receivedAt > Date.now()) return null;
    if (marker) pending.completionBinding!.nativeTurnId = marker.turnId;
    return marker;
}
