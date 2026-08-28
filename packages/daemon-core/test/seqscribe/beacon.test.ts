/**
 * seqscribe Beacon — daemon-side transport (design §7.1 Stage D).
 *
 * ── What this file proves ───────────────────────────────────────────────────
 *  (a) CONTENT BOUNDARY. `projectBeaconReport` is an ALLOW-LIST: free text,
 *      entry payloads and malformed/plaintext hints planted anywhere in a
 *      report do not survive into what the transport is handed. This mirrors
 *      the server-side canary
 *      (packages/server/test/beacon-board-content-boundary.test.ts) on the
 *      daemon side, which is the layer that decides what leaves the machine.
 *  (b) HINTS ARE HASH-ONLY, ENFORCED. `hintKeys` is a per-TOPIC POLICY the
 *      library reads at push time, not a per-call option — so the enforcement
 *      point is the topic table, and `assertNoPlaintextHintTopics` is what makes
 *      opting a topic into `'plain'` a loud failure instead of a one-word diff.
 *      Also pinned: only the register-class `config.settings` topic opts into
 *      hash mode; append-class topics stay out because they need host supply.
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
import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    armBeacon,
    assertNoPlaintextHintTopics,
    BEACON_ENV,
    defaultBeaconTopicScope,
    MAX_BEACON_GET_QUERIES,
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
    CONFIG_SETTINGS_TOPIC,
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
        // The plaintext hint was dropped wholesale — key name included.
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

describe('hints are hash-only and register-scoped', () => {
    it('★opts in config.settings only; append-class topics remain host-path-only', () => {
        const defs = baseTopicDefinitions(['mesh_abc']);
        expect(defs.find((def) => def.topic === CONFIG_SETTINGS_TOPIC)?.policy.hintKeys).toBe('hash');
        for (const def of defs.filter((definition) => definition.policy.kind === 'append')) {
            // Upstream P27 cannot derive per-key hints for append topics; ADHDev
            // supplies no host hints callback, so opting these in would do nothing.
            expect(def.policy.hintKeys).toBeUndefined();
        }
    });

    it('admits only 64-hex keys with exact content-free [writer, seq] values', () => {
        const hash = 'b'.repeat(64);
        const projected = projectBeaconReport({
            node: 'adhdev-0123456789abcdef',
            at: '2026-08-28T00:00:00.000Z',
            vectors: {},
            hints: {
                [CONFIG_SETTINGS_TOPIC]: {
                    [hash]: ['adhdev-aaaaaaaaaaaaaaaa', 4],
                    'security.autoApprove': ['adhdev-aaaaaaaaaaaaaaaa', 5],
                    ['c'.repeat(64)]: ['writer id with prose', 6],
                    ['d'.repeat(64)]: ['adhdev-aaaaaaaaaaaaaaaa', 7, 'CANARY_EXTRA'],
                },
            },
        });

        expect(projected?.hints).toEqual({
            [CONFIG_SETTINGS_TOPIC]: { [hash]: ['adhdev-aaaaaaaaaaaaaaaa', 4] },
        });
        expect(JSON.stringify(projected)).not.toContain('security.autoApprove');
        expect(JSON.stringify(projected)).not.toContain('CANARY_EXTRA');
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

    function open(
        constants?: { BEACON_DEBOUNCE_MS: number },
        withAuthority = false,
    ): SeqscribeNodeHandle {
        handle = openSeqscribeNode({
            dbPath: join(dir, 'seqscribe.db'),
            meshIds: ['mesh_abc123'],
            env: withAuthority ? { ADHDEV_SEQSCRIBE_FLEET_SECRET: 'beacon-test-secret' } : {},
            storedFleetSecret: null,
            ...(constants ? { constants } : {}),
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

    it('★P27: the register fold emits only the SHA-256 key and GET requests its topic', async () => {
        const node = open({ BEACON_DEBOUNCE_MS: 10 }, true);
        const rawKey = 'ui.theme';
        const fake = makeFakeTransport();

        const beacon = armBeacon(node, fake.transport, { env: {} });
        await settle();
        const entryId = await node.node.register(CONFIG_SETTINGS_TOPIC).set(rawKey, 'dark');
        await new Promise((resolve) => setTimeout(resolve, 25));
        await settle();

        const hash = createHash('sha256').update(rawKey, 'utf8').digest('hex');
        expect(fake.puts.at(-1)?.hints).toEqual({
            [CONFIG_SETTINGS_TOPIC]: { [hash]: [entryId[1], entryId[2]] },
        });
        expect(JSON.stringify(fake.puts.at(-1))).not.toContain(rawKey);
        expect(fake.gets.at(-1)).toContain(CONFIG_SETTINGS_TOPIC);
        expect(() => assertNoPlaintextHintTopics(node.topics)).not.toThrow();
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

    it('★UPSTREAM P28 PIN: stop → start restores the initial and append-triggered pushes', async () => {
        // P28 made stop() a reusable pause. Pin both the fresh initial push and
        // the append debounce: merely clearing the old latch for start() would
        // make the first assertion pass while leaving the hub silent afterward.
        const node = open({ BEACON_DEBOUNCE_MS: 10 });
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
        expect(fake.puts.length).toBe(afterFirst + 1); // start() initial push

        const afterRearm = fake.puts.length;
        await node.node
            .log(FLEET_STATUS_TOPIC)
            .append('adhdev.p28.rearm', { generation: 2 });
        await new Promise((r) => setTimeout(r, 25));
        await settle();

        expect(fake.puts.length).toBeGreaterThan(afterRearm); // debounce is live again
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

    it('seeds auth_ok reports through Stage D projection and preserves truncated', async () => {
        const node = open();
        const beacon = armBeacon(node, makeFakeTransport().transport, { env: {} });
        await settle();

        const SECRET = 'auth_ok canary prose must never reach known vectors';
        beacon!.seedKnownBoard({
            reports: [{
                node: 'adhdev-peerpeerpeer01',
                at: '2026-08-28T00:00:00.000Z',
                lastAgentMessage: SECRET,
                vectors: {
                    [FLEET_STATUS_TOPIC]: {
                        preview: SECRET,
                        writers: {
                            'adhdev-peerpeerpeer01': {
                                contig: 42,
                                chain: CHAIN_A,
                                payload: SECRET,
                            },
                        },
                    },
                },
                hints: { 'config.settings': { 'plaintext.canary': ['adhdev-peerpeerpeer01', 42] } },
            }],
            truncated: 2,
        });

        const staleness = node.node.staleness(FLEET_STATUS_TOPIC);
        expect(staleness.behind['adhdev-peerpeerpeer01']).toBe(42);
        expect(JSON.stringify(staleness)).not.toContain(SECRET);
        expect(staleness.keyStale).toBeUndefined();
        const diagnostics = beacon!.diagnostics();
        expect(diagnostics.truncated).toBe(2);
        expect(diagnostics.soleCopyDeferred).toBe(true);
        expect(beacon!.counters().truncated).toBe(2);
        beacon!.stop();
    });

    it('turns an inbound hash hint into a real keyStaleAdvisory value', async () => {
        const node = open(undefined, true);
        const keyHash = 'e'.repeat(64);
        const peer = 'adhdev-peerpeerpeer01';
        const fake = makeFakeTransport({
            board: [{
                node: peer,
                at: '2026-08-28T00:00:00.000Z',
                vectors: {
                    [CONFIG_SETTINGS_TOPIC]: {
                        writers: { [peer]: { contig: 4, chain: CHAIN_A } },
                    },
                },
                hints: { [CONFIG_SETTINGS_TOPIC]: { [keyHash]: [peer, 4] } },
            }],
        });

        const beacon = armBeacon(node, fake.transport, { env: {} });
        await settle();

        expect(fake.gets[0]).toContain(CONFIG_SETTINGS_TOPIC);
        expect(beacon!.diagnostics().keyStaleAdvisory).toEqual([{
            topic: CONFIG_SETTINGS_TOPIC,
            key: keyHash,
            latestKnown: [CONFIG_SETTINGS_TOPIC, peer, 4],
            haveLocally: false,
        }]);
        // ★No correctness gate is derived from the advisory (§5.7a).
        expect(beacon!.diagnostics()).not.toHaveProperty('writeBlocked');
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

    // ── Split-retry (design §7.1.2, owner-approved 2026-08-28) ────────────────
    //
    // These force a deterministic multi-topic scope via `topicScope`, since the
    // library-derived default scope only ever contains the topics this node
    // actually pushed to (single-topic in the tests above). A scriptable
    // transport keyed by the exact topic slice it was called with drives the
    // split/merge logic without needing a real oversized board.
    describe('GET topic-split retry', () => {
        const TOPICS4 = ['fleet.status', 'mesh.a.events', 'mesh.b.events', 'mesh.c.events'];

        /** A transport whose `get()` behavior is scripted per exact topic slice. */
        function makeScriptedTransport(
            script: Map<string, BeaconGetResponse>,
            opts: { onGet?: (topics: readonly string[]) => void } = {},
        ): { transport: BeaconHostTransport; calls: string[][] } {
            const calls: string[][] = [];
            return {
                calls,
                transport: {
                    async put(): Promise<void> {
                        /* not exercised in this suite */
                    },
                    async get(topics: readonly string[]): Promise<BeaconGetResponse> {
                        calls.push([...topics]);
                        opts.onGet?.(topics);
                        const key = [...topics].sort().join(',');
                        const res = script.get(key);
                        if (!res) throw new Error(`unscripted GET for topics=${key}`);
                        return res;
                    },
                },
            };
        }

        function reportFor(node: string, at: string, contig = 1): unknown {
            return {
                node,
                at,
                vectors: { 'fleet.status': { writers: { [node]: { contig, chain: CHAIN_A } } } },
            };
        }

        it('truncated=0 issues exactly one query — the unchanged fast path', async () => {
            const n = open();
            const script = new Map<string, BeaconGetResponse>([
                [
                    [...TOPICS4].sort().join(','),
                    { reports: [reportFor('adhdev-peer1', '2026-08-28T00:00:00.000Z')], truncated: 0 },
                ],
            ]);
            const { transport, calls } = makeScriptedTransport(script);

            const beacon = armBeacon(n, transport, { env: {}, topicScope: () => TOPICS4 });
            await settle();

            expect(calls.length).toBe(1);
            expect(calls[0]!.sort()).toEqual([...TOPICS4].sort());
            expect(beacon!.counters().get).toBe(1);
            expect(beacon!.counters().splitRetries).toBe(0);
            expect(beacon!.counters().truncated).toBe(0);
            beacon!.stop();
        });

        it('truncated>0 on a multi-topic scope bisects and merges peer reports by node', async () => {
            const n = open();
            const left = ['fleet.status', 'mesh.a.events'];
            const right = ['mesh.b.events', 'mesh.c.events'];
            const script = new Map<string, BeaconGetResponse>([
                [
                    [...TOPICS4].sort().join(','),
                    { reports: [], truncated: 2 }, // whole response didn't fit
                ],
                [
                    [...left].sort().join(','),
                    { reports: [reportFor('adhdev-peerA', '2026-08-28T00:00:00.000Z', 7)], truncated: 0 },
                ],
                [
                    [...right].sort().join(','),
                    { reports: [reportFor('adhdev-peerB', '2026-08-28T00:00:01.000Z', 12)], truncated: 0 },
                ],
            ]);
            const { transport, calls } = makeScriptedTransport(script);

            const beacon = armBeacon(n, transport, { env: {}, topicScope: () => TOPICS4 });
            await settle();

            // 1 initial + 2 split halves.
            expect(calls.length).toBe(3);
            expect(beacon!.counters().get).toBe(3);
            expect(beacon!.counters().splitRetries).toBe(1);
            // Both halves fit once split — nothing remains truncated.
            expect(beacon!.counters().truncated).toBe(0);

            // Both peers landed — one from each split half — proving the merge
            // unions across halves rather than keeping only one side.
            const staleness = n.node.staleness('fleet.status');
            expect(staleness.behind['adhdev-peerA']).toBe(7);
            expect(staleness.behind['adhdev-peerB']).toBe(12);
            beacon!.stop();
        });

        it('single-topic residual truncation surfaces as the last-resort backstop', async () => {
            const n = open();
            const SOLO = ['fleet.status'];
            const script = new Map<string, BeaconGetResponse>([
                [SOLO.join(','), { reports: [], truncated: 5 }],
            ]);
            const { transport, calls } = makeScriptedTransport(script);

            const beacon = armBeacon(n, transport, { env: {}, topicScope: () => SOLO });
            await settle();

            // topics.length <= 1 — no split attempted, even though truncated>0.
            expect(calls.length).toBe(1);
            expect(beacon!.counters().splitRetries).toBe(0);
            expect(beacon!.counters().truncated).toBe(5);
            beacon!.stop();
        });

        it('duplicate node across split halves keeps the report with the newer `at`', async () => {
            const n = open();
            const left = ['fleet.status', 'mesh.a.events'];
            const right = ['mesh.b.events', 'mesh.c.events'];
            // Same peer node on both halves, distinguishable by `contig` so the
            // survivor is unambiguous: if the merge kept the OLDER (left) report,
            // staleness() would read contig=1; if it kept the newer (right)
            // report, it reads contig=99. Duplication (both landing) is ruled out
            // by construction — `staleness()` has exactly one entry per peer.
            const older = {
                node: 'adhdev-same00000000',
                at: '2026-08-28T00:00:00.000Z',
                vectors: { 'fleet.status': { writers: { 'adhdev-same00000000': { contig: 1, chain: CHAIN_A } } } },
            };
            const newer = {
                node: 'adhdev-same00000000',
                at: '2026-08-28T00:00:05.000Z',
                vectors: { 'fleet.status': { writers: { 'adhdev-same00000000': { contig: 99, chain: CHAIN_B } } } },
            };
            const script = new Map<string, BeaconGetResponse>([
                [[...TOPICS4].sort().join(','), { reports: [], truncated: 1 }],
                [[...left].sort().join(','), { reports: [older], truncated: 0 }],
                [[...right].sort().join(','), { reports: [newer], truncated: 0 }],
            ]);
            const { transport } = makeScriptedTransport(script);

            const beacon = armBeacon(n, transport, { env: {}, topicScope: () => TOPICS4 });
            await settle();

            expect(beacon!.counters().truncated).toBe(0);
            const staleness = n.node.staleness('fleet.status');
            expect(staleness.behind['adhdev-same00000000']).toBe(99);
            beacon!.stop();
        });

        it('query cap stops recursion and exposes the residual as truncated', async () => {
            const n = open();
            // Every slice — no matter how small — reports truncated>0, forcing the
            // splitter to recurse until the query budget is exhausted rather than
            // stopping at a natural truncated=0 leaf.
            const calls: string[][] = [];
            const alwaysTruncated: BeaconHostTransport = {
                async put(): Promise<void> {},
                async get(topics: readonly string[]): Promise<BeaconGetResponse> {
                    calls.push([...topics]);
                    return { reports: [], truncated: topics.length };
                },
            };

            const manyTopics = Array.from({ length: 64 }, (_, i) => `mesh.t${i}.events`);
            const beacon = armBeacon(n, alwaysTruncated, { env: {}, topicScope: () => manyTopics });
            await settle();

            expect(calls.length).toBeLessThanOrEqual(MAX_BEACON_GET_QUERIES);
            expect(beacon!.counters().get).toBeLessThanOrEqual(MAX_BEACON_GET_QUERIES);
            // The cap was hit before every topic reached a truncated=0 leaf, so
            // some residual truncation must remain — the recursion did not run away.
            expect(beacon!.counters().truncated).toBeGreaterThan(0);
            beacon!.stop();
        });
    });
});
