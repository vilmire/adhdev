/**
 * Coordinator provider switch (design 2026-11-01 §5.1): launch the NEW session
 * first, verify it, hand it the brief, and only then stop the old one. A
 * failure before the old session is stopped leaves the old coordinator exactly
 * as it was (draining released, no brief delivered twice, new session removed).
 *
 * Ports only — the verb layer binds them to `launch_mesh_coordinator`,
 * `stop_cli`, the coordinator registry and `send_chat`.
 */

import { randomUUID } from 'node:crypto';
import type { PortOutcome, ProviderSelection, Quiescence } from './session-control.js';

export const COORDINATOR_READY_TIMEOUT_MS = 90_000;

export interface CoordinatorSwitchPorts {
    setDraining(sessionId: string, draining: boolean): void;
    launch(meshId: string, selection: ProviderSelection): Promise<PortOutcome & { sessionId?: string }>;
    markSuccessor(newSessionId: string, oldSessionId: string): void;
    waitReady(sessionId: string, timeoutMs: number): Promise<boolean>;
    /** Deterministic restart brief for the replacement (assistant/coordinator-handoff-brief.ts). */
    buildBrief(meshId: string, oldSessionId: string, ctx: { handoffId: string; fromProvider?: string; toProvider: string }): Promise<{ text: string; messageId: string }>;
    /** Deliver the brief as the new session's first input; `messageId` makes a repeat a no-op on the receiver. */
    sendBrief(sessionId: string, text: string, messageId: string): Promise<PortOutcome>;
    stop(sessionId: string): Promise<PortOutcome & { quiescence: Quiescence }>;
    /** Remove the new session after a failed handoff (best-effort). */
    discardNew(sessionId: string): Promise<void>;
    /** Point the assistant's follow state at the new session (best-effort). */
    rebind?(meshId: string, oldSessionId: string, newSessionId: string): void;
    log?(line: string): void;
}

export interface CoordinatorSwitchInput {
    meshId: string;
    oldSessionId: string;
    fromProvider?: string;
    selection: ProviderSelection;
    handoffId?: string;
    readyTimeoutMs?: number;
}

export type CoordinatorSwitchResult =
    | { success: true; newSessionId: string; previousSessionId: string; quiescence: Quiescence; handoffId: string }
    | { success: false; code: string; error: string; handoffId: string };

const sentBriefs = new Set<string>();

export async function switchCoordinator(input: CoordinatorSwitchInput, ports: CoordinatorSwitchPorts): Promise<CoordinatorSwitchResult> {
    const handoffId = input.handoffId ?? randomUUID();
    const { meshId, oldSessionId, selection } = input;
    const fail = (code: string, error: string): CoordinatorSwitchResult => ({ success: false, code, error, handoffId });
    // 2. from this point new events go only to the successor
    ports.setDraining(oldSessionId, true);
    let newSessionId = '';
    try {
        // 3. launch the replacement; a failure releases draining and changes nothing
        const launched = await ports.launch(meshId, selection);
        newSessionId = typeof launched.sessionId === 'string' ? launched.sessionId : '';
        if (!launched.success || !newSessionId) {
            ports.setDraining(oldSessionId, false);
            ports.log?.(`[session-control] coordinator switch launch failed code=${launched.code ?? 'launch_failed'}`);
            return fail(launched.code ?? 'coordinator_launch_failed', launched.error ?? 'replacement coordinator did not start');
        }
        ports.markSuccessor(newSessionId, oldSessionId);
        // 4. ready, then the brief (once per handoff id)
        const ready = await ports.waitReady(newSessionId, input.readyTimeoutMs ?? COORDINATOR_READY_TIMEOUT_MS);
        if (!ready) throw Object.assign(new Error('replacement coordinator did not become ready'), { code: 'coordinator_not_ready' });
        const brief = await ports.buildBrief(meshId, oldSessionId, { handoffId, ...(input.fromProvider ? { fromProvider: input.fromProvider } : {}), toProvider: selection.provider });
        if (!sentBriefs.has(brief.messageId)) {
            const sent = await ports.sendBrief(newSessionId, brief.text, brief.messageId);
            if (!sent.success) throw Object.assign(new Error(sent.error ?? 'brief not delivered'), { code: sent.code ?? 'brief_not_delivered' });
            sentBriefs.add(brief.messageId);
        }
    } catch (e) {
        const code = (e as { code?: string }).code ?? 'coordinator_switch_failed';
        ports.setDraining(oldSessionId, false);
        if (newSessionId) {
            try { await ports.discardNew(newSessionId); } catch { /* best-effort: the old coordinator stays authoritative */ }
        }
        ports.log?.(`[session-control] coordinator switch rolled back code=${code}`);
        return fail(code, (e as Error)?.message ?? String(e));
    }
    // 5. the old coordinator goes only after every event already routes to the new one
    const stopped = await ports.stop(oldSessionId);
    if (!stopped.success) {
        // The new coordinator is already the sole receiver; report the leftover honestly.
        ports.log?.(`[session-control] old coordinator stop incomplete code=${stopped.code ?? 'stop_failed'} quiescence=${stopped.quiescence}`);
    }
    ports.rebind?.(meshId, oldSessionId, newSessionId);
    return { success: true, newSessionId, previousSessionId: oldSessionId, quiescence: stopped.success ? stopped.quiescence : 'pending', handoffId };
}

/** Test seam: forget delivered brief ids. */
export function resetSentBriefsForTest(): void {
    sentBriefs.clear();
}
