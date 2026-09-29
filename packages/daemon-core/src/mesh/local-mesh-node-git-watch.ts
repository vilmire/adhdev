/**
 * Coordinator side of the git change detector: the coordinator's OWN checkouts
 * (mesh nodes whose workspace is on this machine — it reads their git itself,
 * nobody pushes them) are watched the same way members watch theirs
 * (workspace-git-watcher.ts). A commit / checkout / `git add` made from a
 * terminal invalidates that mesh's aggregate view, which flushes its keyed
 * `mesh.status` lane — so the dashboard sees it within about a second instead
 * of on the next unrelated event.
 *
 * Registered lazily: a workspace is watched once a mesh_status render has
 * probed it as a local node, i.e. only for meshes someone looks at. The watch
 * spawns nothing; the re-read happens in the next mesh_status. That read's own
 * writes (`git status` refreshing the index) fall inside a quiet window and
 * never re-trigger it.
 */
import type { WorkspaceGitWatchHandle } from './workspace-git-watcher.js';

export const LOCAL_MESH_NODE_GIT_SELF_READ_QUIET_MS = 1_500;

interface LocalMeshNodeGitWatchOptions {
    watch: (workspace: string, onChange: () => void, onError: () => void) => WorkspaceGitWatchHandle | null;
    /** A watched checkout of `meshId` moved. */
    onChange: (meshId: string) => void;
    now?: () => number;
    quietMs?: number;
}

export class LocalMeshNodeGitWatch {
    private readonly watches = new Map<string, { handle: WorkspaceGitWatchHandle | null; meshIds: Set<string> }>();
    private readonly readsInFlight = new Map<string, number>();
    private readonly quietUntil = new Map<string, number>();
    private readonly now: () => number;
    private readonly quietMs: number;

    constructor(private readonly options: LocalMeshNodeGitWatchOptions) {
        this.now = options.now ?? Date.now;
        this.quietMs = options.quietMs ?? LOCAL_MESH_NODE_GIT_SELF_READ_QUIET_MS;
    }

    /** Watch `workspace` (a checkout this daemon reads itself) on behalf of `meshId`. Idempotent. */
    track(meshId: string, workspace: string): void {
        if (!meshId || !workspace) return;
        const existing = this.watches.get(workspace);
        if (existing) {
            existing.meshIds.add(meshId);
            return;
        }
        const entry = { handle: null as WorkspaceGitWatchHandle | null, meshIds: new Set([meshId]) };
        this.watches.set(workspace, entry);
        try {
            entry.handle = this.options.watch(
                workspace,
                () => this.changed(workspace),
                // A dead watch is forgotten; the next render that probes the workspace re-arms it.
                () => { if (this.watches.get(workspace) === entry) this.watches.delete(workspace); },
            );
        } catch {
            entry.handle = null;
        }
        if (!entry.handle) this.watches.delete(workspace);
    }

    isWatching(workspace: string): boolean {
        return !!this.watches.get(workspace)?.handle;
    }

    /** Run this daemon's own read of `workspace`; detector callbacks it causes are ignored. */
    async read<T>(workspace: string, run: () => Promise<T>): Promise<T> {
        this.readsInFlight.set(workspace, (this.readsInFlight.get(workspace) ?? 0) + 1);
        try {
            return await run();
        } finally {
            const left = (this.readsInFlight.get(workspace) ?? 1) - 1;
            if (left > 0) this.readsInFlight.set(workspace, left);
            else this.readsInFlight.delete(workspace);
            this.quietUntil.set(workspace, this.now() + this.quietMs);
        }
    }

    private changed(workspace: string): void {
        if ((this.readsInFlight.get(workspace) ?? 0) > 0) return;
        if (this.now() < (this.quietUntil.get(workspace) ?? 0)) return;
        for (const meshId of this.watches.get(workspace)?.meshIds ?? []) {
            try { this.options.onChange(meshId); } catch { /* best-effort */ }
        }
    }

    stop(): void {
        for (const entry of this.watches.values()) {
            try { entry.handle?.stop(); } catch { /* noop */ }
        }
        this.watches.clear();
    }
}
