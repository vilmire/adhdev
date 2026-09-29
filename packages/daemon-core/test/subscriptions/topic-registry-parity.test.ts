/**
 * Parity harness for the TopicSubscriptionRegistry (design S1 gate).
 *
 * Feeds a synthetic event sequence — subscribe → flushes under throttle →
 * command invalidation via the CORE command registry (`invalidationsFor`) →
 * unsubscribe — into the registry and pins the sink call sequence as an
 * INLINE golden (explicit expected arrays, no snapshot files).
 *
 * Every expectation is derived from the pre-extraction daemon engines (line
 * refs = 2026-08-24 capture, see the map in src/subscriptions/topic-registry.ts):
 *
 * - sampling window `lastFlushedAt > 0 && (now - lastFlushedAt) < intervalMs`
 *   (2026-09-29, audit P1-9/P2: every sampled topic is change-only — an
 *   unchanged state is sent nothing; workspace.git runs git only while watched
 *   and an invalidation runs it regardless of the window).
 * - first flush after subscribe always sends.
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
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getDaemonCommandRegistry } from '../../src/commands/router.js';
import { createGitWorkspaceMonitor } from '../../src/git/git-monitor.js';
import type { GitRepoStatus } from '../../src/git/git-types.js';
import type { TopicEngineOptions, TopicSink } from '../../src/subscriptions/topic-registry.js';
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
    it('reproduces the subscribe → sampled flush → invalidation → unsubscribe sequence (git only while watched, send only on change)', async () => {
        // Start the clock at a nonzero epoch: the throttle guard treats a
        // lastFlushedAt of literal 0 as "never flushed".
        let now = 10_000;
        let modified = 0;
        let gitRuns = 0;
        const { registry, calls } = createHarness({
            now: () => now,
            getStatus: async (workspace) => {
                gitRuns += 1;
                return { ...fakeStatus(workspace), modified, lastCheckedAt: now } as GitRepoStatus;
            },
        });

        // 1. subscribe (dashboard sends { type:'subscribe', topic, key, params }).
        const accepted = registry.subscribe('c1', {
            type: 'subscribe',
            topic: 'workspace.git',
            key: 'git:/repo',
            params: { workspace: ' /repo ', includeDiffSummary: false, intervalMs: 5000 },
        });
        expect(accepted).toBe(true);
        expect(registry.hasSubscriptions('workspace.git')).toBe(true);

        // 2. Targeted first flush right after subscribe → git runs, first frame sent.
        await registry.flushNow('workspace.git', 'c1', 'git:/repo');
        expect(gitRuns).toBe(1);

        // 3. A sample inside the subscription interval → git does not even run.
        now = 11_000;
        await registry.flushNow('workspace.git');
        expect(gitRuns).toBe(1);

        // 4. A sample at the interval edge → git runs; the repo is unchanged
        //    (only `lastCheckedAt` moved) → NOTHING is sent (audit P1-9).
        now = 15_000;
        await registry.flushNow('workspace.git');
        expect(gitRuns).toBe(2);

        // 5. A command invalidation is the explicit "repo changed" signal: it
        //    runs git even inside the interval, and the change is sent.
        now = 15_001;
        modified = 1;
        const invalidatedByStash = getDaemonCommandRegistry().invalidationsFor('git_stash_push');
        expect(invalidatedByStash.has('workspace.git')).toBe(true);
        await registry.invalidate(invalidatedByStash);
        expect(gitRuns).toBe(3);

        // 6. A non-git command invalidates nothing for workspace.git.
        now = 30_000;
        const invalidatedByChat = getDaemonCommandRegistry().invalidationsFor('read_chat');
        expect(invalidatedByChat.has('workspace.git')).toBe(false);
        await registry.invalidate(invalidatedByChat);
        expect(gitRuns).toBe(3);

        // 7. Invalidation with an unchanged repo → git runs, nothing sent;
        //    then a real change → sent.
        const invalidatedByPush = getDaemonCommandRegistry().invalidationsFor('git_push');
        expect(invalidatedByPush.has('workspace.git')).toBe(true);
        await registry.invalidate(invalidatedByPush);
        modified = 2;
        now = 30_001;
        await registry.invalidate(invalidatedByPush);

        // 8. unsubscribe → engine state dropped → later flush runs no git.
        expect(registry.unsubscribe('c1', { topic: 'workspace.git', key: 'git:/repo' })).toBe(true);
        expect(registry.hasSubscriptions('workspace.git')).toBe(false);
        now = 60_000;
        await registry.flushNow('workspace.git');
        expect(gitRuns).toBe(5);

        // Inline golden: exactly three deliveries (first frame + two real
        // changes), per-subscription monotonic seq.
        expect(calls).toEqual([
            { connectionId: 'c1', topic: 'workspace.git', key: 'git:/repo', seq: 1, workspace: '/repo', timestamp: 10_000 },
            { connectionId: 'c1', topic: 'workspace.git', key: 'git:/repo', seq: 2, workspace: '/repo', timestamp: 15_001 },
            { connectionId: 'c1', topic: 'workspace.git', key: 'git:/repo', seq: 3, workspace: '/repo', timestamp: 30_001 },
        ]);
    });

    it('keeps seq independent per subscription and resets it on re-subscribe', async () => {
        let now = 10_000;
        const modified: Record<string, number> = { '/a': 0, '/b': 0 };
        const { registry, calls } = createHarness({
            now: () => now,
            getStatus: async (workspace) => ({ ...fakeStatus(workspace), modified: modified[workspace] ?? 0 } as GitRepoStatus),
        });

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
        modified['/a'] = 1; // only /a changes
        await registry.flushNow('workspace.git');

        // Re-subscribe on the same key resets the engine state → seq restarts
        // at 1 and the fresh subscription gets its first frame.
        registry.subscribe('c1', {
            type: 'subscribe',
            topic: 'workspace.git',
            key: 'git:/a',
            params: { workspace: '/a', intervalMs: 1000 },
        });
        await registry.flushNow('workspace.git', 'c1', 'git:/a');

        expect(calls).toEqual([
            { connectionId: 'c1', topic: 'workspace.git', key: 'git:/a', seq: 1, workspace: '/a', timestamp: 10_000 },
            { connectionId: 'c1', topic: 'workspace.git', key: 'git:/b', seq: 1, workspace: '/b', timestamp: 10_000 },
            // /b unchanged at 11s → nothing sent.
            { connectionId: 'c1', topic: 'workspace.git', key: 'git:/a', seq: 2, workspace: '/a', timestamp: 11_000 },
            // post-resubscribe: /a restarts at seq 1.
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

    it('rejects daemon-stored topics (runtime_output storage stays daemon-side) so daemons keep their local engines', () => {
        let now = 10_000;
        const { registry } = createHarness({ now: () => now });
        const accepted = registry.subscribe('c1', {
            type: 'subscribe',
            topic: 'session.runtime_output',
            key: 'out:1',
            params: { targetSessionId: 'session-1' },
        } as never);
        expect(accepted).toBe(false);
        expect(registry.unsubscribe('c1', { topic: 'session.runtime_output', key: 'out:1' } as never)).toBe(false);
        expect(registry.handlesTopic('workspace.git')).toBe(true);
        expect(registry.handlesTopic('daemon.metadata')).toBe(true);
        expect(registry.handlesTopic('session.runtime_output')).toBe(false);
    });
});

// ─── S3 cohort goldens ──────────────────────────────────────────────────────
//
// Same rules as the workspace.git suite above: every expectation is annotated
// with the daemon whose pre-extraction engine it was derived from (line refs =
// the 2026-08-24 capture in the module-header engine map). "both daemons"
// means the two engines were byte-equivalent for that behavior.

interface PushSinkCall {
    connectionId: string;
    topic: string;
    update: Record<string, unknown>;
}

function createPushHarness(options: {
    now: () => number;
    engine?: Partial<TopicEngineOptions>;
    deliverable?: (connectionId: string) => boolean;
    alive?: (connectionId: string) => boolean;
}) {
    const calls: PushSinkCall[] = [];
    const sink: TopicSink = {
        send: (connectionId, topic, update) => {
            calls.push({ connectionId, topic, update: update as unknown as Record<string, unknown> });
            return true;
        },
        isDeliverable: (connectionId) => options.deliverable?.(connectionId) ?? true,
        isAlive: (connectionId) => options.alive?.(connectionId) ?? true,
    };
    const registry = new TopicSubscriptionRegistry(sink, {
        now: options.now,
        ...(options.engine ?? {}),
    });
    return { registry, calls };
}

describe('TopicSubscriptionRegistry — daemon.metadata parity golden', () => {
    it('always builds (no throttle); sends a snapshot first, then only keyed deltas, with per-subscription monotonic seq', async () => {
        let now = 10_000;
        let bodyBuilds = 0;
        const { registry, calls } = createPushHarness({
            now: () => now,
            engine: {
                sources: {
                    // Cloud body shape: {daemonId, status, meshStateRevisions?};
                    // standalone: {daemonId, status, userName?}. The engine treats
                    // the body opaquely — the golden pins the envelope fields.
                    daemonMetadataBody: (params) => {
                        bodyBuilds += 1;
                        return {
                            daemonId: 'daemon_test',
                            status: { includeSessions: params?.includeSessions === true, build: bodyBuilds } as never,
                        };
                    },
                },
            },
        });

        // Subscribe (dashboard frame) + targeted first flush — both daemons
        // flushed immediately on subscribe (cloud subscriptionChangeHandler /
        // standalone `await flushWsDaemonMetadataSubscriptions(ws)`).
        expect(registry.subscribe('c1', {
            type: 'subscribe',
            topic: 'daemon.metadata',
            key: 'meta:1',
            params: { includeSessions: true },
        })).toBe(true);
        await registry.flushNow('daemon.metadata', 'c1');

        // Two immediate follow-up flush passes: daemon.metadata has NO
        // throttle (union decision #6) — every pass builds, and since the
        // body changed (`build` counter) each sends the keyed delta only.
        await registry.flushNow('daemon.metadata');
        now = 10_001;
        await registry.flushNow('daemon.metadata');

        // Command invalidation drives a flush pass through the CORE table
        // (both daemons routed set_conversation_prefs → metadata flush).
        const invalidated = getDaemonCommandRegistry().invalidationsFor('set_conversation_prefs');
        expect(invalidated.has('daemon.metadata')).toBe(true);
        await registry.invalidate(invalidated);

        // Cloud launch fastpath suppression: skip must prevent the double
        // flush (cloud handleCommand skipped its metadata flush after
        // triggerImmediateLaunchStatusUpdate already pushed one).
        await registry.invalidate(invalidated, { skip: ['daemon.metadata'] });

        expect(registry.unsubscribe('c1', { topic: 'daemon.metadata', key: 'meta:1' })).toBe(true);
        await registry.flushNow('daemon.metadata');

        expect(bodyBuilds).toBe(4);
        expect(calls).toEqual([
            { connectionId: 'c1', topic: 'daemon.metadata', update: { topic: 'daemon.metadata', key: 'meta:1', mode: 'snapshot', daemonId: 'daemon_test', status: { includeSessions: true, build: 1 }, seq: 1, timestamp: 10_000 } },
            { connectionId: 'c1', topic: 'daemon.metadata', update: { topic: 'daemon.metadata', key: 'meta:1', mode: 'delta', daemonId: 'daemon_test', statusSet: { build: 2 }, seq: 2, timestamp: 10_000 } },
            { connectionId: 'c1', topic: 'daemon.metadata', update: { topic: 'daemon.metadata', key: 'meta:1', mode: 'delta', daemonId: 'daemon_test', statusSet: { build: 3 }, seq: 3, timestamp: 10_001 } },
            { connectionId: 'c1', topic: 'daemon.metadata', update: { topic: 'daemon.metadata', key: 'meta:1', mode: 'delta', daemonId: 'daemon_test', statusSet: { build: 4 }, seq: 4, timestamp: 10_001 } },
        ]);
    });

    it('skips alive-but-undeliverable connections without dropping, prunes dead ones (cloud peer-blip semantics)', async () => {
        let deliverable = true;
        let alive = true;
        const { registry, calls } = createPushHarness({
            now: () => 10_000,
            deliverable: () => deliverable,
            alive: () => alive,
            engine: { sources: { daemonMetadataBody: () => ({ daemonId: 'd', status: {} as never }) } },
        });
        registry.subscribe('c1', { type: 'subscribe', topic: 'daemon.metadata', key: 'meta:1', params: {} });

        deliverable = false;
        await registry.flushNow('daemon.metadata');
        expect(calls).toEqual([]);
        expect(registry.hasSubscriptions('daemon.metadata')).toBe(true);

        deliverable = true;
        await registry.flushNow('daemon.metadata');
        expect(calls).toHaveLength(1);
        // seq did NOT advance while undeliverable — the skipped pass mutated nothing.
        expect(calls[0]!.update.seq).toBe(1);

        alive = false;
        await registry.flushNow('daemon.metadata');
        expect(registry.hasSubscriptions('daemon.metadata')).toBe(false);
        expect(calls).toHaveLength(1);
    });
});

describe('TopicSubscriptionRegistry — session.modal parity golden', () => {
    it('dedups on delivery signature, stamps interactionId/trace via hooks (cloud), plain without hooks (standalone)', async () => {
        let now = 10_000;
        // Mutable fake modal state — shape from providers/provider-instance
        // SessionModalState as consumed by BOTH daemons' build functions.
        let modalState: { status: string; title?: string; activeModal?: unknown } | null = null;
        const traces: Array<Record<string, unknown>> = [];
        const { registry, calls } = createPushHarness({
            now: () => now,
            engine: {
                // Cloud wiring: interactionId provider + debug-trace sink.
                interactionId: (sessionId) => (sessionId === 'session-1' ? 'itx-1' : undefined),
                recordTrace: (event) => { traces.push(event as unknown as Record<string, unknown>); },
                sources: { sessionModalState: () => modalState as never },
            },
        });

        // Cloud subscribe validation semantics (union decision #8): a
        // whitespace-only targetSessionId is rejected.
        expect(registry.subscribe('c1', {
            type: 'subscribe', topic: 'session.modal', key: 'modal:bad', params: { targetSessionId: '   ' },
        })).toBe(false);
        expect(registry.subscribe('c1', {
            type: 'subscribe', topic: 'session.modal', key: 'modal:1', params: { targetSessionId: 'session-1' },
        })).toBe(true);

        // No modal state resolvable → nothing published, no state mutation
        // (both daemons: `if (!state) return null`).
        await registry.flushNow('session.modal');
        expect(calls).toEqual([]);

        // Modal appears → published with seq 1 + interactionId (cloud
        // adhdev-daemon.ts:713 semantics; standalone omitted the field only
        // because it passed no provider — same engine).
        modalState = {
            status: 'waiting_approval',
            title: 'Session One',
            activeModal: { message: 'Run rm -rf build/?', buttons: ['Yes', 'No'] },
        };
        await registry.flushNow('session.modal');
        // Same state again → delivery-signature dedup, nothing sent and seq
        // NOT advanced (prepareSessionModalUpdate contract — both daemons).
        await registry.flushNow('session.modal');
        // Modal resolves → status-only update with seq 2.
        now = 11_000;
        modalState = { status: 'generating', title: 'Session One' };
        await registry.flushNow('session.modal');

        expect(calls).toEqual([
            {
                connectionId: 'c1',
                topic: 'session.modal',
                update: {
                    topic: 'session.modal',
                    key: 'modal:1',
                    sessionId: 'session-1',
                    status: 'waiting_approval',
                    title: 'Session One',
                    modalMessage: 'Run rm -rf build/?',
                    modalButtons: ['Yes', 'No'],
                    interactionId: 'itx-1',
                    seq: 1,
                    timestamp: 10_000,
                },
            },
            {
                connectionId: 'c1',
                topic: 'session.modal',
                update: {
                    topic: 'session.modal',
                    key: 'modal:1',
                    sessionId: 'session-1',
                    status: 'generating',
                    title: 'Session One',
                    interactionId: 'itx-1',
                    seq: 2,
                    timestamp: 11_000,
                },
            },
        ]);
        // Debug trace payload shape = cloud recordDebugTrace call, verbatim.
        expect(traces).toEqual([
            {
                interactionId: 'itx-1',
                category: 'topic',
                stage: 'session.modal_published',
                level: 'info',
                sessionId: 'session-1',
                payload: { status: 'waiting_approval', hasTitle: true, modalMessage: 'Run rm -rf build/?', modalButtonCount: 2 },
            },
            {
                interactionId: 'itx-1',
                category: 'topic',
                stage: 'session.modal_published',
                level: 'info',
                sessionId: 'session-1',
                payload: { status: 'generating', hasTitle: true, modalMessage: undefined, modalButtonCount: 0 },
            },
        ]);
    });

    it('publishes without interactionId when no provider is wired (standalone S3 semantics)', async () => {
        const { registry, calls } = createPushHarness({
            now: () => 10_000,
            engine: {
                sources: {
                    sessionModalState: () => ({ status: 'idle', title: 'T' }) as never,
                },
            },
        });
        registry.subscribe('c1', { type: 'subscribe', topic: 'session.modal', key: 'modal:1', params: { targetSessionId: 'session-1' } });
        await registry.flushNow('session.modal');
        expect(calls).toHaveLength(1);
        expect(calls[0]!.update.interactionId).toBeUndefined();
        expect(calls[0]!.update.status).toBe('idle');
    });
});

describe('TopicSubscriptionRegistry — machine.runtime parity golden', () => {
    it('applies the min-5s clamp / default-15s interval throttle with per-subscription seq', async () => {
        let now = 100_000;
        let builds = 0;
        const { registry, calls } = createPushHarness({
            now: () => now,
            engine: {
                sources: { machineInfo: () => { builds += 1; return { hostname: `m${builds}` } as never; } },
            },
        });

        // intervalMs 1000 is clamped to MIN 5000 — identical expression in
        // cloud (adhdev-daemon.ts:633) and standalone (index.ts:2143):
        // Math.max(MIN, Number(params.intervalMs || DEFAULT)).
        registry.subscribe('c1', { type: 'subscribe', topic: 'machine.runtime', key: 'mr:1', params: { intervalMs: 1000 } });
        await registry.flushNow('machine.runtime', 'c1');   // first flush: lastSentAt===0 → sends
        now = 104_999;
        await registry.flushNow('machine.runtime');          // inside clamped window → nothing
        now = 105_000;
        await registry.flushNow('machine.runtime');          // window edge (strict <) → sends
        expect(calls.map((c) => ({ seq: c.update.seq, timestamp: c.update.timestamp }))).toEqual([
            { seq: 1, timestamp: 100_000 },
            { seq: 2, timestamp: 105_000 },
        ]);
        // machine payload sampled ONLY past the window (throttled passes never call the source).
        expect(builds).toBe(2);

        // Unset intervalMs → DEFAULT 15s (both daemons).
        registry.subscribe('c2', { type: 'subscribe', topic: 'machine.runtime', key: 'mr:2', params: {} });
        await registry.flushNow('machine.runtime', 'c2');
        now = 115_000;
        await registry.flushNow('machine.runtime', 'c2');    // 10s later — inside default window
        now = 120_000;
        await registry.flushNow('machine.runtime', 'c2');    // 15s later — sends
        expect(calls.filter((c) => c.connectionId === 'c2').map((c) => c.update.seq)).toEqual([1, 2]);
    });
});

describe('TopicSubscriptionRegistry — session_host.diagnostics parity golden', () => {
    it('interval-throttles (min 5s / default 10s), sends only on change, passes includeSessions/limit, and skips without a controller', async () => {
        let now = 200_000;
        let controllerAvailable = false;
        let runtimeCount = 1;
        const requests: Array<Record<string, unknown>> = [];
        const { registry, calls } = createPushHarness({
            now: () => now,
            engine: {
                sources: {
                    sessionHostDiagnostics: (opts) => {
                        if (!controllerAvailable) return null;
                        requests.push(opts as unknown as Record<string, unknown>);
                        // Every snapshot carries a trace of the diagnostics
                        // request itself — never a change (see the signature).
                        return Promise.resolve({
                            runtimeCount,
                            recentLogs: [],
                            recentRequests: [{ type: 'get_host_diagnostics', timestamp: now, requestId: `r${requests.length}`, success: true, durationMs: 1 }],
                            recentTransitions: [],
                        } as never);
                    },
                },
            },
        });

        registry.subscribe('c1', {
            type: 'subscribe',
            topic: 'session_host.diagnostics',
            key: 'diag:1',
            params: { includeSessions: false, limit: 25, intervalMs: 1000 },
        });

        // Controller unavailable → null source result: nothing sent AND no
        // seq/lastSentAt mutation (both daemons: `if (!controller) return null`
        // BEFORE any state change).
        await registry.flushNow('session_host.diagnostics', 'c1');
        expect(calls).toEqual([]);

        // Controller appears → first delivery still uses seq 1 (nothing was
        // consumed by the unavailable pass); intervalMs 1000 clamps to MIN 5s.
        controllerAvailable = true;
        await registry.flushNow('session_host.diagnostics');
        now = 204_999;
        await registry.flushNow('session_host.diagnostics');  // inside clamped window
        now = 205_000;
        await registry.flushNow('session_host.diagnostics');  // edge → sampled, unchanged → nothing sent
        now = 210_000;
        runtimeCount = 2;
        await registry.flushNow('session_host.diagnostics');  // edge + a real change → sends
        expect(requests).toEqual([
            { includeSessions: false, limit: 25 },
            { includeSessions: false, limit: 25 },
            { includeSessions: false, limit: 25 },
        ]);
        expect(calls.map((c) => ({ seq: c.update.seq, timestamp: c.update.timestamp }))).toEqual([
            { seq: 1, timestamp: 200_000 },
            { seq: 2, timestamp: 210_000 },
        ]);
        // includeSessions defaults to true (`!== false`), limit Number()||undefined — both daemons.
        registry.subscribe('c1', { type: 'subscribe', topic: 'session_host.diagnostics', key: 'diag:2', params: {} });
        await registry.flushNow('session_host.diagnostics');
        expect(requests.at(-1)).toEqual({ includeSessions: true, limit: undefined });
    });
});

afterEach(() => {
    vi.useRealTimers();
});
