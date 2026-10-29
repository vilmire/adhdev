import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MeshNodeFactsProviderQuota } from '@adhdev/mesh-shared';
import { DaemonCommandRouter } from '../../src/commands/router.js';
import { MESH_SENDER_DAEMON_ID_ARG } from '../../src/commands/mesh-sender.js';
import { saveMeshConfig } from '../../src/config/mesh-config-store.js';
import { getMesh } from '../../src/config/mesh-config.js';
import { MeshNodeGitStateStore } from '../../src/mesh/mesh-node-git-state.js';
import { MeshNodeStatePusher } from '../../src/mesh/mesh-node-state-pusher.js';
import { MeshNodeGitRefresher } from '../../src/mesh/mesh-node-git-refresher.js';
import { overlayMeshNodeGitObservations } from '../../src/commands/high-family/mesh-status-node-state.js';
import { evaluateProviderQuotaGate } from '../../src/mesh/mesh-quota-routing.js';
import { recordInlineMeshDirectGitTruth, persistNodeReporterPlatform } from '../../src/mesh/mesh-inline-mesh-cache.js';
import { cleanupTempDir } from '../helpers/temp-cleanup.js';

// Synthetic machine/account only. No CLI, credential, remote probe or live store.
const NOW = 1_900_000_000_000;
const MEMBER = 'daemon_mach_11111111111111111111111111111111';
const COORD = 'daemon_mach_22222222222222222222222222222222';
const PROVIDER = 'kimi';
const ACCOUNT = { version: 1, kind: 'account', key: 'a'.repeat(64) } as const;
const MESHES = ['mesh_quota_a', 'mesh_quota_b'];

function quota(sessionUsed: number | null, updatedAt = NOW - 1_000, provider = PROVIDER): MeshNodeFactsProviderQuota {
    return {
        provider, status: 'ok', updatedAt, error: null,
        session: sessionUsed === null ? null : { usedPercent: sessionUsed, windowMinutes: 300, resetsAt: NOW + 3_600_000 },
        weekly: { usedPercent: 40, windowMinutes: 10080, resetsAt: NOW + 86_400_000 },
        metadata: { source: 'synthetic-measurement', fetchedAt: updatedAt, accountLineage: ACCOUNT },
    };
}

function facts(reading: ReturnType<typeof quota>, reportedAt = NOW) {
    return {
        schemaVersion: 1, reportedAt, platform: 'darwin', arch: 'arm64',
        machineNickname: 'synthetic-machine', daemonBuild: { version: '1.0.81', commit: 'a'.repeat(40) },
        providerVersions: { [reading.provider]: '1.0.0' }, quota: { [reading.provider]: reading },
    };
}

let configDir: string;
let previousConfigDir: string | undefined;
let store: MeshNodeGitStateStore;
let router: DaemonCommandRouter;

beforeEach(() => {
    previousConfigDir = process.env.ADHDEV_CONFIG_DIR;
    configDir = mkdtempSync(join(tmpdir(), 'quota-ingest-'));
    process.env.ADHDEV_CONFIG_DIR = configDir;
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    store = new MeshNodeGitStateStore();
    saveMeshConfig({ meshes: MESHES.map((id, i) => ({
        id, name: id, repoIdentity: `github.com/synthetic/quota-${i}`, defaultBranch: 'main',
        coordinator: {}, policy: {}, nodes: [{
            id: `node_quota_${i}`, daemonId: MEMBER, machineId: MEMBER.slice(7),
            workspace: `/synthetic/quota-${i}`, repoRoot: `/synthetic/quota-${i}`,
            providers: [PROVIDER], policy: {},
        }],
    })) } as any);
    router = new DaemonCommandRouter({
        commandHandler: { handle: vi.fn(async () => ({ success: false })) } as any,
        cliManager: {} as any, cdpManagers: new Map(), providerLoader: {} as any,
        instanceManager: { collectAllStates: () => [], listInstanceIds: () => [], getByCategory: () => [] } as any,
        detectedIdes: { value: [] }, sessionRegistry: {} as any,
        statusInstanceId: COORD, meshNodeGitStateStore: store,
    });
});

afterEach(async () => {
    router?.meshNodeStatePusher.stop();
    vi.restoreAllMocks();
    await cleanupTempDir(configDir);
    if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR;
    else process.env.ADHDEV_CONFIG_DIR = previousConfigDir;
});

async function pushToBoth(reading: ReturnType<typeof quota> | null, reportedAt = NOW) {
    const nodeFacts = reading ? facts(reading, reportedAt) : { ...facts(quota(null), reportedAt), quota: {} };
    for (const [i, meshId] of MESHES.entries()) {
        const result = await router.execute('mesh_node_git_report', {
            meshId, nodeId: `node_quota_${i}`, workspace: `/synthetic/quota-${i}`,
            runtime: { schemaVersion: 1, daemonId: MEMBER, daemonBootId: 'boot_member', sessions: [], nodeFacts },
            runtimeObservedAt: NOW, [MESH_SENDER_DAEMON_ID_ARG]: MEMBER,
        }, 'mesh');
        expect(result).toMatchObject({ success: true, accepted: true });
    }
}

function projection(meshId: string) {
    const mesh = getMesh(meshId)!;
    const snapshot = { nodes: mesh.nodes.map(n => ({ ...n, nodeId: n.id })) };
    overlayMeshNodeGitObservations(snapshot, {
        meshId, store, refresher: new MeshNodeGitRefresher({ store, nudge: async () => false, onSettled: () => {}, now: () => NOW }),
        locality: { localDaemonId: COORD },
    });
    return snapshot.nodes[0];
}

async function expectBoth(reading: ReturnType<typeof quota>) {
    await vi.waitFor(() => {
        for (const [i, meshId] of MESHES.entries()) {
            expect(store.get(meshId, `node_quota_${i}`)?.runtime?.nodeFacts?.quota?.[reading.provider]).toMatchObject(reading);
            expect(getMesh(meshId)!.nodes[0].nodeFacts?.quota?.[reading.provider]).toMatchObject(reading);
            expect(projection(meshId).nodeFacts?.quota?.[reading.provider]).toMatchObject(reading);
        }
    }, { timeout: 500 });
}

describe('member quota ingestion → two mesh projections and persisted routing', () => {
    it('propagates a quota-only 5h measurement after a weekly-only report without a build/config change', async () => {
        await pushToBoth(quota(null, NOW - 2_000));
        await vi.waitFor(() => {
            for (const meshId of MESHES) expect(getMesh(meshId)!.nodes[0].nodeFacts?.quota?.[PROVIDER]?.weekly?.usedPercent).toBe(40);
        });
        await pushToBoth(quota(100));
        await expectBoth(quota(100));
        // Held and presentation have the full fresh measurement already.
        for (const [i, meshId] of MESHES.entries()) {
            expect(store.get(meshId, `node_quota_${i}`)?.runtime?.nodeFacts?.quota?.[PROVIDER]?.session?.usedPercent).toBe(100);
            expect.soft(projection(meshId).nodeFacts?.quota?.[PROVIDER]?.session?.usedPercent).toBe(100);
        }
        // Actual routing reads a freshly loaded config node, not our push fixture.
        await vi.waitFor(() => {
            for (const meshId of MESHES) {
                const node = getMesh(meshId)!.nodes[0];
                expect(evaluateProviderQuotaGate(node, PROVIDER, undefined, NOW)).toMatchObject({ reason: 'provider_quota_session_low' });
            }
        }, { timeout: 300 });
    });

    it('does not replace a measured 5h axis with an older same-account partial carried by a newer envelope', async () => {
        const measured = quota(100);
        await pushToBoth(measured);
        await expectBoth(measured);
        const olderPartial = quota(null, NOW - 60_000);
        olderPartial.metadata!.fetchedAt = NOW;
        await pushToBoth(olderPartial, NOW + 1);
        await expectBoth(measured);
        for (const meshId of MESHES) {
            expect(evaluateProviderQuotaGate(getMesh(meshId)!.nodes[0], PROVIDER, undefined, NOW))
                .toMatchObject({ reason: 'provider_quota_session_low' });
        }
    });

    it('uses capture time across live/app-server and rollout sources, without giving either source blanket precedence', async () => {
        // Source labels are metadata: the same verified authority/account and
        // reset cycle must be proven before comparing measurement clocks.
        const live = quota(100, NOW - 1_000, 'codex-cli');
        live.metadata!.source = 'app-server';
        await pushToBoth(live);
        await expectBoth(live);
        const oldRollout = quota(null, NOW - 60_000, 'codex-cli');
        oldRollout.metadata!.source = 'rollout';
        oldRollout.metadata!.fetchedAt = NOW;
        await pushToBoth(oldRollout, NOW + 1);
        await expectBoth(live);
        const newerRollout = quota(20, NOW, 'codex-cli');
        newerRollout.metadata!.source = 'rollout';
        await pushToBoth(newerRollout, NOW + 2);
        await expectBoth(newerRollout);
        for (const meshId of MESHES) expect(evaluateProviderQuotaGate(getMesh(meshId)!.nodes[0], 'codex-cli', undefined, NOW)).toBeNull();
    });

    it.each(['network', 'unauthorized', 'stale'])('does not hide a fresh %s failure behind an old successful snapshot', async failureKind => {
        await pushToBoth(quota(100));
        await expectBoth(quota(100));
        const failure = { ...quota(null, NOW), status: 'error', session: null, weekly: null, error: failureKind,
            metadata: { ...quota(null).metadata, failureKind } };
        await pushToBoth(failure, NOW + 1);
        await expectBoth(failure);
        for (const meshId of MESHES) expect(evaluateProviderQuotaGate(getMesh(meshId)!.nodes[0], PROVIDER, undefined, NOW)).toBeNull();
    });

    it('does not let a delayed failure attempted before the current measurement erase its supported axes', async () => {
        const measured = quota(100);
        await pushToBoth(measured);
        await expectBoth(measured);
        const delayedFailure = { ...quota(null, NOW - 60_000), status: 'error', session: null, weekly: null, error: 'old network failure',
            metadata: { ...quota(null, NOW - 60_000).metadata, failureKind: 'network' } };
        await pushToBoth(delayedFailure, NOW + 1);
        await expectBoth(measured);
    });

    it('accepts a current failure attempt even when its last-good data clock is older', async () => {
        await pushToBoth(quota(100));
        await expectBoth(quota(100));
        const currentFailure = { ...quota(100, NOW - 60_000), status: 'error', error: 'current network failure',
            metadata: { ...quota(null).metadata, fetchedAt: NOW, failureKind: 'network', lastGoodWindows: true } };
        await pushToBoth(currentFailure, NOW + 1);
        await expectBoth(currentFailure);
    });

    it('clears readings on unconfirmed lineage and never restores the previous account windows', async () => {
        await pushToBoth(quota(100));
        await expectBoth(quota(100));
        const uncertain = { ...quota(null, NOW), status: 'unavailable', weekly: null, error: 'Unconfirmed account',
            metadata: { accountLineage: { version: 1, kind: 'unknown' }, lineageUncertain: true } } as MeshNodeFactsProviderQuota;
        await pushToBoth(uncertain, NOW + 1);
        await expectBoth(uncertain);
        for (const meshId of MESHES) expect(evaluateProviderQuotaGate(getMesh(meshId)!.nodes[0], PROVIDER, undefined, NOW)).toBeNull();
    });

    it('accepts an account switch even when the new account reading has an older capture time', async () => {
        await pushToBoth(quota(100));
        await expectBoth(quota(100));
        const switched = quota(null, NOW - 60_000);
        switched.metadata!.accountLineage = { ...ACCOUNT, key: 'b'.repeat(64) };
        await pushToBoth(switched, NOW + 1);
        await expectBoth(switched);
        for (const meshId of MESHES) expect(evaluateProviderQuotaGate(getMesh(meshId)!.nodes[0], PROVIDER, undefined, NOW)).toBeNull();
    });

    it('does not transfer an old axis to an unknown producer/account reading', async () => {
        await pushToBoth(quota(100));
        await expectBoth(quota(100));
        const unknown = quota(null, NOW - 60_000);
        unknown.metadata = { accountLineage: { version: 1, kind: 'unknown' } };
        await pushToBoth(unknown, NOW + 1);
        await expectBoth(unknown);
    });

    it('does not infer a provider-pool join from headline windows on bucket-based snapshots', async () => {
        const pooled = quota(100, NOW - 1_000, 'antigravity-cli');
        pooled.buckets = [{ id: 'pool-a', usedPercent: 100, windowMinutes: 300, resetsAt: NOW + 3_600_000 }];
        await pushToBoth(pooled);
        await expectBoth(pooled);
        const anotherPool = quota(null, NOW - 60_000, 'antigravity-cli');
        anotherPool.buckets = [{ id: 'pool-b', usedPercent: 40, windowMinutes: 10080, resetsAt: NOW + 86_400_000 }];
        await pushToBoth(anotherPool, NOW + 1);
        await expectBoth(anotherPool);
    });

    it('does not hide a failure behind a newer measurement from an unjoined model pool', async () => {
        const pooled = quota(100, NOW - 1_000, 'antigravity-cli');
        pooled.buckets = [{ id: 'pool-a', usedPercent: 100, windowMinutes: 300, resetsAt: NOW + 3_600_000 }];
        await pushToBoth(pooled);
        await expectBoth(pooled);
        const failure = { ...quota(null, NOW - 60_000, 'antigravity-cli'), status: 'error', weekly: null, error: 'pool unknown',
            metadata: { ...pooled.metadata, fetchedAt: NOW - 60_000, failureKind: 'network' } };
        await pushToBoth(failure, NOW + 1);
        await expectBoth(failure);
    });

    it('retains a measured unreset 5h window past the age threshold and clears it at its own reset', async () => {
        const measured = quota(100, NOW - 3 * 3_600_000);
        await pushToBoth(measured);
        await expectBoth(measured);
        for (const meshId of MESHES) {
            const node = getMesh(meshId)!.nodes[0];
            expect(evaluateProviderQuotaGate(node, PROVIDER, undefined, NOW)).toMatchObject({ reason: 'provider_quota_session_low' });
            expect(evaluateProviderQuotaGate(node, PROVIDER, undefined, NOW + 3_600_001)).toBeNull();
        }
    });

    it('does not carry a prior cycle into a newly reported reset cycle', async () => {
        await pushToBoth(quota(100));
        await expectBoth(quota(100));
        const nextCycle = quota(null, NOW - 60_000);
        nextCycle.weekly = { ...nextCycle.weekly!, resetsAt: NOW + 2 * 86_400_000 };
        await pushToBoth(nextCycle, NOW + 1);
        await expectBoth(nextCycle);
    });

    it('does not retain an old 5h cycle just because the weekly reset still matches', async () => {
        await pushToBoth(quota(100));
        await expectBoth(quota(100));
        const nextCycle = quota(0, NOW - 60_000);
        nextCycle.session = { ...nextCycle.session!, resetsAt: NOW + 2 * 3_600_000 };
        await pushToBoth(nextCycle, NOW + 1);
        await expectBoth(nextCycle);
    });

    it('propagates a reset-only change with unchanged usage, build and bundle timestamp', async () => {
        const expired = quota(100);
        expired.session = { ...expired.session!, resetsAt: NOW - 1 };
        await pushToBoth(expired);
        await expectBoth(expired);
        const reset = quota(100);
        await pushToBoth(reset);
        await expectBoth(reset);
        for (const meshId of MESHES) {
            expect(evaluateProviderQuotaGate(getMesh(meshId)!.nodes[0], PROVIDER, undefined, NOW))
                .toMatchObject({ reason: 'provider_quota_session_low' });
        }
    });

    it('does not invent a 5h axis in a genuinely newer partial measurement', async () => {
        await pushToBoth(quota(100));
        await expectBoth(quota(100));
        const partial = quota(null, NOW);
        await pushToBoth(partial, NOW + 1);
        await expectBoth(partial);
    });

    it('does not resurrect a provider removed from the member snapshot', async () => {
        await pushToBoth(quota(100));
        await expectBoth(quota(100));
        await pushToBoth(null, NOW + 1);
        await vi.waitFor(() => {
            for (const [i, meshId] of MESHES.entries()) {
                expect(store.get(meshId, `node_quota_${i}`)?.runtime?.nodeFacts?.quota?.[PROVIDER]).toBeUndefined();
                expect(getMesh(meshId)!.nodes[0].nodeFacts?.quota?.[PROVIDER]).toBeUndefined();
                expect(evaluateProviderQuotaGate(getMesh(meshId)!.nodes[0], PROVIDER, undefined, NOW)).toBeNull();
            }
        });
    });

    it('keeps the original measurement clock when the member goes offline or awaits a handshake', async () => {
        const measured = quota(100);
        await pushToBoth(measured);
        await expectBoth(measured);
        for (const [i, meshId] of MESHES.entries()) {
            store.markHandshakePending(meshId, `node_quota_${i}`, 'reconnect', NOW);
            expect(projection(meshId).nodeFacts?.quota?.[PROVIDER]?.updatedAt).toBe(measured.updatedAt);
            expect(evaluateProviderQuotaGate(getMesh(meshId)!.nodes[0], PROVIDER, undefined, NOW))
                .toMatchObject({ reason: 'provider_quota_session_low' });
        }
    });

    it('pushes one canonical runtime read to both subscriptions on measurement/reset changes, not attempt-only timestamps', async () => {
        let reading = quota(null);
        const readRuntime = vi.fn(async () => ({
            schemaVersion: 1, daemonId: MEMBER, daemonBootId: 'boot_member', sessions: [], nodeFacts: facts(reading),
        }));
        const dispatch = vi.fn(async (_daemon: string, command: string, args: Record<string, unknown>) =>
            router.execute(command, { ...args, [MESH_SENDER_DAEMON_ID_ARG]: MEMBER }, 'mesh'));
        const pusher = new MeshNodeStatePusher({
            dispatch, readRuntime, readGit: async () => ({ isGitRepo: true, branch: 'main' }),
            now: () => NOW, startTimer: () => ({ stop() {} }),
        });
        try {
            for (const [i, meshId] of MESHES.entries()) pusher.selfRegister({
                coordinatorDaemonId: COORD, meshId, nodeId: `node_quota_${i}`, workspace: `/synthetic/quota-${i}`,
            });
            await pusher.tick();
            await expectBoth(reading);
            expect(readRuntime).toHaveBeenCalledTimes(1);
            reading = quota(100);
            await pusher.tick();
            await expectBoth(reading);
            const sent = dispatch.mock.calls.length;
            reading = { ...reading, metadata: { ...reading.metadata, fetchedAt: NOW } };
            await pusher.tick();
            expect(dispatch).toHaveBeenCalledTimes(sent);
            // Capture time alone is routing data even if the percentages match.
            reading = { ...reading, updatedAt: NOW };
            await pusher.tick();
            await expectBoth(reading);
            expect(dispatch).toHaveBeenCalledTimes(sent + 2);
            reading = { ...reading, session: { ...reading.session!, resetsAt: NOW + 2 * 3_600_000 } };
            await pusher.tick();
            await expectBoth(reading);
            expect(dispatch).toHaveBeenCalledTimes(sent + 4);
        } finally { pusher.stop(); }
    });

    it('does not regress the same node through an older remote git-envelope quota copy', async () => {
        const measured = quota(100);
        await pushToBoth(measured);
        await expectBoth(measured);
        for (const meshId of MESHES) {
            const mesh = getMesh(meshId)!;
            const node = mesh.nodes[0];
            const reporter = recordInlineMeshDirectGitTruth(node, {
                isGitRepo: true, branch: 'main', reporterNodeFacts: facts(quota(null, NOW - 60_000), NOW + 1),
            }, 'selected_coordinator_mesh_p2p_git');
            expect(reporter.nodeFacts?.quota?.[PROVIDER]).toMatchObject(measured);
            persistNodeReporterPlatform('local_config', mesh, node.id, reporter);
        }
        await expectBoth(measured);
    });
});
