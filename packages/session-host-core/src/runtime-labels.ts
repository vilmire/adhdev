import * as path from 'path';
import type { CreateSessionPayload, SessionHostRecord, SessionHostSurfaceKind } from './types.js';

function normalizeSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function normalizeValue(input: string): string {
  return input.trim().toLowerCase();
}

export function getWorkspaceLabel(workspace: string): string {
  const trimmed = workspace.trim();
  if (!trimmed) return 'workspace';
  const normalized = trimmed.replace(/[\\/]+$/, '');
  const base = path.basename(normalized);
  return base || normalized;
}

export function buildRuntimeDisplayName(payload: Pick<CreateSessionPayload, 'displayName' | 'providerType' | 'workspace'>): string {
  const explicit = payload.displayName?.trim();
  if (explicit) return explicit;
  const workspaceLabel = getWorkspaceLabel(payload.workspace);
  const providerLabel = payload.providerType.trim() || 'runtime';
  return `${providerLabel} @ ${workspaceLabel}`;
}

export function buildRuntimeKey(
  payload: Pick<CreateSessionPayload, 'runtimeKey' | 'displayName' | 'providerType' | 'workspace'>,
  existingKeys: Iterable<string>,
): string {
  const requested = payload.runtimeKey?.trim();
  const existing = new Set(Array.from(existingKeys, (key) => key.toLowerCase()));
  const displayName = buildRuntimeDisplayName(payload);
  const baseKey = normalizeSlug(requested || displayName || getWorkspaceLabel(payload.workspace) || payload.providerType || 'runtime') || 'runtime';
  if (!existing.has(baseKey)) return baseKey;

  let suffix = 2;
  let candidate = `${baseKey}-${suffix}`;
  while (existing.has(candidate)) {
    suffix += 1;
    candidate = `${baseKey}-${suffix}`;
  }
  return candidate;
}

export interface SessionHostSurfaceRecordLike {
  lifecycle?: string | null;
  surfaceKind?: SessionHostSurfaceKind | null;
  meta?: Record<string, unknown> | null;
}

const LIVE_LIFECYCLES = new Set(['starting', 'running', 'stopping', 'interrupted']);

export function isSessionHostLiveRuntime(record: SessionHostSurfaceRecordLike | null | undefined): boolean {
  if (!record) return false;
  if (record.surfaceKind === 'live_runtime') return true;
  if (record.surfaceKind === 'recovery_snapshot' || record.surfaceKind === 'inactive_record') return false;
  const lifecycle = String(record.lifecycle || '').trim();
  return LIVE_LIFECYCLES.has(lifecycle);
}

export function getSessionHostRecoveryLabel(meta: Record<string, unknown> | null | undefined): string | null {
  const recoveryState = typeof meta?.runtimeRecoveryState === 'string'
    ? String(meta.runtimeRecoveryState).trim()
    : '';
  if (!recoveryState) return null;
  if (recoveryState === 'auto_resumed') return 'restored after restart';
  if (recoveryState === 'resume_failed') return 'restore failed';
  if (recoveryState === 'host_restart_interrupted') return 'host restart interrupted';
  if (recoveryState === 'orphan_snapshot') return 'snapshot recovered';
  return recoveryState.replace(/_/g, ' ');
}

export function isSessionHostRecoverySnapshot(record: SessionHostSurfaceRecordLike | null | undefined): boolean {
  if (!record) return false;
  if (record.surfaceKind === 'recovery_snapshot') return true;
  if (record.surfaceKind === 'live_runtime' || record.surfaceKind === 'inactive_record') return false;
  if (isSessionHostLiveRuntime(record)) return false;

  const lifecycle = String(record.lifecycle || '').trim();
  if (lifecycle && lifecycle !== 'stopped' && lifecycle !== 'failed') {
    return false;
  }

  const meta = record.meta || undefined;
  if (meta?.restoredFromStorage === true) return true;
  return getSessionHostRecoveryLabel(meta) !== null;
}

export function getSessionHostSurfaceKind(record: SessionHostSurfaceRecordLike | null | undefined): SessionHostSurfaceKind {
  if (record?.surfaceKind === 'live_runtime' || record?.surfaceKind === 'recovery_snapshot' || record?.surfaceKind === 'inactive_record') {
    return record.surfaceKind;
  }
  if (isSessionHostLiveRuntime(record)) return 'live_runtime';
  if (isSessionHostRecoverySnapshot(record)) return 'recovery_snapshot';
  return 'inactive_record';
}

export function resolveAttachableRuntimeRecord(records: SessionHostRecord[], identifier: string): SessionHostRecord {
  const record = resolveRuntimeRecord(records, identifier);
  const surfaceKind = getSessionHostSurfaceKind(record);
  if (surfaceKind === 'live_runtime') {
    return record;
  }
  if (surfaceKind === 'recovery_snapshot') {
    throw new Error(`Runtime ${record.runtimeKey} is a recovery snapshot, not a live attach target. Resume or recover it first.`);
  }
  throw new Error(`Runtime ${record.runtimeKey} is ${record.lifecycle}, not a live attach target.`);
}

function uniqueMatch(records: SessionHostRecord[], predicate: (record: SessionHostRecord) => boolean): SessionHostRecord | null {
  const matches = records.filter(predicate);
  if (matches.length === 1) return matches[0] || null;
  if (matches.length === 0) return null;
  const labels = matches.map((record) => `${record.runtimeKey} (${record.sessionId})`).join(', ');
  throw new Error(`Ambiguous runtime target. Matches: ${labels}`);
}

export function resolveRuntimeRecord(records: SessionHostRecord[], identifier: string): SessionHostRecord {
  const target = identifier.trim();
  if (!target) {
    throw new Error('Runtime target is required');
  }

  const exact = uniqueMatch(records, (record) =>
    record.sessionId === target ||
    normalizeValue(record.runtimeKey) === normalizeValue(target) ||
    normalizeValue(record.displayName) === normalizeValue(target),
  );
  if (exact) return exact;

  const prefix = uniqueMatch(records, (record) =>
    record.sessionId.startsWith(target) ||
    normalizeValue(record.runtimeKey).startsWith(normalizeValue(target)),
  );
  if (prefix) return prefix;

  throw new Error(`Unknown runtime target: ${target}`);
}

export function formatRuntimeOwner(record: Pick<SessionHostRecord, 'writeOwner'>): string {
  if (!record.writeOwner) return 'none';
  return `${record.writeOwner.ownerType}:${record.writeOwner.clientId}`;
}
