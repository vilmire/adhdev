import type {
  GitCompactSummary,
  GitDiffSummary,
  GitRepoStatus,
  GitWorkspaceUpdate,
  WorkspaceGitSubscriptionParams,
} from './git-types.js';
import { getGitDiffSummary } from './git-diff.js';
import { getGitRepoStatus } from './git-status.js';
import { createGitCompactSummary } from './git-summary.js';
import type { GitDiffSummaryProvider, GitStatusProvider } from './git-snapshot-store.js';

export const DEFAULT_GIT_WORKSPACE_POLL_INTERVAL_MS = 5000;
export const MIN_GIT_WORKSPACE_POLL_INTERVAL_MS = 1000;

export interface NormalizeGitWorkspaceSubscriptionOptions {
  defaultIntervalMs?: number;
  minIntervalMs?: number;
}

export interface NormalizedWorkspaceGitSubscriptionParams extends Required<WorkspaceGitSubscriptionParams> {}

export interface GitWorkspaceCacheEntry {
  key: string;
  workspace: string;
  status: GitRepoStatus;
  diffSummary?: GitDiffSummary;
  compactSummary: GitCompactSummary;
  seq: number;
  timestamp: number;
}

export type GitWorkspaceUpdateListener = (update: GitWorkspaceUpdate, cacheEntry: GitWorkspaceCacheEntry) => void;

export interface GitWorkspaceMonitorOptions {
  getStatus?: GitStatusProvider;
  getDiffSummary?: GitDiffSummaryProvider;
  now?: () => number;
  minIntervalMs?: number;
  defaultIntervalMs?: number;
  keyPrefix?: string;
}

export interface GitWorkspaceSubscription {
  params: NormalizedWorkspaceGitSubscriptionParams;
  refresh(): Promise<GitWorkspaceUpdate>;
  getCached(): GitWorkspaceCacheEntry | undefined;
  dispose(): void;
}

function defaultStatusProvider(workspace: string): Promise<GitRepoStatus> {
  return getGitRepoStatus(workspace);
}

function defaultDiffSummaryProvider(workspace: string): Promise<GitDiffSummary> {
  return getGitDiffSummary(workspace);
}

function normalizeIntervalMs(value: number | undefined, defaultIntervalMs: number, minIntervalMs: number): number {
  const requested = Number.isFinite(value) ? Math.floor(value as number) : defaultIntervalMs;
  return Math.max(minIntervalMs, requested > 0 ? requested : defaultIntervalMs);
}

export function normalizeGitWorkspaceSubscriptionParams(
  params: WorkspaceGitSubscriptionParams,
  options: NormalizeGitWorkspaceSubscriptionOptions = {},
): NormalizedWorkspaceGitSubscriptionParams {
  const minIntervalMs = Math.max(1, Math.floor(options.minIntervalMs ?? MIN_GIT_WORKSPACE_POLL_INTERVAL_MS));
  const defaultIntervalMs = Math.max(minIntervalMs, Math.floor(options.defaultIntervalMs ?? DEFAULT_GIT_WORKSPACE_POLL_INTERVAL_MS));

  return {
    workspace: params.workspace,
    includeDiffSummary: Boolean(params.includeDiffSummary),
    intervalMs: normalizeIntervalMs(params.intervalMs, defaultIntervalMs, minIntervalMs),
  };
}

export class GitWorkspaceMonitor {
  private readonly getStatusProvider: GitStatusProvider;
  private readonly getDiffSummaryProvider: GitDiffSummaryProvider;
  private readonly now: () => number;
  private readonly minIntervalMs: number;
  private readonly defaultIntervalMs: number;
  private readonly keyPrefix: string;
  private readonly cache = new Map<string, GitWorkspaceCacheEntry>();
  private readonly listeners = new Set<GitWorkspaceUpdateListener>();
  private seq = 0;

  constructor(options: GitWorkspaceMonitorOptions = {}) {
    this.getStatusProvider = options.getStatus ?? defaultStatusProvider;
    this.getDiffSummaryProvider = options.getDiffSummary ?? defaultDiffSummaryProvider;
    this.now = options.now ?? Date.now;
    this.minIntervalMs = Math.max(1, Math.floor(options.minIntervalMs ?? MIN_GIT_WORKSPACE_POLL_INTERVAL_MS));
    this.defaultIntervalMs = Math.max(
      this.minIntervalMs,
      Math.floor(options.defaultIntervalMs ?? DEFAULT_GIT_WORKSPACE_POLL_INTERVAL_MS),
    );
    this.keyPrefix = options.keyPrefix ?? 'git';
  }

  async refresh(params: string | WorkspaceGitSubscriptionParams): Promise<GitWorkspaceUpdate> {
    const normalized = this.normalize(typeof params === 'string' ? { workspace: params } : params);
    const status = await this.getStatusProvider(normalized.workspace);
    const diffSummary = normalized.includeDiffSummary
      ? await this.getDiffSummaryProvider(normalized.workspace, status)
      : undefined;
    const compactSummary = createGitCompactSummary(status, diffSummary);
    const timestamp = this.now();
    const seq = ++this.seq;
    const key = this.keyForWorkspace(normalized.workspace);
    const update: GitWorkspaceUpdate = {
      topic: 'workspace.git',
      key,
      workspace: normalized.workspace,
      status,
      diffSummary,
      seq,
      timestamp,
    };
    const cacheEntry: GitWorkspaceCacheEntry = {
      key,
      workspace: normalized.workspace,
      status,
      diffSummary,
      compactSummary,
      seq,
      timestamp,
    };

    this.cache.set(normalized.workspace, cacheEntry);
    this.emit(update, cacheEntry);
    return update;
  }

  poll(params: string | WorkspaceGitSubscriptionParams): Promise<GitWorkspaceUpdate> {
    return this.refresh(params);
  }

  getCached(workspace: string): GitWorkspaceCacheEntry | undefined {
    return this.cache.get(workspace);
  }

  getCompactSummary(workspace: string): GitCompactSummary | undefined {
    return this.cache.get(workspace)?.compactSummary;
  }

  onUpdate(listener: GitWorkspaceUpdateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  createSubscription(
    params: WorkspaceGitSubscriptionParams,
    listener?: GitWorkspaceUpdateListener,
  ): GitWorkspaceSubscription {
    const normalized = this.normalize(params);
    const scopedListener: GitWorkspaceUpdateListener | undefined = listener
      ? (update, cacheEntry) => {
          if (update.workspace === normalized.workspace) listener(update, cacheEntry);
        }
      : undefined;
    const unsubscribe = scopedListener ? this.onUpdate(scopedListener) : () => undefined;

    return {
      params: normalized,
      refresh: () => this.refresh(normalized),
      getCached: () => this.getCached(normalized.workspace),
      dispose: unsubscribe,
    };
  }

  normalize(params: WorkspaceGitSubscriptionParams): NormalizedWorkspaceGitSubscriptionParams {
    return normalizeGitWorkspaceSubscriptionParams(params, {
      defaultIntervalMs: this.defaultIntervalMs,
      minIntervalMs: this.minIntervalMs,
    });
  }

  private keyForWorkspace(workspace: string): string {
    return `${this.keyPrefix}:${workspace}`;
  }

  private emit(update: GitWorkspaceUpdate, cacheEntry: GitWorkspaceCacheEntry): void {
    for (const listener of this.listeners) {
      listener(update, cacheEntry);
    }
  }
}

export function createGitWorkspaceMonitor(options: GitWorkspaceMonitorOptions = {}): GitWorkspaceMonitor {
  return new GitWorkspaceMonitor(options);
}
