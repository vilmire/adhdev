import type { AttemptReportSnapshot } from './assistant-native-window.js';
import { ATTEMPT_BODY_MAX_CHARS } from './assistant-relay-store.js';
/** Closed, content-free taxonomy. Never relay exception text, paths or provider prose. */
const REASONS = [
    'exact_committed_attempt_not_found', 'attempt_mesh_mismatch', 'original_terminal_evidence_unavailable',
    'no_unique_original_native_bubble_reference', 'ambiguous_original_native_bubble', 'native_reference_outside_attempt',
    'native_window_unverified', 'terminal_native_reply_unavailable', 'original_native_bubble_unavailable',
    'coordinator_session_no_longer_authorized', 'native_history_unavailable', 'native_history_loading',
    'native_owner_unverified', 'capture_timeout', 'capture_failed', 'remote_unreachable', 'remote_provenance_unverified',
] as const;
export type CaptureFailureReason = typeof REASONS[number];
export function captureFailureReason(value: unknown): CaptureFailureReason {
    return typeof value === 'string' && (REASONS as readonly string[]).includes(value) ? value as CaptureFailureReason : 'capture_failed';
}
export function permanentCaptureFailure(value: unknown): boolean {
    return ['attempt_mesh_mismatch', 'original_terminal_evidence_unavailable', 'no_unique_original_native_bubble_reference',
        'ambiguous_original_native_bubble', 'native_reference_outside_attempt', 'coordinator_session_no_longer_authorized'].includes(String(value));
}

export function normalizeCaptureReport(raw: AttemptReportSnapshot | string | null | undefined): AttemptReportSnapshot {
    if (typeof raw === 'string') return raw.length <= ATTEMPT_BODY_MAX_CHARS
        ? { body: raw, completeness: 'final_native' } : { body: null, completeness: 'envelope_unverified' };
    if (!raw || typeof raw !== 'object') return { body: null, completeness: 'envelope_unverified' };
    if (typeof raw.body === 'string' && raw.body.length > ATTEMPT_BODY_MAX_CHARS) return { body: null, completeness: 'envelope_unverified' };
    const validParts = raw.parts === undefined || (Array.isArray(raw.parts) && raw.parts.length <= 600
        && raw.parts.every(p => p && Number.isFinite(p.at) && Number.isFinite(new Date(p.at).getTime())
            && Number.isSafeInteger(p.chars) && p.chars > 0));
    const completeness = (raw.completeness === 'final_native' || raw.completeness === 'final_adapter') && validParts
        ? raw.completeness : 'envelope_unverified';
    return {
        body: typeof raw.body === 'string' ? raw.body : null,
        completeness,
        ...(typeof raw.source === 'string' && /^[a-z_]{1,128}$/.test(raw.source) ? { source: raw.source } : {}),
        ...(raw.reason ? { reason: captureFailureReason(raw.reason) } : {}),
        ...(raw.parts && validParts ? { parts: raw.parts.map(p => ({ at: p.at, chars: p.chars })) } : {}),
    };
}
