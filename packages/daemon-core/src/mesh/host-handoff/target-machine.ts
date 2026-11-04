/**
 * Target side of the host handoff (design §7.2). The snapshot is staged OUTSIDE
 * the live tables, verified, and acknowledged; only an `activate` from the
 * source applies it (one transaction), takes the host role at `epoch` and
 * launches the coordinator. A restart resumes from the journal: staging is
 * durable and re-applying is idempotent.
 */

import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { brotliDecompressSync } from 'node:zlib';
import type { HandoffJournal } from './journal.js';
import type { HandoffAckClient } from './peer.js';
import type { CertificatePort, HandoffClock, HandoffDataPort, HandoffLog, HandoffMeshPort, TargetCoordinatorPort } from './ports.js';
import { verifyStagedSnapshot } from './snapshot-import.js';
import { sha256Hex } from './snapshot-export.js';
import { verifyHostTransferCertificate } from './certificate.js';
import { originGrantPublicKeysEqual } from '../origin-grant-keypair.js';
import type { ProbeConflict, SnapshotConflictProbe } from './snapshot-probe.js';
import { HOST_HANDOFF_CHUNK_ENCODING, HOST_HANDOFF_PROTOCOL, type HandoffLaunchPlan, type HandoffAck, type HandoffManifest, type HandoffRecord, type HostTransferCertificate, type PeerResult, type TargetPhase } from './types.js';

export interface TargetDeps {
    selfDaemonId: string;
    journal: HandoffJournal;
    mesh: HandoffMeshPort;
    data: HandoffDataPort;
    coordinator: TargetCoordinatorPort;
    certificate: CertificatePort;
    ackClient: HandoffAckClient;
    clock: HandoffClock;
    selfNodeId?: (meshId: string) => string | undefined;
    log?: HandoffLog;
}

/** Staged-but-never-activated handoffs are discarded after this long without contact. */
export const TARGET_STAGE_TTL_MS = 30 * 60_000;
/** The canary already proved this exact selection moments ago; do not bill it again after apply. */
const POST_APPLY_CANARY_MAX_AGE_MS = 15 * 60_000;
const LAUNCH_RETRY_MS = 60_000;
const LAUNCH_MAX_ATTEMPTS = 5;
const LAUNCH_CONVERGE_WINDOW_MS = 60 * 60_000;

const fail = (code: string, error?: string, extra: Record<string, unknown> = {}): PeerResult => ({ success: false, code, ...(error ? { error } : {}), ...extra });

export class HostHandoffTarget {
    private readonly inflight = new Set<Promise<unknown>>();
    private readonly activations = new Map<string, Promise<PeerResult>>();
    constructor(private readonly d: TargetDeps) {}

    async idle(): Promise<void> { while (this.inflight.size) await Promise.allSettled([...this.inflight]); }
    private log(line: string): void { this.d.log?.(`[host-handoff] ${line}`); }

    private move(id: string, to: TargetPhase, patch: Partial<HandoffRecord> = {}): HandoffRecord {
        const cur = this.d.journal.get(id, 'target')!;
        this.log(`target ${id} ${cur.phase} -> ${to}`);
        return this.d.journal.update(id, 'target', { phase: to, updatedAt: this.d.clock.now(), ...patch });
    }

    private requireSource(rec: HandoffRecord, sender: string): PeerResult | null {
        return daemonIdsEquivalent(rec.peerDaemonId, sender) ? null : fail('wrong_peer');
    }

    /** Local record first; a worker daemon may know the project only through its pairing record. */
    private memberView(meshId: string, sender: string) {
        return this.d.mesh.read(meshId) ?? this.d.mesh.describeMember?.(meshId, sender) ?? null;
    }

    async capability(a: { handoffId: string; meshId: string; fromDaemonId: string; launchPlan?: HandoffLaunchPlan; sourcePublicKey?: string; offeredMesh?: Record<string, unknown> | null }, sender: string): Promise<PeerResult & { protocol?: number; targetDaemonId?: string; originGrantPublicKey?: string; hostKeyPinned?: boolean; diskFreeBytes?: number; ready?: { coordinatorLaunchable: boolean; diskOk: boolean; checks?: Array<{ id: string; ok: boolean; detail?: string }> } }> {
        const view = this.memberView(a.meshId, sender);
        if (!view || view.role !== 'member') return fail('target_not_member', 'this daemon is not a member of the mesh');
        if (!view.hostDaemonId || !daemonIdsEquivalent(view.hostDaemonId, sender)) return fail('wrong_peer', 'sender is not this member\'s host');
        const active = this.d.journal.findActive(a.meshId, 'target');
        if (active && active.handoffId !== a.handoffId) return fail('handoff_in_progress');
        // Compared here, never adopted here: a key offered over the wire is not a pin.
        if (view.hostPublicKey && a.sourcePublicKey && !originGrantPublicKeysEqual(view.hostPublicKey, a.sourcePublicKey)) {
            return fail('host_key_mismatch', 'the host key pinned on this machine differs from the key the host presents');
        }
        const readiness = await this.d.coordinator.readiness?.(a.meshId, a.launchPlan, { offeredMesh: a.offeredMesh ?? null });
        return {
            success: true, protocol: HOST_HANDOFF_PROTOCOL, targetDaemonId: this.d.selfDaemonId, originGrantPublicKey: this.d.certificate.ownPublicKey(),
            hostKeyPinned: !!view.hostPublicKey, diskFreeBytes: this.d.data.freeDiskBytes(),
            ready: { coordinatorLaunchable: readiness?.ok ?? this.d.coordinator.canLaunch(a.meshId), ...(readiness ? { checks: readiness.checks } : {}), diskOk: this.d.data.freeDiskBytes() > 64 * 1024 * 1024 },
        };
    }

    /** Answer from the same member check as `capability`, before anything froze. Read-only. */
    conflictProbe(a: { handoffId: string; meshId: string; probe: SnapshotConflictProbe }, sender: string): PeerResult & { conflicts?: ProbeConflict[] } {
        const view = this.memberView(a.meshId, sender);
        if (!view || view.role !== 'member' || !view.hostDaemonId || !daemonIdsEquivalent(view.hostDaemonId, sender)) return fail('wrong_peer');
        if (!this.d.data.findProbeConflicts) return fail('invalid_args', 'conflict probe unavailable');
        return { success: true, conflicts: this.d.data.findProbeConflicts(a.meshId, a.probe) };
    }

    manifest(a: { handoffId: string; meshId: string; manifest: HandoffManifest }, sender: string): PeerResult & { have?: number[]; encodings?: string[] } {
        const m = a.manifest;
        if (!m || m.protocol !== HOST_HANDOFF_PROTOCOL || m.handoffId !== a.handoffId || m.meshId !== a.meshId) return fail('manifest_mismatch');
        if (!daemonIdsEquivalent(m.fromDaemonId, sender) || !daemonIdsEquivalent(m.toDaemonId, this.d.selfDaemonId)) return fail('wrong_peer');
        const view = this.memberView(a.meshId, sender);
        if (!view || view.role !== 'member' || !view.hostDaemonId || !daemonIdsEquivalent(view.hostDaemonId, sender)) return fail('wrong_peer');
        if (m.nextEpoch !== m.hostEpoch + 1 || (!view.unrecorded && m.hostEpoch !== view.hostEpoch)) return fail('stale_epoch');
        const existing = this.d.journal.get(a.handoffId, 'target');
        if (existing) {
            if (existing.phase === 'discarded') return fail('handoff_aborted');
            if (existing.phase === 'active') return fail('already_committed');
            if (existing.manifestDigest !== m.digest) return fail('manifest_mismatch');
            return { success: true, have: this.d.journal.getChunks(a.handoffId).map(c => c.seq), encodings: [HOST_HANDOFF_CHUNK_ENCODING] };
        }
        const other = this.d.journal.findActive(a.meshId, 'target');
        if (other) return fail('handoff_in_progress');
        const now = this.d.clock.now();
        this.d.journal.put({
            ...(m.launchPlan ? { launchPlan: m.launchPlan, targetNodeId: m.launchPlan.targetNodeId } : {}),
            handoffId: a.handoffId, role: 'target', meshId: a.meshId, peerDaemonId: sender, phase: 'importing', epoch: m.nextEpoch,
            manifestDigest: m.digest, createdAt: now, updatedAt: now,
        });
        this.d.journal.putManifest(a.handoffId, m);
        return { success: true, have: [], encodings: [HOST_HANDOFF_CHUNK_ENCODING] };
    }

    chunk(a: { handoffId: string; meshId: string; seq: number; sha256: string; data: string; encoding?: string }, sender: string): PeerResult {
        const rec = this.d.journal.get(a.handoffId, 'target');
        if (!rec) return fail('handoff_unknown');
        const wrong = this.requireSource(rec, sender); if (wrong) return wrong;
        if (rec.phase === 'discarded') return fail('handoff_aborted');
        if (rec.phase !== 'importing') return { success: true, duplicate: true };
        const want = this.d.journal.getManifest(a.handoffId)?.chunks.find(c => c.seq === a.seq);
        if (!want || want.sha256 !== a.sha256) return fail('chunk_hash_mismatch', `chunk ${a.seq} is not in the manifest`);
        let data = a.data;
        if (a.encoding !== undefined) {
            if (a.encoding !== HOST_HANDOFF_CHUNK_ENCODING) return fail('chunk_hash_mismatch', `chunk ${a.seq}: unknown encoding`);
            // The manifest bounds the output, so a hostile stream cannot expand past what was declared.
            try { data = brotliDecompressSync(Buffer.from(a.data, 'base64'), { maxOutputLength: want.bytes + 1 }).toString('utf8'); }
            catch { return fail('chunk_hash_mismatch', `chunk ${a.seq} did not decode`); }
        }
        if (typeof data !== 'string' || sha256Hex(data) !== a.sha256) return fail('chunk_hash_mismatch', `chunk ${a.seq}`);
        this.d.journal.putChunk(a.handoffId, a.seq, a.sha256, data);
        this.d.journal.update(a.handoffId, 'target', { updatedAt: this.d.clock.now() });
        return { success: true };
    }

    /** Verify the staged copy and (asynchronously) send the positive ACK. */
    seal(a: { handoffId: string; meshId: string }, sender: string): PeerResult {
        const rec = this.d.journal.get(a.handoffId, 'target');
        if (!rec) return fail('handoff_unknown');
        const wrong = this.requireSource(rec, sender); if (wrong) return wrong;
        if (rec.phase === 'discarded') return fail('handoff_aborted');
        if (rec.phase === 'verified') {
            // The ACK did not get through (or the source asked again after a restart): say it again, identically.
            const m = this.d.journal.getManifest(a.handoffId)!;
            const again: HandoffAck = {
                handoffId: a.handoffId, meshId: a.meshId, epoch: rec.epoch, manifestDigest: m.digest, rowCounts: rec.rowCounts ?? {},
                targetDaemonId: this.d.selfDaemonId, readiness: { coordinatorLaunchable: this.d.coordinator.canLaunch(a.meshId) },
            };
            const rerun = this.sendAck(rec.peerDaemonId, again).catch(e => this.log(`ack delivery failed: ${(e as Error)?.message ?? e}`));
            this.inflight.add(rerun);
            void rerun.finally(() => this.inflight.delete(rerun));
            return { success: true, verifying: true };
        }
        if (rec.phase !== 'importing') return { success: true, verifying: false, phase: rec.phase };
        const manifest = this.d.journal.getManifest(a.handoffId)!;
        const result = verifyStagedSnapshot(manifest, this.d.journal.getChunks(a.handoffId), t => this.d.data.localColumns(t));
        if (!result.ok) {
            this.discardInternal(rec, `verify:${result.code}`);
            return fail(result.code, result.detail);
        }
        // The real import inside a rolled-back transaction. A conflict found here costs a
        // coordinator restart on the source. Found after the certificate, it would strand the project.
        try {
            this.d.data.dryRunApply?.(rec.meshId, result.payload, { handoffId: rec.handoffId, sourceDaemonId: rec.peerDaemonId, snapshotDigest: manifest.digest, epoch: rec.epoch });
        } catch (e) {
            const detail = (e as Error)?.message ?? String(e);
            this.log(`snapshot would not apply: ${detail}`);
            this.discardInternal(rec, `snapshot_conflict:${detail}`);
            return fail('snapshot_conflict', detail);
        }
        this.move(a.handoffId, 'staged');
        this.move(a.handoffId, 'verified', { rowCounts: result.rowCounts });
        const ack: HandoffAck = {
            handoffId: a.handoffId, meshId: a.meshId, epoch: rec.epoch, manifestDigest: manifest.digest, rowCounts: result.rowCounts,
            targetDaemonId: this.d.selfDaemonId, readiness: { coordinatorLaunchable: this.d.coordinator.canLaunch(a.meshId) },
        };
        const run = this.sendAck(rec.peerDaemonId, ack).catch(e => this.log(`ack delivery failed: ${(e as Error)?.message ?? e}`));
        this.inflight.add(run);
        void run.finally(() => this.inflight.delete(run));
        return { success: true, verifying: true };
    }

    private async sendAck(source: string, ack: HandoffAck): Promise<void> {
        const res = await this.d.ackClient.ack(source, ack);
        const rec = this.d.journal.get(ack.handoffId, 'target');
        if (!rec || rec.phase !== 'verified') return;
        if (res.success) { this.move(ack.handoffId, 'acked'); return; }
        // The source refused: aborted/unknown/mismatched. Our staged copy is worthless — never keep it around.
        this.discardInternal(rec, `ack_refused:${res.code ?? 'unknown'}`);
    }

    async activate(a: { handoffId: string; meshId: string; epoch: number; certificate: HostTransferCertificate }, sender: string): Promise<PeerResult & { applied?: boolean; coordinatorReady?: boolean; coordinatorSessionId?: string }> {
        const pending = this.activations.get(a.handoffId);
        if (pending) return fail('handoff_in_progress');
        const run = this.activateLocked(a, sender);
        this.activations.set(a.handoffId, run);
        try { return await run; }
        finally { this.activations.delete(a.handoffId); }
    }

    private async activateLocked(a: { handoffId: string; meshId: string; epoch: number; certificate: HostTransferCertificate }, sender: string): Promise<PeerResult & { applied?: boolean; coordinatorReady?: boolean; coordinatorSessionId?: string }> {
        const rec = this.d.journal.get(a.handoffId, 'target');
        if (!rec) return fail('not_staged', 'no staged snapshot', { applied: false });
        const wrong = this.requireSource(rec, sender); if (wrong) return { ...wrong, applied: false };
        if (a.meshId !== rec.meshId || a.epoch !== rec.epoch) return fail('invalid_args');
        const saved = this.d.journal.getCertificate(a.handoffId);
        if (rec.phase === 'active' || rec.phase === 'activating') {
            if (!saved || saved.signature !== a.certificate?.signature) return fail('certificate_invalid');
        } else {
            const view = this.memberView(rec.meshId, rec.peerDaemonId);
            const cert = a.certificate;
            const valid = cert && cert.sourceStopped === true && cert.handoffId === rec.handoffId
                && cert.hostEpoch === rec.epoch && daemonIdsEquivalent(cert.newHostDaemonId, this.d.selfDaemonId)
                && cert.newHostPublicKey === this.d.certificate.ownPublicKey() && view?.hostPublicKey
                && verifyHostTransferCertificate(cert, { meshId: rec.meshId, pinnedHostDaemonId: rec.peerDaemonId,
                    pinnedHostPublicKey: view.hostPublicKey, heldEpoch: view.unrecorded ? rec.epoch - 1 : view.hostEpoch }).ok;
            if (!valid) return fail('certificate_invalid', 'verified source stop certificate required', { applied: false });
        }
        // An active authority is not evidence of a ready coordinator process.
        if (rec.phase === 'active') {
            const observed = await this.d.coordinator.observe?.(rec.meshId, rec.launchPlan);
            return { success: true, applied: true, duplicate: true, coordinatorReady: observed?.ready === true, ...(observed?.sessionId ? { coordinatorSessionId: observed.sessionId } : {}), observation: observed };
        }
        if (rec.phase === 'discarded') return fail('handoff_aborted', undefined, { applied: false, discarded: true, phase: 'discarded', epoch: rec.epoch });
        if (a.epoch !== rec.epoch) return fail('stale_epoch', undefined, { applied: false });
        if (rec.phase !== 'verified' && rec.phase !== 'acked' && rec.phase !== 'activating') return fail('not_staged', `phase ${rec.phase}`, { applied: false });
        const manifest = this.d.journal.getManifest(a.handoffId);
        if (!manifest) return fail('not_staged', 'manifest missing', { applied: false });
        const verified = verifyStagedSnapshot(manifest, this.d.journal.getChunks(a.handoffId), t => this.d.data.localColumns(t));
        if (!verified.ok) { this.discardInternal(rec, `reverify:${verified.code}`); return fail(verified.code, verified.detail, { applied: false, discarded: true, phase: 'discarded', epoch: rec.epoch }); }
        if (manifest.launchPlan && manifest.launchPlan.targetNodeId !== a.certificate.newHostNodeId) return fail('certificate_invalid');
        if (this.d.coordinator.readiness) {
            const readiness = await this.d.coordinator.readiness(rec.meshId, manifest.launchPlan, { offeredMesh: verified.payload.config });
            const current = this.d.journal.get(rec.handoffId, 'target');
            // The ACK's own reply can land during this await and move verified -> acked. That is the
            // handoff going right, not a concurrent change: only a discard or a new phase refuses.
            const stillStaged = (phase?: string) => phase === 'verified' || phase === 'acked';
            if (!current || (current.phase !== rec.phase && !(stillStaged(current.phase) && stillStaged(rec.phase)))) return fail('handoff_in_progress');
            if (!readiness.ok) {
                const failed = readiness.checks.filter(check => !check.ok).map(check => check.id).join(',') || 'unknown';
                this.log(`target readiness refused: ${failed}`);
                if (rec.phase === 'activating') return fail('target_not_launchable', 'Activation remains fenced until target readiness recovers.');
                this.discardInternal(rec, 'target_readiness_failed');
                return fail('target_not_launchable', 'Target readiness changed; staged authority discarded.', { applied: false, discarded: true, phase: 'discarded', epoch: rec.epoch });
            }
        }
        const firstApply = rec.phase !== 'activating';
        this.d.journal.putCertificate(a.handoffId, a.certificate);
        this.move(a.handoffId, 'activating');
        try {
            const pinned = this.memberView(rec.meshId, rec.peerDaemonId);
            if (pinned?.unrecorded) this.d.mesh.materializeMember?.(rec.meshId, verified.payload.config, rec.peerDaemonId, pinned.hostPublicKey!);
            this.d.mesh.setFence(rec.meshId, { handoffId: rec.handoffId, epoch: rec.epoch });
            this.d.data.freezeWrites?.(rec.meshId, rec.handoffId, rec.epoch);
            try {
                this.d.data.applySnapshot(rec.meshId, verified.payload, { handoffId: rec.handoffId, sourceDaemonId: rec.peerDaemonId, snapshotDigest: manifest.digest, epoch: rec.epoch });
            } catch (e) {
                // One rolled-back transaction, on the first attempt: nothing was applied and no
                // authority exists here. This is the one failure a retained tombstone can prove.
                if (firstApply && (e as { handoffNoEffect?: boolean }).handoffNoEffect === true) {
                    this.d.mesh.setFence(rec.meshId, null, rec.handoffId);
                    this.log(`snapshot apply rolled back: ${(e as Error)?.message ?? e}`);
                    this.discardActivation(rec, `apply_rolled_back:${(e as Error)?.message ?? e}`);
                    return fail('snapshot_conflict', (e as Error)?.message, { applied: false, discarded: true, phase: 'discarded', epoch: rec.epoch });
                }
                throw e;
            }
            this.d.mesh.applyConfig(rec.meshId, verified.payload.config);
            this.d.mesh.writeHost(rec.meshId, {
                role: 'host', hostDaemonId: this.d.selfDaemonId, ...((rec.targetNodeId ?? this.d.selfNodeId?.(rec.meshId)) ? { hostNodeId: (rec.targetNodeId ?? this.d.selfNodeId?.(rec.meshId))! } : {}), hostEpoch: rec.epoch,
            });
        } catch (e) {
            this.log(`apply failed: ${(e as Error)?.message ?? e}`);
            // SQLite and config are separate durable stores. Once activation
            // begins a failure may have applied either; only forward recovery is safe.
            return fail('activate_failed', (e as Error)?.message);
        }
        return this.finishActivation(a.handoffId, a.certificate);
    }

    private async finishActivation(handoffId: string, cert?: HostTransferCertificate): Promise<PeerResult & { applied?: boolean; coordinatorReady?: boolean; coordinatorSessionId?: string }> {
        const rec = this.d.journal.get(handoffId, 'target')!;
        if (this.d.coordinator.readiness && !(await this.d.coordinator.readiness(rec.meshId, rec.launchPlan, { canaryMaxAgeMs: POST_APPLY_CANARY_MAX_AGE_MS })).ok) {
            return fail('target_not_launchable', 'Applied activation remains fenced until target readiness recovers.');
        }
        this.move(handoffId, 'active');
        this.d.mesh.setFence(rec.meshId, null, handoffId);
        this.d.journal.clearStage(handoffId);
        const launched = await this.launchOnce(handoffId);
        if (cert) {
            const view = this.d.mesh.read(rec.meshId);
            void this.d.certificate.broadcast(rec.meshId, cert, [this.d.selfDaemonId, rec.peerDaemonId, ...(view ? [] : [])]).catch(() => undefined);
        }
        return { success: true, applied: true, coordinatorReady: launched.ready, ...(launched.sessionId ? { coordinatorSessionId: launched.sessionId } : {}) };
    }

    /** Authority first, runtime second. Every attempt is journalled before the launch leaves. */
    private async launchOnce(handoffId: string): Promise<{ success: boolean; sessionId?: string; ready: boolean }> {
        const rec = this.d.journal.get(handoffId, 'target')!;
        const now = this.d.clock.now();
        this.d.journal.update(handoffId, 'target', { launchAttempts: (rec.launchAttempts ?? 0) + 1, lastLaunchAt: now });
        let launched: { success: boolean; sessionId?: string; ready: boolean } = { success: false, ready: false };
        try { launched = await this.d.coordinator.launch(rec.meshId, handoffId, rec.launchPlan); }
        catch (e) { this.log(`coordinator launch failed: ${(e as Error)?.message ?? e}`); }
        if (launched.ready) this.d.journal.update(handoffId, 'target', { coordinatorReadyAt: this.d.clock.now() });
        return launched;
    }

    /** Active with no proved coordinator (a crash or failed launch after authority moved).
     * Launch only on an authoritative empty census: unknown never launches a second one. */
    private async convergeLaunch(rec: HandoffRecord): Promise<void> {
        if (!this.d.coordinator.observe || rec.coordinatorReadyAt !== undefined) return;
        const now = this.d.clock.now();
        if (now - rec.updatedAt >= LAUNCH_CONVERGE_WINDOW_MS || (rec.launchAttempts ?? 0) >= LAUNCH_MAX_ATTEMPTS) return;
        if (rec.lastLaunchAt !== undefined && now - rec.lastLaunchAt < LAUNCH_RETRY_MS) return;
        const seen = await this.d.coordinator.observe(rec.meshId, rec.launchPlan);
        if (seen.ready) { this.d.journal.update(rec.handoffId, 'target', { coordinatorReadyAt: now }); return; }
        if (!seen.runtimeVerified || (seen.liveCount ?? 0) !== 0) return;
        this.log(`target ${rec.handoffId} is host with no coordinator; launching`);
        await this.launchOnce(rec.handoffId);
    }

    async status(a: { handoffId: string; meshId: string }, sender: string): Promise<PeerResult & { phase?: string; epoch?: number }> {
        const rec = this.d.journal.get(a.handoffId, 'target');
        if (!rec) return { success: true, phase: 'unknown', unknown: true };
        const wrong = this.requireSource(rec, sender); if (wrong) return wrong;
        if (a.meshId !== rec.meshId) return fail('invalid_args');
        const view = this.d.mesh.read(rec.meshId);
        let observation: import('./ports.js').CoordinatorObservation | undefined;
        try { observation = await this.d.coordinator.observe?.(rec.meshId, rec.launchPlan); } catch { /* no observation is unknown */ }
        return { success: true, phase: rec.phase, epoch: rec.epoch, actualHostDaemonId: view?.hostDaemonId, actualHostNodeId: view?.hostNodeId, observation,
            ...(rec.launchAttempts !== undefined ? { launchAttempts: rec.launchAttempts } : {}), ...(rec.coordinatorReadyAt !== undefined ? { coordinatorReadyAt: rec.coordinatorReadyAt } : {}) };
    }

    discard(a: { handoffId: string; meshId: string }, sender: string): PeerResult {
        if (this.activations.has(a.handoffId)) return fail('already_committed', 'activation readiness or apply in progress');
        const rec = this.d.journal.get(a.handoffId, 'target');
        if (!rec) return { success: true, duplicate: true };
        const wrong = this.requireSource(rec, sender); if (wrong) return wrong;
        if (a.meshId !== rec.meshId) return fail('invalid_args');
        if (rec.phase === 'active') return fail('already_committed');
        if (rec.phase === 'activating') return fail('already_committed', 'activation in progress');
        this.discardInternal(rec, 'source_discard');
        return { success: true };
    }

    private discardInternal(rec: HandoffRecord, reason: string): void {
        const cur = this.d.journal.get(rec.handoffId, 'target');
        if (!cur || cur.phase === 'discarded' || cur.phase === 'active') return;
        this.move(rec.handoffId, 'discarded', { abortReason: reason });
        this.d.journal.clearStage(rec.handoffId);
    }

    /** The discard an `activating` record may take: its only effect was a transaction that rolled back. */
    private discardActivation(rec: HandoffRecord, reason: string): void {
        this.move(rec.handoffId, 'discarded', { abortReason: reason });
        this.d.journal.clearStage(rec.handoffId);
    }

    /** Resume after a restart: an interrupted activation is finished; stale staging is dropped. */
    async resume(): Promise<void> {
        for (const rec of this.d.journal.list().filter(r => r.role === 'target')) {
            if (rec.phase === 'active') {
                const view = this.d.mesh.read(rec.meshId);
                if (view?.handoffFence?.handoffId === rec.handoffId && view.hostEpoch === rec.epoch
                    && view.hostDaemonId && daemonIdsEquivalent(view.hostDaemonId, this.d.selfDaemonId)
                    && this.d.journal.getCertificate(rec.handoffId)?.sourceStopped) {
                    this.d.mesh.setFence(rec.meshId, null, rec.handoffId);
                }
            }
            if (rec.phase === 'activating') {
                const certificate = this.d.journal.getCertificate(rec.handoffId);
                if (certificate?.sourceStopped) await this.activate({ handoffId: rec.handoffId, meshId: rec.meshId, epoch: rec.epoch, certificate }, rec.peerDaemonId);
            }
        }
    }

    async tick(): Promise<void> {
        const now = this.d.clock.now();
        for (const rec of this.d.journal.list().filter(r => r.role === 'target')) {
            if (this.activations.has(rec.handoffId)) continue;
            if (rec.phase === 'active') { try { await this.convergeLaunch(rec); } catch (e) { this.log(`launch convergence: ${(e as Error)?.message ?? e}`); } continue; }
            if ((rec.phase === 'importing' || rec.phase === 'staged' || rec.phase === 'verified' || rec.phase === 'acked') && now - rec.updatedAt >= TARGET_STAGE_TTL_MS) {
                this.discardInternal(rec, 'stage_ttl');
            }
        }
    }
}
