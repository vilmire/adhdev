import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DST, MESH, OTH, SRC, makeWorld, settle, type World } from './harness.js';
import { checkHostOwnedWrite, readHostEpoch } from '../../../src/mesh/host-handoff/epoch.js';
import { requireMeshHostQueueOwner } from '../../../src/mesh/mesh-host-ownership.js';
import { handlePeerVerb } from '../../../src/mesh/host-handoff/peer-protocol.js';
import { applyHostTransferToMember } from '../../../src/mesh/host-handoff/member-adopt.js';
import { signHostTransferCertificate } from '../../../src/mesh/host-handoff/certificate.js';
import { HOST_HANDOFF_ACK_TIMEOUT_MS, HOST_HANDOFF_FREEZE_TIMEOUT_MS, HOST_HANDOFF_PROBE_BASE_MS, HOST_HANDOFF_RETENTION_MS } from '../../../src/mesh/host-handoff/types.js';
import { TARGET_STAGE_TTL_MS } from '../../../src/mesh/host-handoff/target-machine.js';

let w: World;
afterEach(() => w?.cleanup());

const phase = (d: { journal: { get(i: string, r: 'source' | 'target'): { phase: string } | null } }, id: string, role: 'source' | 'target') => d.journal.get(id, role)?.phase;
const start = (extra: Record<string, unknown> = {}) => w.src.source.start({ meshId: MESH, targetDaemonId: DST, targetNodeId: `node-${DST}`, ...extra });

describe('acceptance 9: normal handoff', () => {
    beforeEach(() => { w = makeWorld(); });

    it('moves the host role and every host-owned row; the source keeps read-only history as a member', async () => {
        const before = w.src.dump();
        const total = w.src.rowTotal();
        expect(total).toBeGreaterThan(20);
        const r = await start();
        expect(r).toMatchObject({ success: true });
        await settle(w);
        const id = (r as { handoffId: string }).handoffId;
        expect(phase(w.src, id, 'source')).toBe('committed');
        expect(phase(w.dst, id, 'target')).toBe('active');
        // target: host at epoch N+1 with identical data
        const dstHost = w.dst.mesh.read(MESH)!;
        expect(dstHost).toMatchObject({ role: 'host', hostDaemonId: DST, hostEpoch: 1, hostNodeId: `node-${DST}` });
        expect(w.dst.dump()).toEqual(before);
        // source: member, epoch N+1, handed-off marker, data untouched
        const srcHost = w.src.mesh.read(MESH)!;
        expect(srcHost).toMatchObject({ role: 'member', hostDaemonId: DST, hostEpoch: 1, handedOff: true });
        expect((w.src.meshRecord.meshHost as { handedOffTo: { retainUntil: number; at: number } }).handedOffTo.retainUntil - (w.src.meshRecord.meshHost as { handedOffTo: { at: number } }).handedOffTo.at).toBe(HOST_HANDOFF_RETENTION_MS);
        expect(w.src.dump()).toEqual(before);
        expect(w.src.handedOffRows).toHaveLength(1);
        // hold released, old coordinator stopped only after the new one was ready, new coordinator launched once
        expect(w.src.holds.size).toBe(0);
        expect(w.src.coordinatorStops).toEqual([MESH]);
        expect(w.dst.coordinatorLaunches).toEqual([MESH]);
        // the other mesh's rows never travelled; the secret-looking config key never travelled
        expect(w.dst.db.prepare("SELECT COUNT(*) AS n FROM mesh_queue WHERE mesh_id = 'other-mesh'").get()).toEqual({ n: 0 });
        expect(JSON.stringify(w.dst.meshRecord)).not.toContain('must-not-travel');
        // the certificate went out to the other members and the third member adopted the new host (and its key)
        expect(w.other.mesh.read(MESH)).toMatchObject({ role: 'member', hostDaemonId: DST, hostEpoch: 1, hostPublicKey: w.dst.publicKey });
        expect(w.other.certificateResults.some(r => r.success)).toBe(true);
        expect(w.src.broadcasts[0]).toMatchObject({ meshId: MESH, newHostDaemonId: DST, hostEpoch: 1, previousHostDaemonId: SRC, newHostPublicKey: w.dst.publicKey });
        // the staging area was dropped
        expect(w.dst.journal.getChunks(id)).toEqual([]);
    });

    it('the transfer is chunked and hash-chained (several chunks, every one verified)', async () => {
        await start();
        await settle(w);
        expect(w.net.sentVerbs('mesh_host_handoff_chunk', 'chunk').length).toBeGreaterThan(3);
        expect(w.net.sentVerbs('mesh_host_handoff_ack')).toHaveLength(1);
        expect(w.net.sentVerbs('mesh_host_handoff_activate')).toHaveLength(1);
    });

    it('the epoch strictly increases across two handoffs back and forth', async () => {
        const first = await start() as { handoffId: string };
        await settle(w);
        expect(readHostEpoch(w.dst.meshRecord)).toBe(1);
        // hand it back: dst is now host, src a member of the handed-off mesh
        w.src.meshRecord.meshHost = { role: 'member', hostDaemonId: DST, hostEpoch: 1 };
        const back = await w.dst.source.start({ meshId: MESH, targetDaemonId: SRC });
        expect(back).toMatchObject({ success: true });
        await settle(w);
        expect(readHostEpoch(w.src.meshRecord)).toBe(2);
        expect(first.handoffId).not.toBe((back as { handoffId: string }).handoffId);
    });
});

describe('acceptance 10: failure injection leaves the source host, data intact, staging gone, hold released', () => {
    beforeEach(() => { w = makeWorld(); });
    const expectSourceStillHost = (before: unknown) => {
        expect(w.src.mesh.read(MESH)).toMatchObject({ role: 'host', hostEpoch: 0, handedOff: false });
        expect(w.src.dump()).toEqual(before);
        expect(w.src.holds.size).toBe(0);
        expect(w.src.coordinatorStops).toEqual([]);
        expect(w.dst.mesh.read(MESH)).toMatchObject({ role: 'member' });
        expect(w.net.sentVerbs('mesh_host_handoff_activate')).toHaveLength(0);
    };

    it('a connection that drops mid-transfer', async () => {
        const before = w.src.dump();
        w.net.faults.push({ verb: 'mesh_host_handoff_chunk', op: 'chunk', seq: 2, mode: 'request', times: 1 });
        const r = await start() as { handoffId: string };
        await settle(w);
        expect(phase(w.src, r.handoffId, 'source')).toBe('aborted');
        expect(w.src.journal.get(r.handoffId, 'source')!.abortReason).toContain('transfer_interrupted');
        expect(phase(w.dst, r.handoffId, 'target')).toBe('discarded');
        expect(w.dst.journal.getChunks(r.handoffId)).toEqual([]);
        expectSourceStillHost(before);
    });

    it('a tampered chunk is refused by its hash', async () => {
        const before = w.src.dump();
        w.net.corruptChunkSeq = 1;
        const r = await start() as { handoffId: string };
        await settle(w);
        expect(w.src.journal.get(r.handoffId, 'source')).toMatchObject({ phase: 'aborted', abortReason: 'chunk_hash_mismatch' });
        expectSourceStillHost(before);
    });

    it('a target whose schema cannot hold the snapshot fails verification (no ACK is ever sent)', async () => {
        const before = w.src.dump();
        w.dst.missingColumns.add('brief_json');
        const r = await start() as { handoffId: string };
        await settle(w);
        expect(w.src.journal.get(r.handoffId, 'source')).toMatchObject({ phase: 'aborted' });
        expect(w.net.sentVerbs('mesh_host_handoff_ack')).toHaveLength(0);
        expect(phase(w.dst, r.handoffId, 'target')).toBe('discarded');
        expectSourceStillHost(before);
    });

    it('an ACK that never comes times out into an abort', async () => {
        const before = w.src.dump();
        w.net.holdAcks();
        const r = await start() as { handoffId: string };
        await w.src.source.idle();
        expect(phase(w.src, r.handoffId, 'source')).toBe('awaiting_ack');
        w.clock.now += HOST_HANDOFF_ACK_TIMEOUT_MS - 1;
        await w.src.source.tick();
        expect(phase(w.src, r.handoffId, 'source')).toBe('awaiting_ack');
        w.clock.now += 2;
        await w.src.source.tick();
        expect(w.src.journal.get(r.handoffId, 'source')).toMatchObject({ phase: 'aborted', abortReason: 'ack_timeout' });
        expect(phase(w.dst, r.handoffId, 'target')).toBe('discarded');
        w.net.releaseAcks();
        await settle(w);
        expectSourceStillHost(before);
    });

    it('an owner abort before activate', async () => {
        const before = w.src.dump();
        w.net.holdAcks();
        const r = await start() as { handoffId: string };
        expect(await w.src.source.abort(r.handoffId)).toMatchObject({ success: true });
        w.net.releaseAcks();
        await settle(w);
        expect(phase(w.dst, r.handoffId, 'target')).toBe('discarded');
        expectSourceStillHost(before);
    });

    it('a mismatching ACK (wrong row counts) aborts instead of activating', async () => {
        w.net.holdAcks();
        const r = await start() as { handoffId: string };
        const rec = w.src.journal.get(r.handoffId, 'source')!;
        const res = await w.src.source.onAck({ handoffId: r.handoffId, meshId: MESH, epoch: rec.epoch, manifestDigest: rec.manifestDigest!, rowCounts: { ...rec.rowCounts!, mesh_queue: 1 }, targetDaemonId: DST, readiness: { coordinatorLaunchable: true } }, DST);
        expect(res).toMatchObject({ success: false, code: 'ack_mismatch' });
        expect(phase(w.src, r.handoffId, 'source')).toBe('aborted');
        w.net.releaseAcks();
        await settle(w);
        expect(w.net.sentVerbs('mesh_host_handoff_activate')).toHaveLength(0);
    });

    it('a stalled freeze times out into an abort and releases the hold', async () => {
        const before = w.src.dump();
        w.src.freezeResult = { ready: false, code: 'coordinator_not_quiescent' };
        const r = await start() as { handoffId: string; phase: string };
        expect(r.phase).toBe('freezing');
        expect(w.src.holds.has(MESH)).toBe(true);
        w.clock.now += HOST_HANDOFF_FREEZE_TIMEOUT_MS + 1;
        await w.src.source.tick();
        expect(w.src.journal.get(r.handoffId, 'source')).toMatchObject({ phase: 'aborted', abortReason: 'freeze_timeout' });
        expectSourceStillHost(before);
    });

    it('a target that disappears before verifying: its staged copy is discarded by TTL and never activates', async () => {
        w.net.faults.push({ verb: 'mesh_host_handoff_chunk', op: 'seal', mode: 'request', times: 1 });
        const r = await start() as { handoffId: string };
        await settle(w);
        expect(phase(w.src, r.handoffId, 'source')).toBe('aborted');
        w.clock.now += TARGET_STAGE_TTL_MS + 1;
        await w.dst.target.tick();
        expect(w.dst.journal.getChunks(r.handoffId)).toEqual([]);
    });
});

describe('acceptance 11: a late ACK changes nothing', () => {
    beforeEach(() => { w = makeWorld(); });
    it('an ACK delivered after the abort is NACKed handoff_aborted; the target discards; no activate is ever sent', async () => {
        w.net.holdAcks();
        const r = await start() as { handoffId: string };
        await w.src.source.idle();
        await w.src.source.abort(r.handoffId);
        const stateBefore = JSON.stringify(w.src.journal.get(r.handoffId, 'source'));
        const hostBefore = JSON.stringify(w.src.meshRecord);
        w.net.releaseAcks();
        await settle(w);
        const ackCall = w.net.sentVerbs('mesh_host_handoff_ack')[0]!;
        expect(ackCall).toMatchObject({ ok: false, code: 'handoff_aborted' });
        expect(JSON.stringify(w.src.journal.get(r.handoffId, 'source'))).toBe(stateBefore);
        expect(JSON.stringify(w.src.meshRecord)).toBe(hostBefore);
        expect(phase(w.dst, r.handoffId, 'target')).toBe('discarded');
        expect(w.net.sentVerbs('mesh_host_handoff_activate')).toHaveLength(0);
        expect(w.dst.mesh.read(MESH)).toMatchObject({ role: 'member' });
    });
    it('an ACK from a daemon that is not the target is refused as wrong_peer', async () => {
        w.net.holdAcks();
        const r = await start() as { handoffId: string };
        const rec = w.src.journal.get(r.handoffId, 'source')!;
        const res = await w.src.source.onAck({ handoffId: r.handoffId, meshId: MESH, epoch: rec.epoch, manifestDigest: rec.manifestDigest!, rowCounts: rec.rowCounts!, targetDaemonId: OTH, readiness: { coordinatorLaunchable: true } }, OTH);
        expect(res).toMatchObject({ success: false, code: 'wrong_peer' });
        expect(phase(w.src, r.handoffId, 'source')).toBe('awaiting_ack');
        w.net.releaseAcks();
        await settle(w);
    });
});

describe('acceptance 12: ACTIVE lost -> uncertain, never two hosts', () => {
    beforeEach(() => { w = makeWorld(); w.net.faults.push({ verb: 'mesh_host_handoff_activate', mode: 'response', times: 1 }); });

    it('stays uncertain and frozen; the target is host at the higher epoch; the source resolves to committed when it can probe', async () => {
        const r = await start() as { handoffId: string };
        await settle(w);
        const id = r.handoffId;
        expect(phase(w.src, id, 'source')).toBe('uncertain');
        expect(phase(w.dst, id, 'target')).toBe('active');
        // the source did not release or finalise anything yet
        expect(w.src.holds.has(MESH)).toBe(true);
        expect(w.src.coordinatorStops).toEqual([]);
        // never two writers: the source is frozen and its epoch is below the new host's, so a request that carries the new epoch is refused by it
        expect(w.src.source.isFrozen(MESH)).toBe(true);
        expect(checkHostOwnedWrite(w.src.meshRecord, { localDaemonId: SRC, requestEpoch: 1 })).toMatchObject({ ok: false, code: 'stale_host_epoch', direction: 'local_stale' });
        expect(checkHostOwnedWrite(w.dst.meshRecord, { localDaemonId: DST, requestEpoch: 0 })).toMatchObject({ ok: false, code: 'stale_host_epoch', direction: 'client_stale' });
        expect(checkHostOwnedWrite(w.dst.meshRecord, { localDaemonId: DST, requestEpoch: 1 })).toMatchObject({ ok: true, epoch: 1 });
        // backoff: an immediate tick does not probe again
        const probes = () => w.net.sentVerbs('mesh_host_handoff_status').length;
        const n = probes();
        await w.src.source.tick();
        expect(probes()).toBe(n);
        w.clock.now += HOST_HANDOFF_PROBE_BASE_MS;
        await w.src.source.tick();
        await settle(w);
        expect(phase(w.src, id, 'source')).toBe('committed');
        expect(w.src.mesh.read(MESH)).toMatchObject({ role: 'member', hostDaemonId: DST, hostEpoch: 1, handedOff: true });
        expect(w.src.holds.size).toBe(0);
        // the activation was applied exactly once
        expect(w.dst.applyCalls).toBe(1);
    });

    it('while the target is offline neither commit nor abort is possible; when it returns the source commits', async () => {
        const r = await start() as { handoffId: string };
        await settle(w);
        const id = r.handoffId;
        w.net.offline.add(DST);
        w.clock.now += HOST_HANDOFF_PROBE_BASE_MS;
        await w.src.source.tick();
        expect(phase(w.src, id, 'source')).toBe('uncertain');
        expect(await w.src.source.abort(id)).toMatchObject({ success: false, code: 'abort_requires_target_confirmation' });
        expect(phase(w.src, id, 'source')).toBe('uncertain');
        expect(w.src.holds.has(MESH)).toBe(true);
        w.net.offline.delete(DST);
        const res = await w.src.source.retry(id);
        await settle(w);
        expect(res).toMatchObject({ success: true });
        expect(phase(w.src, id, 'source')).toBe('committed');
    });

    it('abort is allowed only on the target\'s own report that it discarded; an active target forbids it', async () => {
        const r = await start() as { handoffId: string };
        await settle(w);
        // target is active: abort turns into a commit and is refused
        expect(await w.src.source.abort(r.handoffId)).toMatchObject({ success: false, code: 'already_committed' });
        expect(phase(w.src, r.handoffId, 'source')).toBe('committed');
    });

    it('a target that reports the handoff discarded lets the source abort safely', async () => {
        w.net.faults.length = 0;
        w.net.faults.push({ verb: 'mesh_host_handoff_activate', mode: 'request', times: 1 });
        const r = await start() as { handoffId: string };
        await settle(w);
        const id = r.handoffId;
        expect(phase(w.src, id, 'source')).toBe('uncertain');
        expect(phase(w.dst, id, 'target')).toBe('acked');
        // the target is told to forget it (e.g. staging TTL); then the source may abort
        w.clock.now += TARGET_STAGE_TTL_MS + 1;
        await w.dst.target.tick();
        expect(phase(w.dst, id, 'target')).toBe('discarded');
        expect(await w.src.source.abort(id)).toMatchObject({ success: true });
        expect(w.src.mesh.read(MESH)).toMatchObject({ role: 'host', hostEpoch: 0 });
        expect(w.src.holds.size).toBe(0);
    });

    it('a request that never reached the target is retried by the probe (activate is re-sent)', async () => {
        w.net.faults.length = 0;
        w.net.faults.push({ verb: 'mesh_host_handoff_activate', mode: 'request', times: 1 });
        const r = await start() as { handoffId: string };
        await settle(w);
        expect(phase(w.src, r.handoffId, 'source')).toBe('uncertain');
        w.clock.now += HOST_HANDOFF_PROBE_BASE_MS;
        await w.src.source.tick();
        await settle(w);
        expect(phase(w.src, r.handoffId, 'source')).toBe('committed');
        expect(phase(w.dst, r.handoffId, 'target')).toBe('active');
        expect(w.dst.applyCalls).toBe(1);
    });
});

describe('acceptance 13: crash and restart resume to the same final state', () => {
    it('source crash before activate: the restart cleans up (abort), the target discards, the hold is released', async () => {
        w = makeWorld();
        w.net.holdAcks();
        const r = await start() as { handoffId: string };
        await w.src.source.idle();
        expect(phase(w.src, r.handoffId, 'source')).toBe('awaiting_ack');
        w.src.buildEngines(); // process restart over the same journal
        await w.src.source.resume();
        expect(w.src.journal.get(r.handoffId, 'source')).toMatchObject({ phase: 'aborted', abortReason: 'source_restarted' });
        w.net.releaseAcks();
        await settle(w);
        expect(phase(w.dst, r.handoffId, 'target')).toBe('discarded');
        expect(w.src.holds.size).toBe(0);
        expect(w.src.mesh.read(MESH)).toMatchObject({ role: 'host', hostEpoch: 0 });
    });

    it('source crash after the commit intent: the restart probes and converges to committed; a repeated activate is idempotent', async () => {
        w = makeWorld({ sqliteJournal: true });
        w.net.faults.push({ verb: 'mesh_host_handoff_activate', mode: 'response', times: 1 });
        const r = await start() as { handoffId: string };
        await settle(w);
        expect(phase(w.src, r.handoffId, 'source')).toBe('uncertain');
        w.src.buildEngines();
        await w.src.source.resume();
        await settle(w);
        expect(phase(w.src, r.handoffId, 'source')).toBe('committed');
        expect(w.dst.applyCalls).toBe(1);
        // a duplicate activate reaches the active target: success, no second apply
        const rec = w.src.journal.get(r.handoffId, 'source')!;
        const again = await handlePeerVerb({ target: w.dst.target }, 'mesh_host_handoff_activate', { handoffId: r.handoffId, meshId: MESH, epoch: rec.epoch, certificate: w.src.broadcasts[0] }, SRC);
        expect(again).toMatchObject({ success: true, applied: true, duplicate: true });
        expect(w.dst.applyCalls).toBe(1);
        // restarting again changes nothing
        w.src.buildEngines();
        await w.src.source.resume();
        expect(phase(w.src, r.handoffId, 'source')).toBe('committed');
    });

    it('target crash after staging: the restart keeps the staged copy; the source retry gets the ACK again and the handoff completes', async () => {
        w = makeWorld({ sqliteJournal: true });
        w.net.holdAcks();
        const r = await start() as { handoffId: string };
        await w.src.source.idle();
        expect(phase(w.dst, r.handoffId, 'target')).toBe('verified');
        w.net.releaseAcks();
        w.dst.buildEngines(); // target restart: ACK delivery state is gone, staging is durable
        expect(w.dst.journal.getChunks(r.handoffId).length).toBeGreaterThan(0);
        await w.src.source.retry(r.handoffId);
        await settle(w);
        expect(phase(w.src, r.handoffId, 'source')).toBe('committed');
        expect(phase(w.dst, r.handoffId, 'target')).toBe('active');
    });

    it('target crash in the middle of activation: resume applies idempotently and the source converges', async () => {
        w = makeWorld({ sqliteJournal: true });
        w.net.faults.push({ verb: 'mesh_host_handoff_activate', mode: 'request', times: 1 });
        const r = await start() as { handoffId: string };
        await settle(w);
        expect(phase(w.dst, r.handoffId, 'target')).toBe('acked');
        // the target journalled `activating` and died before applying anything
        w.dst.journal.update(r.handoffId, 'target', { phase: 'activating' });
        w.dst.buildEngines();
        await w.dst.target.resume();
        expect(phase(w.dst, r.handoffId, 'target')).toBe('active');
        expect(w.dst.mesh.read(MESH)).toMatchObject({ role: 'host', hostEpoch: 1 });
        expect(w.dst.dump()).toEqual(w.src.dump());
        w.clock.now += HOST_HANDOFF_PROBE_BASE_MS;
        await w.src.source.tick();
        await settle(w);
        expect(phase(w.src, r.handoffId, 'source')).toBe('committed');
        // resuming again is a no-op
        await w.dst.target.resume();
        expect(w.dst.mesh.read(MESH)).toMatchObject({ role: 'host', hostEpoch: 1 });
    });

    it('a table apply that fails is a definitive "not applied": the source aborts and nothing is half-switched', async () => {
        w = makeWorld();
        w.dst.applyFailure = new Error('disk full');
        const r = await start() as { handoffId: string };
        await settle(w);
        expect(w.src.journal.get(r.handoffId, 'source')).toMatchObject({ phase: 'aborted' });
        expect(w.src.mesh.read(MESH)).toMatchObject({ role: 'host', hostEpoch: 0 });
        expect(w.dst.mesh.read(MESH)).toMatchObject({ role: 'member', hostEpoch: 0 });
        expect(phase(w.dst, r.handoffId, 'target')).toBe('acked');
    });
});

describe('acceptance 14: epoch enforcement of host-owned writes', () => {
    it('after commit the old host refuses mesh_host_handed_off, the queue guard says so, and an old-epoch member request gets stale_host_epoch', async () => {
        w = makeWorld();
        await start();
        await settle(w);
        expect(checkHostOwnedWrite(w.src.meshRecord, { localDaemonId: SRC })).toMatchObject({ ok: false, code: 'mesh_host_handed_off', newHostDaemonId: DST, epoch: 1 });
        expect(() => requireMeshHostQueueOwner({ handedOff: true })).toThrowError(/mesh_host_handed_off/);
        try { requireMeshHostQueueOwner({ handedOff: true }); } catch (e) { expect((e as { code?: string }).code).toBe('mesh_host_handed_off'); }
        expect(checkHostOwnedWrite(w.dst.meshRecord, { localDaemonId: DST, requestEpoch: 0 })).toMatchObject({ ok: false, code: 'stale_host_epoch', epoch: 1, direction: 'client_stale' });
        // the real queue mutators refuse with the same code when told the host role was handed away
        const { enqueueTask } = await import('../../../src/mesh/mesh-work-queue.js');
        expect(() => enqueueTask(MESH, 'work', { ownerRole: 'member', handedOff: true } as never)).toThrowError(/mesh_host_handed_off/);
        expect(() => enqueueTask(MESH, 'work', { ownerRole: 'member' } as never)).toThrowError(/Mesh Host daemon required/);
        // the member re-resolves the host from its own record after the certificate arrives, then writes at the new epoch
        expect(checkHostOwnedWrite(w.dst.meshRecord, { localDaemonId: DST, requestEpoch: 1 })).toMatchObject({ ok: true });
        // a plain member can never be the write target
        expect(checkHostOwnedWrite(w.other.meshRecord, { localDaemonId: OTH })).toMatchObject({ ok: false, code: 'mesh_host_required' });
    });
});

describe('acceptance 17: freeze', () => {
    beforeEach(() => { w = makeWorld(); });
    it('holds the mesh for the whole handoff and nothing stops a worker or the coordinator before commit', async () => {
        w.net.holdAcks();
        const r = await start() as { handoffId: string };
        await w.src.source.idle();
        expect(w.src.holds.has(MESH)).toBe(true);
        expect(w.src.source.isFrozen(MESH)).toBe(true);
        expect(w.src.coordinatorStops).toEqual([]);
        w.net.releaseAcks();
        await settle(w);
        expect(w.src.holds.has(MESH)).toBe(false);
        expect(w.src.holdLog[0]).toBe(`acquire:${r.handoffId}`);
    });
    it('an open writer checkpoint refuses the start (never forced) and leaves no hold or journal', async () => {
        w.src.freezeResult = { ready: false, code: 'writer_checkpoint_pending', detail: 'task t1' };
        const r = await start();
        expect(r).toMatchObject({ success: false, code: 'writer_checkpoint_pending' });
        expect(w.src.holds.size).toBe(0);
        expect(w.src.journal.list()).toHaveLength(0);
    });
    it('a second start on the same mesh is refused while one is in progress', async () => {
        w.net.holdAcks();
        await start();
        const second = await w.src.source.start({ meshId: MESH, targetDaemonId: OTH });
        expect(second).toMatchObject({ success: false, code: 'handoff_in_progress' });
        w.net.releaseAcks();
        await settle(w);
    });
});

describe('acceptance 18: preflight and old daemons', () => {
    beforeEach(() => { w = makeWorld(); });
    it('a target without the handoff engine (older daemon) is refused: peer_capability_unconfirmed', async () => {
        w.dst.target = undefined as never;
        const r = await start();
        expect(r).toMatchObject({ success: false, code: 'peer_capability_unconfirmed' });
        expect(w.src.holds.size).toBe(0);
        expect(w.src.journal.list()).toHaveLength(0);
        expect(w.net.sentVerbs('mesh_host_handoff_chunk')).toHaveLength(0);
    });
    it('a target speaking another protocol version is refused too', async () => {
        const original = w.dst.target.capability.bind(w.dst.target);
        w.dst.target.capability = ((a: never, s: string) => ({ ...original(a, s), protocol: 99 })) as never;
        expect(await start()).toMatchObject({ success: false, code: 'peer_capability_unconfirmed' });
    });
    it('preflight reports each check: not a member, offline, not launchable, self', async () => {
        const pf = (target: string) => w.src.source.preflight({ meshId: MESH, targetDaemonId: target });
        expect((await pf(SRC)).checks.find(c => !c.ok)?.code).toBe('target_is_self');
        expect((await pf('daemon_mach_ffffffffffffffff')).checks.find(c => !c.ok)?.code).toBe('target_not_member');
        w.net.offline.add(DST);
        expect((await pf(DST)).checks.find(c => !c.ok)?.code).toBe('target_offline');
        w.net.offline.delete(DST);
        w.dst.launchable = false;
        expect((await pf(DST)).checks.find(c => !c.ok)?.code).toBe('target_not_launchable');
        w.dst.launchable = true;
        const ok = await pf(DST);
        expect(ok.ok).toBe(true);
        expect(ok.estimateBytes).toBeGreaterThan(1000);
        // a member that is not the host cannot start
        const notHost = await w.dst.source.preflight({ meshId: MESH, targetDaemonId: SRC });
        expect(notHost.checks.find(c => !c.ok)?.code).toBe('not_host');
    });
    it('peer verbs reject an unauthenticated sender, missing ids and unknown verbs', async () => {
        const engines = { source: w.dst.source, target: w.dst.target };
        expect(await handlePeerVerb(engines, 'mesh_host_handoff_status', { handoffId: 'h', meshId: MESH }, '')).toMatchObject({ success: false, code: 'wrong_peer' });
        expect(await handlePeerVerb(engines, 'mesh_host_handoff_status', { meshId: MESH }, SRC)).toMatchObject({ success: false, code: 'invalid_args' });
        expect(await handlePeerVerb(engines, 'mesh_host_handoff_nope', { handoffId: 'h', meshId: MESH }, SRC)).toMatchObject({ success: false, code: 'invalid_args' });
        // an unrelated member cannot drive someone else's handoff
        w.net.holdAcks();
        const r = await start() as { handoffId: string };
        expect(await handlePeerVerb({ target: w.dst.target }, 'mesh_host_handoff_discard', { handoffId: r.handoffId, meshId: MESH }, OTH)).toMatchObject({ success: false, code: 'wrong_peer' });
        w.net.releaseAcks();
        await settle(w);
    });
});

describe('acceptance 15 (live): a member adopts the host only on a certificate the pinned previous host signed', () => {
    it('forged and replayed certificates reach the member and change nothing', async () => {
        w = makeWorld();
        const r = await start() as { handoffId: string };
        await settle(w);
        const good = w.src.broadcasts[0]!;
        const before = JSON.stringify(w.other.meshRecord.meshHost);
        // replay of the same (already adopted) certificate: the pinned host is now the new one, so its signer no longer matches
        expect(await handlePeerVerb({ certificate: (a, s) => applyHostTransferToMemberForTest(w, a) }, 'mesh_host_handoff_certificate', { meshId: MESH, certificate: good }, DST)).toMatchObject({ success: false, code: 'certificate_wrong_signer' });
        // forged: re-signed with the new host's own key, for a higher epoch
        const forged = signHostTransferCertificate({ ...(({ signature, ...u }) => u)(good), hostEpoch: 5 }, w.dst.keys.privateKey);
        expect(applyHostTransferToMemberForTest(w, { meshId: MESH, certificate: forged })).toMatchObject({ success: false });
        expect(JSON.stringify(w.other.meshRecord.meshHost)).toBe(before);
        void r;
    });
});

function applyHostTransferToMemberForTest(world: World, a: { meshId: string; certificate: unknown }) {
    return applyHostTransferToMember(world.other.mesh, OTH, a.meshId, a.certificate);
}
