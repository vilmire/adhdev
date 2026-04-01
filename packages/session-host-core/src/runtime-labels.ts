import * as path from 'path';
import type { CreateSessionPayload, SessionHostRecord } from './types.js';

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
