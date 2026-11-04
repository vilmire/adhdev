/**
 * In-process harness for the host-handoff acceptance tests. Every "daemon" owns
 * a REAL MeshRuntimeStore (full production schema) in its own temp directory
 * and a real Ed25519 key; the network is an object that routes peer verbs and
 * can drop requests/responses. Nothing here touches ~/.adhdev* or a live daemon.
 */

import crypto from 'node:crypto';
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeshRuntimeStore } from '../../../src/mesh/mesh-runtime-store.js';
import { MemoryHandoffJournal, SqliteHandoffJournal, type HandoffJournal } from '../../../src/mesh/host-handoff/journal.js';
import { HostHandoffSource } from '../../../src/mesh/host-handoff/source-machine.js';
import { HostHandoffTarget } from '../../../src/mesh/host-handoff/target-machine.js';
import { handlePeerVerb, createWirePeerClient, createWireAckClient } from '../../../src/mesh/host-handoff/peer-protocol.js';
import { exportSnapshot, HOST_SNAPSHOT_TABLES, readTable } from '../../../src/mesh/host-handoff/snapshot-export.js';
import { applySnapshotTables, localTableColumns } from '../../../src/mesh/host-handoff/snapshot-import.js';
import { applyHostTransferToMember } from '../../../src/mesh/host-handoff/member-adopt.js';
import { signHostTransferCertificate } from '../../../src/mesh/host-handoff/certificate.js';
import { resolveMeshHostStatus } from '../../../src/mesh/mesh-host-ownership.js';
import type { FreezeCheck, HandoffMeshPort, HostMetaWrite } from '../../../src/mesh/host-handoff/ports.js';
import type { HostTransferCertificate, PeerResult } from '../../../src/mesh/host-handoff/types.js';

export const MESH = 'mesh-handoff-1';

export interface FaultRule {
    verb: string;
    op?: string;
    to?: string;
    /** `request`: the call never reaches the peer. `response`: the peer runs it, the answer is lost. */
    mode: 'request' | 'response';
    times: number;
    /** Only match when the chunk seq equals this. */
    seq?: number;
}

export class FakeNet {
    daemons = new Map<string, FakeDaemon>();
    offline = new Set<string>();
    faults: FaultRule[] = [];
    log: Array<{ from: string; to: string; verb: string; op?: string; ok: boolean; code?: string }> = [];
    private ackGate: { promise: Promise<void>; release: () => void } | null = null;
    corruptChunkSeq: number | null = null;
    /** Delivery delay per chunk, so later chunks can overtake earlier ones. */
    chunkDelayMs: ((seq: number) => number) | null = null;
    chunkStats = { open: 0, peak: 0, encodings: [] as unknown[] };
    /** Answer manifests like a build that cannot read encoded chunks. */
    plainChunksOnly = false;

    holdAcks(): void {
        let release!: () => void;
        const promise = new Promise<void>(r => { release = r; });
        this.ackGate = { promise, release };
    }
    releaseAcks(): void { this.ackGate?.release(); this.ackGate = null; }

    dispatcher(from: string) {
        return async (to: string, verb: string, rawArgs: Record<string, unknown>): Promise<PeerResult> => {
            const args = structuredClone(rawArgs);
            const op = typeof args.op === 'string' ? args.op : undefined;
            if (this.offline.has(to) || this.offline.has(from)) throw new Error('peer offline');
            if (verb === 'mesh_host_handoff_ack' && this.ackGate) await this.ackGate.promise;
            if (verb === 'mesh_host_handoff_chunk' && op === 'chunk' && this.corruptChunkSeq === args.seq) {
                // Well-formed on the wire, wrong in content: only the manifest hash can catch this.
                args.data = args.encoding ? brotliCompressSync(`${brotliDecompressSync(Buffer.from(String(args.data), 'base64')).toString('utf8')}tampered`).toString('base64') : `${String(args.data)}tampered`;
            }
            const rule = this.faults.find(f => f.verb === verb && f.times > 0 && (!f.op || f.op === op) && (!f.to || f.to === to) && (f.seq === undefined || f.seq === args.seq));
            if (rule?.mode === 'request') { rule.times--; this.log.push({ from, to, verb, op, ok: false, code: 'request_dropped' }); throw new Error('request dropped'); }
            const peer = this.daemons.get(to);
            if (!peer) throw new Error('unknown peer');
            const isChunk = verb === 'mesh_host_handoff_chunk' && op === 'chunk';
            if (isChunk) {
                this.chunkStats.encodings.push(args.encoding);
                this.chunkStats.peak = Math.max(this.chunkStats.peak, ++this.chunkStats.open);
                const delay = this.chunkDelayMs?.(Number(args.seq)) ?? 0;
                if (delay) await new Promise(resolve => setTimeout(resolve, delay));
            }
            const res = await handlePeerVerb({ source: peer.source, target: peer.target, certificate: (a, sender) => applyHostTransferToMember(peer.mesh, peer.id, a.meshId, a.certificate) }, verb, args, from);
            if (isChunk) this.chunkStats.open--;
            if (op === 'manifest' && this.plainChunksOnly) delete (res as { encodings?: unknown }).encodings;
            this.log.push({ from, to, verb, op, ok: res.success, code: res.code });
            if (rule?.mode === 'response') { rule.times--; throw new Error('response lost'); }
            return structuredClone(res);
        };
    }
    sentVerbs(verb: string, op?: string) { return this.log.filter(l => l.verb === verb && (!op || l.op === op)); }
}

export interface DaemonOpts {
    id: string;
    net: FakeNet;
    role: 'host' | 'member';
    hostDaemonId: string;
    memberIds: string[];
    clock: { now: number };
    sqliteJournal?: boolean;
    hostPublicKeyOf?: (id: string) => string;
}

export class FakeDaemon {
    readonly dir: string;
    readonly store: MeshRuntimeStore;
    readonly db: MeshRuntimeStore['db'];
    readonly keys = crypto.generateKeyPairSync('ed25519');
    journal: HandoffJournal;
    meshRecord: Record<string, unknown>;
    holds = new Set<string>();
    holdLog: string[] = [];
    freezeResult: FreezeCheck = { ready: true };
    coordinatorStops: string[] = [];
    stopFailure: Error | null = null;
    coordinatorLaunches: string[] = [];
    launchable = true;
    launchReady = true;
    missingColumns = new Set<string>();
    broadcasts: HostTransferCertificate[] = [];
    certificateResults: PeerResult[] = [];
    handedOffRows: Array<Record<string, unknown>> = [];
    applyCalls = 0;
    applyFailure: Error | null = null;
    source!: HostHandoffSource;
    target!: HostHandoffTarget;
    readonly publicKey: string;
    private idCounter = 0;

    constructor(readonly opts: DaemonOpts) {
        this.dir = mkdtempSync(join(tmpdir(), `host-handoff-${opts.id}-`));
        this.store = new (MeshRuntimeStore as unknown as new (p: string) => MeshRuntimeStore)(join(this.dir, 'mesh-runtime.db'));
        this.db = this.store.db;
        this.publicKey = (this.keys.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64url');
        this.journal = opts.sqliteJournal ? new SqliteHandoffJournal(this.db as never) : new MemoryHandoffJournal();
        this.meshRecord = {
            id: MESH, name: 'Blog', repoIdentity: 'github.com/acme/blog',
            meshHost: { role: opts.role, hostDaemonId: opts.hostDaemonId, ...(opts.role === 'host' ? { hostEpoch: 0 } : { hostEpoch: 0 }) },
            nodes: opts.memberIds.map(d => ({ id: `node-${d}`, daemonId: d, workspace: '/w' })),
            policy: {}, projectContext: {}, secretToken: 'must-not-travel', coordinator: { cliType: 'claude-cli' },
        };
        opts.net.daemons.set(opts.id, this);
        this.buildEngines();
    }

    get id(): string { return this.opts.id; }

    mesh: HandoffMeshPort = {
        setFence: (_meshId, fence, expectedHandoffId) => {
            const host = this.meshRecord.meshHost as Record<string, unknown>;
            const prior = host.handoffFence as { handoffId: string } | undefined;
            if (prior && prior.handoffId !== (fence?.handoffId ?? expectedHandoffId)) throw new Error('handoff fence identity changed');
            if (fence) host.handoffFence = fence; else delete host.handoffFence;
        },
        read: () => {
            const status = resolveMeshHostStatus(this.meshRecord);
            return {
                role: status.role, hostDaemonId: status.hostDaemonId, hostNodeId: status.hostNodeId, hostEpoch: status.hostEpoch ?? 0,
                hostPublicKey: (this.meshRecord.meshHost as { originGrantPublicKey?: string }).originGrantPublicKey,
                handedOff: !!status.handedOffTo, config: this.meshRecord,
                handoffFence: (this.meshRecord.meshHost as { handoffFence?: { handoffId: string; epoch: number } }).handoffFence,
                memberDaemonIds: (this.meshRecord.nodes as Array<{ daemonId: string }>).map(n => n.daemonId),
            };
        },
        writeHost: (_meshId: string, meta: HostMetaWrite) => {
            const prev = this.meshRecord.meshHost as Record<string, unknown>;
            this.meshRecord.meshHost = { ...prev, role: meta.role, hostDaemonId: meta.hostDaemonId, hostEpoch: meta.hostEpoch,
                ...(meta.hostNodeId ? { hostNodeId: meta.hostNodeId } : {}), ...(meta.hostPublicKey ? { originGrantPublicKey: meta.hostPublicKey } : {}), ...(meta.handedOffTo ? { handedOffTo: meta.handedOffTo } : {}) };
            if (meta.role === 'host') {
                const host = this.meshRecord.meshHost as Record<string, unknown>;
                delete host.handedOffTo; delete host.originGrantPublicKey;
            }
        },
        applyConfig: (_meshId, config) => {
            if (config) this.meshRecord = { ...config, meshHost: this.meshRecord.meshHost };
        },
    };

    /** (Re)create the engines over the SAME journal and stores — a process restart. */
    buildEngines(): void {
        const { net, clock } = this.opts;
        const certificate = {
            sign: (u: Omit<HostTransferCertificate, 'signature'>) => signHostTransferCertificate(u, this.keys.privateKey),
            ownPublicKey: () => this.publicKey,
            broadcast: async (meshId: string, cert: HostTransferCertificate, except: string[]) => {
                this.broadcasts.push(cert);
                for (const [id, peer] of net.daemons) {
                    if (except.includes(id) || net.offline.has(id)) continue;
                    peer.certificateResults.push(await net.dispatcher(this.id)(id, 'mesh_host_handoff_certificate', { meshId, handoffId: cert.handoffId, certificate: cert }));
                }
            },
        };
        const clk = { now: () => clock.now, newId: () => `h-${this.id}-${++this.idCounter}` };
        this.source = new HostHandoffSource({
            selfDaemonId: this.id, journal: this.journal, mesh: this.mesh,
            data: this.dataPort(), clock: clk,
            hold: { acquire: (m, h) => { if (this.holds.has(m)) return { ok: false, error: 'held' }; this.holds.add(m); this.holdLog.push(`acquire:${h}`); return { ok: true }; },
                release: (m, h) => { this.holds.delete(m); this.holdLog.push(`release:${h}`); } },
            freeze: { check: async () => this.freezeResult },
            coordinator: { stopSource: async (m) => {
                if (this.stopFailure) throw this.stopFailure;
                this.coordinatorStops.push(m);
            } },
            certificate,
            peer: (t) => createWirePeerClient(net.dispatcher(this.id), t),
            peerOnline: (d) => !net.offline.has(d) && net.daemons.has(d),
        });
        this.target = new HostHandoffTarget({
            selfDaemonId: this.id, journal: this.journal, mesh: this.mesh, data: this.dataPort(), clock: clk, certificate,
            coordinator: { canLaunch: () => this.launchable, launch: async (m) => { this.coordinatorLaunches.push(m); return { success: true, sessionId: 'coord-new', ready: this.launchReady }; } },
            ackClient: createWireAckClient(net.dispatcher(this.id)),
            selfNodeId: () => `node-${this.id}`,
        });
    }

    private dataPort() {
        return {
            exportSnapshot: (a: Parameters<typeof exportSnapshot>[0] extends infer T ? Omit<T & { meshConfig: unknown }, 'db' | 'chunkBytes'> : never) => exportSnapshot({ ...a, db: this.db as never, chunkBytes: 700 }),
            localColumns: (t: string) => localTableColumns(this.db as never)(t).filter(c => !this.missingColumns.has(c)),
            applySnapshot: (m: string, p: Parameters<typeof applySnapshotTables>[2]) => {
                this.applyCalls++;
                if (this.applyFailure) throw this.applyFailure;
                return applySnapshotTables(this.db as never, m, p);
            },
            freeDiskBytes: () => 10 * 1024 * 1024 * 1024,
            markHandedOff: (row: Record<string, unknown>) => { this.handedOffRows.push(row); },
        };
    }

    /** Seed host-owned data: queue, missions, items (one open decision), events, notes. */
    seed(): void {
        const t = new Date(this.opts.clock.now).toISOString();
        const run = (sql: string, ...a: unknown[]) => this.db.prepare(sql).run(...a);
        run("INSERT INTO mesh_missions (id, mesh_id, title, goal, status, created_at, updated_at) VALUES ('m1', ?, 'Ship budget', 'g', 'active', ?, ?)", MESH, t, t);
        run("INSERT INTO mesh_missions (id, mesh_id, title, goal, status, created_at, updated_at) VALUES ('m2', ?, 'Docs', 'g2', 'paused', ?, ?)", MESH, t, t);
        run("INSERT INTO mesh_mission_items (id, mission_id, mesh_id, kind, state, text, decision_json, created_at, updated_at) VALUES ('i1','m1',?, 'decision','open','Budget default?', '{\"question\":\"Budget default?\"}', ?, ?)", MESH, t, t);
        run("INSERT INTO mesh_mission_items (id, mission_id, mesh_id, kind, state, text, created_at, updated_at) VALUES ('i2','m1',?, 'task','done','done thing', ?, ?)", MESH, t, t);
        for (let n = 0; n < 12; n++) {
            run("INSERT INTO mesh_queue (id, mesh_id, status, created_at, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?)",
                `q${n}`, MESH, n % 3 === 0 ? 'completed' : n % 3 === 1 ? 'pending' : 'assigned', t, t, JSON.stringify({ message: `task ${n} `.repeat(30), n }));
        }
        run("INSERT INTO mesh_mission_events (mission_id, mesh_id, type, actor, payload_json, at) VALUES ('m1', ?, 'created', 'coordinator', '{}', ?)", MESH, t);
        run("INSERT INTO mesh_mission_events (mission_id, mesh_id, type, actor, payload_json, at) VALUES ('m1', ?, 'item_added', 'coordinator', '{\"id\":\"i1\"}', ?)", MESH, t);
        run("INSERT INTO mesh_handoff_note_text (mesh_id, task_id, notes_json, recorded_at) VALUES (?, 'q1', '[\"note\"]', ?)", MESH, t);
        run("INSERT INTO mesh_idle_reminder (mesh_id, emitted_at, set_hash) VALUES (?, 5, 'abc')", MESH);
        run("INSERT INTO assistant_threads (mesh_id, opened_at, last_send_at) VALUES (?, 1, 2)", MESH);
        // another mesh's rows must never travel
        run("INSERT INTO mesh_queue (id, mesh_id, status, created_at, updated_at, payload) VALUES ('other-q', 'other-mesh', 'pending', ?, ?, '{}')", t, t);
    }

    /** Canonical dump of the host-owned rows of the mesh (what must survive a handoff unchanged). */
    dump(): Record<string, unknown[][]> {
        return Object.fromEntries(HOST_SNAPSHOT_TABLES.map(spec => [spec.table, readTable(this.db as never, spec, MESH).rows]));
    }
    rowTotal(): number { return Object.values(this.dump()).reduce((n, rows) => n + rows.length, 0); }

    close(): void { try { this.store.close(); } catch { /* ignore */ } rmSync(this.dir, { recursive: true, force: true }); }
}

export interface World { net: FakeNet; clock: { now: number }; src: FakeDaemon; dst: FakeDaemon; other: FakeDaemon; all: FakeDaemon[]; cleanup(): void }

export const SRC = 'daemon_mach_aaaaaaaaaaaaaaaa';
export const DST = 'daemon_mach_bbbbbbbbbbbbbbbb';
export const OTH = 'daemon_mach_cccccccccccccccc';

export function makeWorld(opts: { sqliteJournal?: boolean } = {}): World {
    const net = new FakeNet();
    const clock = { now: 1_800_000_000_000 };
    const all = [SRC, DST, OTH];
    const common = { net, clock, hostDaemonId: SRC, memberIds: all, ...(opts.sqliteJournal ? { sqliteJournal: true } : {}) };
    const src = new FakeDaemon({ ...common, id: SRC, role: 'host' });
    const dst = new FakeDaemon({ ...common, id: DST, role: 'member' });
    const other = new FakeDaemon({ ...common, id: OTH, role: 'member' });
    src.seed();
    for (const m of [dst, other]) (m.meshRecord.meshHost as Record<string, unknown>).originGrantPublicKey = src.publicKey;
    return { net, clock, src, dst, other, all: [src, dst, other], cleanup: () => { for (const d of [src, dst, other]) d.close(); } };
}

export async function settle(w: World): Promise<void> {
    for (let i = 0; i < 4; i++) for (const d of w.all) { await d.source.idle(); await d.target.idle(); }
}
