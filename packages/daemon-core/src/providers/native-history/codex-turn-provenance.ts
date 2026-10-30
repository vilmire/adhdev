import { createHash } from 'node:crypto';
/** File-order provenance, shared by both Codex rollout readers. Only acknowledged whole-input digests establish response-item ownership. */
import type { NativeTurnTerminalMarker } from '../../chat/native-turn-signal.js';
import type { ProviderFailure } from '@adhdev/mesh-shared';

export interface CodexOpenTurn {
    nativeSessionId?: string;
    turnId: string;
    startedAt: number;
    inputAt: number;
    inputDigest: string;
}

export function createCodexTurnProvenance(nativeSessionId?: string, acknowledgedInputDigest?: string) {
    let current: { id: string; startedAt: number; errorAt?: number; failure?: ProviderFailure; inputAt?: number; inputDigest?: string } | undefined;
    let last: NativeTurnTerminalMarker | undefined;
    const observe = (payload: Record<string, unknown>, at: number, marker?: NativeTurnTerminalMarker): NativeTurnTerminalMarker | undefined => {
        const id = marker?.turnId ?? (typeof payload.turn_id === 'string' ? payload.turn_id.trim() : '');
        if (payload.type === 'task_started') {
            if (last) last.supersededAt = at;
            current = { id, startedAt: at };
        }
        // response_item includes environment/context messages too. Only an
        // acknowledged whole input in this native turn may establish provenance.
        if (payload.type === 'message' && payload.role === 'user' && acknowledgedInputDigest && current) {
            const meta = payload.internal_chat_message_metadata_passthrough as { turn_id?: string } | undefined;
            if (meta?.turn_id !== current.id) return undefined;
            const blocks = Array.isArray(payload.content) ? payload.content : [];
            const text = typeof payload.content === 'string' ? payload.content
                : blocks.filter(b => b?.type === 'input_text' && typeof b.text === 'string').map(b => b.text).join('\n');
            // Provider context envelopes are not task inputs, even when emitted
            // inside the same native turn. Do not digest/bind those records.
            if (/^<(environment_context|context)>[\s\S]*<\/\1>\s*$/.test(text.trim())) return undefined;
            const digest = createHash('sha256').update(text.trim()).digest('hex');
            if (digest === acknowledgedInputDigest) {
                payload = { type: 'user_message', message: text, turn_id: current.id };
            } else if (current.inputAt) {
                current.startedAt = 0; // A later unacknowledged input cannot inherit ownership.
            }
        }
        if (payload.type === 'user_message' && current && (!id || id === current.id) && typeof payload.message === 'string' && at >= current.startedAt) {
            const digest = createHash('sha256').update(payload.message.trim()).digest('hex');
            if (current.inputDigest && current.inputDigest !== digest) current.startedAt = 0;
            if (!current.inputAt && (!acknowledgedInputDigest || digest === acknowledgedInputDigest)) {
                current.inputAt = at;
                current.inputDigest = digest;
            }
        }
        if (marker && current && ((id && current.id && id !== current.id) || (!id && current.id))) return { ...marker, startedAt: 0 };
        if (payload.type === 'error' && current && at < current.startedAt) {
            if (at <= 0) current.startedAt = 0; // Missing error time makes attribution ambiguous.
            else return undefined; // A delayed error from before this native start.
        }
        const error = payload.error;
        if ((payload.type === 'error' || marker) && error && typeof error === 'object') {
            const code = (error as Record<string, unknown>).codex_error_info ?? (error as Record<string, unknown>).type;
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
        const result = { ...marker, ...(current ? { startedAt: current.startedAt, inputAt: current.inputAt, inputDigest: current.inputDigest } : {}), nativeSessionId,
            ...(current?.failure && (!marker.summary || payload.error) ? { outcome: 'failed' as const, providerFailure: current.failure, errorAt: current.errorAt } : {}) };
        last = result;
        current = undefined;
        return result;
    };
    return Object.assign(observe, { openTurn: (): CodexOpenTurn | undefined =>
        current && current.id && current.startedAt > 0 && current.inputAt && current.inputDigest && !current.failure
            ? { nativeSessionId, turnId: current.id, startedAt: current.startedAt,
                inputAt: current.inputAt, inputDigest: current.inputDigest } : undefined });
}
