/** Host critical-section stop with expected-assignment CAS. */
import type { SessionCleanupExpectedAssignment, SessionHostRecord, SessionHostResponse } from '@adhdev/session-host-core';
import { refuseCleanupExpectedStop } from './stop-session-if-expected.js';

export interface StopSessionIfExpectedHost {
  registry: {
    getSession(sessionId: string): SessionHostRecord | null | undefined;
    setLifecycle(sessionId: string, lifecycle: SessionHostRecord['lifecycle']): void;
  };
  runtimes: { has(sessionId: string): boolean };
  stopRequests: { set(sessionId: string, reason: 'stop' | 'delete'): void };
  currentHostBootId(): string | null;
  persistNow(sessionId: string): void;
  requireRuntime(sessionId: string): { stop(): void };
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

export function handleStopSessionIfExpected(
  host: StopSessionIfExpectedHost,
  payload: { sessionId: string; expected: SessionCleanupExpectedAssignment },
): SessionHostResponse {
  const record = host.registry.getSession(payload.sessionId);
  const refused = refuseCleanupExpectedStop(
    record, payload.expected, host.currentHostBootId(), host.runtimes.has(payload.sessionId),
  );
  if (refused) return { success: false, error: refused };
  host.stopRequests.set(payload.sessionId, 'stop');
  host.registry.setLifecycle(payload.sessionId, 'stopping');
  host.persistNow(payload.sessionId);
  host.requireRuntime(payload.sessionId).stop();
  host.emitEvent({ type: 'session_stopped', sessionId: payload.sessionId });
  host.recordRuntimeTransition(payload.sessionId, 'stop_session_if_expected', 'stopping', undefined, true);
  return { success: true, result: host.registry.getSession(payload.sessionId) };
}
