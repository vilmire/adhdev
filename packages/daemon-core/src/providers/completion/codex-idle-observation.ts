import { COMPLETED_FINALIZATION_RETRY_MS } from '../cli-provider-instance-types.js';
import type { TurnAttemptRef } from '@adhdev/mesh-shared';
import type { CodexOpenTurn } from '../native-history/codex-turn-provenance.js';

// Freshness of a native read, not an idle/alarm delay. The existing instance
// tick re-probes at 5s even when the PTY is silent; getState performs no I/O.
const SAMPLE_MAX_AGE_MS = 5_000;
interface Host {
    type: string;
    providerSessionId?: string;
    generatingStartedAt: number;
    lastAcknowledgedUserInputAt: number;
    lastAcknowledgedInputDigest?: string;
    lastAcknowledgedTurnOwner?: string;
    lastCodexOpenTurn?: CodexOpenTurn;
    lastNativeTurnTerminalMarkers?: import('../../chat/native-turn-signal.js').NativeTurnTerminalMarker[] | null;
    nativeTurnSampleAt?: number;
    nativeHistoryReadPending?: boolean;
    disposed?: boolean;
    currentAttemptRef?(): TurnAttemptRef | null;
    completingTurnTaskId?(): string | undefined;
    readExternalCompletionMessages(): unknown[] | null;
}
type Owner = { identity: string; nativeSessionId: string; turnId: string };
const owners = new WeakMap<object, Owner>();
// Keep the accepted native turn fence even when a later read is unavailable.
// Only a new acknowledged task/attempt identity can replace that fence.
const bindings = new WeakMap<object, Owner>();
function identity(h: Host): string {
    return JSON.stringify([h.generatingStartedAt, h.lastAcknowledgedUserInputAt,
        h.lastAcknowledgedInputDigest, h.completingTurnTaskId?.(), h.currentAttemptRef?.()]);
}
/** Only the Codex PTY idle candidate probes. Both status surfaces consume the
 * same exact-bound observation; unavailable/stale/foreign evidence holds nothing. */
export function preserveCodexGeneratingOnIdle(h: Host, probe = false): boolean {
    if (h.type !== 'codex-cli' || h.disposed || !h.generatingStartedAt || !h.lastAcknowledgedInputDigest) return false;
    if (h.lastAcknowledgedTurnOwner !== JSON.stringify([h.completingTurnTaskId?.(), h.currentAttemptRef?.() ?? null])) return false;
    const owner = identity(h);
    const previous = bindings.get(h);
    if (probe && previous?.identity === owner && typeof h.nativeTurnSampleAt === 'number'
        && Date.now() - h.nativeTurnSampleAt < COMPLETED_FINALIZATION_RETRY_MS
        && preserveCodexGeneratingOnIdle(h)) return true;
    if (probe) {
        owners.delete(h);
        const pin = h.providerSessionId;
        try { if (h.readExternalCompletionMessages() === null) return false; } catch { return false; }
        if (owner !== identity(h) || (pin && pin !== h.providerSessionId)) return false;
    }
    const open = h.lastCodexOpenTurn;
    const now = Date.now();
    const sampled = h.nativeTurnSampleAt;
    const closed = open && h.lastNativeTurnTerminalMarkers?.some(marker => marker.nativeSessionId === open.nativeSessionId
        && marker.turnId === open.turnId && marker.inputDigest === open.inputDigest && marker.receivedAt >= open.inputAt);
    const valid = !closed && !h.nativeHistoryReadPending && typeof sampled === 'number'
        && sampled <= now && now - sampled <= SAMPLE_MAX_AGE_MS
        && !!open && !!h.providerSessionId && open.nativeSessionId === h.providerSessionId && !!open.turnId
        && open.inputDigest === h.lastAcknowledgedInputDigest
        && Number.isFinite(open.startedAt) && open.startedAt >= h.lastAcknowledgedUserInputAt
        && open.startedAt <= h.generatingStartedAt && open.startedAt <= open.inputAt
        && Number.isFinite(open.inputAt) && open.inputAt >= h.lastAcknowledgedUserInputAt && open.inputAt <= now;
    if (!valid || !open || !h.providerSessionId) return false;
    // An unexpected native turn cannot inherit the same acknowledged attempt.
    if (previous?.identity === owner && (previous.nativeSessionId !== h.providerSessionId || previous.turnId !== open.turnId)) return false;
    if (probe) {
        const accepted = { identity: owner, nativeSessionId: h.providerSessionId, turnId: open.turnId };
        bindings.set(h, accepted);
        owners.set(h, accepted);
    }
    return owners.get(h)?.identity === owner;
}
