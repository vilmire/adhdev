import {
  SESSION_HOST_SUPPORTED_REQUEST_TYPES,
} from '@adhdev/session-host-core';
import type {
  SessionHostDiagnostics,
  SessionHostLogEntry,
  SessionHostRecord,
  SessionHostRequestTrace,
  SessionHostRuntimeTransition,
} from '@adhdev/session-host-core';

export const MAX_RECENT_DIAGNOSTICS = 200;

export function pushRecent<T>(bucket: T[], entry: T, max = MAX_RECENT_DIAGNOSTICS): void {
  bucket.push(entry);
  if (bucket.length > max) {
    bucket.splice(0, bucket.length - max);
  }
}

export function getSessionHostRecoveryLabel(record: SessionHostRecord): string | null {
  const recoveryState = typeof record.meta?.runtimeRecoveryState === 'string'
    ? String(record.meta.runtimeRecoveryState).trim()
    : '';
  if (!recoveryState) return null;
  if (recoveryState === 'auto_resumed') return 'restored after restart';
  if (recoveryState === 'resume_failed') return 'restore failed';
  if (recoveryState === 'host_restart_interrupted') return 'host restart interrupted';
  if (recoveryState === 'orphan_snapshot') return 'snapshot recovered';
  return recoveryState.replace(/_/g, ' ');
}

export function getSessionSurfaceKind(
  record: SessionHostRecord,
): 'live_runtime' | 'recovery_snapshot' | 'inactive_record' {
  if (['starting', 'running', 'stopping', 'interrupted'].includes(record.lifecycle)) {
    return 'live_runtime';
  }
  if ((record.lifecycle === 'stopped' || record.lifecycle === 'failed') && (record.meta?.restoredFromStorage === true || getSessionHostRecoveryLabel(record))) {
    return 'recovery_snapshot';
  }
  return 'inactive_record';
}

export function annotateSessionSurface(record: SessionHostRecord): SessionHostRecord {
  return {
    ...record,
    surfaceKind: getSessionSurfaceKind(record),
  };
}

export function sanitizeDiagnosticsRecord(record: SessionHostRecord): SessionHostRecord {
  return {
    ...record,
    launchCommand: {
      command: record.launchCommand.command,
      args: Array.isArray(record.launchCommand.args) ? [...record.launchCommand.args] : [],
    },
  };
}

export interface BuildHostDiagnosticsParams {
  payload?: { includeSessions?: boolean; limit?: number };
  hostStartedAt: number;
  endpointPath: string;
  runtimeCount: number;
  sessions: SessionHostRecord[];
  recentLogs: SessionHostLogEntry[];
  recentRequests: SessionHostRequestTrace[];
  recentTransitions: SessionHostRuntimeTransition[];
}

export function buildHostDiagnostics(params: BuildHostDiagnosticsParams): SessionHostDiagnostics {
  const limit = Math.max(1, Math.min(200, Number(params.payload?.limit) || 50));
  const allSessions = params.payload?.includeSessions === false
    ? undefined
    : params.sessions
      .map((record) => annotateSessionSurface(record))
      .map((record) => sanitizeDiagnosticsRecord(record));
  const liveRuntimes = allSessions?.filter((record) => record.surfaceKind === 'live_runtime');
  const recoverySnapshots = allSessions?.filter((record) => record.surfaceKind === 'recovery_snapshot').slice(0, limit);
  const inactiveRecords = allSessions?.filter((record) => record.surfaceKind === 'inactive_record').slice(0, limit);
  const sessions = allSessions
    ? [
      ...(liveRuntimes || []),
      ...(recoverySnapshots || []),
      ...(inactiveRecords || []),
    ]
    : undefined;
  return {
    hostStartedAt: params.hostStartedAt,
    endpoint: params.endpointPath,
    runtimeCount: params.runtimeCount,
    supportedRequestTypes: [...SESSION_HOST_SUPPORTED_REQUEST_TYPES],
    sessions,
    liveRuntimes,
    recoverySnapshots,
    inactiveRecords,
    recentLogs: params.recentLogs.slice(-limit),
    recentRequests: params.recentRequests.slice(-limit),
    recentTransitions: params.recentTransitions.slice(-limit),
  };
}
