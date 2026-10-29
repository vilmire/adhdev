/** Durable bounded recovery after an uncertainty notice, never a session-tail read. */
import type { AssistantRelayStore, AssistantRelayRow } from './assistant-relay-store.js';
import { ATTEMPT_BODY_TTL_MS } from './assistant-relay-store.js';
import type { AttemptReportSnapshot } from './assistant-native-window.js';
import { permanentCaptureFailure } from './capture-failure.js';
import { receiptKey } from './relay-gap-tracker.js';
import { reportBodyId } from './report-continuation.js';
interface LateCaptureState { deadline: number; nextAt: number; probes: number; sourceComplete: boolean; reportId: string | null; done?: boolean }
export function readLateCaptureState(store: AssistantRelayStore, id: string, now: number): LateCaptureState | null {
    try {
        const state = JSON.parse(store.readReceipt(receiptKey('late-capture', id), now) ?? 'null');
        return state && Number.isFinite(state.deadline) && Number.isFinite(state.nextAt) && Number.isSafeInteger(state.probes)
            && typeof state.sourceComplete === 'boolean' && (!state.sourceComplete || /^[a-f0-9]{64}$/.test(state.reportId)) ? state : null;
    } catch { return null; }
}
export function settleLateCapture(store: AssistantRelayStore, id: string, at: number,
    info: { surfacedMissing: boolean; committedAt?: number; rendered: boolean; reason?: unknown }): void {
    const state = readLateCaptureState(store, id, at);
    if (info.surfacedMissing && info.committedAt !== undefined && !state) {
        store.writeReceipt(receiptKey('late-capture', id), JSON.stringify({ deadline: info.committedAt + ATTEMPT_BODY_TTL_MS,
            nextAt: at + 60_000, probes: 0, sourceComplete: false, reportId: null, done: permanentCaptureFailure(info.reason) }), at, 'capture');
    } else if (info.rendered && state) store.writeReceipt(receiptKey('late-capture', id), JSON.stringify({ ...state, done: true }), at, 'capture');
}
export async function repairLateCaptures(ports: { store: AssistantRelayStore; now: number; live(): boolean;
    read(row: AssistantRelayRow): Promise<AttemptReportSnapshot>; ready(row: AssistantRelayRow, report: AttemptReportSnapshot): void }): Promise<void> {
    const { store, now } = ports;
    let probes = 0;
    for (const row of store.listSettledUncovered?.(now) ?? []) {
        const state = readLateCaptureState(store, row.attemptId, now);
        if (!state || state.done || state.deadline <= now || state.nextAt > now || state.probes >= 24
            || !store.isThreadOpen(row.meshId)) continue;
        if (++probes > 4 || !ports.live()) break;
        const key = receiptKey('late-capture', row.attemptId);
        const next = { ...state, probes: state.probes + 1, nextAt: now + Math.min(60 * 60_000, 60_000 * 2 ** Math.min(6, state.probes)) };
        store.writeReceipt(key, JSON.stringify(next), now, 'capture');
        let report: AttemptReportSnapshot;
        try { report = await ports.read(row); }
        catch { report = { body: null, completeness: 'envelope_unverified', reason: 'capture_failed' }; }
        if (!ports.live() || !store.isThreadOpen(row.meshId)) return;
        const sourceComplete = report.completeness === 'final_native' || report.completeness === 'final_adapter';
        if (!sourceComplete || !report.body?.trim()) {
            if (permanentCaptureFailure(report.reason)) store.writeReceipt(key, JSON.stringify({ ...next, done: true }), now, 'capture');
            continue;
        }
        if (state.sourceComplete && state.reportId !== reportBodyId(report.body)) {
            store.writeReceipt(key, JSON.stringify({ ...next, done: true }), now, 'capture');
            continue;
        }
        // Persist identity before reopening: restart replays only this exact report.
        store.writeReceipt(key, JSON.stringify({ ...next, sourceComplete: true, reportId: reportBodyId(report.body) }), now, 'capture');
        if (store.reopenUncovered?.(row.attemptId)) ports.ready(row, report);
    }
}
