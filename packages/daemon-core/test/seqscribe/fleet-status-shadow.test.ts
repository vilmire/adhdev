import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    configureFleetStatusShadow,
    recordFleetStatusShadow,
    fleetStatusCounters,
    fleetStatusInflight,
    fleetStatusMode,
    isFleetStatusShadowActive,
    resolveFleetStatusMode,
    FLEET_STATUS_ENTRY_KIND,
    __resetFleetStatusShadowForTests,
} from '../../src/seqscribe/fleet-status-shadow.js';
import {
    countFleetSessions,
    fleetStatusEntry,
    type FleetStatusEntry,
} from '../../src/status/reporter.js';
import { FLEET_STATUS_TOPIC } from '../../src/seqscribe/topics.js';
import { openSeqscribeNode, type SeqscribeNodeHandle } from '../../src/seqscribe/node.js';

/**
 * Phase 4 Stage 1 — `fleet.status` producer shadow.
 *
 * Two properties are load-bearing and both are pinned here:
 *
 *   1. THE SHAPE IS CLOSED. `fleet.status` is an `access: 'metadata'` topic that
 *      replicates to the whole fleet, so it is governed by the same content
 *      boundary as the server WS status path. The entry must be a fixed key set
 *      of identifiers, enums, booleans and counters — never user or agent text,
 *      and never a dynamic-key map whose KEYS carry unreviewed data.
 *   2. A SHADOW FAILURE IS INERT. The append is called from the status
 *      reporting tick, whose success gates routing and push notifications. No
 *      input, and no node state, may make it throw.
 */

/**
 * The complete set of keys an entry may carry. Adding one here is an assertion
 * that the field is non-content — see the `fleetStatusEntry` doc comment.
 */
const ALLOWED_TOP_LEVEL_KEYS = [
    'daemonId',
    'at',
    'onlineState',
    'p2pActive',
    'sessionCounts',
    'seqscribe',
] as const;

const ALLOWED_COUNT_KEYS = [
    'ideCount',
    'cliCount',
    'acpCount',
    'idleCount',
    'generatingCount',
    'waitingApprovalCount',
    'erroredCount',
] as const;

const tmpDirs: string[] = [];
const handles: SeqscribeNodeHandle[] = [];

function openNode(name: string): SeqscribeNodeHandle {
    const dir = mkdtempSync(join(tmpdir(), `adhdev-fleet-${name}-`));
    tmpDirs.push(dir);
    const handle = openSeqscribeNode({
        dbPath: join(dir, 'seq.db'),
        env: {},
        storedFleetSecret: null,
        daemonId: 'daemon_mach_test',
    });
    handles.push(handle);
    return handle;
}

function entry(overrides: Partial<FleetStatusEntry> = {}): FleetStatusEntry {
    return fleetStatusEntry({
        daemonId: 'daemon_mach_test',
        sessions: [],
        onlineState: 'online',
        p2pActive: true,
        timestamp: 1_700_000_000_000,
        ...(overrides as any),
    });
}

/** Poll a predicate — consumer delivery lands on a later turn. */
async function until(predicate: () => boolean, what: string, budgetMs = 2000): Promise<void> {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`timeout waiting for: ${what}`);
}

/** Poll until the fire-and-forget appends have settled. */
async function untilQuiet(budgetMs = 2000): Promise<void> {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
        if (fleetStatusInflight() === 0) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('timeout waiting for appends to settle');
}

afterEach(async () => {
    __resetFleetStatusShadowForTests();
    for (const handle of handles.splice(0)) {
        try {
            await handle.close();
        } catch {
            /* noop */
        }
    }
    for (const dir of tmpDirs.splice(0)) {
        try {
            rmSync(dir, { recursive: true, force: true });
        } catch {
            /* noop */
        }
    }
});

// ─── Schema: fixed keys only ────────────────────────────────────────────────

describe('fleet.status entry schema', () => {
    it('carries exactly the allow-listed top-level keys', () => {
        const built = entry({ seqscribe: undefined });
        // `seqscribe` is optional-and-absent when no node reports, so the
        // present set must be a SUBSET of the allow-list and must contain every
        // required key.
        for (const key of Object.keys(built)) {
            expect(ALLOWED_TOP_LEVEL_KEYS).toContain(key as any);
        }
        for (const key of ['daemonId', 'at', 'onlineState', 'p2pActive', 'sessionCounts']) {
            expect(built).toHaveProperty(key);
        }
    });

    it('omits seqscribe entirely rather than zeroing it when no node reports', () => {
        expect(entry({ seqscribe: undefined })).not.toHaveProperty('seqscribe');
    });

    it('sessionCounts is a fixed key set of numbers — never a dynamic map', () => {
        const counts = entry().sessionCounts;
        expect(Object.keys(counts).sort()).toEqual([...ALLOWED_COUNT_KEYS].sort());
        for (const value of Object.values(counts)) {
            expect(typeof value).toBe('number');
        }
    });

    it('carries only scalars at the top level — no arrays, no free text', () => {
        const built = entry();
        expect(typeof built.daemonId).toBe('string');
        expect(typeof built.at).toBe('string');
        expect(['online', 'reconnecting', 'offline']).toContain(built.onlineState);
        expect(typeof built.p2pActive).toBe('boolean');
        for (const value of Object.values(built)) {
            expect(Array.isArray(value)).toBe(false);
        }
    });

    it('stamps `at` as an ISO-8601 string derived from the tick timestamp', () => {
        expect(entry().at).toBe(new Date(1_700_000_000_000).toISOString());
    });

    it('falls back to now — never NaN or "Invalid Date" — on a bad timestamp', () => {
        const built = entry({} as any);
        const bad = fleetStatusEntry({
            daemonId: 'd',
            sessions: [],
            onlineState: 'online',
            p2pActive: false,
            timestamp: Number.NaN,
        });
        expect(bad.at).not.toBe('Invalid Date');
        expect(Number.isNaN(Date.parse(bad.at))).toBe(false);
        expect(built.at).toBeTruthy();
    });
});

// ─── Negative: injected dynamic keys must not reach the topic ───────────────

describe('fleet.status entry rejects unlisted fields', () => {
    /**
     * The shapes a careless widening would forward. Mirrors the negative case in
     * status/cloud-status-content-boundary.test.ts — the point is that the
     * builder is an ALLOW-LIST that copies by name, so a caller cannot smuggle a
     * field through by putting it on the input.
     */
    it('drops per-session arrays, nicknames, topic names and dynamic maps', () => {
        const built = fleetStatusEntry({
            daemonId: 'daemon_mach_test',
            sessions: [
                {
                    id: 'sess-1',
                    kind: 'agent',
                    transport: 'pty',
                    status: 'generating',
                    // Content that must never be tallied into the entry:
                    title: 'refactor the billing module',
                    lastAgentMessage: 'secret prompt text',
                    workspace: '/Users/someone/private-project',
                },
            ],
            onlineState: 'online',
            p2pActive: true,
            timestamp: 1_700_000_000_000,
            // Fields a future caller might try to pass through:
            machineNickname: 'vilmire-Jupiter',
            sessionsById: { 'sess-1': { status: 'generating' } },
            perProvider: { claude: 2, codex: 1 },
            topicNames: [FLEET_STATUS_TOPIC],
            peerIds: ['peer-a'],
            writerId: 'adhdev-0123456789abcdef',
        } as any);

        for (const leaked of [
            'machineNickname',
            'sessionsById',
            'perProvider',
            'topicNames',
            'peerIds',
            'writerId',
            'sessions',
        ]) {
            expect(built).not.toHaveProperty(leaked);
        }
        // The session contributed a COUNT and nothing else.
        expect(built.sessionCounts.cliCount).toBe(1);
        expect(built.sessionCounts.generatingCount).toBe(1);
        expect(JSON.stringify(built)).not.toContain('secret prompt text');
        expect(JSON.stringify(built)).not.toContain('private-project');
        expect(JSON.stringify(built)).not.toContain('vilmire-Jupiter');
    });

    it('drops unlisted seqscribe fields via the shared projection', () => {
        const built = fleetStatusEntry({
            daemonId: 'd',
            sessions: [],
            onlineState: 'online',
            p2pActive: false,
            timestamp: 1,
            seqscribe: {
                topics: 3,
                peers: 1,
                peersReady: 1,
                pendingBucket: 0,
                consumerLagBucket: 0,
                queueBucket: 0,
                fgenAgeBucket: 0,
                quarantined: false,
                authority: true,
                dualWrite: true,
                dualWriteFailedBucket: 0,
                dualWriteDroppedBucket: 0,
                dualWriteBackfilledBucket: 0,
                parityMismatchBucket: 0,
                parityRan: true,
                parityMissingInShadowBucket: 0,
                parityExtraInShadowBucket: 0,
                parityFieldMismatchBucket: 0,
                topicNames: ['session.sess-1.transcript'],
                lastEntryPayload: { text: 'secret prompt text' },
            } as any,
        });

        expect(built.seqscribe).not.toHaveProperty('topicNames');
        expect(built.seqscribe).not.toHaveProperty('lastEntryPayload');
        for (const value of Object.values(built.seqscribe ?? {})) {
            expect(['number', 'boolean']).toContain(typeof value);
        }
    });
});

// ─── Counting ───────────────────────────────────────────────────────────────

describe('countFleetSessions', () => {
    it('counts categories from top-level sessions only, by kind+transport', () => {
        const counts = countFleetSessions([
            { id: 'a', kind: 'workspace', transport: 'cdp-page', status: 'idle' },
            { id: 'b', kind: 'agent', transport: 'pty', status: 'idle' },
            { id: 'c', kind: 'agent', transport: 'acp', status: 'idle' },
            // Nested: contributes no CATEGORY count.
            { id: 'd', parentId: 'a', kind: 'agent', transport: 'pty', status: 'idle' },
        ]);
        expect(counts.ideCount).toBe(1);
        expect(counts.cliCount).toBe(1);
        expect(counts.acpCount).toBe(1);
    });

    it('counts state buckets across ALL sessions, nested included', () => {
        const counts = countFleetSessions([
            { id: 'a', kind: 'workspace', transport: 'cdp-page', status: 'idle' },
            // A nested agent waiting on approval still needs a human.
            { id: 'd', parentId: 'a', kind: 'agent', transport: 'pty', status: 'waiting_approval' },
        ]);
        expect(counts.ideCount).toBe(1);
        expect(counts.cliCount).toBe(0);
        expect(counts.waitingApprovalCount).toBe(1);
    });

    it('folds waiting_choice into the approval bucket', () => {
        const counts = countFleetSessions([
            { id: 'a', kind: 'agent', transport: 'pty', status: 'waiting_approval' },
            { id: 'b', kind: 'agent', transport: 'pty', status: 'waiting_choice' },
        ]);
        expect(counts.waitingApprovalCount).toBe(2);
    });

    it('leaves statuses outside the four buckets uncounted rather than misfiled', () => {
        const counts = countFleetSessions([
            { id: 'a', kind: 'agent', transport: 'pty', status: 'finalizing' },
            { id: 'b', kind: 'agent', transport: 'pty', status: 'stopped' },
            { id: 'c', kind: 'agent', transport: 'pty', status: 'starting' },
            { id: 'd', kind: 'agent', transport: 'pty', status: 'disconnected' },
        ]);
        // Category total is 4; the state buckets deliberately do not partition.
        expect(counts.cliCount).toBe(4);
        expect(counts.idleCount).toBe(0);
        expect(counts.generatingCount).toBe(0);
        expect(counts.waitingApprovalCount).toBe(0);
        expect(counts.erroredCount).toBe(0);
    });

    it('returns zeros for a non-array, null entries and unknown shapes', () => {
        for (const input of [undefined, null, 'nope', 42, {}]) {
            const counts = countFleetSessions(input);
            for (const value of Object.values(counts)) expect(value).toBe(0);
        }
        const counts = countFleetSessions([null, undefined, {}, { status: 'bogus' }]);
        for (const value of Object.values(counts)) expect(value).toBe(0);
    });
});

// ─── Mode resolution: OFF by default ────────────────────────────────────────

describe('resolveFleetStatusMode', () => {
    it('defaults to off — this leg is opt-in until a consumer exists', () => {
        expect(resolveFleetStatusMode({})).toBe('off');
        expect(resolveFleetStatusMode({ ADHDEV_SEQSCRIBE_FLEET_STATUS: '' })).toBe('off');
    });

    it('accepts shadow and off, case- and whitespace-insensitively', () => {
        expect(resolveFleetStatusMode({ ADHDEV_SEQSCRIBE_FLEET_STATUS: 'shadow' })).toBe('shadow');
        expect(resolveFleetStatusMode({ ADHDEV_SEQSCRIBE_FLEET_STATUS: ' SHADOW ' })).toBe('shadow');
        expect(resolveFleetStatusMode({ ADHDEV_SEQSCRIBE_FLEET_STATUS: 'off' })).toBe('off');
    });

    it('fails closed on an unrecognized value', () => {
        expect(resolveFleetStatusMode({ ADHDEV_SEQSCRIBE_FLEET_STATUS: 'primary' })).toBe('off');
        expect(resolveFleetStatusMode({ ADHDEV_SEQSCRIBE_FLEET_STATUS: 'shdaow' })).toBe('off');
    });
});

// ─── The append leg is inert on failure ─────────────────────────────────────

describe('recordFleetStatusShadow never throws', () => {
    it('is a no-op when unconfigured', () => {
        expect(() => recordFleetStatusShadow(entry())).not.toThrow();
        expect(recordFleetStatusShadow(entry())).toBe(false);
        expect(isFleetStatusShadowActive()).toBe(false);
    });

    it('is a no-op when the mode is off, even with a live node', () => {
        const node = openNode('off');
        configureFleetStatusShadow(node, {});
        expect(fleetStatusMode()).toBe('off');
        expect(isFleetStatusShadowActive()).toBe(false);
        expect(recordFleetStatusShadow(entry())).toBe(false);
        expect(fleetStatusCounters().written).toBe(0);
    });

    it('is a no-op after detaching with null', () => {
        const node = openNode('detach');
        configureFleetStatusShadow(node, { ADHDEV_SEQSCRIBE_FLEET_STATUS: 'shadow' });
        expect(isFleetStatusShadowActive()).toBe(true);
        configureFleetStatusShadow(null, { ADHDEV_SEQSCRIBE_FLEET_STATUS: 'shadow' });
        expect(isFleetStatusShadowActive()).toBe(false);
        expect(recordFleetStatusShadow(entry())).toBe(false);
    });

    it('swallows a node whose append rejects, and counts it', async () => {
        const node = openNode('reject');
        configureFleetStatusShadow(node, { ADHDEV_SEQSCRIBE_FLEET_STATUS: 'shadow' });
        // Replace the log accessor with one whose append rejects — the failure
        // mode a closed node or a sealed writer produces at runtime.
        const original = node.node.log.bind(node.node);
        (node.node as any).log = () => ({
            append: () => Promise.reject(new Error('append exploded')),
        });

        expect(() => recordFleetStatusShadow(entry())).not.toThrow();
        await untilQuiet();
        expect(fleetStatusCounters().failed).toBeGreaterThan(0);
        expect(fleetStatusCounters().written).toBe(0);

        (node.node as any).log = original;
    });

    it('swallows a node whose log accessor throws synchronously', () => {
        const node = openNode('throw');
        configureFleetStatusShadow(node, { ADHDEV_SEQSCRIBE_FLEET_STATUS: 'shadow' });
        const original = node.node.log.bind(node.node);
        (node.node as any).log = () => {
            throw new Error('log exploded');
        };

        expect(() => recordFleetStatusShadow(entry())).not.toThrow();
        expect(recordFleetStatusShadow(entry())).toBe(false);
        expect(fleetStatusCounters().failed).toBeGreaterThan(0);

        (node.node as any).log = original;
    });

    it('swallows a malformed entry rather than throwing at the caller', () => {
        const node = openNode('malformed');
        configureFleetStatusShadow(node, { ADHDEV_SEQSCRIBE_FLEET_STATUS: 'shadow' });
        const cyclic: any = { daemonId: 'd', at: 'x', onlineState: 'online', p2pActive: false };
        cyclic.self = cyclic;
        expect(() => recordFleetStatusShadow(cyclic)).not.toThrow();
    });

    it('disables itself when the node lacks the fleet.status topic', () => {
        const node = openNode('notopic');
        // Simulate a node whose boot definitions did not include the topic.
        node.topics = node.topics.filter((d) => d.topic !== FLEET_STATUS_TOPIC);
        configureFleetStatusShadow(node, { ADHDEV_SEQSCRIBE_FLEET_STATUS: 'shadow' });
        expect(recordFleetStatusShadow(entry())).toBe(false);
        expect(fleetStatusCounters().written).toBe(0);
    });

    it('sheds load rather than growing unboundedly, counting the drops', async () => {
        const node = openNode('shed');
        configureFleetStatusShadow(node, { ADHDEV_SEQSCRIBE_FLEET_STATUS: 'shadow' });
        // Appends that never settle: in-flight climbs to the cap and stays.
        (node.node as any).log = () => ({ append: () => new Promise(() => {}) });

        for (let i = 0; i < 100; i++) recordFleetStatusShadow(entry());

        expect(fleetStatusInflight()).toBeLessThanOrEqual(32);
        expect(fleetStatusCounters().dropped).toBeGreaterThan(0);
    });
});

// ─── The happy path actually lands in the ring ──────────────────────────────

describe('recordFleetStatusShadow writes to the ring', () => {
    /**
     * ★ Why this asserts through `vectors()` and not by reading the entries back.
     *
     * `log()` is append-only, and `onEntry` is rejected on this topic outright:
     * `ERR_MISUSE: onEntry requires retention "full" (fleet.status) — ring/none
     * serve via SUB`. A ring topic has no in-process reader by design — the read
     * side is a SUB, which is precisely what Stage 2 builds. So at Stage 1 the
     * observable proof that a record landed is the node's own have-vector
     * advancing for this writer on this topic, which is also exactly what a peer
     * would use to discover the entry.
     *
     * The SHAPE of what lands is pinned by the schema suites above, against the
     * same builder whose output is handed to `append` verbatim (the module
     * re-shapes nothing — see its doc comment).
     */
    it('appends to the ring and advances the writer vector', async () => {
        const node = openNode('write');
        configureFleetStatusShadow(node, { ADHDEV_SEQSCRIBE_FLEET_STATUS: 'shadow' });

        const before = node.node.vectors()[FLEET_STATUS_TOPIC]?.writers?.[node.writerId]?.contig ?? 0;

        const built = entry({
            sessions: [{ id: 'a', kind: 'agent', transport: 'pty', status: 'generating' }],
        } as any);
        // Sanity: the record handed to `append` is the one the builder produced.
        expect(built.sessionCounts.generatingCount).toBe(1);
        expect(built.sessionCounts.cliCount).toBe(1);

        expect(recordFleetStatusShadow(built)).toBe(true);
        await untilQuiet();

        expect(fleetStatusCounters().written).toBe(1);
        expect(fleetStatusCounters().failed).toBe(0);
        expect(fleetStatusCounters().dropped).toBe(0);
        expect(fleetStatusCounters().oversized).toBe(0);

        await until(
            () =>
                (node.node.vectors()[FLEET_STATUS_TOPIC]?.writers?.[node.writerId]?.contig ?? 0) >
                before,
            'the fleet.status writer vector to advance',
        );
    });

    it('records every tick — the ring tail is not deduped by this leg', async () => {
        const node = openNode('repeat');
        configureFleetStatusShadow(node, { ADHDEV_SEQSCRIBE_FLEET_STATUS: 'shadow' });

        for (let i = 0; i < 3; i++) expect(recordFleetStatusShadow(entry())).toBe(true);
        await untilQuiet();

        expect(fleetStatusCounters().written).toBe(3);
        expect(fleetStatusCounters().failed).toBe(0);
    });
});
