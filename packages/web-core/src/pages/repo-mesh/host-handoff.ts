/**
 * Host handoff — dashboard-side parsing and step mapping (design
 * docs/design/2026-11-01-assistant-session-handoff.md §8). The daemon owns the
 * protocol; this only reads the `mesh_host_handoff` answers defensively (the
 * daemon may be an older build) and maps journal phases onto the five visible steps.
 */

export const HOST_HANDOFF_COMMAND = 'mesh_host_handoff' as const

export type HandoffStepId = 'freeze' | 'transfer' | 'verify' | 'ack' | 'switch'
export const HANDOFF_STEPS: readonly HandoffStepId[] = ['freeze', 'transfer', 'verify', 'ack', 'switch']

export interface HandoffRecordView {
    handoffId: string
    phase: string
    abortReason?: string
    peerDaemonId?: string
    epoch?: number
}

export interface PreflightCheckView { id: string; ok: boolean; code?: string; detail?: string }

function rec(v: unknown): Record<string, any> | null {
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : null
}

/** Cloud wraps the daemon answer once (`{success, result:{…}}`); standalone does not. */
export function unwrapHandoffAnswer(raw: unknown): Record<string, any> | null {
    const r = rec(raw)
    if (!r) return null
    const inner = rec(r.result)
    return inner && ('success' in inner || 'checks' in inner || 'enabled' in inner || 'handoffId' in inner) ? inner : r
}

export function parseHandoffRecord(v: unknown): HandoffRecordView | null {
    const r = rec(v)
    if (!r || typeof r.handoffId !== 'string' || typeof r.phase !== 'string') return null
    return {
        handoffId: r.handoffId, phase: r.phase,
        ...(typeof r.abortReason === 'string' ? { abortReason: r.abortReason } : {}),
        ...(typeof r.peerDaemonId === 'string' ? { peerDaemonId: r.peerDaemonId } : {}),
        ...(typeof r.epoch === 'number' ? { epoch: r.epoch } : {}),
    }
}

export interface HandoffEvidenceView { sourceStopped: boolean; sourceDaemonId?: string; sourceSessionIds: string[]; targetHost?: string; targetSession?: string; targetReady: boolean; targetVerified: boolean }
export interface HandoffStatusView { evidence?: HandoffEvidenceView; enabled: boolean; source: HandoffRecordView | null }

/** `enabled:false` on a daemon with the feature off; an older daemon (unknown verb) reads as disabled too. */
export function parseHandoffStatus(raw: unknown): HandoffStatusView {
    const r = unwrapHandoffAnswer(raw)
    if (!r) return { enabled: false, source: null }
    if (r.success === false) return { enabled: false, source: null }
    const proof = rec(r.evidence), target = rec(proof?.target), observed = rec(target?.observation), stop = rec(proof?.sourceStopProof)
    const evidence = proof ? { sourceStopped: proof.sourceStopped === true,
        ...(typeof proof.sourceDaemonId === 'string' ? { sourceDaemonId: proof.sourceDaemonId } : {}),
        sourceSessionIds: Array.isArray(stop?.sessionIds) ? stop.sessionIds.filter((id: unknown): id is string => typeof id === 'string') : [],
        ...(typeof target?.actualHostDaemonId === 'string' ? { targetHost: target.actualHostDaemonId } : {}),
        ...(typeof observed?.sessionId === 'string' ? { targetSession: observed.sessionId } : {}),
        targetReady: observed?.ready === true, targetVerified: observed?.runtimeVerified === true } : undefined
    return { enabled: r.enabled === true, source: parseHandoffRecord(r.source), ...(evidence ? { evidence } : {}) }
}

export function parsePreflight(raw: unknown): { ok: boolean; checks: PreflightCheckView[]; error?: string } {
    const r = unwrapHandoffAnswer(raw)
    if (!r) return { ok: false, checks: [], error: 'no_answer' }
    const checks = Array.isArray(r.checks)
        ? r.checks.flatMap((c: unknown) => {
            const x = rec(c)
            return x && typeof x.id === 'string' ? [{ id: x.id, ok: x.ok === true, ...(typeof x.code === 'string' ? { code: x.code } : {}), ...(typeof x.detail === 'string' ? { detail: x.detail } : {}) }] : []
        })
        : []
    return { ok: r.ok === true && checks.every((c: PreflightCheckView) => c.ok), checks, ...(r.success === false && typeof r.code === 'string' && checks.length === 0 ? { error: r.code } : {}) }
}

export function parseStartResult(raw: unknown): { ok: true; handoffId: string; phase: string } | { ok: false; code: string } {
    const r = unwrapHandoffAnswer(raw)
    if (r && r.success === true && typeof r.handoffId === 'string') return { ok: true, handoffId: r.handoffId, phase: typeof r.phase === 'string' ? r.phase : 'freezing' }
    return { ok: false, code: typeof r?.code === 'string' ? r.code : 'failed' }
}

/** Which of the five steps a journal phase is working on (-1 = not started, 5 = done). */
export function phaseToStep(phase: string): number {
    switch (phase) {
        case 'preflight': return -1
        case 'freezing': case 'frozen': return 0
        case 'exporting': case 'exported': return 1
        case 'awaiting_ack': return 2
        case 'acked': return 3
        case 'activating': case 'uncertain': return 4
        case 'committed': return 5
        default: return -1
    }
}

export const isHandoffTerminal = (phase: string): boolean => phase === 'committed' || phase === 'aborted'

/** Abort is offered only while it is safe: never once activation was sent (the daemon enforces it too). */
export function canAbortHandoff(phase: string): boolean {
    return !isHandoffTerminal(phase) && phase !== 'activating' && phase !== 'uncertain'
}
export const canRetryHandoff = (phase: string): boolean => phase === 'frozen' || phase === 'acked' || phase === 'awaiting_ack' || phase === 'uncertain' || phase === 'activating'
