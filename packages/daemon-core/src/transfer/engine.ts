/**
 * Project file transfer engine: one state machine for both roles (source / target).
 * Owner-facing methods are called by commands that already proved owner ingress; the
 * peer-facing {@link handlePeerOp} is called with the transport-stamped sender daemon id.
 * Nothing here talks to the server; the control plane is the authenticated mesh relay and
 * the bulk plane is the injected STUN-only {@link TransferLink}.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { getBindingInfo, probeRoot, TransferFsError } from '../transfer-fs/index.js';
import { TRANSFER_LIMITS, TRANSFER_RETENTION_MS } from './limits.js';
import {
  ManifestError, isTransferId, selectionDigest, selectionTotalBytes, validateContentManifest,
  validateFinalName, validateSelectionManifest, type SelectionManifest,
} from './manifest.js';
import type { TransferLink, TransferLinkFactory, TransferSignal } from './link.js';
import { ReceiverSession, SenderSession, SessionError } from './link-session.js';
import { TransferRateLimiter } from './rate-limit.js';
import { TransferReceiver, removeStagingFor } from './receiver.js';
import { freezeSelection, requireFreeDisk } from './spool.js';
import { browseDirectory, scanSelection } from './source-scan.js';
import { ACTIVE_STATES, TERMINAL_STATES, TransferStore, type TransferRecord, type TransferRole, type TransferState } from './store.js';

export interface WorkspaceRef { id: string; path: string; label?: string }

export interface TransferHostPorts {
  baseDir: string;
  selfDaemonId(): string;
  /** Send one `project_transfer_peer` request to the peer daemon over the authenticated mesh relay. */
  dispatchPeer(peerDaemonId: string, args: Record<string, unknown>): Promise<{ ok: boolean; code?: string; [k: string]: unknown }>;
  /** Changes whenever the owner's authentication identity changes (re-login, secret rotation). */
  ownerAuthGeneration(): string;
  /** Still a same-account, non-revoked peer? */
  isPeerAuthorized(peerDaemonId: string): boolean;
  resolveWorkspace(workspaceId: string): WorkspaceRef | null;
  linkFactory?: TransferLinkFactory;
  now?(): number;
  rate?: TransferRateLimiter;
}

export interface TransferFailure { ok: false; code: string; detail?: string; [k: string]: unknown }
export type EngineResult<T> = ({ ok: true } & T) | TransferFailure;

interface RunCtx {
  linkKey?: Buffer;
  link?: TransferLink;
  session?: SenderSession | ReceiverSession;
  receiver?: TransferReceiver;
  watchdog?: NodeJS.Timeout;
  retryTimer?: NodeJS.Timeout;
  retries: number;
  cancelled: boolean;
  starting: boolean;
}

const fail = (code: string, detail?: string): TransferFailure => ({ ok: false, code, ...(detail ? { detail } : {}) });

export class ProjectTransferEngine {
  readonly store: TransferStore;
  private readonly rate: TransferRateLimiter;
  private readonly restartEpoch = randomBytes(8).toString('hex');
  private readonly records = new Map<string, TransferRecord>();
  private readonly runs = new Map<string, RunCtx>();

  constructor(private readonly ports: TransferHostPorts) {
    this.store = new TransferStore(ports.baseDir);
    this.rate = ports.rate ?? new TransferRateLimiter();
    this.recover();
  }

  private now(): number { return this.ports.now ? this.ports.now() : Date.now(); }

  // ── lifecycle ────────────────────────────────────────────────────────────────

  /** Boot: every non-terminal approved transfer needs re-approval (restart invalidates consent). */
  private recover(): void {
    for (const rec of this.store.list()) {
      if (!TERMINAL_STATES.has(rec.state) && rec.state !== 'previewed' && rec.state !== 'offered') {
        rec.state = 'needs_reapproval';
        delete rec.localApproval;
        rec.peerApproved = false;
        this.persist(rec, 'needs_reapproval');
      }
      this.records.set(rec.id, rec);
    }
    this.sweep();
  }

  /** Expiry + retention sweep; call on a timer. */
  sweep(): void {
    const t = this.now();
    for (const rec of this.records.values()) {
      if (TERMINAL_STATES.has(rec.state)) continue;
      const awaitingFirstApproval = rec.state === 'previewed' || rec.state === 'offered';
      if (awaitingFirstApproval && t > rec.previewExpiresAt) this.terminate(rec, 'expired', 'PREVIEW_EXPIRED');
      else if (!awaitingFirstApproval && t - rec.createdAt > TRANSFER_RETENTION_MS.consent && rec.state === 'needs_reapproval') this.terminate(rec, 'expired', 'CONSENT_EXPIRED');
      else if (rec.localApproval && t - rec.localApproval.at > TRANSFER_RETENTION_MS.consent && !ACTIVE_STATES.has(rec.state)) this.terminate(rec, 'expired', 'CONSENT_EXPIRED');
    }
    const { staleTempIds } = this.store.gc(t);
    for (const id of staleTempIds) { const rec = this.records.get(id); if (rec) this.terminate(rec, 'expired', 'TEMP_DATA_EXPIRED'); }
  }

  /** Host hook: owner auth generation / peer authorisation changed. Revokes unauthorised runs. */
  onAuthorityChanged(): void {
    for (const rec of this.records.values()) {
      if (TERMINAL_STATES.has(rec.state) || !rec.localApproval) continue;
      if (this.authorizationProblem(rec)) this.terminate(rec, 'revoked', 'REVOKED', true);
    }
  }

  private authorizationProblem(rec: TransferRecord): string | null {
    const a = rec.localApproval;
    if (!a) return null;
    if (a.ownerAuthGeneration !== this.ports.ownerAuthGeneration()) return 'owner-auth-changed';
    if (a.restartEpoch !== this.restartEpoch) return 'restart';
    if (!this.ports.isPeerAuthorized(rec.peerDaemonId)) return 'peer-unauthorized';
    return null;
  }

  private persist(rec: TransferRecord, event?: string): void {
    rec.updatedAt = this.now();
    rec.activityAt = rec.updatedAt;
    this.records.set(rec.id, rec);
    this.store.save(rec);
    if (event) this.store.audit({ id: rec.id, role: rec.role, event, ...(rec.errorCode ? { code: rec.errorCode } : {}), files: rec.selection.entries.filter((e) => e.kind === 'file').length, bytes: rec.totalBytes }, this.now());
  }

  private setState(rec: TransferRecord, state: TransferState, event?: string): void {
    rec.state = state;
    this.persist(rec, event ?? state);
  }

  /** Terminal transition with full cleanup of runtime, spool and staging. */
  private terminate(rec: TransferRecord, state: Extract<TransferState, 'failed' | 'cancelled' | 'expired' | 'revoked'>, code: string, notifyPeer = false): void {
    if (TERMINAL_STATES.has(rec.state)) return;
    const run = this.runs.get(rec.id);
    if (run) run.cancelled = true;
    const hadReceiver = !!run?.receiver;
    this.teardownRun(rec.id, true);
    if (rec.role === 'target' && !hadReceiver) {
      const ws = this.ports.resolveWorkspace(rec.selection.targetWorkspaceId);
      if (ws) removeStagingFor(ws.path, rec.id);
    }
    rec.errorCode = code;
    rec.state = state;
    delete rec.localApproval;
    this.persist(rec, state);
    this.store.removeSpool(rec.id);
    this.store.writeReceipt({
      id: rec.id, role: rec.role, outcome: state, errorCode: code, finishedAt: this.now(),
      files: (rec.content?.files ?? []).map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 })),
      excluded: rec.selection.excluded,
    });
    if (notifyPeer) void this.ports.dispatchPeer(rec.peerDaemonId, { op: 'cancel', transferId: rec.id, code }).catch(() => {});
  }

  private teardownRun(id: string, cleanStaging: boolean): void {
    const run = this.runs.get(id);
    if (!run) return;
    clearInterval(run.watchdog);
    clearTimeout(run.retryTimer);
    try { run.session?.abort('CANCELLED'); } catch { /* ignore */ }
    try { run.link?.close(); } catch { /* ignore */ }
    if (run.receiver) { try { cleanStaging ? run.receiver.abort() : run.receiver.dispose(); } catch { /* ignore */ } }
    run.linkKey?.fill(0);
    this.runs.delete(id);
  }

  // ── capabilities ─────────────────────────────────────────────────────────────

  capabilities(): { supported: boolean; reasons: string[]; platform: string; arch: string } {
    const reasons: string[] = [];
    try { getBindingInfo(); } catch { reasons.push('NATIVE_HELPER_UNAVAILABLE'); }
    if (!this.ports.linkFactory) reasons.push('LINK_UNAVAILABLE');
    return { supported: reasons.length === 0, reasons, platform: process.platform, arch: process.arch };
  }

  private requireSupport(): TransferFailure | null {
    const c = this.capabilities();
    return c.supported ? null : fail(c.reasons[0]!, c.reasons.join(','));
  }

  private activeCount(): number {
    let n = 0;
    for (const r of this.records.values()) if (ACTIVE_STATES.has(r.state)) n++;
    return n;
  }

  // ── owner API ────────────────────────────────────────────────────────────────

  browse(workspaceId: string, relDir: string) {
    const ws = this.ports.resolveWorkspace(workspaceId);
    if (!ws) return fail('WORKSPACE_NOT_REGISTERED');
    try { return { ok: true as const, entries: browseDirectory(ws.path, relDir) }; } catch (e) { return fail('BROWSE_FAILED', (e as Error).message); }
  }

  list(): TransferRecord[] {
    return [...this.records.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
  }

  get(id: string): TransferRecord | null { return this.records.get(id) ?? null; }

  async create(input: { workspaceId: string; selected: string[]; targetDaemonId: string; targetWorkspaceId: string; finalName: string }): Promise<EngineResult<{ transferId: string; record: TransferRecord }>> {
    const unsupported = this.requireSupport();
    if (unsupported) return unsupported;
    const ws = this.ports.resolveWorkspace(input.workspaceId);
    if (!ws) return fail('WORKSPACE_NOT_REGISTERED');
    const self = this.ports.selfDaemonId();
    if (!input.targetDaemonId || daemonIdsEquivalent(input.targetDaemonId, self)) return fail('INVALID_TARGET', 'target must be another of your machines');
    if (!this.ports.isPeerAuthorized(input.targetDaemonId)) return fail('PEER_UNAUTHORIZED');
    if ([...this.records.values()].filter((r) => !TERMINAL_STATES.has(r.state)).length >= 10) return fail('TOO_MANY_TRANSFERS');
    let finalName: string;
    try { finalName = validateFinalName(input.finalName); } catch (e) { return fail((e as ManifestError).code ?? 'INVALID_FINAL_NAME', (e as Error).message); }
    if (!Array.isArray(input.selected) || input.selected.length === 0 || input.selected.length > TRANSFER_LIMITS.maxEntries) return fail('MANIFEST_INVALID', 'selection required');
    let manifest: SelectionManifest;
    try {
      const scan = scanSelection(ws.path, input.selected.map(String));
      manifest = validateSelectionManifest({
        v: 1, transferId: randomBytes(16).toString('hex'), sourceDaemonId: self, targetDaemonId: input.targetDaemonId,
        sourceWorkspaceId: ws.id, targetWorkspaceId: input.targetWorkspaceId, finalName, entries: scan.entries, excluded: scan.excluded,
      });
    } catch (e) {
      if (e instanceof ManifestError) return fail(e.code, e.message);
      if (e instanceof TransferFsError) return fail('SOURCE_UNREADABLE', e.message);
      throw e;
    }
    const digest = selectionDigest(manifest);
    const t = this.now();
    const rec: TransferRecord = {
      v: 1, id: manifest.transferId, role: 'source', peerDaemonId: input.targetDaemonId, selection: manifest, selectionDigest: digest,
      state: 'previewed', createdAt: t, updatedAt: t, activityAt: t, previewExpiresAt: t + TRANSFER_RETENTION_MS.preview,
      linkGen: 0, blocksDone: [], bytesDone: 0, totalBytes: selectionTotalBytes(manifest),
    };
    let reply: Awaited<ReturnType<TransferHostPorts['dispatchPeer']>>;
    try { reply = await this.ports.dispatchPeer(input.targetDaemonId, { op: 'offer', transferId: manifest.transferId, selection: manifest, selectionDigest: digest }); }
    catch (e) { return fail('PEER_UNREACHABLE', (e as Error).message); }
    if (!reply?.ok) return fail(String(reply?.code ?? 'OFFER_REFUSED'));
    this.persist(rec, 'previewed');
    return { ok: true, transferId: rec.id, record: rec };
  }

  /** Owner approval on THIS machine. `digest` must be the selection digest the owner saw. */
  async approve(id: string, digest: string): Promise<EngineResult<{ record: TransferRecord }>> {
    const rec = this.records.get(id);
    if (!rec) return fail('NOT_FOUND');
    if (TERMINAL_STATES.has(rec.state)) return fail('TRANSFER_FINISHED');
    if (digest !== rec.selectionDigest) return fail('APPROVAL_MISMATCH');
    const first = rec.state === 'previewed' || rec.state === 'offered';
    if (first && this.now() > rec.previewExpiresAt) { this.terminate(rec, 'expired', 'PREVIEW_EXPIRED', true); return fail('PREVIEW_EXPIRED'); }
    if (!first && rec.state !== 'needs_reapproval') return fail('ALREADY_APPROVED');
    if (!this.ports.isPeerAuthorized(rec.peerDaemonId)) return fail('PEER_UNAUTHORIZED');
    const unsupported = this.requireSupport();
    if (unsupported) return unsupported;
    rec.localApproval = { at: this.now(), ownerAuthGeneration: this.ports.ownerAuthGeneration(), restartEpoch: this.restartEpoch };
    rec.state = 'awaiting_approval';
    this.persist(rec, 'approved');
    try { await this.ports.dispatchPeer(rec.peerDaemonId, { op: 'approval', transferId: id, selectionDigest: digest, approved: true }); } catch { /* peer learns on next contact */ }
    void this.maybeStart(rec);
    return { ok: true, record: rec };
  }

  async revokeApproval(id: string): Promise<EngineResult<object>> {
    const rec = this.records.get(id);
    if (!rec) return fail('NOT_FOUND');
    if (!rec.localApproval) return fail('NOT_APPROVED');
    this.terminate(rec, 'revoked', 'REVOKED', true);
    return { ok: true };
  }

  async cancel(id: string): Promise<EngineResult<object>> {
    const rec = this.records.get(id);
    if (!rec) return fail('NOT_FOUND');
    if (TERMINAL_STATES.has(rec.state)) return fail('TRANSFER_FINISHED');
    this.terminate(rec, 'cancelled', 'CANCELLED', true);
    return { ok: true };
  }

  // ── start / run ──────────────────────────────────────────────────────────────

  private async maybeStart(rec: TransferRecord): Promise<void> {
    if (!rec.localApproval || !rec.peerApproved || TERMINAL_STATES.has(rec.state)) return;
    if (rec.role !== 'source') return; // the target waits for `content`
    const run = this.runs.get(rec.id) ?? { retries: 0, cancelled: false, starting: false };
    this.runs.set(rec.id, run);
    if (run.starting) return;
    run.starting = true;
    try { await this.startSource(rec, run); } catch (e) {
      const code = e instanceof ManifestError || e instanceof SessionError ? e.code : 'INTERNAL_ERROR';
      this.terminate(rec, 'failed', code, true);
    } finally { run.starting = false; }
  }

  private guard(rec: TransferRecord): void {
    const problem = this.authorizationProblem(rec);
    if (problem) { this.terminate(rec, 'revoked', 'REVOKED', true); throw new SessionError('REVOKED', problem); }
  }

  private async startSource(rec: TransferRecord, run: RunCtx): Promise<void> {
    this.guard(rec);
    if (this.activeCount() >= TRANSFER_LIMITS.maxConcurrentPerDaemon && !ACTIVE_STATES.has(rec.state)) throw new SessionError('TOO_MANY_TRANSFERS', 'concurrent transfer limit');
    const ws = this.ports.resolveWorkspace(rec.selection.sourceWorkspaceId);
    if (!ws) throw new ManifestError('WORKSPACE_NOT_REGISTERED', 'source workspace gone');
    if (!rec.content) {
      this.setState(rec, 'freezing');
      rec.content = await freezeSelection({ rootPath: ws.path, selection: rec.selection, spoolDir: this.store.spoolDir(rec.id), isCancelled: () => run.cancelled });
      rec.blocksDone = rec.content.files.map(() => 0);
      this.persist(rec);
    }
    await this.openSourceLink(rec, run);
  }

  private async openSourceLink(rec: TransferRecord, run: RunCtx): Promise<void> {
    this.guard(rec);
    const factory = this.ports.linkFactory;
    if (!factory) throw new SessionError('LINK_UNAVAILABLE', 'no link factory');
    run.linkKey = randomBytes(32);
    rec.linkGen += 1;
    this.setState(rec, 'linking');
    const reply = await this.ports.dispatchPeer(rec.peerDaemonId, {
      op: 'content', transferId: rec.id, selectionDigest: rec.selectionDigest, content: rec.content, linkGen: rec.linkGen, linkKeyB64: run.linkKey.toString('base64'),
    });
    if (!reply?.ok) throw new SessionError(String(reply?.code ?? 'PEER_REFUSED'), 'peer refused content');
    const link = factory.create({ transferId: rec.id, role: 'initiator', linkGen: rec.linkGen });
    run.link = link;
    link.onSignalOut((s) => { void this.ports.dispatchPeer(rec.peerDaemonId, { op: 'signal', transferId: rec.id, linkGen: rec.linkGen, signal: s }).catch(() => {}); });
    const session = new SenderSession(link, rec.id, rec.linkGen, run.linkKey, rec.content!, this.store.spoolDir(rec.id), this.rate, (fi, bi) => {
      rec.blocksDone[fi] = Math.max(rec.blocksDone[fi] ?? 0, bi + 1);
      rec.bytesDone = rec.blocksDone.reduce((n, b, i) => n + Math.min(b * TRANSFER_LIMITS.blockBytes, rec.content!.files[i]!.size), 0);
      rec.activityAt = this.now();
    });
    run.session = session;
    this.setState(rec, 'transferring');
    this.armWatchdog(rec, run);
    session.wait().then(() => {
      // All blocks acknowledged: the target now verifies and publishes; its `state` op finalises us.
      if (!TERMINAL_STATES.has(rec.state)) this.setState(rec, 'verifying');
    }, (e: Error) => this.onSessionFailure(rec, run, e));
  }

  private armWatchdog(rec: TransferRecord, run: RunCtx): void {
    clearInterval(run.watchdog);
    run.watchdog = setInterval(() => {
      if (TERMINAL_STATES.has(rec.state)) { clearInterval(run.watchdog); return; }
      if (this.authorizationProblem(rec)) this.terminate(rec, 'revoked', 'REVOKED', true);
    }, 2000);
    run.watchdog.unref?.();
  }

  private onSessionFailure(rec: TransferRecord, run: RunCtx, err: Error): void {
    if (TERMINAL_STATES.has(rec.state) || run.cancelled) return;
    const code = err instanceof SessionError ? err.code : 'INTERNAL_ERROR';
    if (code === 'LINK_LOST' || code === 'PEER_ABORT') {
      this.setState(rec, 'paused', 'paused');
      try { run.link?.close(); } catch { /* ignore */ }
      run.link = undefined; run.session = undefined;
      if (rec.role === 'source') this.scheduleRetry(rec, run);
      return;
    }
    this.terminate(rec, 'failed', code, true);
  }

  private scheduleRetry(rec: TransferRecord, run: RunCtx): void {
    if (run.retries >= 5) { this.terminate(rec, 'failed', 'DIRECT_UNAVAILABLE', true); return; }
    const delay = Math.min(30_000, 1000 * 2 ** run.retries++);
    run.retryTimer = setTimeout(() => {
      if (TERMINAL_STATES.has(rec.state)) return;
      this.openSourceLink(rec, run).catch((e) => this.onSessionFailure(rec, run, e instanceof Error ? e : new SessionError('INTERNAL_ERROR', String(e))));
    }, delay);
    run.retryTimer.unref?.();
  }

  // ── peer API (control plane) ─────────────────────────────────────────────────

  async handlePeerOp(sender: string, args: Record<string, any>): Promise<{ ok: boolean; code?: string; [k: string]: unknown }> {
    const op = String(args?.op ?? '');
    const id = args?.transferId;
    if (!isTransferId(id)) return fail('PROTOCOL_ERROR');
    if (!sender || !this.ports.isPeerAuthorized(sender)) return fail('PEER_UNAUTHORIZED');
    try {
      if (op === 'offer') return this.onOffer(sender, id, args);
      const rec = this.records.get(id);
      if (!rec) return fail('NOT_FOUND');
      if (!daemonIdsEquivalent(rec.peerDaemonId, sender)) return fail('PEER_UNAUTHORIZED');
      switch (op) {
        case 'approval': return this.onPeerApproval(rec, args);
        case 'content': return await this.onContent(rec, args);
        case 'signal': return this.onSignal(rec, args);
        case 'cancel': this.terminate(rec, 'cancelled', 'PEER_CANCELLED', false); return { ok: true };
        case 'state': return this.onPeerState(rec, args);
        default: return fail('PROTOCOL_ERROR');
      }
    } catch (e) {
      if (e instanceof ManifestError || e instanceof SessionError) return fail(e.code, e.message);
      return fail('INTERNAL_ERROR');
    }
  }

  private onOffer(sender: string, id: string, args: Record<string, any>): { ok: boolean; code?: string } {
    const unsupported = this.requireSupport();
    if (unsupported) return unsupported;
    if (this.records.has(id)) return fail('DUPLICATE');
    const selection = validateSelectionManifest(args.selection);
    const self = this.ports.selfDaemonId();
    if (selection.transferId !== id || !daemonIdsEquivalent(selection.sourceDaemonId, sender) || !daemonIdsEquivalent(selection.targetDaemonId, self)) return fail('PEER_UNAUTHORIZED');
    if (selectionDigest(selection) !== args.selectionDigest) return fail('APPROVAL_MISMATCH');
    const ws = this.ports.resolveWorkspace(selection.targetWorkspaceId);
    if (!ws) return fail('WORKSPACE_NOT_REGISTERED');
    try { probeRoot(ws.path, { requireAtomicNoReplace: true }); } catch { return fail('ATOMIC_NOREPLACE_UNSUPPORTED'); }
    try { requireFreeDisk(ws.path, selectionTotalBytes(selection)); } catch (e) { return fail((e as ManifestError).code ?? 'DISK_SPACE_EXHAUSTED'); }
    const t = this.now();
    this.persist({
      v: 1, id, role: 'target', peerDaemonId: sender, selection, selectionDigest: args.selectionDigest, state: 'offered',
      createdAt: t, updatedAt: t, activityAt: t, previewExpiresAt: t + TRANSFER_RETENTION_MS.preview,
      linkGen: 0, blocksDone: [], bytesDone: 0, totalBytes: selectionTotalBytes(selection),
    }, 'offered');
    return { ok: true };
  }

  private onPeerApproval(rec: TransferRecord, args: Record<string, any>): { ok: boolean; code?: string } {
    if (args.selectionDigest !== rec.selectionDigest) return fail('APPROVAL_MISMATCH');
    rec.peerApproved = args.approved === true;
    this.persist(rec, rec.peerApproved ? 'peer_approved' : 'peer_unapproved');
    if (rec.peerApproved) void this.maybeStart(rec);
    else if (rec.localApproval && !TERMINAL_STATES.has(rec.state)) this.terminate(rec, 'revoked', 'REVOKED', false);
    return { ok: true };
  }

  private async onContent(rec: TransferRecord, args: Record<string, any>): Promise<{ ok: boolean; code?: string }> {
    if (rec.role !== 'target') return fail('PROTOCOL_ERROR');
    if (!rec.localApproval || !rec.peerApproved) return fail('APPROVAL_REQUIRED');
    this.guard(rec);
    if (args.selectionDigest !== rec.selectionDigest) return fail('APPROVAL_MISMATCH');
    const content = validateContentManifest(args.content, rec.selection);
    if (!Number.isInteger(args.linkGen) || args.linkGen <= rec.linkGen) return fail('PROTOCOL_ERROR');
    const key = Buffer.from(String(args.linkKeyB64 ?? ''), 'base64');
    if (key.length !== 32) return fail('PROTOCOL_ERROR');
    if (this.activeCount() >= TRANSFER_LIMITS.maxConcurrentPerDaemon && !ACTIVE_STATES.has(rec.state)) return fail('TOO_MANY_TRANSFERS');
    const factory = this.ports.linkFactory;
    if (!factory) return fail('LINK_UNAVAILABLE');
    const ws = this.ports.resolveWorkspace(rec.selection.targetWorkspaceId);
    if (!ws) return fail('WORKSPACE_NOT_REGISTERED');

    const prev = this.runs.get(rec.id);
    if (prev) { clearInterval(prev.watchdog); try { prev.session?.abort('SUPERSEDED'); prev.link?.close(); } catch { /* ignore */ } prev.receiver?.dispose(); }
    const run: RunCtx = { retries: 0, cancelled: false, starting: false, linkKey: key };
    rec.content = content;
    rec.linkGen = args.linkGen;
    if (rec.blocksDone.length !== content.files.length) rec.blocksDone = content.files.map(() => 0);
    const receiver = new TransferReceiver(ws.path, rec.selection, content, (fi, blocks, bytes) => {
      rec.blocksDone[fi] = blocks; rec.bytesDone = bytes; this.persist(rec);
    });
    let resume: number[];
    try { resume = receiver.init(rec.blocksDone); } catch (e) { receiver.dispose(); throw e; }
    rec.blocksDone = [...resume];
    run.receiver = receiver;
    this.runs.set(rec.id, run);
    this.setState(rec, 'linking');
    const link = factory.create({ transferId: rec.id, role: 'responder', linkGen: rec.linkGen });
    run.link = link;
    link.onSignalOut((s) => { void this.ports.dispatchPeer(rec.peerDaemonId, { op: 'signal', transferId: rec.id, linkGen: rec.linkGen, signal: s }).catch(() => {}); });
    const session = new ReceiverSession(link, rec.id, rec.linkGen, key, receiver, resume);
    run.session = session;
    this.armWatchdog(rec, run);
    this.setState(rec, 'transferring');
    session.wait().then(() => this.finishTarget(rec, run), (e: Error) => this.onSessionFailure(rec, run, e));
    return { ok: true };
  }

  private onSignal(rec: TransferRecord, args: Record<string, any>): { ok: boolean; code?: string } {
    const run = this.runs.get(rec.id);
    if (!run?.link || args.linkGen !== rec.linkGen) return fail('STALE_LINK');
    const s = args.signal as TransferSignal;
    if (!s || !['offer', 'answer', 'candidate'].includes(s.kind)) return fail('PROTOCOL_ERROR');
    if (typeof s.candidate === 'string' && / typ relay\b/.test(s.candidate)) return fail('RELAY_CANDIDATE_REFUSED');
    run.link.signalIn(s);
    return { ok: true };
  }

  private onPeerState(rec: TransferRecord, args: Record<string, any>): { ok: boolean } {
    if (rec.role !== 'source') return { ok: true };
    if (args.state === 'completed') {
      if (typeof args.publishedName === 'string') rec.publishedName = args.publishedName;
      this.completeRecord(rec);
    } else if (args.state === 'failed') {
      this.terminate(rec, 'failed', String(args.code ?? 'TARGET_FAILED'), false);
    }
    return { ok: true };
  }

  private async finishTarget(rec: TransferRecord, run: RunCtx): Promise<void> {
    try {
      this.setState(rec, 'verifying');
      run.receiver!.verifyAll();
      this.setState(rec, 'publishing');
      rec.publishedName = run.receiver!.publish(rec.selection.finalName);
      run.receiver!.dispose();
      run.receiver = undefined;
      this.completeRecord(rec);
      await this.ports.dispatchPeer(rec.peerDaemonId, { op: 'state', transferId: rec.id, state: 'completed', publishedName: rec.publishedName }).catch(() => {});
    } catch (e) {
      const code = (e as { code?: string }).code && /^[A-Z_]+$/.test(String((e as any).code)) ? String((e as any).code) : 'VERIFY_FAILED';
      this.terminate(rec, 'failed', code, false);
      await this.ports.dispatchPeer(rec.peerDaemonId, { op: 'state', transferId: rec.id, state: 'failed', code }).catch(() => {});
    }
  }

  private completeRecord(rec: TransferRecord): void {
    this.teardownRun(rec.id, false);
    rec.errorCode = undefined;
    rec.bytesDone = rec.totalBytes;
    delete rec.localApproval;
    this.setState(rec, 'completed');
    this.store.removeSpool(rec.id);
    this.store.writeReceipt({
      id: rec.id, role: rec.role, outcome: 'completed', finishedAt: this.now(), publishedName: rec.publishedName,
      files: (rec.content?.files ?? []).map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 })), excluded: rec.selection.excluded,
    });
  }

  /** Remove everything (tests / shutdown). */
  shutdown(): void {
    for (const id of [...this.runs.keys()]) this.teardownRun(id, false);
  }
}

export type { TransferRole };
export function defaultTransferBaseDir(configDir: string): string { return path.join(configDir, 'project-transfers'); }
export function ensureBaseDir(dir: string): void { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
