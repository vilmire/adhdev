/** Host critical-section delete with expected-assignment / incarnation CAS. */
import type { SessionCleanupExpectedAssignment, SessionHostRecord, SessionHostResponse } from '@adhdev/session-host-core';
import { tagCleanupAfterStopSideEffect } from '@adhdev/session-host-core';
import { refuseCleanupExpectedDelete } from './stop-session-if-expected.js';

/** Structural host surface — kept loose so SessionHostServer assigns cleanly. */
export interface DeleteSessionIfExpectedHost {
  registry: {
    getSession(sessionId: string): SessionHostRecord | null | undefined;
    setLifecycle(sessionId: string, lifecycle: SessionHostRecord['lifecycle']): void;
    deleteSession(sessionId: string): void;
  };
  runtimes: { has(sessionId: string): boolean };
  stopRequests: { set(sessionId: string, reason: 'stop' | 'delete'): void; delete(sessionId: string): void };
  storage: { remove(sessionId: string): void; removeTombstone(sessionId: string): void };
  currentHostBootId(): string | null;
  persistNow(sessionId: string): void;
  requireRuntime(sessionId: string): { stop(): void };
  waitForRuntimeExit(sessionId: string): Promise<void>;
  emitEvent(event: { type: string; sessionId: string }): void;
  recordRuntimeTransition(
    sessionId: string,
    action: string,
    lifecycle?: SessionHostRecord['lifecycle'],
    detail?: string,
    ok?: boolean,
    error?: string,
  ): void;
}

export async function handleDeleteSessionIfExpected(
  host: DeleteSessionIfExpectedHost,
  payload: { sessionId: string; expected: SessionCleanupExpectedAssignment; force?: boolean },
): Promise<SessionHostResponse> {
  const before = host.registry.getSession(payload.sessionId);
  if (!before) {
    return { success: true, result: { sessionId: payload.sessionId, deleted: true, alreadyAbsent: true } };
  }
  const refused = refuseCleanupExpectedDelete(
    before, payload.expected, host.currentHostBootId(), host.runtimes.has(payload.sessionId), payload.force === true,
  );
  // Bare refusal codes prove stop was not requested — client may abort its fence.
  if (refused) return { success: false, error: refused };
  let stopRequested = false;
  if (host.runtimes.has(payload.sessionId)) {
    host.stopRequests.set(payload.sessionId, 'delete');
    host.registry.setLifecycle(payload.sessionId, 'stopping');
    host.persistNow(payload.sessionId);
    host.requireRuntime(payload.sessionId).stop();
    stopRequested = true;
    await host.waitForRuntimeExit(payload.sessionId).catch((error: any) => {
      host.recordRuntimeTransition(
        payload.sessionId, 'delete_session_if_expected_timeout', 'stopping', undefined, false, error?.message || String(error),
      );
    });
  }
  // Re-check after await: a replaced/reassigned incarnation must survive.
  const after = host.registry.getSession(payload.sessionId);
  if (!after) {
    return { success: true, result: { sessionId: payload.sessionId, deleted: true, alreadyAbsent: true } };
  }
  const afterRefused = refuseCleanupExpectedDelete(
    after, payload.expected, host.currentHostBootId(), host.runtimes.has(payload.sessionId), false,
  );
  if (afterRefused) {
    // Tag post-stop refusals so the client retains its durable fence (writer may be dead).
    return {
      success: false,
      error: stopRequested ? tagCleanupAfterStopSideEffect(afterRefused) : afterRefused,
    };
  }
  host.registry.deleteSession(payload.sessionId);
  host.storage.remove(payload.sessionId);
  host.storage.removeTombstone(payload.sessionId);
  host.stopRequests.delete(payload.sessionId);
  host.emitEvent({ type: 'session_deleted', sessionId: payload.sessionId });
  host.recordRuntimeTransition(payload.sessionId, 'delete_session_if_expected', after.lifecycle, undefined, true);
  return { success: true, result: { sessionId: payload.sessionId, deleted: true } };
}
