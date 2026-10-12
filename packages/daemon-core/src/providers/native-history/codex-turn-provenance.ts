/** File-order provenance, shared by both Codex rollout readers. Never scans message text. */
import type { NativeTurnTerminalMarker } from '../../chat/native-turn-signal.js';
import type { ProviderFailure } from '@adhdev/mesh-shared';

export function createCodexTurnProvenance() {
    let current: { id: string; startedAt: number; errorAt?: number; failure?: ProviderFailure } | undefined;
    return (payload: Record<string, unknown>, at: number, marker?: NativeTurnTerminalMarker): NativeTurnTerminalMarker | undefined => {
        const id = marker?.turnId ?? (typeof payload.turn_id === 'string' ? payload.turn_id.trim() : '');
        if (payload.type === 'task_started') {
            current = { id, startedAt: at };
        }
        if (marker && current && ((id && current.id && id !== current.id) || (!id && current.id))) return { ...marker, startedAt: 0 };
        if (payload.type === 'error' && current && at < current.startedAt) {
            if (at <= 0) current.startedAt = 0; // Missing error time makes attribution ambiguous.
            else return undefined; // A delayed error from before this native start.
        }
        const error = payload.error;
        if ((payload.type === 'error' || marker) && error && typeof error === 'object') {
            const code = (error as Record<string, unknown>).type;
            const failure: ProviderFailure = code === 'usage_limit_exceeded' ? 'usage_limit_exceeded'
                : code === 'server_overloaded' ? 'server_overloaded'
                : code === 'auth_failed' || code === 'authentication_error' || code === 'unauthorized' ? 'auth_failed'
                : 'provider_error';
            if (current && (!id || id === current.id)) {
                current.failure = failure;
                current.errorAt = at;
            } else if (!marker && !current) {
                current = { id, startedAt: 0, failure, errorAt: at };
            } else if (marker) {
                return { ...marker, outcome: 'failed', providerFailure: failure, errorAt: at };
            }
        }
        if (!marker) return undefined;
        // A late terminal of another turn cannot inherit this turn's start or error.
        const result = { ...marker, ...(current ? { startedAt: current.startedAt } : {}),
            ...(current?.failure && (!marker.summary || payload.error) ? { outcome: 'failed' as const, providerFailure: current.failure, errorAt: current.errorAt } : {}) };
        return result;
    };
}
