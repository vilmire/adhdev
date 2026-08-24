/**
 * Parity harness for the TopicSubscriptionRegistry (design S1 gate).
 *
 * Feeds a synthetic event sequence — subscribe → flushes under throttle →
 * command invalidation via the CORE `commandInvalidations` table →
 * unsubscribe — into the registry and pins the sink call sequence as an
 * INLINE golden (explicit expected arrays, no snapshot files).
 *
 * Every expectation is derived from the pre-extraction daemon engines (line
 * refs = 2026-08-24 capture, see the map in src/subscriptions/topic-registry.ts):
 *
 * - throttle window `lastSentAt > 0 && (now - lastSentAt) < intervalMs`:
 *   IDENTICAL in cloud (adhdev-daemon.ts buildWorkspaceGitUpdateForSubscription)
 *   and standalone (index.ts flushWsGitSubscriptions) — golden asserts both.
 * - first flush after subscribe always sends (lastSentAt === 0): both daemons.
 * - invalidation triggers a flush PASS but does NOT bypass the throttle:
 *   both daemons called their plain flush function from the
 *   commandInvalidations gate — golden pins the "invalidate inside the
 *   throttle window sends nothing" behavior.
 * - seq = per-subscription monotonic counter: CLOUD semantics (union decision
 *   #2 in the module header). Standalone previously stamped the
 *   GitWorkspaceMonitor's process-global seq; that difference is intentionally
 *   resolved to per-subscription here (still strictly monotonic per key).
 * - refresh concurrency cap 2: STANDALONE semantics (runAsyncBatch
 *   { concurrency: 2 }); cloud was a sequential per-peer loop and GAINS the
 *   bounded parallelism (union decision #1).
 * - re-subscribe on the same key resets engine state (seq restarts): both
 *   daemons overwrote the stored subscription state on subscribe.
 * - subscriptions on a connection that is alive but not deliverable are
 *   SKIPPED, not dropped (cloud kept subscriptions across transient
 *   `disconnected` peer states); dead connections are pruned.
 */
import { describe, expect, it } from 'vitest';

import { commandInvalidations } from '../../src/commands/command-invalidations.js';
import { createGitWorkspaceMonitor } from '../../src/git/git-monitor.js';
import type { GitRepoStatus } from '../../src/git/git-types.js';
import type { TopicSink } from '../../src/subscriptions/topic-registry.js';
import { DEFAULT_GIT_REFRESH_CONCURRENCY, TopicSubscriptionRegistry } from '../../src/subscriptions/topic-registry.js';

function fakeStatus(workspace: string): GitRepoStatus {
    return {
        workspace,
        repoRoot: workspace,
        isGitRepo: true,
        branch: 'main',
        headCommit: 'abc123',
        headMessage: 'test',
        upstream: null,
        upstreamStatus: 'unknown',
        ahead: 0,
        behind: 0,
        staged: 0,
        modified: 0,
        untracked: 0,
        deleted: 0,
        renamed: 0,
        dirty: false,
        hasConflicts: false,
        conflictFiles: [],
        stashCount: 0,
        lastCheckedAt: 0,
    } as unknown as GitRepoStatus;
}

interface SinkCall {
    connectionId: string;
    topic: string;
    key: string;
    seq: number;
    workspace: string;
    timestamp: number;
}

function createHarness(options: {
    now: () => number;
    getStatus?: (workspace: string) => Promise<GitRepoStatus>;
    deliverable?: (connectionId: string) => boolean;
    alive?: (connectionId: string) => boolean;
    gitRefreshConcurrency?: number;
}) {
    const calls: SinkCall[] = [];
    const sink: TopicSink = {
        send: (connectionId, topic, update) => {
            const u = update as { key: string; seq: number; workspace?: string; timestamp: number };
            calls.push({
                connectionId,
                topic,
                key: u.key,
                seq: u.seq,
                workspace: u.workspace ?? '',
                timestamp: u.timestamp,
            });
            return true;
        },
        isDeliverable: (connectionId) => options.deliverable?.(connectionId) ?? true,
        isAlive: (connectionId) => options.alive?.(connectionId) ?? true,
    };
    const monitor = createGitWorkspaceMonitor({
        now: options.now,
        getStatus: options.getStatus ?? (async (workspace) => fakeStatus(workspace)),
        getDiffSummary: async () => {
            throw new Error('diff summary must not be requested when includeDiffSummary=false');
        },
    });
    const registry = new TopicSubscriptionRegistry(sink, {
        now: options.now,
        gitMonitor: monitor,
        ...(options.gitRefreshConcurrency !== undefined
            ? { gitRefreshConcurrency: options.gitRefreshConcurrency }
            : {}),
    });
    return { registry, calls };
}

describe('TopicSubscriptionRegistry — workspace.git parity golden', () => {
    it('reproduces the subscribe → throttled flush → command invalidation → unsubscribe sequence', async () => {
        // Start the clock at a nonzero epoch: both daemons' throttle guard is
        // `lastSentAt > 0 && …`, i.e. a lastSentAt of literal 0 means
        // "never sent" — a t=0 first delivery would disable the throttle.
        let now = 10_000;
        const { registry, calls } = createHarness({ now: () => now });

        // 1. subscribe (dashboard sends { type:'subscribe', topic, key, params }).
        //    intervalMs 5000 = DEFAULT_GIT_WORKSPACE_POLL_INTERVAL_MS in both daemons.
        const accepted = registry.subscribe('c1', {
            type: 'subscribe',
            topic: 'workspace.git',
            key: 'git:/repo',
            params: { workspace: ' /repo ', includeDiffSummary: false, intervalMs: 5000 },
        });
        expect(accepted).toBe(true);
        expect(registry.hasSubscriptions('workspace.git')).toBe(true);
        // Workspace trimming = cloud semantics (union decision #3).

        // 2. Initial targeted flush right after subscribe (standalone:
        //    `await this.flushWsGitSubscriptions(ws)`; cloud: subscriptionChangeHandler
        //    → flushP2PWorkspaceGitSubscriptions). lastSentAt === 0 → always sends.
        await registry.flushNow('workspace.git', 'c1');

        // 3. Heartbeat flush inside the throttle window → nothing sent
        //    (both daemons: lastSentAt > 0 && now - lastSentAt < intervalMs).
        now = 11_000;
        await registry.flushNow('workspace.git');

        // 4. Heartbeat flush at the window edge (elapsed === intervalMs) → sends
        //    (both daemons use a strict `<` comparison).
        now = 15_000;
        await registry.flushNow('workspace.git');

        // 5. Command invalidation inside the throttle window: `git_stash_push`
        //    invalidates workspace.git per the CORE table, but invalidation only
        //    triggers a flush pass — the throttle still applies → nothing sent.
        now = 15_001;
        const invalidatedByStash = commandInvalidations('git_stash_push');
        expect(invalidatedByStash.has('workspace.git')).toBe(true);
        await registry.invalidate(invalidatedByStash);

        // 6. A non-git command invalidates nothing for workspace.git.
        now = 30_000;
        const invalidatedByChat = commandInvalidations('read_chat');
        expect(invalidatedByChat.has('workspace.git')).toBe(false);
        await registry.invalidate(invalidatedByChat);

        // 7. Command invalidation outside the throttle window → sends.
        const invalidatedByPush = commandInvalidations('git_push');
        expect(invalidatedByPush.has('workspace.git')).toBe(true);
        await registry.invalidate(invalidatedByPush);

        // 8. unsubscribe → engine state dropped → later flush sends nothing.
        expect(registry.unsubscribe('c1', { topic: 'workspace.git', key: 'git:/repo' })).toBe(true);
        expect(registry.hasSubscriptions('workspace.git')).toBe(false);
        now = 60_000;
        await registry.flushNow('workspace.git');

        // Inline golden: exactly three deliveries, per-subscription monotonic seq
        // (cloud semantics — union decision #2), timestamps from the monitor clock.
        expect(calls).toEqual([
            { connectionId: 'c1', topic: 'workspace.git', key: 'git:/repo', seq: 1, workspace: '/repo', timestamp: 10_000 },
            { connectionId: 'c1', topic: 'workspace.git', key: 'git:/repo', seq: 2, workspace: '/repo', timestamp: 15_000 },
            { connectionId: 'c1', topic: 'workspace.git', key: 'git:/repo', seq: 3, workspace: '/repo', timestamp: 30_000 },
        ]);
    });

    it('keeps seq independent per subscription and resets it on re-subscribe', async () => {
        let now = 10_000;
        const { registry, calls } = createHarness({ now: () => now });

        registry.subscribe('c1', {
            type: 'subscribe',
            topic: 'workspace.git',
            key: 'git:/a',
            params: { workspace: '/a', intervalMs: 1000 },
        });
        registry.subscribe('c1', {
            type: 'subscribe',
            topic: 'workspace.git',
            key: 'git:/b',
            params: { workspace: '/b', intervalMs: 1000 },
        });
        await registry.flushNow('workspace.git');
        now = 11_000;
        await registry.flushNow('workspace.git');

        // Re-subscribe on the same key resets the engine state (both daemons
        // overwrote the stored subscription on subscribe) → seq restarts at 1.
        registry.subscribe('c1', {
            type: 'subscribe',
            topic: 'workspace.git',
            key: 'git:/a',
            params: { workspace: '/a', intervalMs: 1000 },
        });
        await registry.flushNow('workspace.git', 'c1');

        expect(calls).toEqual([
            { connectionId: 'c1', topic: 'workspace.git', key: 'git:/a', seq: 1, workspace: '/a', timestamp: 10_000 },
            { connectionId: 'c1', topic: 'workspace.git', key: 'git:/b', seq: 1, workspace: '/b', timestamp: 10_000 },
            { connectionId: 'c1', topic: 'workspace.git', key: 'git:/a', seq: 2, workspace: '/a', timestamp: 11_000 },
            { connectionId: 'c1', topic: 'workspace.git', key: 'git:/b', seq: 2, workspace: '/b', timestamp: 11_000 },
            // post-resubscribe: /a restarts at seq 1; /b untouched (throttled at t=11s).
            { connectionId: 'c1', topic: 'workspace.git', key: 'git:/a', seq: 1, workspace: '/a', timestamp: 11_000 },
        ]);
    });

    it('caps concurrent git refreshes at the standalone-derived default of 2', async () => {
        expect(DEFAULT_GIT_REFRESH_CONCURRENCY).toBe(2);
        let now = 10_000;
        let inFlight = 0;
        let maxInFlight = 0;
        const gate: Array<() => void> = [];
        const { registry, calls } = createHarness({
            now: () => now,
            getStatus: (workspace) => new Promise<GitRepoStatus>((resolve) => {
                inFlight += 1;
                maxInFlight = Math.max(maxInFlight, inFlight);
                gate.push(() => {
                    inFlight -= 1;
                    resolve(fakeStatus(workspace));
                });
            }),
        });

        for (const ws of ['/r1', '/r2', '/r3', '/r4']) {
            registry.subscribe('c1', {
                type: 'subscribe',
                topic: 'workspace.git',
                key: `git:${ws}`,
                params: { workspace: ws, intervalMs: 1000 },
            });
        }
        const flush = registry.flushNow('workspace.git');
        // Let the batch start its first slots.
        await new Promise((resolve) => setImmediate(resolve));
        expect(maxInFlight).toBe(2);
        while (gate.length > 0) {
            gate.shift()!();
            // eslint-disable-next-line no-await-in-loop
            await new Promise((resolve) => setImmediate(resolve));
        }
        await flush;
        expect(maxInFlight).toBe(2);
        expect(calls.map((c) => c.key).sort()).toEqual(['git:/r1', 'git:/r2', 'git:/r3', 'git:/r4']);
    });

    it('skips alive-but-undeliverable connections without dropping them, and prunes dead ones', async () => {
        let now = 10_000;
        let deliverable = true;
        let alive = true;
        const { registry, calls } = createHarness({
            now: () => now,
            deliverable: () => deliverable,
            alive: () => alive,
        });
        registry.subscribe('c1', {
            type: 'subscribe',
            topic: 'workspace.git',
            key: 'git:/repo',
            params: { workspace: '/repo', intervalMs: 1000 },
        });

        // Transient transport blip (cloud peer in 'disconnected'): skipped, kept.
        deliverable = false;
        await registry.flushNow('workspace.git');
        expect(calls).toEqual([]);
        expect(registry.hasSubscriptions('workspace.git')).toBe(true);

        // Recovery: same subscription resumes with its own state.
        deliverable = true;
        await registry.flushNow('workspace.git');
        expect(calls).toEqual([
            { connectionId: 'c1', topic: 'workspace.git', key: 'git:/repo', seq: 1, workspace: '/repo', timestamp: 10_000 },
        ]);

        // Dead connection: pruned on the next flush pass.
        alive = false;
        now = 15_000;
        await registry.flushNow('workspace.git');
        expect(registry.hasSubscriptions('workspace.git')).toBe(false);
        expect(calls).toHaveLength(1);
    });

    it('rejects unmigrated topics so daemons keep their local engines until each cohort lands', () => {
        let now = 10_000;
        const { registry } = createHarness({ now: () => now });
        const accepted = registry.subscribe('c1', {
            type: 'subscribe',
            topic: 'daemon.metadata',
            key: 'meta:1',
            params: {},
        } as never);
        expect(accepted).toBe(false);
        expect(registry.unsubscribe('c1', { topic: 'daemon.metadata', key: 'meta:1' } as never)).toBe(false);
        expect(registry.handlesTopic('workspace.git')).toBe(true);
        expect(registry.handlesTopic('daemon.metadata')).toBe(false);
    });
});
