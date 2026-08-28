/**
 * seqscribe Beacon — the CONSUMER surface (mission b60d70b8).
 *
 * ── What this file proves ───────────────────────────────────────────────────
 *  (a) LAG ARITHMETIC. `behind` is measured against THIS node's positions, per
 *      peer and per topic, and a peer that is level or behind contributes zero
 *      rather than a negative number.
 *  (b) ★SOLE-COPY IS DEFERRED WHEN THE BOARD IS TRUNCATED (§7.1.2.1). This is
 *      the discipline the mission calls out explicitly: a truncated GET means
 *      the peer list is a SUBSET of the fleet, so "nobody else has this" is
 *      unprovable. The verdict must be `'unknown'` — never `false`/`replicated`
 *      (a confident wrong answer) and never `'sole-copy'` (an invented scare).
 *  (c) ★TRUNCATION IS REPORTED, NOT SWALLOWED. `truncated` survives onto the
 *      wire shape, because it is what a consumer needs to know its sole-copy
 *      column is deferred.
 *  (d) ★keyStale IS ADVISORY-ONLY (§5.7a). The field is named
 *      `keyStaleAdvisory`, carries hash-only keys, and nothing in the pipeline
 *      derives a gate from its raw-seq approximation.
 *  (e) ★NO ELAPSED-TIME FIELD REACHES THE WIRE. Every status frame is deduped by
 *      hashing the payload; an age recomputed per report would make each frame
 *      unique and turn an idle daemon into a constant transmitter — the exact
 *      regression §7.1.2 depends on not happening.
 *  (f) DIAGNOSTICS ARE FREE. `beacon.diagnostics()` issues no transport call,
 *      so a dashboard render cannot become a Beacon traffic source.
 *
 * ── Red/green injection (gate checklist ①) ──────────────────────────────────
 * Deleting the `truncated > 0` branch in `summarizeSoleCopy` turns (b) red on
 * every deferral assertion. Re-adding `boardAgeMs`/`lastSeenAgeMs` to
 * `toBeaconDiagnosticsSummary` turns (e) red. Making `diagnostics()` call
 * `transport.get()` turns (f) red.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    armBeacon,
    buildTopicPolicyMap,
    type BeaconGetResponse,
    type BeaconHostTransport,
    type ProjectedBeaconReport,
} from '../../src/seqscribe/beacon.js';
import {
    computeBeaconDiagnostics,
    summarizeSoleCopy,
    toBeaconDiagnosticsSummary,
    type BeaconBoardSnapshot,
} from '../../src/seqscribe/beacon-diagnostics.js';
import { openSeqscribeNode, type SeqscribeNodeHandle } from '../../src/seqscribe/node.js';
import { baseTopicDefinitions, FLEET_STATUS_TOPIC, meshEventsTopic } from '../../src/seqscribe/topics.js';

const CHAIN_A = 'a'.repeat(64);
const CHAIN_B = 'b'.repeat(64);

const ME = 'adhdev-1111111111111111';
const PEER_A = 'adhdev-2222222222222222';
const PEER_B = 'adhdev-3333333333333333';

const MESH_TOPIC = meshEventsTopic('mesh_abc123');

/** A board snapshot with sane defaults, so each test states only what it varies. */
function board(
    reports: ProjectedBeaconReport[],
    over: Partial<BeaconBoardSnapshot> = {},
): BeaconBoardSnapshot {
    return {
        reports,
        truncated: 0,
        topicScope: [FLEET_STATUS_TOPIC, MESH_TOPIC],
        capturedAt: 1_000_000,
        ...over,
    };
}

function report(node: string, vectors: ProjectedBeaconReport['vectors']): ProjectedBeaconReport {
    return { node, at: '2026-08-28T00:00:00.000Z', vectors };
}

function writers(entries: Record<string, number>): Record<string, { contig: number; chain: string }> {
    const out: Record<string, { contig: number; chain: string }> = {};
    for (const [writer, contig] of Object.entries(entries)) out[writer] = { contig, chain: CHAIN_A };
    return out;
}

/**
 * A second full-sync topic, so the multi-topic lag test can exercise "worst of
 * several" without reaching for a subscribe-only ring.
 *
 * ★ It must be full-sync. Using `fleet.status` here (as this file originally
 * did) builds a state production can never reach — see TOPIC_POLICY below.
 */
const MESH_TOPIC_B = meshEventsTopic('mesh_def456');

/**
 * ★ The topic replication table, mirroring `topics.ts`.
 *
 * This is the fixture correction the badge-semantics fix turns on. The previous
 * version of this file placed a PEER's writer inside our own local vectors for
 * `fleet.status`:
 *
 *     [FLEET_STATUS_TOPIC]: { writers: writers({ [ME]: 10, [PEER_A]: 3 }) }
 *
 * That state is unreachable in production. `fleet.status` is `subscribe-only`,
 * so it is granted `serve` (never `full`), the library's `mutualFull()` gate is
 * permanently false, and peer entries are never applied into our log — the peer
 * writerId never appears in `vectors()` at all. The fixture asserted a lag of 7
 * (10 − 3) that no live daemon can produce; live, `mine` is 0 and the "lag" is
 * the peer's entire lifetime append count. Testing against the impossible state
 * is exactly why the permanent-badge defect passed a green suite.
 */
const TOPIC_POLICY = {
    [FLEET_STATUS_TOPIC]: { replicates: false, ringSize: 50 },
    [MESH_TOPIC]: { replicates: true },
    [MESH_TOPIC_B]: { replicates: true },
};

describe('computeBeaconDiagnostics — per-peer, per-topic lag (①wake-up lag)', () => {
    it('measures how far each peer is ahead of THIS node, per topic', () => {
        const d = computeBeaconDiagnostics({
            node: ME,
            localVectors: {
                [MESH_TOPIC_B]: { writers: writers({ [ME]: 10, [PEER_A]: 3 }) },
                [MESH_TOPIC]: { writers: writers({ [ME]: 5 }) },
            },
            board: board([
                report(PEER_A, {
                    // 7 ahead of our 3 on its own writer, level on ours.
                    [MESH_TOPIC_B]: { writers: writers({ [PEER_A]: 10, [ME]: 10 }) },
                    // We hold nothing of PEER_A here → 4 behind.
                    [MESH_TOPIC]: { writers: writers({ [PEER_A]: 4 }) },
                }),
            ]),
            topicPolicy: TOPIC_POLICY,
            now: 1_000_000,
        });

        expect(d.peers).toHaveLength(1);
        const peer = d.peers[0]!;
        expect(peer.node).toBe(PEER_A);
        expect(peer.topics.find((t) => t.topic === MESH_TOPIC_B)?.behind).toBe(7);
        expect(peer.topics.find((t) => t.topic === MESH_TOPIC)?.behind).toBe(4);
        // Headline = the worst single topic, not the sum: it answers "how far
        // behind am I at worst", which is what a badge shows.
        expect(peer.behind).toBe(7);
        expect(d.maxBehind).toBe(7);
    });

    it('never reports a negative lag when this node is AHEAD of a peer', () => {
        const d = computeBeaconDiagnostics({
            node: ME,
            localVectors: { [FLEET_STATUS_TOPIC]: { writers: writers({ [ME]: 100 }) } },
            board: board([report(PEER_A, { [FLEET_STATUS_TOPIC]: { writers: writers({ [ME]: 2 }) } })]),
            now: 1_000_000,
        });

        expect(d.peers[0]!.behind).toBe(0);
        expect(d.peers[0]!.topics).toEqual([]);
        expect(d.maxBehind).toBe(0);
    });

    it('excludes this node from its own peer list', () => {
        const d = computeBeaconDiagnostics({
            node: ME,
            localVectors: { [FLEET_STATUS_TOPIC]: { writers: writers({ [ME]: 1 }) } },
            board: board([
                report(ME, { [FLEET_STATUS_TOPIC]: { writers: writers({ [ME]: 9 }) } }),
                report(PEER_A, { [FLEET_STATUS_TOPIC]: { writers: writers({ [ME]: 1 }) } }),
            ]),
            now: 1_000_000,
        });

        expect(d.peers.map((p) => p.node)).toEqual([PEER_A]);
        // A self-report must not manufacture lag against ourselves either.
        expect(d.maxBehind).toBe(0);
    });

    it('ranks peers worst-lag first so a consumer can take the head', () => {
        const d = computeBeaconDiagnostics({
            node: ME,
            localVectors: { [FLEET_STATUS_TOPIC]: { writers: writers({ [ME]: 0 }) } },
            board: board([
                report(PEER_A, { [FLEET_STATUS_TOPIC]: { writers: writers({ [PEER_A]: 3 }) } }),
                report(PEER_B, { [FLEET_STATUS_TOPIC]: { writers: writers({ [PEER_B]: 50 }) } }),
            ]),
            now: 1_000_000,
        });

        expect(d.peers.map((p) => p.node)).toEqual([PEER_B, PEER_A]);
    });

    it('reads a retired writer at its sealed finalSeq, not as absent', () => {
        const d = computeBeaconDiagnostics({
            node: ME,
            localVectors: { [FLEET_STATUS_TOPIC]: { writers: writers({ [PEER_B]: 4 }) } },
            board: board([
                report(PEER_A, {
                    [FLEET_STATUS_TOPIC]: {
                        writers: {
                            [PEER_B]: { retired: true, finalSeq: 12, finalChain: CHAIN_B, rgen: 1 },
                        },
                    },
                }),
            ]),
            now: 1_000_000,
        });

        expect(d.peers[0]!.behind).toBe(8);
    });
});

describe('★summarizeSoleCopy — truncation defers the verdict (§7.1.2.1)', () => {
    it('says sole-copy when the board is complete and no peer has our entries', () => {
        expect(summarizeSoleCopy({ localSeq: 5, bestPeerSeq: 2, truncated: 0, haveBoard: true }))
            .toEqual({ verdict: 'sole-copy' });
    });

    it('says replicated when a peer is level or ahead', () => {
        expect(summarizeSoleCopy({ localSeq: 5, bestPeerSeq: 5, truncated: 0, haveBoard: true }))
            .toEqual({ verdict: 'replicated' });
        expect(summarizeSoleCopy({ localSeq: 5, bestPeerSeq: 9, truncated: 0, haveBoard: true }))
            .toEqual({ verdict: 'replicated' });
    });

    it('★DEFERS to unknown when ANY peer report was truncated — never to replicated', () => {
        // The exact trap: locally this looks like a confident "replicated"
        // (a peer is ahead), and separately like a confident "sole-copy"
        // (nobody is). Both are unprovable — the peer that would settle it may
        // be the one the server dropped.
        for (const bestPeerSeq of [null, 0, 2, 5, 99]) {
            const out = summarizeSoleCopy({ localSeq: 5, bestPeerSeq, truncated: 1, haveBoard: true });
            expect(out.verdict, `bestPeerSeq=${bestPeerSeq} must defer`).toBe('unknown');
            expect(out.unknownReason).toBe('truncated');
        }
    });

    it('★defers to unknown when no board has arrived at all', () => {
        const out = summarizeSoleCopy({ localSeq: 5, bestPeerSeq: null, truncated: 0, haveBoard: false });
        expect(out.verdict).toBe('unknown');
        expect(out.unknownReason).toBe('no-board');
    });

    it('treats "complete board, nobody reported this topic" as the sole-copy signal', () => {
        expect(summarizeSoleCopy({ localSeq: 5, bestPeerSeq: null, truncated: 0, haveBoard: true }))
            .toEqual({ verdict: 'sole-copy' });
        // …but an empty local position is not a sole copy of anything.
        expect(summarizeSoleCopy({ localSeq: 0, bestPeerSeq: null, truncated: 0, haveBoard: true }))
            .toEqual({ verdict: 'replicated' });
    });
});

describe('★computeBeaconDiagnostics — sole-copy candidates (③sole-copy awareness)', () => {
    const localVectors = {
        [FLEET_STATUS_TOPIC]: { writers: writers({ [ME]: 20 }) },
    };

    it('flags entries no peer confirmed, with the unreplicated count', () => {
        const d = computeBeaconDiagnostics({
            node: ME,
            localVectors,
            board: board([report(PEER_A, { [FLEET_STATUS_TOPIC]: { writers: writers({ [ME]: 12 }) } })]),
            now: 1_000_000,
        });

        expect(d.soleCopy).toHaveLength(1);
        expect(d.soleCopy[0]).toMatchObject({
            topic: FLEET_STATUS_TOPIC,
            writer: ME,
            localSeq: 20,
            bestPeerSeq: 12,
            unreplicated: 8,
            verdict: 'sole-copy',
        });
        expect(d.soleCopyDeferred).toBe(false);
    });

    it('omits positions a peer has fully replicated — the list is the actionable subset', () => {
        const d = computeBeaconDiagnostics({
            node: ME,
            localVectors,
            board: board([report(PEER_A, { [FLEET_STATUS_TOPIC]: { writers: writers({ [ME]: 20 }) } })]),
            now: 1_000_000,
        });

        expect(d.soleCopy).toEqual([]);
    });

    it('★with truncated > 0, EVERY verdict is unknown and the deferral is flagged', () => {
        const d = computeBeaconDiagnostics({
            node: ME,
            localVectors,
            // A peer that appears fully caught up — the tempting "replicated".
            board: board([report(PEER_A, { [FLEET_STATUS_TOPIC]: { writers: writers({ [ME]: 20 }) } })], {
                truncated: 3,
            }),
            now: 1_000_000,
        });

        expect(d.truncated).toBe(3);
        expect(d.soleCopyDeferred).toBe(true);
        expect(d.soleCopy).toHaveLength(1);
        expect(d.soleCopy[0]!.verdict).toBe('unknown');
        expect(d.soleCopy[0]!.unknownReason).toBe('truncated');
        // ★ Nothing may be presented as a confident count while deferred.
        expect(d.soleCopy[0]!.unreplicated).toBe(0);
        // And no verdict anywhere claims certainty.
        for (const c of d.soleCopy) expect(c.verdict).not.toBe('replicated');
    });

    it('★before the first board, reports unknown/stale rather than a fabricated zero', () => {
        const d = computeBeaconDiagnostics({ node: ME, localVectors, board: null, now: 1_000_000 });

        expect(d.stale).toBe(true);
        expect(d.boardAt).toBeNull();
        expect(d.boardAgeMs).toBeNull();
        expect(d.peers).toEqual([]);
        expect(d.soleCopy[0]!.verdict).toBe('unknown');
        expect(d.soleCopy[0]!.unknownReason).toBe('no-board');
    });

    it('marks a board older than the TTL as stale but still serves it', () => {
        const fresh = computeBeaconDiagnostics({
            node: ME, localVectors, board: board([]), now: 1_000_000 + 5_000,
        });
        const old = computeBeaconDiagnostics({
            node: ME, localVectors, board: board([]), now: 1_000_000 + 120_000,
        });

        expect(fresh.stale).toBe(false);
        expect(old.stale).toBe(true);
        // Stale ≠ withheld: an idle daemon's board is SUPPOSED to age, and that
        // must read as "quiet", not "broken".
        expect(old.boardAt).not.toBeNull();
    });
});

describe('★keyStale is advisory-only (§5.7a / upstream P27)', () => {
    it('exposes the advisory list under an explicitly advisory name, empty by default', () => {
        const d = computeBeaconDiagnostics({
            node: ME,
            localVectors: {},
            board: board([]),
            now: 1_000_000,
        });

        // The field name itself is the guard: a reader cannot mistake
        // `keyStaleAdvisory` for a correctness signal the way a bare
        // `keyStale` invites.
        expect(d).toHaveProperty('keyStaleAdvisory');
        expect(d).not.toHaveProperty('keyStale');
        // Reports without hints preserve the old empty behavior exactly.
        expect(d.keyStaleAdvisory).toEqual([]);
    });

    it('carries an advisory entry through verbatim when one is supplied, gating nothing', () => {
        const d = computeBeaconDiagnostics({
            node: ME,
            localVectors: {},
            board: board([]),
            now: 1_000_000,
            keyStaleAdvisory: [
                { topic: 'config.settings', key: 'a'.repeat(64), latestKnown: ['t', 'w', 4], haveLocally: false },
            ],
        });

        expect(d.keyStaleAdvisory).toHaveLength(1);
        // ★No derived boolean anywhere says "blocked"/"unsafe" — the advisory
        // does not become a gate, which is the whole §5.7a discipline.
        expect(d).not.toHaveProperty('writeBlocked');
        expect(d).not.toHaveProperty('unsafeToWrite');
        expect(JSON.stringify(d)).not.toContain('blocked');
    });
});

describe('★toBeaconDiagnosticsSummary — no elapsed-time field reaches the wire', () => {
    const full = computeBeaconDiagnostics({
        node: ME,
        localVectors: { [FLEET_STATUS_TOPIC]: { writers: writers({ [ME]: 9 }) } },
        board: board([report(PEER_A, { [FLEET_STATUS_TOPIC]: { writers: writers({ [PEER_A]: 20 }) } })]),
        now: 1_050_000,
    });

    it('carries the in-process ages but strips them from the wire shape', () => {
        // Read on a clock AFTER the peer's own `at`, so the peer age is a real
        // elapsed value rather than the clamped 0 a 1970-epoch `now` produces.
        const aged = computeBeaconDiagnostics({
            node: ME,
            localVectors: { [FLEET_STATUS_TOPIC]: { writers: writers({ [ME]: 9 }) } },
            board: board(
                [report(PEER_A, { [FLEET_STATUS_TOPIC]: { writers: writers({ [PEER_A]: 20 }) } })],
                { capturedAt: Date.parse('2026-08-28T00:00:00.000Z') },
            ),
            now: Date.parse('2026-08-28T00:00:50.000Z'),
        });

        // In-process: ages present, because a local reader wants them.
        expect(aged.boardAgeMs).toBe(50_000);
        expect(aged.peers[0]!.lastSeenAgeMs).toBe(50_000);

        const wire = toBeaconDiagnosticsSummary(aged);

        // ★ On the wire: absent. An age recomputed on every report would make
        // each status frame unique, defeat the payload-hash dedup, and turn an
        // idle daemon into a constant transmitter (§7.1.2).
        expect(wire).not.toHaveProperty('boardAgeMs');
        expect(wire).not.toHaveProperty('stale');
        for (const peer of wire.peers) expect(peer).not.toHaveProperty('lastSeenAgeMs');
    });

    it('keeps the stable instants a consumer derives age from', () => {
        const wire = toBeaconDiagnosticsSummary(full);

        expect(wire.boardAt).toBe(new Date(1_000_000).toISOString());
        expect(wire.peers[0]!.lastSeen).toBe('2026-08-28T00:00:00.000Z');
    });

    it('★two reads at different clock times produce a BYTE-IDENTICAL wire shape', () => {
        // This is the dedup property stated as a test: same board, different
        // `now`, identical serialization. Re-adding an age field breaks it.
        const inputs = {
            node: ME,
            localVectors: { [FLEET_STATUS_TOPIC]: { writers: writers({ [ME]: 9 }) } },
            board: board([report(PEER_A, { [FLEET_STATUS_TOPIC]: { writers: writers({ [PEER_A]: 20 }) } })]),
        };
        const early = toBeaconDiagnosticsSummary(computeBeaconDiagnostics({ ...inputs, now: 1_001_000 }));
        const later = toBeaconDiagnosticsSummary(computeBeaconDiagnostics({ ...inputs, now: 1_900_000 }));

        expect(JSON.stringify(early)).toBe(JSON.stringify(later));
    });

    it('preserves truncation and the deferred verdicts onto the wire', () => {
        const deferred = computeBeaconDiagnostics({
            node: ME,
            localVectors: { [FLEET_STATUS_TOPIC]: { writers: writers({ [ME]: 9 }) } },
            board: board([], { truncated: 2 }),
            now: 1_000_000,
        });
        const wire = toBeaconDiagnosticsSummary(deferred);

        // A consumer that cannot see `truncated`/`soleCopyDeferred` would render
        // a deferred judgement as a confident one.
        expect(wire.truncated).toBe(2);
        expect(wire.soleCopyDeferred).toBe(true);
        expect(wire.soleCopy[0]!.verdict).toBe('unknown');
    });

    it('is an allow-list — an unknown future field does not ride along', () => {
        const wire = toBeaconDiagnosticsSummary({
            ...full,
            someFutureField: 'a brand new leak',
        } as never);

        expect(wire).not.toHaveProperty('someFutureField');
        expect(JSON.stringify(wire)).not.toContain('a brand new leak');
    });
});

describe('armBeacon().diagnostics() — against a real node', () => {
    let dir: string;
    let handle: SeqscribeNodeHandle | null = null;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'adhdev-beacon-diag-'));
    });

    afterEach(async () => {
        try {
            await handle?.close();
        } catch {
            /* noop */
        }
        handle = null;
        rmSync(dir, { recursive: true, force: true });
    });

    function open(): SeqscribeNodeHandle {
        handle = openSeqscribeNode({
            dbPath: join(dir, 'seqscribe.db'),
            meshIds: ['mesh_abc123'],
            env: {},
            storedFleetSecret: null,
        });
        return handle;
    }

    /** Wait for the library's push() microtask chain (put → get) to settle. */
    async function settle(): Promise<void> {
        for (let i = 0; i < 12; i++) await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
        for (let i = 0; i < 12; i++) await Promise.resolve();
    }

    it('★issues NO transport call — a diagnostics read is free', async () => {
        const node = open();
        let getCalls = 0;
        const transport: BeaconHostTransport = {
            async put(): Promise<void> {},
            async get(): Promise<BeaconGetResponse> {
                getCalls++;
                return { reports: [] };
            },
        };

        const beacon = armBeacon(node, transport, { env: {} })!;
        await settle();
        const afterArm = getCalls;

        // Twenty reads — a dashboard polling hard.
        for (let i = 0; i < 20; i++) beacon.diagnostics();

        // ★ If this ever fails, opening a dashboard turns an idle daemon into a
        // Beacon transmitter and breaks the status dedup floor (§7.1.2).
        expect(getCalls).toBe(afterArm);
        beacon.stop();
    });

    it('reports the board the beacon captured, including residual truncation', async () => {
        const node = open();
        const peerReport = report(PEER_A, {
            [FLEET_STATUS_TOPIC]: { writers: writers({ [PEER_A]: 42 }) },
        });
        const transport: BeaconHostTransport = {
            async put(): Promise<void> {},
            async get(): Promise<BeaconGetResponse> {
                // truncated on a SINGLE-topic-or-fewer request is the last-resort
                // backstop §7.1.2.1 leaves in place — no further split possible.
                return { reports: [peerReport], truncated: 1 };
            },
        };

        const beacon = armBeacon(node, transport, { env: {} })!;
        await settle();

        const d = beacon.diagnostics();
        expect(d.node).toBe(node.writerId);
        expect(d.peers.map((p) => p.node)).toContain(PEER_A);
        expect(d.truncated).toBeGreaterThan(0);
        // ★ Residual truncation ⇒ every sole-copy verdict deferred.
        expect(d.soleCopyDeferred).toBe(true);
        for (const c of d.soleCopy) expect(c.verdict).toBe('unknown');
        beacon.stop();
    });

    it('reports stale/no-board honestly before any GET succeeds', async () => {
        const node = open();
        const transport: BeaconHostTransport = {
            async put(): Promise<void> {
                throw new Error('offline'); // library chains get() off put()
            },
            async get(): Promise<BeaconGetResponse> {
                return { reports: [] };
            },
        };

        const beacon = armBeacon(node, transport, { env: {} })!;
        await settle();

        const d = beacon.diagnostics();
        expect(d.boardAt).toBeNull();
        expect(d.stale).toBe(true);
        expect(d.peers).toEqual([]);
        beacon.stop();
    });
});

/**
 * ★ THE "BOY WHO CRIED WOLF" REGRESSION (2026-08-28).
 *
 * Live on rc.32, all three fleet machines showed a permanent `behind 8425` and
 * a permanent `sole-copy`. Neither was a replication failure: both came from
 * running the local-vs-peer comparison on `fleet.status`, a `subscribe-only`
 * ring whose peer entries never enter `node.vectors()` (grant is `serve`, so
 * `mutualFull()` is permanently false and `applyExternal` never runs for a peer
 * writer).
 *
 * With `mine` structurally pinned at 0, `behind` degenerates into the peer's
 * whole lifetime append count — monotonically growing, never closing — and
 * `bestPeerSeq` is always null, so every position we hold is judged sole-copy.
 *
 * ── Red/green injection (gate checklist ①) ─────────────────────────────────
 * These tests are written as PAIRS. Each first asserts the OLD behaviour by
 * omitting `topicPolicy` (the pre-fix code path exactly), then asserts the
 * fixed behaviour with the policy supplied. Delete the `replicatesLocally`
 * guards from either loop in beacon-diagnostics.ts and the second half of each
 * pair goes red while the first half stays green — proving the assertions bite
 * on the fix itself and not on incidental fixture shape.
 */
describe('computeBeaconDiagnostics — subscribe-only topics are excluded (badge semantics)', () => {
    /**
     * The live shape.
     *
     * ★ On `fleet.status` we hold ONLY our own writer — that is the whole
     * point: a subscribe-only grant means `PEER_A` never enters our vectors.
     * On the full-sync `MESH_TOPIC` we DO hold the peer's writer (at 40, five
     * behind their 45), because there replication genuinely happens.
     */
    const liveVectors = {
        [FLEET_STATUS_TOPIC]: { writers: writers({ [ME]: 12 }) },
        [MESH_TOPIC]: { writers: writers({ [ME]: 40, [PEER_A]: 40 }) },
    };
    const liveBoard = () =>
        board([
            report(PEER_A, {
                // 8425 lifetime appends on a ring topic we never replicate.
                // ★ The peer does NOT echo our writer back: it never received
                // our fleet.status entries into ITS log either — the topic is
                // subscribe-only in both directions. That absence is what makes
                // `bestPeerSeq` null and every local position read as sole-copy.
                [FLEET_STATUS_TOPIC]: { writers: writers({ [PEER_A]: 8425 }) },
                // A genuine, closable 5-entry gap on a full-sync topic.
                [MESH_TOPIC]: { writers: writers({ [PEER_A]: 45, [ME]: 40 }) },
            }),
        ]);

    it('RED (pre-fix): without a topic policy, a subscribe-only ring reports the peer lifetime as lag', () => {
        const d = computeBeaconDiagnostics({
            node: ME,
            localVectors: liveVectors,
            board: liveBoard(),
            now: 1_000_000,
        });

        // This is the defect, reproduced: 8425 − 0.
        expect(d.peers[0]!.topics.find((t) => t.topic === FLEET_STATUS_TOPIC)?.behind).toBe(8425);
        expect(d.maxBehind).toBe(8425);
    });

    it('GREEN: a subscribe-only topic contributes ZERO lag; full-sync lag survives', () => {
        const d = computeBeaconDiagnostics({
            node: ME,
            localVectors: liveVectors,
            board: liveBoard(),
            topicPolicy: TOPIC_POLICY,
            now: 1_000_000,
        });

        // The ring is gone from the lag arithmetic entirely — not clamped, not
        // thresholded: it never had a meaningful value to report.
        expect(d.peers[0]!.topics.find((t) => t.topic === FLEET_STATUS_TOPIC)).toBeUndefined();
        // ★ The real convergence number is untouched. This is what keeps the
        // fix from being "turn the badge off".
        expect(d.peers[0]!.topics.find((t) => t.topic === MESH_TOPIC)?.behind).toBe(5);
        expect(d.maxBehind).toBe(5);
    });

    it('RED (pre-fix): without a topic policy, every subscribe-only position is judged sole-copy', () => {
        const d = computeBeaconDiagnostics({
            node: ME,
            localVectors: liveVectors,
            board: liveBoard(),
            now: 1_000_000,
        });

        // No peer report can ever confirm our fleet.status position, so the
        // pre-fix code calls it sole-copy — permanently.
        const ring = d.soleCopy.find((s) => s.topic === FLEET_STATUS_TOPIC);
        expect(ring?.verdict).toBe('sole-copy');
    });

    it('GREEN: a subscribe-only topic yields no sole-copy candidate at all', () => {
        const d = computeBeaconDiagnostics({
            node: ME,
            localVectors: liveVectors,
            board: liveBoard(),
            topicPolicy: TOPIC_POLICY,
            now: 1_000_000,
        });

        expect(d.soleCopy.find((s) => s.topic === FLEET_STATUS_TOPIC)).toBeUndefined();
    });

    it('a full-sync topic still reports a genuine sole-copy (the fix is not a blanket mute)', () => {
        const d = computeBeaconDiagnostics({
            node: ME,
            // We are ahead of every peer on a topic we DO replicate: a real
            // "only this machine has these entries" signal.
            localVectors: { [MESH_TOPIC]: { writers: writers({ [ME]: 40 }) } },
            board: board([report(PEER_A, { [MESH_TOPIC]: { writers: writers({ [ME]: 30 }) } })]),
            topicPolicy: TOPIC_POLICY,
            now: 1_000_000,
        });

        const found = d.soleCopy.find((s) => s.topic === MESH_TOPIC);
        expect(found?.verdict).toBe('sole-copy');
        expect(found?.unreplicated).toBe(10);
    });

    it('an unknown topic defaults to replicating, so the exclusion stays targeted', () => {
        // A topic absent from the policy map (e.g. defined after the map was
        // built) must behave exactly as it did before this change — the map is
        // an exclusion list, never an allow-list.
        const d = computeBeaconDiagnostics({
            node: ME,
            localVectors: { 'topic.unlisted': { writers: writers({ [ME]: 3 }) } },
            board: board([
                report(PEER_A, { 'topic.unlisted': { writers: writers({ [PEER_A]: 9, [ME]: 3 }) } }),
            ]),
            topicPolicy: TOPIC_POLICY,
            now: 1_000_000,
        });

        expect(d.peers[0]!.topics.find((t) => t.topic === 'topic.unlisted')?.behind).toBe(9);
    });
});

describe('computeBeaconDiagnostics — ring topics cap unreplicated (P2)', () => {
    it('bounds unreplicated by ring size rather than by raw sequence distance', () => {
        // A ring holds at most `size` entries; older ones are already evicted.
        // So a 10,000-wide sequence gap cannot mean 10,000 entries live only
        // here. This is a general rule — with P0 in force `fleet.status` no
        // longer reaches it, but any future subscribe-capable ring does.
        const RING_TOPIC = 'ring.sample';
        const d = computeBeaconDiagnostics({
            node: ME,
            localVectors: { [RING_TOPIC]: { writers: writers({ [ME]: 10_000 }) } },
            board: board([report(PEER_A, { [RING_TOPIC]: { writers: writers({ [ME]: 5 }) } })]),
            topicPolicy: { [RING_TOPIC]: { replicates: true, ringSize: 50 } },
            now: 1_000_000,
        });

        const found = d.soleCopy.find((s) => s.topic === RING_TOPIC);
        expect(found?.verdict).toBe('sole-copy');
        // Raw distance would be 9,995; the ring can only hold 50.
        expect(found?.unreplicated).toBe(50);
        // The raw sequences are still reported truthfully — only the derived
        // "how much could be lost" figure is bounded.
        expect(found?.localSeq).toBe(10_000);
        expect(found?.bestPeerSeq).toBe(5);
    });

    it('leaves a full-retention topic uncapped', () => {
        const d = computeBeaconDiagnostics({
            node: ME,
            localVectors: { [MESH_TOPIC]: { writers: writers({ [ME]: 900 }) } },
            board: board([report(PEER_A, { [MESH_TOPIC]: { writers: writers({ [ME]: 5 }) } })]),
            topicPolicy: TOPIC_POLICY,
            now: 1_000_000,
        });

        expect(d.soleCopy.find((s) => s.topic === MESH_TOPIC)?.unreplicated).toBe(895);
    });
});

describe('buildTopicPolicyMap — derives the policy from the live topic table', () => {
    it('marks subscribe-only topics as non-replicating and carries ring size', () => {
        const map = buildTopicPolicyMap({
            topics: [
                {
                    topic: FLEET_STATUS_TOPIC,
                    policy: { replication: 'subscribe-only', retention: { mode: 'ring', size: 50 } },
                },
                {
                    topic: MESH_TOPIC,
                    policy: { replication: 'full-sync', retention: { mode: 'full' } },
                },
            ],
        });

        expect(map[FLEET_STATUS_TOPIC]).toEqual({ replicates: false, ringSize: 50 });
        // No ringSize key at all for a full-retention topic, so `capUnreplicated`
        // passes it through untouched.
        expect(map[MESH_TOPIC]).toEqual({ replicates: true });
    });

    it('treats an unrecognised replication mode as replicating', () => {
        const map = buildTopicPolicyMap({
            topics: [{ topic: 'topic.future', policy: { replication: 'some-future-mode' } }],
        });
        expect(map['topic.future']?.replicates).toBe(true);
    });

    it('agrees with the real topic table: fleet.status is excluded, mesh events are not', () => {
        // Pins the fix to the ACTUAL production policies rather than to a
        // hand-written fixture — if topics.ts ever flips fleet.status to
        // full-sync, this fails and the exclusion gets re-examined.
        const map = buildTopicPolicyMap({ topics: baseTopicDefinitions(['mesh_abc123']) });
        expect(map[FLEET_STATUS_TOPIC]?.replicates).toBe(false);
        expect(map[MESH_TOPIC]?.replicates).toBe(true);
    });
});
