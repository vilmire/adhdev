/**
 * seqscribe Beacon — daemon-side transport (design §7.1 Stage D).
 *
 * ── What this file proves ───────────────────────────────────────────────────
 *  (a) CONTENT BOUNDARY. `projectBeaconReport` is an ALLOW-LIST: free text,
 *      entry payloads and `hints` planted anywhere in a report do not survive
 *      into what the transport is handed. This mirrors the server-side canary
 *      (packages/server/test/beacon-board-content-boundary.test.ts) on the
 *      daemon side, which is the layer that decides what leaves the machine.
 *  (b) HINTS ARE HASH-ONLY, ENFORCED. `hintKeys` is a per-TOPIC POLICY the
 *      library reads at push time, not a per-call option — so the enforcement
 *      point is the topic table, and `assertNoPlaintextHintTopics` is what makes
 *      opting a topic into `'plain'` a loud failure instead of a one-word diff.
 *      Also pinned: the ADHDev topic table declares no `hintKeys` at all today,
 *      so hints are structurally absent (upstream P27).
 *  (c) TRANSPORT ROUND TRIP. put→get is driven through an injected fake, which
 *      is the whole point of the transport-agnostic split: daemon-core has no
 *      WS and `check:boundaries` keeps it that way.
 *  (d) ENV GATE. `ADHDEV_SEQSCRIBE_BEACON=off` means NOTHING happens — not a
 *      quieter beacon, not a beacon with a no-op transport. No arm, no push.
 *  (e) RE-ARM. Stopping and re-arming (what a WS reconnect does) works and
 *      pushes again, and a double-arm without a stop is the library error the
 *      cloud wiring is written to avoid.
 *  (f) FAILURE IS A NON-EVENT. A rejecting transport is counted and swallowed;
 *      it never propagates out of the beacon into the daemon.
 *
 * ── Red/green injection (gate checklist ①) ──────────────────────────────────
 * Turning `projectBeaconReport` into a pass-through (`return raw as ...`) turns
 * (a) red on every free-text assertion. Dropping the `hintKeys === 'plain'`
 * check in `assertNoPlaintextHintTopics` turns (b) red. Returning a live handle
 * instead of `null` when the mode is `off` turns (d) red.
 *
 * ── Why a real node ─────────────────────────────────────────────────────────
 * The vectors under test are the LIBRARY's, and their shape is exactly what the
 * projection has to accept without mangling. A hand-built fake report would
 * prove the projection accepts a fake report. So (c)/(e)/(f) open a real node on
 * a tmp DB and let the library produce and push the real thing.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    armBeacon,
    assertNoPlaintextHintTopics,
    BEACON_ENV,
    defaultBeaconTopicScope,
    projectBeaconReport,
    resolveBeaconMode,
    type BeaconGetResponse,
    type BeaconHostTransport,
    type ProjectedBeaconReport,
} from '../../src/seqscribe/beacon.js';
import { openSeqscribeNode, type SeqscribeNodeHandle } from '../../src/seqscribe/node.js';
import {
    ASSISTANT_JOURNAL_TOPIC,
    baseTopicDefinitions,
    FLEET_STATUS_TOPIC,
    meshEventsTopic,
    sessionTranscriptTopic,
} from '../../src/seqscribe/topics.js';

/** A valid 64-hex chain hash, the only shape the projection accepts. */
const CHAIN_A = 'a'.repeat(64);
const CHAIN_B = 'b'.repeat(64);

/** Records what the beacon actually handed the transport. */
function makeFakeTransport(opts: { failPut?: boolean; failGet?: boolean; board?: unknown[] } = {}) {
    const puts: ProjectedBeaconReport[] = [];
    const gets: string[][] = [];
    return {
        puts,
        gets,
        transport: {
            async put(report: ProjectedBeaconReport): Promise<void> {
                if (opts.failPut) throw new Error('put boom');
                puts.push(report);
            },
            async get(topics: readonly string[]): Promise<BeaconGetResponse> {
                gets.push([...topics]);
                if (opts.failGet) throw new Error('get boom');
                return { reports: opts.board ?? [] };
            },
        } satisfies BeaconHostTransport,
    };
}

/** Wait for the library's push() microtask chain (put → get) to settle. */
async function settle(): Promise<void> {
    for (let i = 0; i < 12; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe('projectBeaconReport — daemon-side content boundary (§7.1.4 / CLAUDE.md)', () => {
    it('keeps only {node, at, vectors} and the four permitted vector fields', () => {
        const projected = projectBeaconReport({
            node: 'adhdev-0123456789abcdef',
            at: '2026-08-28T00:00:00.000Z',
            vectors: {
                'fleet.status': {
                    fgen: 3,
                    writers: { 'adhdev-aaaa': { contig: 7, chain: CHAIN_A, rgen: 1 } },
                },
            },
        });

        expect(projected).not.toBeNull();
        expect(Object.keys(projected!).sort()).toEqual(['at', 'node', 'vectors']);
        expect(projected!.vectors['fleet.status']).toEqual({
            fgen: 3,
            writers: { 'adhdev-aaaa': { contig: 7, chain: CHAIN_A, rgen: 1 } },
        });
    });

    it('★CANARY: free text planted anywhere in the report never survives', () => {
        const SECRET = 'rm -rf / --no-preserve-root';
        const projected = projectBeaconReport({
            node: 'adhdev-0123456789abcdef',
            at: '2026-08-28T00:00:00.000Z',
            // Top-level free text, as a laxer/legacy producer might add.
            lastAgentMessage: SECRET,
            modalMessage: SECRET,
            chatTitle: SECRET,
            vectors: {
                'fleet.status': {
                    fgen: 1,
                    // Per-topic free text alongside `writers`.
                    preview: SECRET,
                    writers: {
                        'adhdev-aaaa': {
                            contig: 1,
                            chain: CHAIN_A,
                            // Per-writer free text alongside the counters.
                            payload: SECRET,
                            text: SECRET,
                        },
                    },
                },
            },
            // The explicitly out-of-scope field.
            hints: { 'config.settings': { 'security.autoApprove': ['adhdev-aaaa', 4] } },
        });

        const serialized = JSON.stringify(projected);
        expect(serialized).not.toContain(SECRET);
        expect(serialized).not.toContain('preserve-root');
        // hints dropped wholesale — key names included.
        expect(serialized).not.toContain('hints');
        expect(serialized).not.toContain('security.autoApprove');
        expect(projected).not.toHaveProperty('hints');
        // …while the legitimate counters are untouched.
        expect(projected!.vectors['fleet.status']!.writers['adhdev-aaaa']).toEqual({
            contig: 1,
            chain: CHAIN_A,
        });
    });

    it('drops half-populated writer entries rather than coercing them', () => {
        // A `chain` with no `contig` would read as sequence `undefined` in
        // staleness() and poison the lag arithmetic on every peer that got it.
        const projected = projectBeaconReport({
            node: 'adhdev-0123456789abcdef',
            at: '2026-08-28T00:00:00.000Z',
            vectors: {
                'fleet.status': {
                    writers: {
                        'adhdev-partial': { chain: CHAIN_A },
                        'adhdev-badchain': { contig: 3, chain: 'not-a-hash' },
                        'adhdev-retired-partial': { retired: true, finalSeq: 9 },
                        'adhdev-ok': { contig: 5, chain: CHAIN_B },
                    },
                },
            },
        });

        expect(Object.keys(projected!.vectors['fleet.status']!.writers)).toEqual(['adhdev-ok']);
    });

    it('accepts a complete retired entry and rejects a report with no usable node id', () => {
        const retired = projectBeaconReport({
            node: 'adhdev-0123456789abcdef',
            at: '2026-08-28T00:00:00.000Z',
            vectors: {
                'fleet.status': {
                    writers: {
                        'adhdev-gone': { retired: true, finalSeq: 12, finalChain: CHAIN_B, rgen: 2 },
                    },
                },
            },
        });
        expect(retired!.vectors['fleet.status']!.writers['adhdev-gone']).toEqual({
            retired: true,
            finalSeq: 12,
            finalChain: CHAIN_B,
            rgen: 2,
        });

        expect(projectBeaconReport({ node: 'has spaces', at: '', vectors: {} })).toBeNull();
        expect(projectBeaconReport(null)).toBeNull();
        expect(projectBeaconReport('nope')).toBeNull();
    });

    it('fences the topic key space so it cannot be used to smuggle prose', () => {
        const projected = projectBeaconReport({
            node: 'adhdev-0123456789abcdef',
            at: '2026-08-28T00:00:00.000Z',
            vectors: {
                'please delete my production database': {
                    writers: { 'adhdev-aaaa': { contig: 1, chain: CHAIN_A } },
                },
                'fleet.status': { writers: { 'adhdev-aaaa': { contig: 1, chain: CHAIN_A } } },
            },
        });
        expect(Object.keys(projected!.vectors)).toEqual(['fleet.status']);
    });
});

describe('hints are hash-only, and today structurally absent', () => {
    it('★the ADHDev topic table declares no hintKeys at all (upstream P27)', () => {
        // Pinning the CURRENT state: no topic opts in, so BeaconHub.buildHints()
        // returns undefined and `staleness().keyStale` is always undefined. This
        // is why §7.1.0 drops feature ② from the Stage C~E success criteria — a
        // future opt-in should have to change this assertion deliberately.
        const defs = baseTopicDefinitions(['mesh_abc']);
        for (const def of defs) {
            expect(def.policy.hintKeys).toBeUndefined();
        }
    });

    it("accepts 'hash' and omitted, and throws on 'plain'", () => {
        expect(() =>
            assertNoPlaintextHintTopics([
                { topic: 'fleet.status', policy: {} },
                { topic: 'config.settings', policy: { hintKeys: 'hash' } },
            ]),
        ).not.toThrow();

        expect(() =>
            assertNoPlaintextHintTopics([
                { topic: 'config.settings', policy: { hintKeys: 'plain' } },
            ]),
        ).toThrow(/config\.settings.*plain/s);
    });

    it('the base topic table passes the assertion', () => {
        expect(() => assertNoPlaintextHintTopics(baseTopicDefinitions(['mesh_abc']))).not.toThrow();
    });
});

describe('defaultBeaconTopicScope — metadata class only (§7.1.2)', () => {
    it('includes fleet.status and mesh events, excludes content-class topics', () => {
        const scope = defaultBeaconTopicScope({
            [FLEET_STATUS_TOPIC]: {},
            [meshEventsTopic('mesh_abc123')]: {},
            [ASSISTANT_JOURNAL_TOPIC]: {},
            [sessionTranscriptTopic('sess-1')]: {},
            'config.settings': {},
        });

        expect(scope.sort()).toEqual([FLEET_STATUS_TOPIC, meshEventsTopic('mesh_abc123')].sort());
        // The content-class transcript topic name is the one §7.1.4 calls a
        // case-by-case decision — it must not ride the DEFAULT scope.
        expect(scope).not.toContain(sessionTranscriptTopic('sess-1'));
    });
});

describe('resolveBeaconMode', () => {
    it('defaults on, respects an explicit off, and treats a typo as on', () => {
        expect(resolveBeaconMode({})).toBe('on');
        expect(resolveBeaconMode({ [BEACON_ENV]: '' })).toBe('on');
        expect(resolveBeaconMode({ [BEACON_ENV]: 'off' })).toBe('off');
        expect(resolveBeaconMode({ [BEACON_ENV]: ' OFF ' })).toBe('off');
        expect(resolveBeaconMode({ [BEACON_ENV]: 'on' })).toBe('on');
        // Advisory, content-free, no read path: an unrecognized value keeps the
        // feature alive rather than silently killing it. See the doc comment.
        expect(resolveBeaconMode({ [BEACON_ENV]: 'shadow' })).toBe('on');
    });
});

describe('armBeacon — lifecycle against a real node', () => {
    let dir: string;
    let handle: SeqscribeNodeHandle | null = null;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'adhdev-beacon-'));
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

    it('pushes a projected report on arm and requests the metadata scope', async () => {
        const node = open();
        const fake = makeFakeTransport();

        const beacon = armBeacon(node, fake.transport, { env: {} });
        expect(beacon).not.toBeNull();
        await settle();

        expect(fake.puts.length).toBeGreaterThanOrEqual(1);
        const report = fake.puts[0]!;
        expect(report.node).toBe(node.writerId);
        expect(Object.keys(report).sort()).toEqual(['at', 'node', 'vectors']);
        expect(report).not.toHaveProperty('hints');

        // GET rode the same push and asked only about metadata-class topics.
        expect(fake.gets.length).toBeGreaterThanOrEqual(1);
        for (const topic of fake.gets[0]!) {
            expect(topic === FLEET_STATUS_TOPIC || topic.startsWith('mesh.')).toBe(true);
        }

        expect(beacon!.counters().put).toBeGreaterThanOrEqual(1);
        beacon!.stop();
    });

    it('★env gate off = complete inaction: no arm, no push', async () => {
        const node = open();
        const fake = makeFakeTransport();

        const beacon = armBeacon(node, fake.transport, { env: { [BEACON_ENV]: 'off' } });
        await settle();

        expect(beacon).toBeNull();
        expect(fake.puts).toEqual([]);
        expect(fake.gets).toEqual([]);
    });

    it('★UPSTREAM DEFECT PIN: BeaconHub.stopped is a one-way latch, so a re-arm is silent forever', async () => {
        // This is the reason the cloud wiring arms ONCE and re-seeds with
        // pushNow() instead of re-arming per reconnect. `BeaconHub.stop()` sets
        // `stopped = true` and `start()` never clears it, so the second arm
        // accepts the call, returns a healthy-looking handle, and never pushes.
        //
        // Pinned as a test rather than left as a comment because the failure is
        // SILENT SUCCESS: without this, a future "simplification" back to
        // stop/re-arm would pass review, log "beacon armed" every epoch, and
        // report an empty board forever. If upstream fixes the latch this test
        // goes red — which is the correct signal to revisit the workaround.
        const node = open();
        const fake = makeFakeTransport();

        const first = armBeacon(node, fake.transport, { env: {} });
        await settle();
        const afterFirst = fake.puts.length;
        expect(afterFirst).toBeGreaterThanOrEqual(1);

        // A double arm without stopping is a library `misuse` throw.
        expect(() => armBeacon(node, fake.transport, { env: {} })).toThrow();

        first!.stop();
        const second = armBeacon(node, fake.transport, { env: {} });
        await settle();

        expect(second).not.toBeNull();
        expect(fake.puts.length).toBe(afterFirst); // ← the defect: no new push
        second!.stop();
    });

    it('pushNow() re-seeds the board across a reconnect without re-arming', async () => {
        const node = open();
        const fake = makeFakeTransport();

        const beacon = armBeacon(node, fake.transport, { env: {} });
        await settle();
        const afterArm = fake.puts.length;
        const getsAfterArm = fake.gets.length;

        // What the cloud host does on the second and later authenticated epochs.
        await beacon!.pushNow();

        expect(fake.puts.length).toBe(afterArm + 1);
        expect(fake.gets.length).toBe(getsAfterArm + 1);
        // The re-seeded report is the same projected shape, not a raw one.
        const latest = fake.puts.at(-1)!;
        expect(Object.keys(latest).sort()).toEqual(['at', 'node', 'vectors']);
        expect(latest.node).toBe(node.writerId);

        beacon!.stop();
    });

    it('pushNow() after stop is a no-op, and a failing transport does not throw out of it', async () => {
        const node = open();
        const failing = makeFakeTransport({ failPut: true });
        const beacon = armBeacon(node, failing.transport, { env: {} });
        await settle();

        // Rejection is swallowed like the library's own push().catch().
        await expect(beacon!.pushNow()).resolves.toBeUndefined();
        expect(beacon!.counters().putFailed).toBeGreaterThanOrEqual(2);

        beacon!.stop();
        const before = beacon!.counters();
        await beacon!.pushNow();
        expect(beacon!.counters()).toEqual(before);
    });

    it('feeds inbound peer reports through the projection before staleness sees them', async () => {
        const node = open();
        const SECRET = 'peer chat content that must not land';
        const fake = makeFakeTransport({
            board: [
                {
                    node: 'adhdev-peerpeerpeer01',
                    at: '2026-08-28T00:00:00.000Z',
                    lastAgentMessage: SECRET,
                    vectors: {
                        [FLEET_STATUS_TOPIC]: {
                            writers: { 'adhdev-peerpeerpeer01': { contig: 42, chain: CHAIN_A } },
                        },
                    },
                    hints: { 'config.settings': { 'security.x': ['adhdev-peerpeerpeer01', 1] } },
                },
            ],
        });

        const beacon = armBeacon(node, fake.transport, { env: {} });
        await settle();

        // The peer's position landed — staleness() sees a writer 42 ahead of our 0.
        const staleness = node.node.staleness(FLEET_STATUS_TOPIC);
        expect(staleness.behind['adhdev-peerpeerpeer01']).toBe(42);
        // …and nothing the peer smuggled came with it.
        expect(JSON.stringify(staleness)).not.toContain(SECRET);
        expect(staleness.keyStale).toBeUndefined();

        expect(beacon!.counters().get).toBeGreaterThanOrEqual(1);
        beacon!.stop();
    });

    it('counts a truncated board without treating it as an error', async () => {
        const node = open();
        const fake = makeFakeTransport();
        const transport: BeaconHostTransport = {
            put: fake.transport.put,
            async get(topics) {
                await fake.transport.get(topics);
                return { reports: [], truncated: 3 };
            },
        };

        const beacon = armBeacon(node, transport, { env: {} });
        await settle();

        expect(beacon!.counters().truncated).toBe(3);
        expect(beacon!.counters().getFailed).toBe(0);
        beacon!.stop();
    });

    it('★transport failure is counted and swallowed, never propagated', async () => {
        const node = open();
        const failing = makeFakeTransport({ failPut: true });

        const beacon = armBeacon(node, failing.transport, { env: {} });
        // The library's push() chains get() off put(), so a failing put means
        // get() is never reached — and nothing escapes into the daemon.
        await expect(settle()).resolves.toBeUndefined();

        expect(beacon!.counters().putFailed).toBeGreaterThanOrEqual(1);
        expect(beacon!.counters().put).toBe(0);
        beacon!.stop();
    });

    it('node.close() stops an armed beacon even when nobody holds its handle', async () => {
        const node = open();
        const fake = makeFakeTransport();
        armBeacon(node, fake.transport, { env: {} });
        await settle();
        const before = fake.puts.length;

        await node.close();
        handle = null;
        await settle();

        // No push after close, and no throw from the teardown path.
        expect(fake.puts.length).toBe(before);
    });
});
