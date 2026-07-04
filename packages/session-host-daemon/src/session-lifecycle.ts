import {
  resolveSessionHostCols,
  resolveSessionHostRows,
} from '@adhdev/session-host-core';
import type {
  CreateSessionPayload,
  SessionHostDuplicateSessionGroup,
  SessionHostRecord,
} from '@adhdev/session-host-core';
import type { PersistedRuntimeState } from './storage.js';

export function compareDuplicateCandidates(a: SessionHostRecord, b: SessionHostRecord): number {
  const score = (record: SessionHostRecord) => {
    const lifecycleScore = record.lifecycle === 'running'
      ? 4
      : record.lifecycle === 'starting'
        ? 3
        : record.lifecycle === 'stopping'
          ? 2
          : record.lifecycle === 'interrupted'
            ? 1
            : 0;
    return [
      lifecycleScore,
      record.writeOwner ? 1 : 0,
      Array.isArray(record.attachedClients) ? record.attachedClients.length : 0,
      record.lastActivityAt || 0,
      record.startedAt || 0,
      record.createdAt || 0,
    ];
  };

  const aScore = score(a);
  const bScore = score(b);
  for (let i = 0; i < aScore.length; i += 1) {
    if (aScore[i] === bScore[i]) continue;
    return bScore[i] - aScore[i];
  }
  return 0;
}

export interface DuplicatePrunePlan {
  duplicateGroups: SessionHostDuplicateSessionGroup[];
  keptSessionIds: string[];
  // Records to prune, in group order. Only populated for non-dry-run callers.
  duplicateRecords: SessionHostRecord[];
}

export function planDuplicatePrune(
  sessions: SessionHostRecord[],
  filters: { providerFilter: string; workspaceFilter: string },
): DuplicatePrunePlan {
  const candidates = sessions
    .filter((record) => ['starting', 'running', 'stopping', 'interrupted'].includes(record.lifecycle))
    .filter((record) => !filters.providerFilter || record.providerType === filters.providerFilter)
    .filter((record) => !filters.workspaceFilter || record.workspace === filters.workspaceFilter);

  const groups = new Map<string, SessionHostRecord[]>();
  for (const record of candidates) {
    const providerSessionId = typeof record.meta?.providerSessionId === 'string'
      ? String(record.meta.providerSessionId).trim()
      : '';
    if (!providerSessionId) continue;
    const bindingKey = `${record.providerType}::${record.workspace}::${providerSessionId}`;
    const bucket = groups.get(bindingKey) || [];
    bucket.push(record);
    groups.set(bindingKey, bucket);
  }

  const duplicateGroups: SessionHostDuplicateSessionGroup[] = [];
  const keptSessionIds: string[] = [];
  const duplicateRecords: SessionHostRecord[] = [];

  for (const [bindingKey, records] of groups.entries()) {
    if (records.length < 2) continue;
    const sorted = [...records].sort((a, b) => compareDuplicateCandidates(a, b));
    const kept = sorted[0];
    const duplicates = sorted.slice(1);
    const providerSessionId = typeof kept.meta?.providerSessionId === 'string'
      ? String(kept.meta.providerSessionId)
      : '';
    duplicateGroups.push({
      bindingKey,
      providerType: kept.providerType,
      workspace: kept.workspace,
      providerSessionId,
      keptSessionId: kept.sessionId,
      prunedSessionIds: duplicates.map((record) => record.sessionId),
    });
    keptSessionIds.push(kept.sessionId);
    for (const duplicate of duplicates) {
      duplicateRecords.push(duplicate);
    }
  }

  return { duplicateGroups, keptSessionIds, duplicateRecords };
}

export function buildPayloadFromRecord(record: SessionHostRecord): CreateSessionPayload {
  return {
    sessionId: record.sessionId,
    runtimeKey: record.runtimeKey,
    displayName: record.displayName,
    providerType: record.providerType,
    category: record.category,
    workspace: record.workspace,
    launchCommand: record.launchCommand,
    cols: resolveSessionHostCols(typeof record.meta?.sessionHostCols === 'number' ? record.meta.sessionHostCols as number : undefined),
    rows: resolveSessionHostRows(typeof record.meta?.sessionHostRows === 'number' ? record.meta.sessionHostRows as number : undefined),
    meta: record.meta,
  };
}

export interface RecoveredRuntimeState {
  recoveredRecord: SessionHostRecord;
  wasLiveRuntime: boolean;
  hadRecoveryInterest: boolean;
}

export function buildRecoveredRecord(persisted: PersistedRuntimeState): RecoveredRuntimeState {
  const wasLiveRuntime = !['stopped', 'failed'].includes(persisted.record.lifecycle);
  const hadAttachedClients = Array.isArray(persisted.record.attachedClients) && persisted.record.attachedClients.length > 0;
  const hadWriteOwner = !!persisted.record.writeOwner;
  const hadRecoveryInterest = hadAttachedClients || hadWriteOwner;
  const recoveredRecord: SessionHostRecord = {
    ...persisted.record,
    attachedClients: [],
    writeOwner: null,
    lifecycle: wasLiveRuntime ? 'stopped' : persisted.record.lifecycle,
    lastActivityAt: Date.now(),
    meta: {
      ...(persisted.record.meta || {}),
      restoredFromStorage: true,
      runtimeRecoveryState: wasLiveRuntime ? 'orphan_snapshot' : 'snapshot',
      runtimeHadAttachedClientsAtCrash: hadAttachedClients,
      runtimeHadWriteOwnerAtCrash: hadWriteOwner,
      runtimeAutoResumeSkipped: wasLiveRuntime && hadRecoveryInterest,
    },
  };
  return { recoveredRecord, wasLiveRuntime, hadRecoveryInterest };
}
