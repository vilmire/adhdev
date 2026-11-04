/**
 * One real daemon process for the two-daemon handoff test: a private config dir,
 * a real MeshRuntimeStore, the real live-env ports and real durable stores. Only
 * the session host and the mesh transport are fakes, driven over Node IPC.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConfigDir } from '../../../../src/config/config.js';
import { loadMeshConfig, saveMeshConfig } from '../../../../src/config/mesh-config-store.js';
import { createLiveHandoffEngines, createLiveMeshPort, type LiveHandoffHost } from '../../../../src/mesh/host-handoff/live-env.js';
import { handlePeerVerb } from '../../../../src/mesh/host-handoff/peer-protocol.js';
import { applyHostTransferToMember, type MemberAdoptionPort } from '../../../../src/mesh/host-handoff/member-adopt.js';
import { stopProjectCoordinators } from '../../../../src/mesh/host-handoff/coordinator-stop.js';
import { inspectTargetReadiness } from '../../../../src/mesh/host-handoff/target-readiness.js';
import { durableHandoffAdmissionFailure, withCoordinatorTransition } from '../../../../src/mesh/host-handoff/admission.js';
import { HOST_SNAPSHOT_TABLES, readTable } from '../../../../src/mesh/host-handoff/snapshot-export.js';
import { MeshRuntimeStore } from '../../../../src/mesh/mesh-runtime-store.js';
import { getOrCreateHostKeyPair } from '../../../../src/mesh/origin-grant-keypair.js';
import { readAuthenticatedPeerOriginGrantPublicKey, readMeshHostRecord, transferMeshHostRecord, writeMeshHostRecord } from '../../../../src/mesh/mesh-host-memory.js';
import { readRecentHolds } from './fixture-holds.js';

const SELF = process.env.FIXTURE_DAEMON_ID!;
const send = (m: unknown) => process.send!(m);
const pending = new Map<string, (r: any) => void>();
const flags: Record<string, unknown> = {};
let clockOffset = 0;
const realNow = Date.now.bind(Date);
Date.now = () => realNow() + clockOffset;

/** Coordinators as the trusted session-host census would report them, persisted so a crash keeps them. */
const censusPath = () => join(getConfigDir(), 'fixture-census.json');
type Row = { sessionId: string; lifecycle: string; surfaceKind?: string; providerType: string; meta: { meshCoordinatorFor: string } };
const census = (): Row[] => existsSync(censusPath()) ? JSON.parse(readFileSync(censusPath(), 'utf8')) : [];
const saveCensus = (rows: Row[]) => writeFileSync(censusPath(), JSON.stringify(rows));
const liveFor = (meshId: string) => census().filter(r => r.meta.meshCoordinatorFor === meshId && r.lifecycle === 'running');
const launches: string[] = [];

const provider = { type: 'fixture-cli', spawn: { command: process.execPath }, hostHandoffCanary: { version: 1 as const, enforcement: 'host' as const,
    hostTimeoutMs: 15_000 as const, hostMaxOutputBytes: 16_384 as const, nativeTurnCap: false as const, nativeOutputTokenCap: false as const,
    privateContextDisabled: true as const, toolsDisabled: true as const,
    args: ['-e', `if (require('fs').existsSync(${JSON.stringify(join(getConfigDir(), 'canary-fails'))})) process.exit(3); process.stdout.write('ADHDEV_HANDOFF_READY')`, '{{prompt}}'] } };

const host: LiveHandoffHost = {
    selfDaemonId: SELF,
    dispatch: (daemonId, verb, args) => new Promise((resolve, reject) => {
        const id = randomUUID();
        pending.set(id, r => (r.error ? reject(new Error(r.error)) : resolve(r.result)));
        send({ kind: 'dispatch', id, to: daemonId, verb, args: JSON.parse(JSON.stringify(args)) });
    }),
    peerOnline: (d) => !(flags.offline as string[] | undefined)?.includes(d),
    coordinatorState: (meshId) => liveFor(meshId).map(r => ({ sessionId: r.sessionId, idle: flags.coordinatorBusy !== true, modalParked: false })),
    stopCoordinators: async (meshId) => withCoordinatorTransition(meshId, async () => {
        if (flags.stopRefused) throw new Error('stop refused');
        const proof = await stopProjectCoordinators(meshId, {
            list: async () => census(), registered: () => liveFor(meshId).map(r => ({ sessionId: r.sessionId, cliType: r.providerType })),
            stop: async (id) => { saveCensus(census().map(r => r.sessionId === id ? { ...r, lifecycle: 'stopped' } : r)); return { success: true }; },
            timeoutMs: 2_000,
        });
        if (flags.crashAfterStop) process.kill(process.pid, 'SIGKILL');
        return proof;
    }),
    observeCoordinator: async (meshId) => {
        if (flags.censusUnknown) return { ready: false, runtimeVerified: false, checkedAt: Date.now() };
        const live = liveFor(meshId);
        return { ready: live.length === 1, runtimeVerified: true, liveCount: live.length, checkedAt: Date.now(), ...(live[0] ? { sessionId: live[0].sessionId } : {}) };
    },
    selectLaunch: (_meshId, targetNodeId) => { if (!targetNodeId) throw new Error('explicit node required'); return { provider: 'fixture-cli', targetNodeId }; },
    readiness: async (meshId, plan, opts) => {
        if (opts?.canaryMaxAgeMs && flags.crashAtPostApply) process.kill(process.pid, 'SIGKILL');
        const mesh = (loadMeshConfig().meshes.find(m => m.id === meshId) ?? opts?.offeredMesh) as never;
        return inspectTargetReadiness({ selfDaemonId: SELF, mesh, plan, validateSelection: () => true, provider: () => provider, coordinatorCapable: () => true, census: async () => census(), ...(opts?.canaryMaxAgeMs ? { canaryMaxAgeMs: opts.canaryMaxAgeMs } : {}) });
    },
    restoreCoordinator: async (meshId) => launch(meshId),
    canLaunchCoordinator: () => true,
    launchCoordinator: async (meshId) => {
        if (liveFor(meshId).length) return { success: true, ready: true, sessionId: liveFor(meshId)[0]!.sessionId };
        if (flags.launchFails) { flags.launchFails = false; return { success: false, ready: false }; }
        return { ...(await launch(meshId)), ready: true };
    },
    selfNodeId: (meshId) => loadMeshConfig().meshes.find(m => m.id === meshId)?.nodes?.find(n => n.daemonId === SELF)?.id,
    log: (line) => { if (process.env.FIXTURE_LOG) console.error(`[${SELF.slice(-1)}] ${line}`); },
};

/** The real launch gate: a fenced or transferred project refuses, whatever asks. */
async function launch(meshId: string): Promise<{ success: boolean; sessionId?: string; error?: string }> {
    const refused = durableHandoffAdmissionFailure(meshId);
    if (refused) return { success: false, error: refused.code };
    const sessionId = `coord-${SELF.slice(-4)}-${launches.length + 1}`;
    launches.push(sessionId);
    saveCensus([...census(), { sessionId, lifecycle: 'running', providerType: 'fixture-cli', meta: { meshCoordinatorFor: meshId } }]);
    return { success: true, sessionId };
}

const db = () => MeshRuntimeStore.getInstance().db as any;
const engines = () => (cachedEngines ??= createLiveHandoffEngines(host));
let cachedEngines: ReturnType<typeof createLiveHandoffEngines> | undefined;
const mesh = createLiveMeshPort(SELF);
const adoption = (sender: string): MemberAdoptionPort => ({
    sender,
    readRecord: (meshId) => {
        const record = readMeshHostRecord(meshId);
        if (!record) return null;
        const pin = readAuthenticatedPeerOriginGrantPublicKey(meshId, record.hostDaemonId);
        return { hostDaemonId: record.hostDaemonId, ...(pin ? { originGrantPublicKey: pin } : {}) };
    },
    writeRecord: (meshId, next) => { transferMeshHostRecord(meshId, next); },
});

const ops: Record<string, (a: any) => unknown> = {
    ping: () => ({ pid: process.pid }),
    publicKey: () => getOrCreateHostKeyPair(SELF).publicKey,
    set: (a) => { Object.assign(flags, a); return true; },
    shiftClock: (a) => { clockOffset += a.ms; return true; },
    writeMeshes: (a) => { saveMeshConfig({ meshes: a.meshes } as never); return true; },
    readMeshes: () => loadMeshConfig().meshes,
    hostRecord: (a) => readMeshHostRecord(a.meshId),
    pinHost: (a) => writeMeshHostRecord(a.meshId, a.hostDaemonId, 'pairing', a.publicKey, { pairingVerified: true }),
    learnHost: (a) => writeMeshHostRecord(a.meshId, a.hostDaemonId, 'first_dispatch'),
    launch: (a) => launch(a.meshId),
    live: (a) => liveFor(a.meshId).map(r => r.sessionId),
    sql: (a) => { const st = db().prepare(a.sql); return st.reader ? st.all(...(a.args ?? [])) : st.run(...(a.args ?? [])); },
    tryWrite: (a) => { try { db().prepare(a.sql).run(...(a.args ?? [])); return { ok: true }; } catch (e) { return { ok: false, error: (e as Error).message }; } },
    dump: (a) => Object.fromEntries(HOST_SNAPSHOT_TABLES.map(spec => [spec.table, readTable(db(), spec, a.meshId).rows])),
    view: (a) => mesh.read(a.meshId),
    admission: (a) => durableHandoffAdmissionFailure(a.meshId),
    holds: () => readRecentHolds(),
    preflight: (a) => engines().source.preflight(a),
    start: (a) => engines().source.start(a),
    source: (a) => engines().source.status(a),
    target: (a) => engines().journal.get(a.handoffId, 'target'),
    abort: (a) => engines().source.abort(a.handoffId),
    retry: (a) => engines().source.retry(a.handoffId),
    tick: async () => { await engines().source.tick(); await engines().target.tick(); await engines().source.idle(); await engines().target.idle(); return true; },
    resume: async () => { await engines().source.resume(); await engines().target.resume(); await engines().source.idle(); await engines().target.idle(); return true; },
    idle: async () => { await engines().source.idle(); await engines().target.idle(); return true; },
    peer: (a) => handlePeerVerb({
        source: engines().source, target: engines().target,
        certificate: (c, sender) => applyHostTransferToMember(mesh, SELF, c.meshId, c.certificate, adoption(sender)),
    }, a.verb, a.args, a.sender),
};

process.on('message', async (m: any) => {
    if (m.kind === 'dispatched') { pending.get(m.id)?.(m); pending.delete(m.id); return; }
    try { send({ kind: 'result', id: m.id, result: await ops[m.op]!(m.args ?? {}) ?? null }); }
    catch (e) { send({ kind: 'result', id: m.id, error: (e as Error).message }); }
});
send({ kind: 'ready' });
