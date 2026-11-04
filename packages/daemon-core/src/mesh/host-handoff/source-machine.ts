/**
 * Source side of the host handoff (design §7.2). Drives
 *   preflight -> freezing -> frozen -> exporting -> exported -> awaiting_ack -> acked -> activating -> committed
 * with `aborted` reachable until `activate` has been sent, and `uncertain`
 * (probe, never guess) when `ACTIVE` cannot be confirmed. Phases are journalled
 * BEFORE the effect they announce. A late or foreign ACK never changes state
 * (`handoff_aborted` NACK). The source is durably fenced and its coordinator's
 * exit must be proved before target activation is sent.
 */

import { brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import type { HandoffJournal } from './journal.js';
import type { HandoffPeerClient } from './peer.js';
import type {
    CertificatePort, HandoffClock, HandoffDataPort, HandoffFreezePort, HandoffHoldPort, HandoffLog, HandoffMeshPort, HandoffMetrics, SourceCoordinatorPort,
} from './ports.js';
import { describeProbeConflicts } from './snapshot-probe.js';
import { rowCountsOf, sanitizeConfigForSnapshot, snapshotBytes, type ExportedSnapshot } from './snapshot-export.js';
import {
    HOST_HANDOFF_ACK_TIMEOUT_MS, HOST_HANDOFF_ADVERTISE_INTERVAL_MS, HOST_HANDOFF_CHUNK_ATTEMPTS, HOST_HANDOFF_CHUNK_ENCODING, HOST_HANDOFF_FREEZE_TIMEOUT_MS, HOST_HANDOFF_PROBE_BASE_MS, HOST_HANDOFF_PROBE_MAX_MS, HOST_HANDOFF_PROTOCOL, HOST_HANDOFF_SEND_WINDOW,
    HOST_HANDOFF_RETENTION_MS, type HandoffLaunchPlan, type HandoffAck, type HandoffErrorCode, type HandoffRecord, type PeerResult, type PreflightCheck, type SourcePhase,
} from './types.js';

export interface SourceDeps {
    selfDaemonId: string;
    journal: HandoffJournal;
    mesh: HandoffMeshPort;
    data: HandoffDataPort;
    hold: HandoffHoldPort;
    freeze: HandoffFreezePort;
    coordinator: SourceCoordinatorPort;
    certificate: CertificatePort;
    peer: (targetDaemonId: string) => HandoffPeerClient;
    peerOnline: (daemonId: string) => boolean;
    clock: HandoffClock;
    log?: HandoffLog;
    metrics?: HandoffMetrics;
    /** Production must prove the complete preservation boundary before any freeze. */
    preservationCheck?: (meshId: string) => PreflightCheck;
}

export interface StartInput { meshId: string; targetDaemonId: string; targetNodeId?: string; handoffId?: string }

export type StartResult =
    | { success: true; handoffId: string; phase: SourcePhase }
    | { success: false; code: HandoffErrorCode | string; error: string; checks?: PreflightCheck[]; handoffId?: string; phase?: SourcePhase };

const MEMBER_UNREACHABLE = /PEER_NOT_CONNECTED|NO_PEER|NO_TRANSPORT|QUEUE_OVERFLOW|CONNECT_TIMEOUT|not connected|signaling|not available/i;

/** A refusal as the journal keeps it: the code first, so the dashboard shows which table and key. */
const refusalReason = (r: PeerResult, fallback: string): string => {
    const code = String(r.code ?? fallback);
    const detail = typeof r.error === 'string' ? r.error : '';
    return detail ? `${code}: ${detail}`.slice(0, 500) : code;
};

const refuse = (code: HandoffErrorCode | string, error: string, extra: Record<string, unknown> = {}): { success: false; code: string; error: string } & Record<string, unknown> =>
    ({ success: false, code, error, ...extra });

export class HostHandoffSource {
    private snapshots = new Map<string, ExportedSnapshot>();
    private readonly inflight = new Set<Promise<unknown>>();
    private busy = new Set<string>();
    private starting = new Set<string>();
    private activating = new Set<string>();
    private advertising = new Set<string>();
    constructor(private readonly d: SourceDeps) {}

    /** Await background work (tests). */
    async idle(): Promise<void> {
        while (this.inflight.size) await Promise.allSettled([...this.inflight]);
    }

    private log(line: string): void { this.d.log?.(`[host-handoff] ${line}`); }

    private move(id: string, to: SourcePhase, patch: Partial<HandoffRecord> = {}): HandoffRecord {
        const cur = this.d.journal.get(id, 'source')!;
        const next = this.d.journal.update(id, 'source', { phase: to, updatedAt: this.d.clock.now(), ...patch });
        this.log(`source ${id} ${cur.phase} -> ${to}${patch.abortReason ? ` (${patch.abortReason})` : ''}`);
        this.d.metrics?.phase(id, cur.phase, to, this.d.clock.now() - cur.updatedAt);
        return next;
    }

    // ── preflight ────────────────────────────────────────────────────────────

    async preflight(input: StartInput, opts: { allowOwnActive?: string } = {}): Promise<{ ok: boolean; checks: PreflightCheck[]; targetPublicKey?: string; estimateBytes?: number; launchPlan?: HandoffLaunchPlan }> {
        const checks: PreflightCheck[] = [];
        const add = (id: string, ok: boolean, code?: HandoffErrorCode, detail?: string) => { checks.push({ id, ok, ...(code && !ok ? { code } : {}), ...(detail ? { detail } : {}) }); return ok; };
        const view = this.d.mesh.read(input.meshId);
        add('is_host', !!view && view.role === 'host' && !view.handedOff && (!view.hostDaemonId || daemonIdsEquivalent(view.hostDaemonId, this.d.selfDaemonId)), 'not_host');
        add('target_not_self', !daemonIdsEquivalent(input.targetDaemonId, this.d.selfDaemonId), 'target_is_self');
        add('target_is_member', !!view?.memberDaemonIds.some(id => daemonIdsEquivalent(id, input.targetDaemonId)), 'target_not_member');
        const active = this.d.journal.findActive(input.meshId, 'source');
        add('no_other_handoff', !active || active.handoffId === opts.allowOwnActive, 'handoff_in_progress', active?.handoffId);
        add('target_online', this.d.peerOnline(input.targetDaemonId), 'target_offline');
        if (this.d.preservationCheck) checks.push(this.d.preservationCheck(input.meshId));
        let launchPlan: HandoffLaunchPlan | undefined;
        if (this.d.coordinator.selectLaunch) {
            try { launchPlan = this.d.coordinator.selectLaunch(input.meshId, input.targetNodeId); add('launch_selection', true); }
            catch (e) { add('launch_selection', false, 'target_not_launchable', (e as Error).message); }
        }
        let targetPublicKey: string | undefined;
        let estimateBytes: number | undefined;
        if (checks.every(c => c.ok)) {
            const probeId = input.handoffId ?? 'probe';
            let cap: Awaited<ReturnType<HandoffPeerClient['capability']>> | undefined;
            // The roster travels so a worker daemon with no local project record can inspect
            // its own node. Nothing in it is trusted beyond that daemon's own registered workspace.
            const offeredMesh = view?.config ? sanitizeConfigForSnapshot(view.config).value as Record<string, unknown> : null;
            try { cap = await this.d.peer(input.targetDaemonId).capability({ handoffId: probeId, meshId: input.meshId, fromDaemonId: this.d.selfDaemonId, launchPlan, sourcePublicKey: this.d.certificate.ownPublicKey(), offeredMesh }); } catch { cap = undefined; }
            const capable = !!cap && cap.success === true && cap.protocol === HOST_HANDOFF_PROTOCOL;
            add('peer_capability', capable, 'peer_capability_unconfirmed', capable ? undefined : String(cap?.code ?? 'no_response'));
            if (capable) {
                // Activation verifies the stop certificate against the target's pin. Find a
                // missing or different pin here, while nothing has stopped yet.
                add('host_key_pinned', cap!.hostKeyPinned === true, 'host_key_unpinned', cap!.hostKeyPinned === true ? undefined : 'Pair the target with this host first (create_mesh_host_pairing_token, then join_mesh_host_pairing on the target).');
                add('target_launchable', cap!.ready?.coordinatorLaunchable === true, 'target_not_launchable', JSON.stringify(cap!.ready?.checks ?? []));
                targetPublicKey = cap!.originGrantPublicKey;
                try {
                    const snap = this.d.data.exportSnapshot({ meshId: input.meshId, handoffId: probeId, fromDaemonId: this.d.selfDaemonId, toDaemonId: input.targetDaemonId, hostEpoch: view!.hostEpoch, meshConfig: view!.config, launchPlan });
                    estimateBytes = snapshotBytes(snap);
                    // Staging, the retained snapshot archive and the before-image each hold about one copy,
                    // and the rehearsal's rolled-back import needs about one more in the WAL.
                    const targetFree = cap!.diskFreeBytes;
                    add('disk_space', this.d.data.freeDiskBytes() >= estimateBytes * 2 && cap!.ready?.diskOk !== false && (targetFree === undefined || targetFree >= estimateBytes * 4), 'insufficient_disk');
                } catch (e) { add('snapshot_readable', false, 'verify_failed', (e as Error)?.message); }
            }
            if (capable) await this.checkFleetMembers(input, view?.memberDaemonIds ?? [], checks);
            if (capable) await this.checkConflictProbe(input, probeId, checks);
            const freeze = await this.d.freeze.check(input.meshId);
            // A coordinator that is merely busy is waited out during `freezing`; an open writer checkpoint is never forced.
            add('no_open_writer_checkpoint', freeze.ready || freeze.code !== 'writer_checkpoint_pending', 'writer_checkpoint_pending', freeze.ready ? undefined : freeze.detail);
        }
        return { ok: checks.every(c => c.ok), checks, ...(launchPlan ? { launchPlan } : {}), ...(targetPublicKey ? { targetPublicKey } : {}), ...(estimateBytes !== undefined ? { estimateBytes } : {}) };
    }

    /** Find a collision the import would refuse while nothing has stopped. Silence proves nothing: the rehearsal still decides. */
    private async checkConflictProbe(input: StartInput, handoffId: string, checks: PreflightCheck[]): Promise<void> {
        const client = this.d.peer(input.targetDaemonId);
        if (!client.conflictProbe || !this.d.data.buildConflictProbe) return;
        let answer: Awaited<ReturnType<NonNullable<HandoffPeerClient['conflictProbe']>>>;
        try { answer = await client.conflictProbe({ handoffId, meshId: input.meshId, probe: this.d.data.buildConflictProbe(input.meshId) }); }
        catch (e) { this.log(`conflict probe unanswered: ${(e as Error)?.message ?? e}`); return; }
        const conflicts = answer.success && Array.isArray(answer.conflicts) ? answer.conflicts : [];
        checks.push({ id: 'no_snapshot_conflicts', ok: conflicts.length === 0, ...(conflicts.length ? { code: 'snapshot_conflict' as const, detail: describeProbeConflicts(conflicts) } : {}) });
    }

    /** Every online roster member must speak this protocol, or it could never adopt the new host. */
    private async checkFleetMembers(input: StartInput, members: string[], checks: PreflightCheck[]): Promise<void> {
        const others = [...new Set(members)].filter(id => !daemonIdsEquivalent(id, this.d.selfDaemonId) && !daemonIdsEquivalent(id, input.targetDaemonId));
        const stale: string[] = [], offline: string[] = [];
        await Promise.all(others.map(async id => {
            if (!this.d.peerOnline(id)) { offline.push(id); return; }
            const probe = this.d.peer(id).memberProbe;
            let answer: { success?: boolean; protocol?: number } | undefined;
            try { answer = await probe?.({ meshId: input.meshId }); }
            catch (e) {
                // Unreachable is offline: it adopts when it returns. A daemon that answered
                // without this verb is on an older build, and that is what must block the move.
                const failure = e as { code?: unknown; message?: unknown };
                if (MEMBER_UNREACHABLE.test(`${String(failure.code ?? '')} ${String(failure.message ?? '')}`)) { offline.push(id); return; }
            }
            if (answer?.success !== true || answer.protocol !== HOST_HANDOFF_PROTOCOL) stale.push(id);
        }));
        const detail = [stale.length ? `not on protocol ${HOST_HANDOFF_PROTOCOL}: ${stale.join(', ')}` : '', offline.length ? `offline, adopts on reconnect: ${offline.join(', ')}` : ''].filter(Boolean).join('; ');
        checks.push({ id: 'fleet_members', ok: stale.length === 0, ...(stale.length ? { code: 'member_protocol_unsupported' as const } : {}), ...(detail ? { detail } : {}) });
    }

    // ── start ────────────────────────────────────────────────────────────────

    async start(input: StartInput): Promise<StartResult> {
        if (this.starting.has(input.meshId)) return refuse('handoff_in_progress', 'another start is checking this project');
        this.starting.add(input.meshId);
        try { return await this.startLocked(input); }
        finally { this.starting.delete(input.meshId); }
    }

    private async startLocked(input: StartInput): Promise<StartResult> {
        if (input.handoffId) {
            const existing = this.d.journal.get(input.handoffId, 'source');
            if (existing) {
                if (existing.meshId !== input.meshId || !daemonIdsEquivalent(existing.peerDaemonId, input.targetDaemonId)
                    || existing.targetNodeId !== input.targetNodeId) return refuse('invalid_args', 'handoffId belongs to a different request');
                return { success: true, handoffId: existing.handoffId, phase: existing.phase as SourcePhase };
            }
        }
        const active = this.d.journal.findActive(input.meshId, 'source');
        if (active) return refuse('handoff_in_progress', 'another handoff holds the project', { handoffId: active.handoffId });
        const handoffId = input.handoffId ?? this.d.clock.newId();
        const pre = await this.preflight({ ...input, handoffId });
        if (!pre.ok) {
            const first = pre.checks.find(c => !c.ok)!;
            return refuse(first.code ?? 'verify_failed', `preflight failed: ${first.id}`, { checks: pre.checks });
        }
        const view = this.d.mesh.read(input.meshId)!;
        const now = this.d.clock.now();
        this.d.journal.put({
            ...(pre.launchPlan ? { launchPlan: pre.launchPlan } : {}),
            handoffId, role: 'source', meshId: input.meshId, peerDaemonId: input.targetDaemonId, phase: 'preflight', epoch: view.hostEpoch + 1,
            ...(input.targetNodeId ? { targetNodeId: input.targetNodeId } : {}), ...(pre.targetPublicKey ? { targetPublicKey: pre.targetPublicKey } : {}),
            createdAt: now, updatedAt: now,
        });
        const hold = this.d.hold.acquire(input.meshId, handoffId);
        if (!hold.ok) {
            this.move(handoffId, 'aborted', { abortReason: 'hold_failed' });
            return refuse('hold_failed', hold.error, { handoffId, phase: 'aborted' });
        }
        this.move(handoffId, 'freezing');
        await this.advance(handoffId);
        return { success: true, handoffId, phase: this.d.journal.get(handoffId, 'source')!.phase as SourcePhase };
    }

    /** Run the state machine forward as far as it can go without waiting on the other side. */
    async advance(handoffId: string): Promise<void> {
        if (this.busy.has(handoffId)) return;
        this.busy.add(handoffId);
        try {
            for (;;) {
                const rec = this.d.journal.get(handoffId, 'source');
                if (!rec) return;
                if (rec.phase === 'freezing') {
                    const freeze = await this.d.freeze.check(rec.meshId);
                    if (!freeze.ready) {
                        if (freeze.code === 'writer_checkpoint_pending') { await this.abortInternal(rec, 'writer_checkpoint_pending'); return; }
                        if (this.d.clock.now() - rec.updatedAt >= HOST_HANDOFF_FREEZE_TIMEOUT_MS) { await this.abortInternal(rec, 'freeze_timeout'); return; }
                        return; // wait for a later tick
                    }
                    this.move(handoffId, 'frozen');
                } else if (rec.phase === 'frozen') {
                    // Stop admission and the coordinator BEFORE cutting data.
                    // Staging a snapshot while the coordinator could still write
                    // would lose changes even if activation itself was fenced.
                    this.d.mesh.setFence(rec.meshId, { handoffId, epoch: rec.epoch });
                    if (!this.d.journal.getCertificate(handoffId)?.sourceStopped) {
                        let sourceStopProof: import('./types.js').HostTransferCertificate['sourceStopProof'];
                        try { sourceStopProof = await this.d.coordinator.stopSource(rec.meshId) || undefined; }
                        catch (e) { this.log(`source stop unconfirmed: ${(e as Error)?.message ?? e}`); return; }
                        this.d.data.freezeWrites?.(rec.meshId, handoffId, rec.epoch);
                        if (!rec.targetPublicKey) { await this.abortInternal(rec, 'certificate_unavailable'); return; }
                        this.d.journal.putCertificate(handoffId, this.sourceCertificate(rec, sourceStopProof));
                    }
                    this.move(handoffId, 'exporting');
                } else if (rec.phase === 'exporting') {
                    const view = this.d.mesh.read(rec.meshId);
                    if (!view) { await this.abortInternal(rec, 'mesh_unreadable'); return; }
                    try {
                        const snap = this.d.data.exportSnapshot({ meshId: rec.meshId, handoffId, fromDaemonId: this.d.selfDaemonId, toDaemonId: rec.peerDaemonId, hostEpoch: view.hostEpoch, meshConfig: view.config, launchPlan: rec.launchPlan });
                        this.snapshots.set(handoffId, snap);
                        this.move(handoffId, 'exported', { manifestDigest: snap.manifest.digest, rowCounts: rowCountsOf(snap.manifest) });
                    } catch (e) { await this.abortInternal(rec, `export_failed:${(e as Error)?.message ?? e}`); return; }
                } else if (rec.phase === 'exported') {
                    // Journal `awaiting_ack` BEFORE the seal leaves: the target's ACK may overtake the seal's own response.
                    this.move(handoffId, 'awaiting_ack');
                    const sent = await this.transfer(rec);
                    if (!sent.ok) { await this.abortInternal(this.d.journal.get(handoffId, 'source')!, sent.code); }
                    return; // the target's ACK drives the next step
                } else {
                    return;
                }
            }
        } finally { this.busy.delete(handoffId); }
    }

    private async transfer(rec: HandoffRecord): Promise<{ ok: true } | { ok: false; code: string }> {
        let snap = this.snapshots.get(rec.handoffId);
        if (!snap) {
            const view = this.d.mesh.read(rec.meshId);
            if (!view) return { ok: false, code: 'mesh_unreadable' };
            snap = this.d.data.exportSnapshot({ meshId: rec.meshId, handoffId: rec.handoffId, fromDaemonId: this.d.selfDaemonId, toDaemonId: rec.peerDaemonId, hostEpoch: view.hostEpoch, meshConfig: view.config, launchPlan: rec.launchPlan });
            this.snapshots.set(rec.handoffId, snap);
        }
        const peer = this.d.peer(rec.peerDaemonId);
        try {
            const m = await peer.manifest({ handoffId: rec.handoffId, meshId: rec.meshId, manifest: snap.manifest });
            if (!m.success) return { ok: false, code: refusalReason(m, 'manifest_mismatch') };
            const have = new Set(m.have ?? []);
            const pending = snap.chunks.filter(c => !have.has(c.seq));
            // Chunk JSON is about 4.5x smaller encoded, and bytes are what a relayed channel is short of.
            // Only an encoding target gets a window: a plain chunk already fills the ack budget alone.
            const encode = m.encodings?.includes(HOST_HANDOFF_CHUNK_ENCODING) === true;
            let next = 0;
            let refused: string | undefined;
            const worker = async () => {
                while (next < pending.length && refused === undefined) {
                    const c = pending[next++]!;
                    const wire = encode
                        ? { data: brotliCompressSync(Buffer.from(c.data, 'utf8'), { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5, [zlibConstants.BROTLI_PARAM_LGWIN]: 22 } }).toString('base64'), encoding: HOST_HANDOFF_CHUNK_ENCODING }
                        : { data: c.data };
                    // A lost RPC on one of hundreds of chunks is not worth the whole handoff. An
                    // explicit refusal from the target still stops the transfer immediately.
                    for (let attempt = 1; ; attempt++) {
                        try {
                            const r = await peer.chunk({ handoffId: rec.handoffId, meshId: rec.meshId, seq: c.seq, sha256: c.sha256, ...wire });
                            if (!r.success) refused ??= refusalReason(r, 'chunk_hash_mismatch');
                            break;
                        } catch (e) { if (attempt >= HOST_HANDOFF_CHUNK_ATTEMPTS) throw e; }
                    }
                    // Progress, not silence: the ACK deadline starts when the copy is complete.
                    this.d.journal.update(rec.handoffId, 'source', { updatedAt: this.d.clock.now() });
                }
            };
            await Promise.all(Array.from({ length: encode ? HOST_HANDOFF_SEND_WINDOW : 1 }, worker));
            if (refused !== undefined) return { ok: false, code: refused };
            const sealed = await peer.seal({ handoffId: rec.handoffId, meshId: rec.meshId });
            if (!sealed.success) return { ok: false, code: refusalReason(sealed, 'verify_failed') };
            this.d.journal.update(rec.handoffId, 'source', { updatedAt: this.d.clock.now() });
            return { ok: true };
        } catch (e) {
            return { ok: false, code: `transfer_interrupted:${(e as Error)?.message ?? e}` };
        }
    }

    // ── ACK ──────────────────────────────────────────────────────────────────

    /** The target's positive ACK. Anything but an exact, timely match is refused without changing state. */
    async onAck(ack: HandoffAck, senderDaemonId: string): Promise<PeerResult> {
        const rec = this.d.journal.get(ack?.handoffId, 'source');
        if (!rec) return { success: false, code: 'handoff_unknown' };
        if (!daemonIdsEquivalent(rec.peerDaemonId, senderDaemonId) || !daemonIdsEquivalent(ack.targetDaemonId, senderDaemonId)) return { success: false, code: 'wrong_peer' };
        if (rec.phase === 'aborted') return { success: false, code: 'handoff_aborted' };
        if (rec.phase === 'acked' || rec.phase === 'activating' || rec.phase === 'uncertain' || rec.phase === 'committed') {
            // A repeat of an ACK we already accepted is harmless (idempotent) only when identical.
            return rec.manifestDigest === ack.manifestDigest ? { success: true, duplicate: true } : { success: false, code: 'ack_mismatch' };
        }
        if (rec.phase !== 'awaiting_ack') return { success: false, code: 'handoff_unknown', error: `not awaiting an ACK (${rec.phase})` };
        const ours = rec.rowCounts ?? {};
        const same = ack.manifestDigest === rec.manifestDigest && ack.epoch === rec.epoch && ack.meshId === rec.meshId
            && Object.keys(ours).length === Object.keys(ack.rowCounts ?? {}).length
            && Object.entries(ours).every(([t, n]) => ack.rowCounts?.[t] === n)
            && ack.readiness?.coordinatorLaunchable === true;
        if (!same) {
            await this.abortInternal(rec, 'ack_mismatch');
            return { success: false, code: 'ack_mismatch' };
        }
        this.move(rec.handoffId, 'acked');
        const run = this.activate(rec.handoffId).catch(e => this.log(`activate error ${(e as Error)?.message ?? e}`));
        this.inflight.add(run);
        void run.finally(() => this.inflight.delete(run));
        return { success: true };
    }

    // ── activate / commit ────────────────────────────────────────────────────

    private sourceCertificate(rec: HandoffRecord, sourceStopProof?: import('./types.js').HostTransferCertificate['sourceStopProof']) {
        return this.d.certificate.sign({ sourceStopped: true, ...(sourceStopProof ? { sourceStopProof } : {}), meshId: rec.meshId, newHostDaemonId: rec.peerDaemonId,
            ...(rec.targetNodeId ? { newHostNodeId: rec.targetNodeId } : {}), hostEpoch: rec.epoch,
            newHostPublicKey: rec.targetPublicKey!, handoffId: rec.handoffId, previousHostDaemonId: this.d.selfDaemonId,
            issuedAt: this.d.clock.now() });
    }

    private async activate(handoffId: string): Promise<void> {
        if (this.activating.has(handoffId)) return;
        this.activating.add(handoffId);
        try { await this.activateLocked(handoffId); }
        finally { this.activating.delete(handoffId); }
    }

    private async activateLocked(handoffId: string): Promise<void> {
        let rec = this.d.journal.get(handoffId, 'source');
        if (!rec || (rec.phase !== 'acked' && rec.phase !== 'uncertain')) return;
        const view = this.d.mesh.read(rec.meshId);
        if (!view || !rec.targetPublicKey) { await this.abortInternal(rec, 'certificate_unavailable'); return; }
        // Fence FIRST. The config-backed admission fence also prevents restore
        // if this daemon dies during stop or while the activate reply is lost.
        this.d.mesh.setFence(rec.meshId, { handoffId, epoch: rec.epoch });
        try { if (!this.d.journal.getCertificate(handoffId)?.sourceStopped) await this.d.coordinator.stopSource(rec.meshId); }
        catch (e) {
            this.log(`source stop unconfirmed: ${(e as Error)?.message ?? e}`);
            return; // no activate byte leaves; owner can retry or abort this fenced ACK
        }
        const cert = this.d.journal.getCertificate(handoffId) ?? this.sourceCertificate(rec);
        this.d.journal.putCertificate(handoffId, cert);
        // Durable commit intent BEFORE the first byte of `activate` leaves: from here on, abort is no longer free.
        rec = this.move(handoffId, 'activating', { commitIntentAt: this.d.clock.now() });
        let res: Awaited<ReturnType<HandoffPeerClient['activate']>>;
        try { res = await this.d.peer(rec.peerDaemonId).activate({ handoffId, meshId: rec.meshId, epoch: rec.epoch, certificate: cert }); }
        catch (e) { this.move(handoffId, 'uncertain', { probeCount: 0, lastProbeAt: this.d.clock.now() }); this.log(`activate response lost: ${(e as Error)?.message ?? e}`); return; }
        if (res.success && res.applied !== false) { await this.commit(handoffId, { coordinatorReady: res.coordinatorReady === true }, cert); return; }
        // A refusal alone does not revoke a delayed activate. Only a retained
        // tombstone for this exact epoch proves the target cannot later apply.
        if (res.applied === false && res.discarded === true && res.phase === 'discarded' && res.epoch === rec.epoch) {
            await this.abortInternal(this.d.journal.get(handoffId, 'source')!, refusalReason(res, 'activate_failed'), true); return;
        }
        this.move(handoffId, 'uncertain', { probeCount: 0, lastProbeAt: this.d.clock.now() });
    }

    private async commit(handoffId: string, info: { coordinatorReady: boolean }, cert?: import('./types.js').HostTransferCertificate): Promise<void> {
        const rec = this.d.journal.get(handoffId, 'source')!;
        if (rec.phase === 'committed') return;
        const now = this.d.clock.now();
        const retainUntil = now + HOST_HANDOFF_RETENTION_MS;
        // Local effects first, journal last: a crash in between re-runs this idempotently from `activating`/`uncertain`.
        this.d.mesh.writeHost(rec.meshId, {
            role: 'member', hostDaemonId: rec.peerDaemonId, ...(rec.targetNodeId ? { hostNodeId: rec.targetNodeId } : {}), hostEpoch: rec.epoch,
            ...(rec.targetPublicKey ? { hostPublicKey: rec.targetPublicKey } : {}),
            handedOffTo: { daemonId: rec.peerDaemonId, epoch: rec.epoch, handoffId, at: now, retainUntil },
        });
        this.d.data.markHandedOff({ meshId: rec.meshId, handoffId, newHostDaemonId: rec.peerDaemonId, epoch: rec.epoch, handedOffAt: now, retainUntil });
        this.move(handoffId, 'committed');
        this.d.mesh.setFence(rec.meshId, null, handoffId);
        this.snapshots.delete(handoffId);
        this.d.hold.release(rec.meshId, handoffId);
        const view = this.d.mesh.read(rec.meshId);
        const certificate = cert ?? this.d.journal.getCertificate(handoffId);
        if (certificate && !this.d.certificate.deliver) void this.d.certificate.broadcast(rec.meshId, certificate, [this.d.selfDaemonId, rec.peerDaemonId]).catch(() => undefined);
        void view;
        await this.advertise(handoffId, true);
        // Source stop was proved BEFORE activate. A target launch failure never
        // permits automatic source resurrection after target authority was granted.
        void info;
    }

    // ── abort ────────────────────────────────────────────────────────────────

    /** An inherited v1 intent may have activated the target before stopping the
     * source. Never infer v2 stop proof from that journal's phase alone. */
    private async verifyRecoveredSourceStop(rec: HandoffRecord): Promise<boolean> {
        if (this.d.journal.getCertificate(rec.handoffId)?.sourceStopped === true) return true;
        try {
            this.d.mesh.setFence(rec.meshId, { handoffId: rec.handoffId, epoch: rec.epoch });
            await this.d.coordinator.stopSource(rec.meshId);
            this.d.data.freezeWrites?.(rec.meshId, rec.handoffId, rec.epoch);
            return true;
        } catch (e) {
            this.log(`legacy source stop unconfirmed: ${(e as Error)?.message ?? e}`);
            return false;
        }
    }

    private async abortInternal(rec: HandoffRecord, reason: string, targetAlreadyDiscarded = false): Promise<void> {
        const cur = this.d.journal.get(rec.handoffId, 'source');
        if (!cur || cur.phase === 'aborted' || cur.phase === 'committed') return;
        if (!targetAlreadyDiscarded && (cur.commitIntentAt !== undefined || this.activating.has(rec.handoffId))) return;
        this.d.mesh.setFence(rec.meshId, null, rec.handoffId);
        this.move(rec.handoffId, 'aborted', { abortReason: reason });
        this.snapshots.delete(rec.handoffId);
        this.d.hold.release(rec.meshId, rec.handoffId);
        // This abort can no longer activate: commit intent was never written, or the
        // target proved a discard. Undo the one effect the owner would notice.
        const stopped = this.d.journal.getCertificate(rec.handoffId)?.sourceStopProof?.sessionIds ?? [];
        if (stopped.length && this.d.coordinator.restoreSource) {
            const run = this.restore(rec.handoffId, rec.meshId);
            this.inflight.add(run);
            void run.finally(() => this.inflight.delete(run));
        }
        if (!targetAlreadyDiscarded) { try { await this.d.peer(rec.peerDaemonId).discard({ handoffId: rec.handoffId, meshId: rec.meshId }); } catch { /* target discards on its own TTL / next contact */ } }
    }

    private async restore(handoffId: string, meshId: string): Promise<void> {
        let restore: NonNullable<HandoffRecord['restore']>;
        try {
            const out = await this.d.coordinator.restoreSource!(meshId);
            restore = { ok: out.success === true, ...(out.sessionId ? { sessionId: out.sessionId } : {}), ...(out.error ? { error: out.error } : {}), at: this.d.clock.now() };
        } catch (e) { restore = { ok: false, error: (e as Error)?.message ?? String(e), at: this.d.clock.now() }; }
        this.log(`source coordinator restore ${restore.ok ? 'ok' : `failed: ${restore.error ?? 'unknown'}`}`);
        this.d.journal.update(handoffId, 'source', { restore });
    }

    /** Offer the transfer to every roster member that has not taken it. Members offline at
     * commit adopt here when they return, for as long as the source retains the handoff. */
    private async advertise(handoffId: string, force: boolean): Promise<void> {
        const deliver = this.d.certificate.deliver;
        if (!deliver || this.advertising.has(handoffId)) return;
        const rec = this.d.journal.get(handoffId, 'source');
        const cert = this.d.journal.getCertificate(handoffId);
        if (!rec || rec.phase !== 'committed' || !cert) return;
        const now = this.d.clock.now();
        if (!force && rec.lastAdvertiseAt !== undefined && now - rec.lastAdvertiseAt < HOST_HANDOFF_ADVERTISE_INTERVAL_MS) return;
        const acks = new Set(rec.memberAcks ?? []);
        const members = [...new Set(this.d.mesh.read(rec.meshId)?.memberDaemonIds ?? [])]
            .filter(id => !daemonIdsEquivalent(id, this.d.selfDaemonId) && !daemonIdsEquivalent(id, rec.peerDaemonId) && ![...acks].some(a => daemonIdsEquivalent(a, id)));
        if (!members.length) return;
        this.advertising.add(handoffId);
        try {
            for (const id of members) {
                if (!this.d.peerOnline(id)) continue;
                try { if (await deliver(id, rec.meshId, cert)) acks.add(id); } catch { /* retried at the next interval */ }
            }
            this.d.journal.update(handoffId, 'source', { memberAcks: [...acks], lastAdvertiseAt: now });
        } finally { this.advertising.delete(handoffId); }
    }

    /** Owner abort. After `activate` was sent, only a target-confirmed discard permits it. */
    async abort(handoffId: string, reason = 'owner_abort'): Promise<PeerResult> {
        const rec = this.d.journal.get(handoffId, 'source');
        if (!rec) return { success: false, code: 'handoff_unknown' };
        if (this.activating.has(handoffId) || this.busy.has(handoffId)) return { success: false, code: 'handoff_in_progress', error: 'source transfer, stop or activation is in progress' };
        if (rec.phase === 'committed') return { success: false, code: 'already_committed' };
        if (rec.phase === 'aborted') return { success: true, duplicate: true };
        if (rec.phase === 'activating' || rec.phase === 'uncertain') {
            if (!await this.verifyRecoveredSourceStop(rec)) return { success: false, code: 'coordinator_not_quiescent' };
            let status: Awaited<ReturnType<HandoffPeerClient['status']>> | undefined;
            try { status = await this.d.peer(rec.peerDaemonId).status({ handoffId, meshId: rec.meshId }); } catch { status = undefined; }
            if (status?.success && status.phase === 'active' && status.epoch === rec.epoch && status.unknown !== true) { await this.commit(handoffId, { coordinatorReady: false }); return { success: false, code: 'already_committed' }; }
            if (!(status?.success && status.phase === 'discarded' && status.epoch === rec.epoch && status.unknown !== true)) return { success: false, code: 'abort_requires_target_confirmation', error: 'the target must be reachable and prove this exact handoff was discarded' };
            await this.abortInternal(rec, reason, true);
            return { success: true };
        }
        await this.abortInternal(rec, reason);
        return { success: true };
    }

    // ── tick / resume / status ───────────────────────────────────────────────

    async tick(): Promise<void> {
        const now = this.d.clock.now();
        for (const rec of this.d.journal.list().filter(r => r.role === 'source')) {
            if (rec.phase === 'freezing' || rec.phase === 'frozen') await this.advance(rec.handoffId);
            else if (rec.phase === 'awaiting_ack' && !this.busy.has(rec.handoffId) && now - rec.updatedAt >= HOST_HANDOFF_ACK_TIMEOUT_MS) await this.abortInternal(rec, 'ack_timeout');
            else if (rec.phase === 'committed' && now - rec.updatedAt < HOST_HANDOFF_RETENTION_MS) await this.advertise(rec.handoffId, false);
            else if (rec.phase === 'uncertain' || (rec.phase === 'activating' && !this.activating.has(rec.handoffId) && rec.commitIntentAt)) await this.probe(rec.handoffId, false);
        }
    }

    /** Probe the target for an unconfirmed activation. `force` ignores the backoff. */
    async probe(handoffId: string, force: boolean): Promise<PeerResult & { phase?: string }> {
        const rec = this.d.journal.get(handoffId, 'source');
        if (!rec) return { success: false, code: 'handoff_unknown' };
        if (rec.phase !== 'uncertain' && rec.phase !== 'activating') return { success: true, phase: rec.phase };
        if (!await this.verifyRecoveredSourceStop(rec)) return { success: false, phase: rec.phase, code: 'coordinator_not_quiescent' };
        const count = rec.probeCount ?? 0;
        const wait = Math.min(HOST_HANDOFF_PROBE_BASE_MS * 2 ** count, HOST_HANDOFF_PROBE_MAX_MS);
        if (!force && rec.lastProbeAt !== undefined && this.d.clock.now() - rec.lastProbeAt < wait) return { success: true, phase: rec.phase, waiting: true };
        this.d.journal.update(handoffId, 'source', { probeCount: count + 1, lastProbeAt: this.d.clock.now() });
        let status: Awaited<ReturnType<HandoffPeerClient['status']>>;
        try { status = await this.d.peer(rec.peerDaemonId).status({ handoffId, meshId: rec.meshId }); }
        catch { return { success: true, phase: 'uncertain', unreachable: true }; }
        if (!status.success) return { success: true, phase: 'uncertain', unreachable: true };
        if (status.phase === 'active' && status.epoch === rec.epoch && status.unknown !== true) { await this.commit(handoffId, { coordinatorReady: false }); return { success: true, phase: 'committed' }; }
        if (status.phase === 'discarded' && status.epoch === rec.epoch && status.unknown !== true) { await this.abortInternal(this.d.journal.get(handoffId, 'source')!, 'target_discarded', true); return { success: true, phase: 'aborted' }; }
        if (status.unknown === true || status.epoch !== rec.epoch) return { success: true, phase: 'uncertain', unverified: true };
        // still staged / verified / acked: re-send activate (idempotent on the target)
        if (rec.phase === 'activating') this.move(handoffId, 'uncertain');
        await this.activate(handoffId);
        return { success: true, phase: this.d.journal.get(handoffId, 'source')!.phase };
    }

    /** After a process restart: pre-activation handoffs are cleaned up, post-intent ones are probed. */
    async resume(): Promise<void> {
        for (const rec of this.d.journal.list().filter(r => r.role === 'source')) {
            if (rec.phase === 'committed' || rec.phase === 'aborted') continue;
            if (rec.phase === 'frozen') { await this.advance(rec.handoffId); continue; }
            if (rec.phase === 'acked') { await this.activate(rec.handoffId); continue; }
            if (rec.phase === 'activating' || rec.phase === 'uncertain') {
                if (rec.phase === 'activating') this.move(rec.handoffId, 'uncertain');
                await this.probe(rec.handoffId, true);
            } else {
                await this.abortInternal(rec, 'source_restarted');
            }
        }
    }

    /** Owner retry: re-drive the transfer of an unacknowledged snapshot, or re-probe an unconfirmed activation. */
    async retry(handoffId: string): Promise<PeerResult & { phase?: string }> {
        const rec = this.d.journal.get(handoffId, 'source');
        if (!rec) return { success: false, code: 'handoff_unknown' };
        if (rec.phase === 'awaiting_ack') {
            if (this.busy.has(handoffId)) return { success: true, phase: 'awaiting_ack', transferring: true };
            this.busy.add(handoffId);
            try {
                const sent = await this.transfer(rec);
                if (!sent.ok) { this.busy.delete(handoffId); await this.abortInternal(rec, sent.code); return { success: false, code: sent.code, phase: 'aborted' }; }
            } finally { this.busy.delete(handoffId); }
            this.d.journal.update(handoffId, 'source', { updatedAt: this.d.clock.now() });
            return { success: true, phase: 'awaiting_ack' };
        }
        if (rec.phase === 'acked') { await this.activate(handoffId); return { success: true, phase: this.d.journal.get(handoffId, 'source')!.phase }; }
        if (rec.phase === 'uncertain' || rec.phase === 'activating') return this.probe(handoffId, true);
        if (rec.phase === 'freezing' || rec.phase === 'frozen') { await this.advance(handoffId); return { success: true, phase: this.d.journal.get(handoffId, 'source')!.phase }; }
        return { success: true, phase: rec.phase };
    }

    /** True while a handoff of the mesh holds it frozen (anything from `freezing` to `uncertain`). */
    isFrozen(meshId: string): boolean {
        return this.d.journal.findActive(meshId, 'source') !== null;
    }

    async evidence(handoffId: string): Promise<Record<string, unknown>> {
        const rec = this.d.journal.get(handoffId, 'source');
        if (!rec) return {};
        const certificate = this.d.journal.getCertificate(handoffId);
        let timer: ReturnType<typeof setTimeout> | undefined;
        let target: PeerResult | undefined;
        try {
            target = await Promise.race([this.d.peer(rec.peerDaemonId).status({ handoffId, meshId: rec.meshId }),
                new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('target observation timeout')), 3_000); })]);
        } catch { /* uncertainty is shown; never inferred as coordinator readiness */ }
        finally { if (timer) clearTimeout(timer); }
        return { sourceStopped: certificate?.sourceStopped === true, sourceStopProof: certificate?.sourceStopProof,
            sourceDaemonId: this.d.selfDaemonId, target: target?.success ? target : { unknown: true } };
    }

    status(a: { handoffId?: string; meshId?: string }): HandoffRecord | null {
        if (a.handoffId) return this.d.journal.get(a.handoffId, 'source');
        if (a.meshId) return this.d.journal.findActive(a.meshId, 'source') ?? [...this.d.journal.list(a.meshId)].filter(r => r.role === 'source').sort((x, y) => y.updatedAt - x.updatedAt)[0] ?? null;
        return null;
    }
}
