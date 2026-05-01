import type {
  GitDiffSummary,
  GitFileChange,
  GitRepoStatus,
  GitSnapshot,
  GitSnapshotCompareSummary,
  GitSnapshotReason,
} from './git-types.js';

export type MaybePromise<T> = T | Promise<T>;

export type GitStatusProvider = (workspace: string) => MaybePromise<GitRepoStatus>;
export type GitDiffSummaryProvider = (workspace: string, status: GitRepoStatus) => MaybePromise<GitDiffSummary>;

export interface GitSnapshotStoreOptions {
  capacity?: number;
  getStatus?: GitStatusProvider;
  getDiffSummary?: GitDiffSummaryProvider;
  now?: () => number;
  idPrefix?: string;
}

export interface GitSnapshotCreateInput {
  workspace: string;
  reason: GitSnapshotReason;
  sessionId?: string;
  turnId?: string;
  getStatus?: GitStatusProvider;
  getDiffSummary?: GitDiffSummaryProvider;
}

export interface GitSnapshotListQuery {
  workspace?: string;
  sessionId?: string;
  limit?: number;
}

export interface GitSnapshotStore {
  create(input: GitSnapshotCreateInput): Promise<GitSnapshot>;
  get(id: string): GitSnapshot | undefined;
  compare(beforeSnapshotId: string, afterSnapshotId: string): GitSnapshotCompareSummary;
  list(query?: GitSnapshotListQuery): GitSnapshot[];
  clear(): void;
}

function normalizeCapacity(capacity: number | undefined): number {
  return Math.max(1, Math.floor(capacity ?? 100));
}

function createEmptyDiffSummary(status: GitRepoStatus): GitDiffSummary {
  return {
    workspace: status.workspace,
    repoRoot: status.repoRoot,
    isGitRepo: status.isGitRepo,
    files: [],
    totalInsertions: 0,
    totalDeletions: 0,
    truncated: false,
    lastCheckedAt: status.lastCheckedAt,
    error: status.error,
    reason: status.reason,
  };
}

function changedFileKey(file: GitFileChange): string {
  return `${file.oldPath ?? ''}\u0000${file.path}`;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(Array.from(values).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function plural(count: number, singular: string, pluralText = `${singular}s`): string {
  return count === 1 ? singular : pluralText;
}

export function compareGitSnapshots(before: GitSnapshot, after: GitSnapshot): GitSnapshotCompareSummary {
  const beforeFileKeys = new Set(before.diffSummary.files.map(changedFileKey));
  const changedAfterFiles = after.diffSummary.files.filter((file) => !beforeFileKeys.has(changedFileKey(file)));

  const addedFiles: string[] = [];
  const modifiedFiles: string[] = [];
  const deletedFiles: string[] = [];
  const renamedFiles: Array<{ oldPath: string; path: string }> = [];
  const untrackedFiles: string[] = [];
  const conflictFilesFromDiff: string[] = [];

  let totalInsertions = 0;
  let totalDeletions = 0;

  for (const file of changedAfterFiles) {
    totalInsertions += file.insertions;
    totalDeletions += file.deletions;

    switch (file.status) {
      case 'added':
      case 'copied':
        addedFiles.push(file.path);
        break;
      case 'modified':
        modifiedFiles.push(file.path);
        break;
      case 'deleted':
        deletedFiles.push(file.path);
        break;
      case 'renamed':
        renamedFiles.push({ oldPath: file.oldPath ?? file.path, path: file.path });
        break;
      case 'untracked':
        untrackedFiles.push(file.path);
        break;
      case 'conflict':
        conflictFilesFromDiff.push(file.path);
        break;
    }
  }

  renamedFiles.sort((a, b) => `${a.oldPath}\u0000${a.path}`.localeCompare(`${b.oldPath}\u0000${b.path}`));
  const conflictFiles = uniqueSorted([...after.status.conflictFiles, ...conflictFilesFromDiff]);
  const changedFiles = changedAfterFiles.length;
  const hasConflicts = after.status.hasConflicts || conflictFiles.length > 0;
  const summaryParts: string[] = [];

  if (changedFiles > 0) summaryParts.push(`${changedFiles} ${plural(changedFiles, 'file')} changed`);
  if (addedFiles.length > 0) summaryParts.push(`${addedFiles.length} added`);
  if (modifiedFiles.length > 0) summaryParts.push(`${modifiedFiles.length} modified`);
  if (deletedFiles.length > 0) summaryParts.push(`${deletedFiles.length} deleted`);
  if (renamedFiles.length > 0) summaryParts.push(`${renamedFiles.length} renamed`);
  if (untrackedFiles.length > 0) summaryParts.push(`${untrackedFiles.length} untracked`);
  if (hasConflicts) summaryParts.push(`${conflictFiles.length || 1} ${plural(conflictFiles.length || 1, 'conflict')}`);

  return {
    beforeSnapshotId: before.id,
    afterSnapshotId: after.id,
    workspace: after.workspace,
    repoRoot: after.repoRoot,
    changedFiles,
    addedFiles: uniqueSorted(addedFiles),
    modifiedFiles: uniqueSorted(modifiedFiles),
    deletedFiles: uniqueSorted(deletedFiles),
    renamedFiles,
    untrackedFiles: uniqueSorted(untrackedFiles),
    conflictFiles,
    totalInsertions,
    totalDeletions,
    hasConflicts,
    currentStatus: after.status,
    summaryText: summaryParts.length > 0 ? summaryParts.join(', ') : 'No file-set changes between snapshots.',
  };
}

export class InMemoryGitSnapshotStore implements GitSnapshotStore {
  private readonly snapshots = new Map<string, GitSnapshot>();
  private readonly order: string[] = [];
  private readonly capacity: number;
  private readonly now: () => number;
  private readonly idPrefix: string;
  private readonly getStatusProvider?: GitStatusProvider;
  private readonly getDiffSummaryProvider?: GitDiffSummaryProvider;
  private counter = 0;

  constructor(options: GitSnapshotStoreOptions = {}) {
    this.capacity = normalizeCapacity(options.capacity);
    this.now = options.now ?? Date.now;
    this.idPrefix = options.idPrefix ?? 'git-snapshot';
    this.getStatusProvider = options.getStatus;
    this.getDiffSummaryProvider = options.getDiffSummary;
  }

  async create(input: GitSnapshotCreateInput): Promise<GitSnapshot> {
    const getStatus = input.getStatus ?? this.getStatusProvider;
    if (!getStatus) {
      throw new Error('GitSnapshotStore requires an injected getStatus provider');
    }

    const status = await getStatus(input.workspace);
    const getDiffSummary = input.getDiffSummary ?? this.getDiffSummaryProvider;
    const diffSummary = getDiffSummary ? await getDiffSummary(input.workspace, status) : createEmptyDiffSummary(status);
    const createdAt = this.now();
    const id = `${this.idPrefix}-${createdAt}-${++this.counter}`;
    const snapshot: GitSnapshot = {
      id,
      workspace: input.workspace,
      repoRoot: status.repoRoot ?? input.workspace,
      sessionId: input.sessionId,
      turnId: input.turnId,
      reason: input.reason,
      status,
      diffSummary,
      createdAt,
    };

    this.snapshots.set(id, snapshot);
    this.order.push(id);
    this.enforceCapacity();
    return snapshot;
  }

  get(id: string): GitSnapshot | undefined {
    return this.snapshots.get(id);
  }

  compare(beforeSnapshotId: string, afterSnapshotId: string): GitSnapshotCompareSummary {
    const before = this.snapshots.get(beforeSnapshotId);
    if (!before) throw new Error(`Unknown before snapshot: ${beforeSnapshotId}`);

    const after = this.snapshots.get(afterSnapshotId);
    if (!after) throw new Error(`Unknown after snapshot: ${afterSnapshotId}`);

    return compareGitSnapshots(before, after);
  }

  list(query: GitSnapshotListQuery = {}): GitSnapshot[] {
    const limit = Math.max(1, Math.floor(query.limit ?? this.capacity));
    return this.order
      .map((id) => this.snapshots.get(id))
      .filter((snapshot): snapshot is GitSnapshot => Boolean(snapshot))
      .filter((snapshot) => !query.workspace || snapshot.workspace === query.workspace)
      .filter((snapshot) => !query.sessionId || snapshot.sessionId === query.sessionId)
      .slice(-limit);
  }

  clear(): void {
    this.snapshots.clear();
    this.order.splice(0, this.order.length);
  }

  private enforceCapacity(): void {
    while (this.order.length > this.capacity) {
      const evictedId = this.order.shift();
      if (evictedId) this.snapshots.delete(evictedId);
    }
  }
}

export function createGitSnapshotStore(options: GitSnapshotStoreOptions = {}): GitSnapshotStore {
  return new InMemoryGitSnapshotStore(options);
}
