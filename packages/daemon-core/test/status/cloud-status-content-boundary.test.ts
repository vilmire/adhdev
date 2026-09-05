import { describe, expect, it } from 'vitest';
import { buildCloudStatusReportPayload } from '../../src/status/reporter.js';

/**
 * The server WS control plane must never carry user chat content.
 *
 * ADHDev is P2P-first: chat, commands, screenshots and file ops travel over the
 * WebRTC DataChannel; the server sees auth, signaling and lightweight routing
 * metadata only. `buildCloudStatusReportPayload` IS that boundary for the status
 * path, so these tests are the regression guard for it.
 */

/** A session carrying every content-bearing field a real snapshot can hold. */
function sessionWithContent(overrides: Record<string, unknown> = {}) {
    return {
        id: 'sess-1',
        parentId: null,
        providerType: 'claude-cli',
        providerName: 'Claude Code',
        kind: 'agent',
        transport: 'pty',
        status: 'generating',
        workspace: '/Users/someone/projects/my-app',
        cdpConnected: false,
        surfaceHidden: false,
        muted: false,

        // ── content — none of this may cross to the server ──
        title: 'why is my auth token expiring early',
        lastMessagePreview: 'The bug is in refreshToken() — it compares seconds to ms',
        lastMessageRole: 'assistant',
        lastMessageAt: 1_700_000_000_000,
        lastMessageHash: 'deadbeef',
        summaryMetadata: { items: [{ id: 'branch', value: 'fix/auth-token-ttl' }] },
        runtimeDisplayName: 'my-app — auth refactor',
        runtimeWorkspaceLabel: 'my-app (auth)',
        activeChat: { messages: [{ role: 'user', content: 'secret prompt text' }] },
        settings: { executablePath: '/opt/homebrew/bin/claude' },
        git: { branch: 'fix/auth-token-ttl', dirty: true },
        controlValues: { model: 'opus' },
        providerControls: [{ id: 'model', label: 'Model' }],
        meshQueueStats: {
            pending: 1,
            assigned: 0,
            completed: 0,
            failed: 0,
            activeAssignments: [{ id: 'a1', message: 'investigate the token TTL bug' }],
        },
        ...overrides,
    };
}

const CONTENT_FIELDS = [
    'title',
    'lastMessagePreview',
    'lastMessageRole',
    'lastMessageAt',
    'lastMessageHash',
    'summaryMetadata',
    'runtimeDisplayName',
    'runtimeWorkspaceLabel',
    'activeChat',
    'settings',
    'git',
    'controlValues',
    'providerControls',
    'meshQueueStats',
];

describe('buildCloudStatusReportPayload — server WS content boundary', () => {
    it('omits every content-bearing field from the server payload', () => {
        const [session] = buildCloudStatusReportPayload([sessionWithContent()], undefined, 1).sessions;

        for (const field of CONTENT_FIELDS) {
            expect(session, `"${field}" must not be sent to the server`).not.toHaveProperty(field);
        }
    });

    it('never serializes chat text anywhere in the payload', () => {
        // Belt-and-braces: no nesting, rename, or stray passthrough can smuggle it.
        const payload = buildCloudStatusReportPayload([sessionWithContent()], undefined, 1);
        const wire = JSON.stringify(payload);

        for (const secret of [
            'why is my auth token expiring early',
            'The bug is in refreshToken()',
            'secret prompt text',
            'investigate the token TTL bug',
            'my-app — auth refactor',
            'fix/auth-token-ttl',
        ]) {
            expect(wire, `payload leaked: ${secret}`).not.toContain(secret);
        }
    });

    it('keeps the routing metadata the server needs', () => {
        const [session] = buildCloudStatusReportPayload([sessionWithContent()], undefined, 1).sessions;

        expect(session).toEqual({
            id: 'sess-1',
            parentId: null,
            providerType: 'claude-cli',
            providerName: 'Claude Code',
            kind: 'agent',
            transport: 'pty',
            status: 'generating',
            workspace: '/Users/someone/projects/my-app',
            cdpConnected: false,
            surfaceHidden: false,
            muted: false,
        });
    });

    it('forwards surfaceHidden and muted so the server can gate push notifications', () => {
        const [session] = buildCloudStatusReportPayload(
            [sessionWithContent({ surfaceHidden: true, muted: true })],
            undefined,
            1,
        ).sessions;

        expect(session.surfaceHidden).toBe(true);
        expect(session.muted).toBe(true);
    });

    it('is an allow-list — an unknown future field is dropped, not forwarded', () => {
        // The regression this guards: a deny-list would forward anything new.
        const [session] = buildCloudStatusReportPayload(
            [sessionWithContent({ someFutureContentField: 'a brand new leak' })],
            undefined,
            1,
        ).sessions;

        expect(session).not.toHaveProperty('someFutureContentField');
        expect(JSON.stringify(session)).not.toContain('a brand new leak');
    });

    it('falls back to providerType when providerName is absent', () => {
        const [session] = buildCloudStatusReportPayload(
            [sessionWithContent({ providerName: undefined })],
            undefined,
            1,
        ).sessions;

        expect(session.providerName).toBe('claude-cli');
    });

    it('normalizes missing parentId/workspace to null', () => {
        const [session] = buildCloudStatusReportPayload(
            [sessionWithContent({ parentId: undefined, workspace: undefined })],
            undefined,
            1,
        ).sessions;

        expect(session.parentId).toBeNull();
        expect(session.workspace).toBeNull();
    });

    it('forwards p2p state and timestamp', () => {
        const p2p = { available: true, state: 'connected', peers: 2, screenshotActive: false } as const;
        const payload = buildCloudStatusReportPayload([], p2p, 4242);

        expect(payload.p2p).toEqual(p2p);
        expect(payload.timestamp).toBe(4242);
    });

    it('projects p2p through an allow-list, dropping unknown fields', () => {
        const payload = buildCloudStatusReportPayload([], {
            available: true,
            state: 'connected',
            peers: 1,
            screenshotActive: false,
            // A future/tampered daemon field that is NOT on the allow-list.
            peerAddresses: ['203.0.113.7:51820'],
            lastPeerNote: 'freeform text that must never reach the server',
        } as any, 1);

        expect(payload.p2p).not.toHaveProperty('peerAddresses');
        expect(payload.p2p).not.toHaveProperty('lastPeerNote');
    });
});

describe('buildCloudStatusReportPayload — p2p transport telemetry', () => {
    const base = { available: true, state: 'connected', peers: 3, screenshotActive: false };

    it('forwards direct/relay transport counters', () => {
        const payload = buildCloudStatusReportPayload([], {
            ...base,
            direct: 2,
            relay: 1,
            unknownTransport: 0,
            directTotal: 7,
            relayTotal: 4,
        } as any, 1);

        expect(payload.p2p).toMatchObject({
            direct: 2,
            relay: 1,
            unknownTransport: 0,
            directTotal: 7,
            relayTotal: 4,
        });
    });

    it('preserves a genuine zero rather than dropping it', () => {
        // "0 relay connections" is a real measurement and must be distinguishable
        // from "this daemon does not report transport at all".
        const payload = buildCloudStatusReportPayload([], { ...base, relay: 0, relayTotal: 0 } as any, 1);

        expect(payload.p2p?.relay).toBe(0);
        expect(payload.p2p?.relayTotal).toBe(0);
    });

    it('omits counters entirely when the daemon does not report them', () => {
        const payload = buildCloudStatusReportPayload([], base, 1);

        expect(payload.p2p).not.toHaveProperty('direct');
        expect(payload.p2p).not.toHaveProperty('relay');
        expect(payload.p2p).not.toHaveProperty('directTotal');
        expect(payload.p2p).not.toHaveProperty('relayTotal');
    });

    it('rejects malformed or negative counters instead of forwarding them', () => {
        const payload = buildCloudStatusReportPayload([], {
            ...base,
            direct: -1,
            relay: Number.NaN,
            directTotal: 'lots',
            relayTotal: null,
        } as any, 1);

        expect(payload.p2p).not.toHaveProperty('direct');
        expect(payload.p2p).not.toHaveProperty('relay');
        expect(payload.p2p).not.toHaveProperty('directTotal');
        expect(payload.p2p).not.toHaveProperty('relayTotal');
    });

    it('carries no peer identifiers — counters only', () => {
        const payload = buildCloudStatusReportPayload([], {
            ...base, direct: 1, relay: 1, directTotal: 1, relayTotal: 1,
        } as any, 1);

        for (const value of Object.values(payload.p2p ?? {})) {
            expect(['number', 'boolean', 'string']).toContain(typeof value);
        }
        // `state` is the only string, and it is a fixed enum-ish connection state.
        expect(typeof payload.p2p?.state).toBe('string');
    });

    it('tolerates a non-array or malformed session list', () => {
        expect(buildCloudStatusReportPayload(undefined, undefined, 1).sessions).toEqual([]);
        expect(buildCloudStatusReportPayload(null, undefined, 1).sessions).toEqual([]);
        expect(() => buildCloudStatusReportPayload([null, undefined], undefined, 1)).not.toThrow();
    });
});

/**
 * seqscribe replication health (design §1.5) rides the same status frame, so it
 * sits behind the same allow-list.
 *
 * The specific leak this guards: seqscribe's own `stats()` is keyed BY TOPIC,
 * and ADHDev topic names embed identifiers — `session.<sessionId>.transcript`,
 * `mesh.<meshId>.events`. Forwarding that map would publish the fleet's session
 * and mesh inventory to the server on every heartbeat. Only aggregates cross.
 */
describe('cloud status seqscribe boundary', () => {
    const healthy = {
        topics: 4,
        peers: 2,
        peersReady: 2,
        pendingBucket: 0,
        consumerLagBucket: 1,
        queueBucket: 0,
        fgenAgeBucket: 1,
        quarantined: false,
        authority: true,
        dualWrite: false,
        dualWriteFailedBucket: 0,
        dualWriteDroppedBucket: 0,
        dualWriteBackfilledBucket: 0,
        parityMismatchBucket: 0,
        parityRan: false,
        parityMissingInShadowBucket: 0,
        parityExtraInShadowBucket: 0,
        parityFieldMismatchBucket: 0,
        transcriptPublish: false,
        transcriptPublishedBucket: 0,
        transcriptPublishFailedBucket: 0,
        transcriptDedupedBucket: 0,
        transcriptOversizedBucket: 0,
        transcriptDroppedBucket: 0,
        transcriptParityRan: false,
        transcriptParityMismatchBucket: 0,
    };

    it('omits the field entirely when no seqscribe node is running', () => {
        // Absent must stay distinguishable from "a healthy idle node", so this
        // is omitted rather than zero-filled.
        expect(buildCloudStatusReportPayload([], undefined, 1)).not.toHaveProperty('seqscribe');
        expect(buildCloudStatusReportPayload([], undefined, 1, undefined)).not.toHaveProperty('seqscribe');
    });

    it('forwards the aggregate counters', () => {
        const payload = buildCloudStatusReportPayload([], undefined, 1, healthy as any);
        expect(payload.seqscribe).toEqual(healthy);
    });

    it('drops topic names, peer ids and any other unlisted field', () => {
        const payload = buildCloudStatusReportPayload([], undefined, 1, {
            ...healthy,
            // The shapes a careless widening would forward:
            topicNames: ['session.sess-1.transcript', 'mesh.mesh_abc.events'],
            perTopic: { 'session.sess-1.transcript': { pending: 3 } },
            peerIds: ['peer-a', 'peer-b'],
            writerId: 'adhdev-0123456789abcdef',
            lastEntryPayload: { text: 'secret prompt text' },
        } as any);

        expect(payload.seqscribe).toEqual(healthy);
        for (const leaked of ['topicNames', 'perTopic', 'peerIds', 'writerId', 'lastEntryPayload']) {
            expect(payload.seqscribe).not.toHaveProperty(leaked);
        }
    });

    it('carries only numbers and booleans — never a string', () => {
        const payload = buildCloudStatusReportPayload([], undefined, 1, healthy as any);
        for (const value of Object.values(payload.seqscribe ?? {})) {
            expect(['number', 'boolean']).toContain(typeof value);
        }
    });

    /**
     * `Object.values` above only walks the TOP level. If a future field were
     * shaped like `Record<string, number>` (e.g. a per-key sync counter), every
     * value it holds would still be a number and the assertion above would pass
     * — while the object's own KEYS could be session ids, mesh ids, or setting
     * names smuggled into the wire payload. This recurses into any nested plain
     * object and asserts its keys are drawn from the fixed field allow-list
     * (i.e. no nested object should exist at all today), so a dynamic-keyed
     * field trips this test instead of silently passing.
     */
    it('never carries an object whose keys are dynamic identifiers, not fixed field names', () => {
        const payload = buildCloudStatusReportPayload([], undefined, 1, healthy as any);
        const seqscribe = payload.seqscribe ?? {};
        const allowedKeys = new Set(Object.keys(healthy));

        function assertNoDynamicKeys(value: unknown, path: string): void {
            if (value === null || typeof value !== 'object') return;
            for (const key of Object.keys(value as Record<string, unknown>)) {
                expect(allowedKeys, `unlisted key "${path}.${key}" — object keys must not carry dynamic identifiers`).toContain(key);
                assertNoDynamicKeys((value as Record<string, unknown>)[key], `${path}.${key}`);
            }
        }

        assertNoDynamicKeys(seqscribe, 'seqscribe');
    });

    it('coerces malformed counters rather than emitting NaN', () => {
        const payload = buildCloudStatusReportPayload([], undefined, 1, {
            topics: Number.NaN,
            peers: -3,
            peersReady: 'two',
            pendingBucket: null,
            consumerLagBucket: 2.7,
            queueBucket: undefined,
            fgenAgeBucket: Infinity,
            quarantined: 'yes',
            authority: 1,
        } as any);

        expect(payload.seqscribe).toEqual({
            topics: 0,
            peers: 0,
            peersReady: 0,
            pendingBucket: 0,
            consumerLagBucket: 2,
            queueBucket: 0,
            fgenAgeBucket: 0,
            // Non-boolean truthy values must not become `true` — only a real
            // boolean says the fleet secret is configured.
            quarantined: false,
            authority: false,
            // Absent Stage 2+3 input coerces to inactive/zero, same discipline
            // as the malformed counters above.
            dualWrite: false,
            dualWriteFailedBucket: 0,
            dualWriteDroppedBucket: 0,
            dualWriteBackfilledBucket: 0,
            parityMismatchBucket: 0,
            parityRan: false,
            parityMissingInShadowBucket: 0,
            parityExtraInShadowBucket: 0,
            parityFieldMismatchBucket: 0,
            transcriptPublish: false,
            transcriptPublishedBucket: 0,
            transcriptPublishFailedBucket: 0,
            transcriptDedupedBucket: 0,
            transcriptOversizedBucket: 0,
            transcriptDroppedBucket: 0,
            transcriptParityRan: false,
            transcriptParityMismatchBucket: 0,
        });
    });

    /**
     * The LOCAL-ONLY replication diagnostics (library P22/P24) that
     * `get_status_metadata` carries and the server must never see.
     *
     * `syncHotspots` is the dangerous one: it pairs a TOPIC NAME — which embeds
     * a session or mesh id — with a PEER ID, which is exactly the fleet-shape
     * leak the rest of this file exists to prevent. `throughput` is raw
     * unbucketed counters, which would additionally defeat the status-frame
     * dedup and turn an idle daemon into a constant transmitter.
     *
     * They are safe only because `buildCloudSeqscribeSummary` is a fixed-key
     * ALLOW-LIST. This test is what keeps it that way: rewriting it as a
     * deny-list, or adding these keys to the forward list, turns it red.
     */
    it('never forwards the local-only P22/P24 diagnostics', () => {
        const payload = buildCloudStatusReportPayload([], undefined, 1, {
            ...healthy,
            applyRejects: 17,
            stalledStreams: 4,
            throughput: {
                intervalMs: 60_000,
                servedEntries: 250,
                servedBytes: 1_048_576,
                appliedEntries: 250,
                appliedBytes: 1_048_576,
                wantRoundsRequested: 12,
                wantRoundsServed: 12,
            },
            syncHotspots: [
                { topic: 'session.sess-1.transcript', peerId: 'peer-a', bytes: 1_048_576 },
                { topic: 'mesh.mesh_abc.events', peerId: 'peer-b', bytes: 524_288 },
            ],
            // Stage 4A read-path routing. Local-only for the dedup reason
            // rather than the content one: these are RAW monotonic counters, so
            // forwarding them would make every status frame unique and turn an
            // idle daemon into a constant transmitter.
            readRouting: {
                fromReplica: 412,
                fromLedger: 9,
                fallbacks: { consumer_lag: 7, parity_mismatch: 2 },
            },
            // §5.6 gate instrumentation: the RAW, undecimated transcript parity
            // counters `get_status_metadata` serves so an observer can tell a
            // clean `persistentMismatches: 0` from an UNDECIDED one. Local-only
            // for the dedup reason (raw monotonic counters) — the bucketed
            // `transcriptParity*Bucket` fields remain the cloud-facing surface.
            transcriptParityDetail: {
                runs: 9, compared: 9, mismatches: 3, persistentMismatches: 1,
                missingCompleteRevision: 2, fieldMismatch: 1, extraMessage: 0,
                wrongSession: 0, wrongOwner: 0, digestMismatch: 0,
                sessionsObserved: 4, sessionsRepeated: 3,
                pendingMissingRevisits: 2, pendingMissingOpen: 1,
                since: 1_700_000_000_000, uptimeMs: 3_600_000,
            },
        } as any);

        expect(payload.seqscribe).toEqual(healthy);
        for (const local of [
            'applyRejects',
            'stalledStreams',
            'throughput',
            'syncHotspots',
            'readRouting',
            'transcriptParityDetail',
        ]) {
            expect(payload.seqscribe).not.toHaveProperty(local);
        }
        // Belt and braces: no identifier from the hotspots survives anywhere in
        // the serialized frame, whatever shape a future refactor gives it.
        const wire = JSON.stringify(payload);
        expect(wire).not.toContain('sess-1');
        expect(wire).not.toContain('mesh_abc');
        expect(wire).not.toContain('peer-a');
        // The raw parity detail must not survive under ANY key a future
        // refactor might rename it to: `since` is a wall-clock ms stamp, unique
        // enough that finding it anywhere in the frame means the block leaked.
        expect(wire).not.toContain('1700000000000');
        expect(wire).not.toContain('sessionsRepeated');
        expect(wire).not.toContain('pendingMissingRevisits');
    });
});

/**
 * ★Beacon diagnostics must not reach the server status path (mission b60d70b8).
 *
 * This is the subtlest boundary in the seqscribe integration, because the answer
 * is "yes" on one path and "no" on another:
 *
 *   - CLAUDE.md's approved "Beacon vector exception" (design §7.1.4, D10) lets
 *     TOPIC NAMES reach the server on the BEACON BOARD path — the daemon's
 *     `beacon_vectors` PUT/GET frames. "Which topic is how far ahead" is the
 *     feature; erasing the topic axis leaves nothing.
 *   - It does NOT widen the STATUS path. `seqscribe/stats.ts` still excludes
 *     topic names outright there, because aggregates alone are sufficient.
 *
 * The consumer surface produces a per-topic, per-peer object — exactly the
 * shape the status path forbids — and puts it on `StatusReportPayload` (the P2P
 * rich payload). That is safe only because the SERVER frame is built by
 * `buildCloudStatusReportPayload` from a different input, through a fixed-key
 * allow-list. These tests are what keep that true: adding `beacon` to
 * `buildCloudSeqscribeSummary`, or rewriting either projection as a deny-list,
 * turns them red.
 */
describe('★beacon diagnostics never reach the server status frame', () => {
    const healthy = {
        topics: 4, peers: 2, peersReady: 2, pendingBucket: 0, consumerLagBucket: 0,
        queueBucket: 0, fgenAgeBucket: 0, quarantined: false, authority: true,
        dualWrite: false, dualWriteFailedBucket: 0, dualWriteDroppedBucket: 0,
        dualWriteBackfilledBucket: 0, parityMismatchBucket: 0, parityRan: false,
        parityMissingInShadowBucket: 0, parityExtraInShadowBucket: 0, parityFieldMismatchBucket: 0,
        transcriptPublish: false, transcriptPublishedBucket: 0, transcriptPublishFailedBucket: 0,
        transcriptDedupedBucket: 0, transcriptOversizedBucket: 0, transcriptDroppedBucket: 0,
        transcriptParityRan: false, transcriptParityMismatchBucket: 0,
    };

    /** A realistic diagnostics object, carrying every identifier class it legitimately holds. */
    const beacon = {
        node: 'adhdev-0123456789abcdef',
        peers: [
            {
                node: 'adhdev-fedcba9876543210',
                behind: 42,
                topics: [
                    { node: 'adhdev-fedcba9876543210', topic: 'mesh.mesh_abc.events', behind: 42 },
                    { node: 'adhdev-fedcba9876543210', topic: 'session.sess-1.transcript', behind: 7 },
                ],
                lastSeen: '2026-08-28T00:00:00.000Z',
            },
        ],
        maxBehind: 42,
        soleCopy: [
            {
                topic: 'session.sess-1.transcript',
                writer: 'adhdev-0123456789abcdef',
                localSeq: 20, bestPeerSeq: 12, unreplicated: 8, verdict: 'sole-copy',
            },
        ],
        truncated: 0,
        soleCopyDeferred: false,
        topicScope: ['fleet.status', 'mesh.mesh_abc.events'],
        boardAt: '2026-08-28T00:00:00.000Z',
        keyStaleAdvisory: [],
    };

    it('the server payload has no `beacon` field even when one is planted on the input', () => {
        const payload = buildCloudStatusReportPayload([], undefined, 1, {
            ...healthy,
            beacon,
        } as any);

        expect(payload).not.toHaveProperty('beacon');
        expect(payload.seqscribe).not.toHaveProperty('beacon');
        expect(payload.seqscribe).toEqual(healthy);
    });

    it('★CANARY: no topic name, peer writer id or sole-copy verdict is serialized anywhere', () => {
        const payload = buildCloudStatusReportPayload([], undefined, 1, {
            ...healthy,
            beacon,
            // The flatter shapes a careless widening might take instead.
            beaconMaxBehind: 42,
            beaconTopics: ['mesh.mesh_abc.events', 'session.sess-1.transcript'],
            beaconSoleCopy: beacon.soleCopy,
        } as any);
        const wire = JSON.stringify(payload);

        for (const leaked of [
            'mesh.mesh_abc.events',      // mesh id in a topic name
            'session.sess-1.transcript', // ★ a CONTENT-class topic's name
            'mesh_abc',
            'sess-1',
            'adhdev-fedcba9876543210',   // peer writer id
            'adhdev-0123456789abcdef',   // our own writer id
            'sole-copy',
            'fleet.status',
        ]) {
            expect(wire, `server frame leaked: ${leaked}`).not.toContain(leaked);
        }
        for (const key of ['beacon', 'beaconMaxBehind', 'beaconTopics', 'beaconSoleCopy']) {
            expect(payload.seqscribe).not.toHaveProperty(key);
        }
    });

    it('the P2P payload shape and the server payload shape are genuinely different objects', () => {
        // The reason the field above is safe on `StatusReportPayload`: the
        // server frame is not a projection OF that object — it is built
        // separately from the session list. A regression that started deriving
        // the server frame from the P2P payload would make `beacon` reachable,
        // so this pins the two as independent.
        const payload = buildCloudStatusReportPayload(
            [{ id: 's1', providerType: 'claude-cli', beacon } as any],
            undefined,
            1,
            healthy as any,
        );

        expect(payload.sessions[0]).not.toHaveProperty('beacon');
        expect(JSON.stringify(payload)).not.toContain('adhdev-fedcba9876543210');
    });
});
