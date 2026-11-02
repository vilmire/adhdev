/**
 * Project file transfer engine: one state machine for both roles (source / target).
 * Owner-facing methods are called by commands that already proved owner ingress; the
 * peer-facing {@link handlePeerOp} is called with the transport-stamped sender daemon id.
 * Nothing here talks to the server; the control plane is the authenticated mesh relay and
 * the bulk plane is the injected {@link TransferLink}: STUN-only, or (owner-approved fallback,
 * both daemons opt in) TURN-relayed after a direct attempt failed. The relay changes only the path.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { LOG } from '../logging/logger.js';
import { findWorkspace } from './workspace-lookup.js';
import { close as nativeClose, getBindingInfo, openRoot, probeRoot, TransferFsError } from '../transfer-fs/index.js';
import { OverwriteError, revertOverwrite, scanOverwriteTargets, type OverwritePlan, type RevertResult } from './overwrite.js';
import { TRANSFER_LIMITS, TRANSFER_RETENTION_MS } from './limits.js';
import {
  ManifestError, blockCount, isTransferId, selectionDigest, selectionTotalBytes, validateContentManifest,
  validateFinalName, validateSelectionManifest, validateTargetDir, type SelectionManifest, type TransferTargetMode,
} from './manifest.js';
import type { TransferLink, TransferLinkFactory, TransferSignal } from './link.js';
import { ReceiverSession, SenderSession, SessionError, safeTransferCode } from './link-session.js';
import { extractSdpFingerprint, sdpHasRelayCandidate } from './protocol.js';
import { TransferRateLimiter } from './rate-limit.js';
import { TransferReceiver, removeStagingFor } from './receiver.js';
import { freezeSelection, requireFreeDisk } from './spool.js';
import { browseDirectory, scanSelection } from './source-scan.js';
import { ACTIVE_STATES, TERMINAL_STATES, TransferStore, type OverwriteInfo, type TransferRecord, type TransferRequester, type TransferRole, type TransferState } from './store.js';

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
  /** This run's links may use a TURN relay (set after the direct attempts failed and both sides allow it). */
  relay?: boolean;
  /** The established link really is relayed: its bytes count against the relay limits. */
  relayActive?: boolean;
  relayBase?: number;
  relayCounted?: number;
}

/**
 * Transfer log lines carry ONLY the transfer id prefix, role, state/event names, counters and
 * error CODES. Never keys, SDP, ICE candidates, DTLS fingerprints, file names or paths (IG02).
 */
const LOG_TAG = 'Transfer';
const idTag = (rec: { id: string; role: string }): string => `${rec.id.slice(0, 8)}/${rec.role}`;

/** Non-terminal transfer records a daemon keeps (owner-created and peer-offered alike). */
const MAX_OPEN_TRANSFERS = 10;

/** Terminal events are logged once, with their code, by terminate(). */
const LOG_SKIP_EVENTS: ReadonlySet<string> = new Set(['failed', 'cancelled', 'expired', 'revoked']);

const newRun = (): RunCtx => ({ retries: 0, cancelled: false, starting: false });

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

  /** Per-machine option (default ON): may this daemon's transfers fall back to a TURN relay? */
  relayAllowed(): boolean { return this.store.readRelayAllowed(); }
  setRelayAllowed(allowed: boolean): void { this.store.writeRelayAllowed(allowed === true); }

  /** Per-machine option (default OFF): may agent-requested transfers that replace nothing be approved without the owner? */
  agentAutoApproveAllowed(): boolean { return this.store.readAgentAutoApprove(); }
  setAgentAutoApprove(allowed: boolean): void { this.store.writeAgentAutoApprove(allowed === true); }

  /** Control-plane gate shared by peer ops that are not about one transfer. */
  isPeerAllowed(peerId: string): boolean { return !!peerId && this.ports.isPeerAuthorized(peerId); }

  /** Ask the target machine which of its registered workspaces a loose name (id / label / path) means. */
  async resolveTargetWorkspace(peerId: string, query: string): Promise<{ workspaceId: string; label?: string } | null> {
    if (!this.ports.isPeerAuthorized(peerId)) return null;
    let reply: Awaited<ReturnType<TransferHostPorts['dispatchPeer']>>;
    try { reply = await this.ports.dispatchPeer(peerId, { op: 'resolve_workspace', query }); } catch { return null; }
    if (!reply?.ok || typeof reply.workspaceId !== 'string' || !reply.workspaceId) return null;
    return { workspaceId: reply.workspaceId, ...(typeof reply.label === 'string' ? { label: reply.label.slice(0, 80) } : {}) };
  }

  /** Remember which owner decision is waiting on this (agent-requested) transfer. */
  setDecision(id: string, decision: { meshId: string; itemId: string }): void {
    const rec = this.records.get(id);
    if (!rec) return;
    rec.decision = decision;
    this.persist(rec);
  }

  private terminalListeners: Array<(rec: TransferRecord) => void> = [];
  /** Observe terminal transitions (used to withdraw the owner decision of an agent request). */
  onTerminal(cb: (rec: TransferRecord) => void): void { this.terminalListeners.push(cb); }
  private notifyTerminal(rec: TransferRecord): void {
    for (const cb of this.terminalListeners) { try { cb(rec); } catch { /* listener errors never affect the transfer */ } }
  }

  /** Scan the target project of an existing_path selection (handle-relative, symlink-safe). */
  private scanTarget(selection: SelectionManifest): OverwritePlan {
    const ws = this.ports.resolveWorkspace(selection.targetWorkspaceId);
    if (!ws) throw new OverwriteError('TARGET_DIR_MISSING', 'target workspace is not registered');
    const root = openRoot(ws.path);
    try { return scanOverwriteTargets(root, selection); } finally { try { nativeClose(root); } catch { /* ignore */ } }
  }

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
      const problem = this.authorizationProblem(rec);
      if (problem) this.endForProblem(rec, problem);
    }
  }

  private endForProblem(rec: TransferRecord, problem: string): void {
    if (problem === 'consent-expired') this.terminate(rec, 'expired', 'CONSENT_EXPIRED', true);
    else this.terminate(rec, 'revoked', 'REVOKED', true);
  }

  private authorizationProblem(rec: TransferRecord): string | null {
    const a = rec.localApproval;
    if (!a) return null;
    if (this.now() - a.at > TRANSFER_RETENTION_MS.consent) return 'consent-expired';
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
    if (event && !LOG_SKIP_EVENTS.has(event)) LOG.info(LOG_TAG, `${idTag(rec)} ${event} state=${rec.state} linkGen=${rec.linkGen} files=${rec.selection.entries.filter((e) => e.kind === 'file').length} bytes=${rec.bytesDone}/${rec.totalBytes}`);
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
    (state === 'failed' ? LOG.warn : LOG.info).call(LOG, LOG_TAG, `${idTag(rec)} terminal state=${state} code=${code} linkGen=${rec.linkGen} bytes=${rec.bytesDone}/${rec.totalBytes}`);
    this.store.removeSpool(rec.id);
    this.store.writeReceipt({
      id: rec.id, role: rec.role, outcome: state, errorCode: code, finishedAt: this.now(),
      files: (rec.content?.files ?? []).map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 })),
      excluded: rec.selection.excluded,
    });
    if (notifyPeer) void this.ports.dispatchPeer(rec.peerDaemonId, { op: 'cancel', transferId: rec.id, code }).catch(() => {});
    this.notifyTerminal(rec);
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

  capabilities(): { supported: boolean; reasons: string[]; platform: string; arch: string; relayAllowed: boolean; agentAutoApprove: boolean } {
    const reasons: string[] = [];
    try { getBindingInfo(); } catch { reasons.push('NATIVE_HELPER_UNAVAILABLE'); }
    if (!this.ports.linkFactory) reasons.push('LINK_UNAVAILABLE');
    return { supported: reasons.length === 0, reasons, platform: process.platform, arch: process.arch, relayAllowed: this.relayAllowed(), agentAutoApprove: this.agentAutoApproveAllowed() };
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

  async create(input: {
    workspaceId: string; selected: string[]; targetDaemonId: string; targetWorkspaceId: string; finalName: string;
    targetMode?: TransferTargetMode; targetDir?: string; requestedBy?: TransferRequester;
  }): Promise<EngineResult<{ transferId: string; record: TransferRecord; peerAllowsAgentAutoApprove?: boolean }>> {
    const unsupported = this.requireSupport();
    if (unsupported) return unsupported;
    const ws = this.ports.resolveWorkspace(input.workspaceId);
    if (!ws) return fail('WORKSPACE_NOT_REGISTERED');
    const self = this.ports.selfDaemonId();
    if (!input.targetDaemonId || daemonIdsEquivalent(input.targetDaemonId, self)) return fail('INVALID_TARGET', 'target must be another of your machines');
    if (!this.ports.isPeerAuthorized(input.targetDaemonId)) return fail('PEER_UNAUTHORIZED');
    if ([...this.records.values()].filter((r) => !TERMINAL_STATES.has(r.state)).length >= MAX_OPEN_TRANSFERS) return fail('TOO_MANY_TRANSFERS');
    let finalName: string;
    const existingPath = input.targetMode === 'existing_path';
    let targetDir = '';
    try {
      if (input.targetMode !== undefined && input.targetMode !== 'new_folder' && !existingPath) return fail('INVALID_TARGET_MODE');
      if (existingPath) {
        targetDir = validateTargetDir(input.targetDir ?? '');
        finalName = validateFinalName(input.finalName || (targetDir ? targetDir.split('/').pop()! : 'project-root'));
      } else finalName = validateFinalName(input.finalName);
    } catch (e) { return fail((e as ManifestError).code ?? 'INVALID_FINAL_NAME', (e as Error).message); }
    const requestedBy = normalizeRequester(input.requestedBy);
    if (!Array.isArray(input.selected) || input.selected.length === 0 || input.selected.length > TRANSFER_LIMITS.maxEntries) return fail('MANIFEST_INVALID', 'selection required');
    let manifest: SelectionManifest;
    try {
      const scan = scanSelection(ws.path, input.selected.map(String));
      manifest = validateSelectionManifest({
        v: 1, transferId: randomBytes(16).toString('hex'), sourceDaemonId: self, targetDaemonId: input.targetDaemonId,
        sourceWorkspaceId: ws.id, targetWorkspaceId: input.targetWorkspaceId, finalName,
        ...(existingPath ? { targetMode: 'existing_path' as const, targetDir } : {}),
        entries: scan.entries, excluded: scan.excluded,
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
      ...(requestedBy ? { requestedBy } : {}),
    };
    let reply: Awaited<ReturnType<TransferHostPorts['dispatchPeer']>>;
    try { reply = await this.ports.dispatchPeer(input.targetDaemonId, { op: 'offer', transferId: manifest.transferId, selection: manifest, selectionDigest: digest, ...(requestedBy ? { requestedBy } : {}) }); }
    catch (e) { return fail('PEER_UNREACHABLE', (e as Error).message); }
    if (!reply?.ok) return fail(safeTransferCode(reply?.code ?? 'OFFER_REFUSED'));
    if (existingPath) {
      const ov = parsePeerOverwrite(reply.overwrite, targetDir);
      if (!ov) { void this.ports.dispatchPeer(input.targetDaemonId, { op: 'cancel', transferId: rec.id, code: 'PROTOCOL_ERROR' }).catch(() => {}); return fail('PEER_UNSUPPORTED', 'the target machine cannot overwrite existing files (update it)'); }
      rec.overwrite = ov;
    }
    this.persist(rec, 'previewed');
    return { ok: true, transferId: rec.id, record: rec, peerAllowsAgentAutoApprove: reply.agentAutoApprove === true };
  }

  /** Owner approval on THIS machine. `digest` must be the selection digest the owner saw. */
  async approve(id: string, digest: string, replaceDigest?: string): Promise<EngineResult<{ record: TransferRecord }>> {
    const rec = this.records.get(id);
    if (!rec) return fail('NOT_FOUND');
    if (TERMINAL_STATES.has(rec.state)) return fail('TRANSFER_FINISHED');
    if (digest !== rec.selectionDigest) return fail('APPROVAL_MISMATCH');
    const ovProblem = this.checkOverwriteApproval(rec, replaceDigest);
    if (ovProblem) return ovProblem;
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

  /**
   * existing_path: the approval must carry the digest of the target state the owner previewed, and the
   * TARGET machine re-inspects its own project right now. A changed target ends the transfer with
   * TARGET_CHANGED (returning the refreshed preview); the owner approves a fresh transfer.
   */
  private checkOverwriteApproval(rec: TransferRecord, replaceDigest: string | undefined): TransferFailure | null {
    if (rec.selection.targetMode !== 'existing_path') return null;
    if (!rec.overwrite || replaceDigest !== rec.overwrite.digest) return fail('APPROVAL_MISMATCH', 'approval does not match the previewed overwrite');
    if (rec.role !== 'target') return null;
    let plan: OverwritePlan;
    try { plan = this.scanTarget(rec.selection); } catch (e) { return fail(e instanceof OverwriteError ? e.code : 'TARGET_PATH_UNSAFE'); }
    if (plan.digest !== rec.overwrite.digest) {
      // Fail closed: the previewed state is gone. The refreshed preview is returned; a new transfer needs a new approval.
      rec.overwrite = { ...plan };
      const view = this.overwriteView(rec);
      this.terminate(rec, 'failed', 'TARGET_CHANGED', true);
      return { ok: false, code: 'TARGET_CHANGED', overwrite: view };
    }
    return null;
  }

  private overwriteView(rec: TransferRecord): Record<string, unknown> | undefined {
    const o = rec.overwrite;
    if (!o) return undefined;
    return {
      targetDir: o.targetDir, digest: o.digest, newCount: o.newFiles.length, replacedCount: o.replaced.length,
      replaced: o.replaced.map((r) => ({ path: r.path, size: r.size })),
      ...(o.reverted ? { reverted: true } : {}),
    };
  }

  /**
   * Agent-requested transfer: auto-approve (daemon side, no owner) when BOTH machines allow it and the
   * transfer replaces nothing. The target decides with its OWN setting; nothing the requester says
   * about itself is trusted.
   */
  async tryAgentAutoApprove(id: string, peerAllowsAgentAutoApprove: boolean): Promise<boolean> {
    const rec = this.records.get(id);
    if (!rec || rec.role !== 'source' || !rec.requestedBy) return false;
    if (!this.agentAutoApproveAllowed() || !peerAllowsAgentAutoApprove) return false;
    if ((rec.overwrite?.replaced.length ?? 0) > 0) return false;
    let reply: Awaited<ReturnType<TransferHostPorts['dispatchPeer']>>;
    try {
      reply = await this.ports.dispatchPeer(rec.peerDaemonId, {
        op: 'agent_approve', transferId: id, selectionDigest: rec.selectionDigest, ...(rec.overwrite ? { replaceDigest: rec.overwrite.digest } : {}),
      });
    } catch { return false; }
    if (!reply?.ok) return false;
    const mine = await this.approve(id, rec.selectionDigest, rec.overwrite?.digest);
    return mine.ok;
  }

  /** Target side of {@link tryAgentAutoApprove}: only ever honours this machine's own setting. */
  private async onAgentApprove(rec: TransferRecord, args: Record<string, any>): Promise<{ ok: boolean; code?: string; [k: string]: unknown }> {
    if (rec.role !== 'target' || !rec.requestedBy) return fail('AUTO_APPROVE_NOT_ALLOWED');
    if (!this.agentAutoApproveAllowed()) return fail('AUTO_APPROVE_NOT_ALLOWED');
    if ((rec.overwrite?.replaced.length ?? 0) > 0) return fail('AUTO_APPROVE_NOT_ALLOWED');
    if (args.selectionDigest !== rec.selectionDigest) return fail('APPROVAL_MISMATCH');
    const r = await this.approve(rec.id, rec.selectionDigest, rec.overwrite?.digest);
    return r.ok ? { ok: true } : fail(r.code);
  }

  /** Owner-only: put the backed-up originals of a completed overwrite transfer back. */
  revert(id: string): EngineResult<{ result: RevertResult; record: TransferRecord }> {
    const rec = this.records.get(id);
    if (!rec) return fail('NOT_FOUND');
    if (rec.role !== 'target') return fail('NOT_TARGET');
    if (rec.state !== 'completed' || !rec.overwrite || rec.overwrite.replaced.length === 0) return fail('REVERT_UNAVAILABLE');
    if (rec.overwrite.reverted) return fail('ALREADY_REVERTED');
    const ws = this.ports.resolveWorkspace(rec.selection.targetWorkspaceId);
    if (!ws) return fail('WORKSPACE_NOT_REGISTERED');
    let result: RevertResult;
    const root = openRoot(ws.path);
    try { result = revertOverwrite(root, rec.selection, this.store.backupDir(rec.id)); }
    catch (e) { return fail(e instanceof OverwriteError ? e.code : 'REVERT_FAILED'); }
    finally { try { nativeClose(root); } catch { /* ignore */ } }
    if (result.conflicts.length === 0) rec.overwrite.reverted = true;
    rec.overwrite.revertConflicts = result.conflicts.length;
    this.persist(rec, 'reverted');
    return { ok: true, result, record: rec };
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
    const run = this.runs.get(rec.id) ?? newRun();
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
    if (problem) { this.endForProblem(rec, problem); throw new SessionError(problem === 'consent-expired' ? 'CONSENT_EXPIRED' : 'REVOKED', problem); }
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
    if (run.relay) this.checkRelayLimits(rec);
    run.linkKey = randomBytes(32);
    rec.linkGen += 1;
    LOG.info(LOG_TAG, `${idTag(rec)} link attempt ${rec.linkGen} started (retries=${run.retries}${run.relay ? ', relay allowed' : ''})`);
    this.setState(rec, 'linking');
    const reply = await this.ports.dispatchPeer(rec.peerDaemonId, {
      op: 'content', transferId: rec.id, selectionDigest: rec.selectionDigest, content: rec.content, linkGen: rec.linkGen, linkKeyB64: run.linkKey.toString('base64'),
      ...(run.relay ? { relay: true } : {}),
    });
    // The peer opted out of relays: the direct failure stands.
    if (!reply?.ok && reply?.code === 'RELAY_NOT_ALLOWED') throw new SessionError('DIRECT_UNAVAILABLE', 'peer does not allow a relay');
    if (!reply?.ok) { const code = safeTransferCode(reply?.code ?? 'PEER_REFUSED'); LOG.warn(LOG_TAG, `${idTag(rec)} peer refused content for link ${rec.linkGen} code=${code}`); throw new SessionError(code, 'peer refused content'); }
    const link = factory.create({ transferId: rec.id, role: 'initiator', linkGen: rec.linkGen, ...(run.relay ? { allowRelay: true } : {}) });
    run.link = link;
    link.onSignalOut((s) => { void this.ports.dispatchPeer(rec.peerDaemonId, { op: 'signal', transferId: rec.id, linkGen: rec.linkGen, signal: s }).catch(() => {}); });
    const session = new SenderSession(link, rec.id, rec.linkGen, run.linkKey, rec.content!, this.store.spoolDir(rec.id), this.rate, (fi, bi) => {
      rec.blocksDone[fi] = Math.max(rec.blocksDone[fi] ?? 0, bi + 1);
      rec.bytesDone = rec.blocksDone.reduce((n, b, i) => n + Math.min(b * TRANSFER_LIMITS.blockBytes, rec.content!.files[i]!.size), 0);
      rec.activityAt = this.now();
      this.accountRelay(rec, run);
    });
    run.session = session;
    this.bindEstablished(rec, run, session);
    this.armWatchdog(rec, run);
    session.wait().then(() => {
      // All blocks acknowledged: the target now verifies and publishes; its `state` op finalises us.
      if (!TERMINAL_STATES.has(rec.state)) this.setState(rec, 'verifying');
    }, (e: Error) => this.onSessionFailure(rec, run, e));
  }

  /**
   * A record is `transferring` only once the link is up AND the session's channel binding is
   * verified (HELLO ok) — i.e. the data phase can start. Until then it stays `linking`, so a link
   * that never connects does not flicker between "transferring" and "connecting" (bug 3: the state
   * used to flip to `transferring` the moment the session object was created, before any link).
   */
  private bindEstablished(rec: TransferRecord, run: RunCtx, session: SenderSession | ReceiverSession): void {
    const gen = rec.linkGen;
    session.onEstablished(() => {
      if (TERMINAL_STATES.has(rec.state) || rec.linkGen !== gen) return;
      // In a relay-allowed run the link reports which path ICE really picked; a link that cannot say
      // is trusted only as far as the mode it was created in (direct mode can never carry a relay).
      let reported: 'direct' | 'relay' | 'unknown' = 'unknown';
      try { reported = run.link?.transportPath?.() ?? 'unknown'; } catch { /* unreadable */ }
      const path: 'direct' | 'relay' = reported === 'unknown' ? (run.relay ? 'relay' : 'direct') : reported;
      rec.path = path;
      run.relayActive = path === 'relay';
      run.relayBase = rec.bytesDone;
      run.relayCounted = 0;
      LOG.info(LOG_TAG, `${idTag(rec)} link ${gen} connected (${path})`);
      if (rec.state === 'linking') this.setState(rec, 'transferring'); else this.persist(rec);
    });
  }

  /** Refuse a relay attempt that cannot fit the per-transfer or the daily relay budget. */
  private checkRelayLimits(rec: TransferRecord): void {
    const remaining = Math.max(0, rec.totalBytes - rec.bytesDone);
    if (rec.totalBytes > TRANSFER_LIMITS.relayMaxTransferBytes || this.store.relayUsedToday(this.now()) + remaining > TRANSFER_LIMITS.relayDailyBytes) {
      throw new SessionError('RELAY_LIMIT_EXCEEDED', 'relay transfer limit');
    }
  }

  /** Count bytes that crossed a relayed link (called on every progress step); enforces the limits mid-flight. */
  private accountRelay(rec: TransferRecord, run: RunCtx): void {
    if (!run.relayActive) return;
    const moved = Math.max(0, rec.bytesDone - (run.relayBase ?? 0));
    const delta = moved - (run.relayCounted ?? 0);
    if (delta <= 0) return;
    run.relayCounted = moved;
    const day = this.store.addRelayBytes(delta, this.now());
    if (moved > TRANSFER_LIMITS.relayMaxTransferBytes || day > TRANSFER_LIMITS.relayDailyBytes) {
      this.terminate(rec, 'failed', 'RELAY_LIMIT_EXCEEDED', true);
    }
  }

  private armWatchdog(rec: TransferRecord, run: RunCtx): void {
    clearInterval(run.watchdog);
    run.watchdog = setInterval(() => {
      if (TERMINAL_STATES.has(rec.state)) { clearInterval(run.watchdog); return; }
      const problem = this.authorizationProblem(rec);
      if (problem) this.endForProblem(rec, problem);
    }, 2000);
    run.watchdog.unref?.();
  }

  private onSessionFailure(rec: TransferRecord, run: RunCtx, err: Error): void {
    if (TERMINAL_STATES.has(rec.state) || run.cancelled) return;
    // A run replaced by a newer link attempt (the peer sent fresh `content`) must not end the transfer.
    if (this.runs.get(rec.id) !== run) return;
    const code = err instanceof SessionError ? err.code : 'INTERNAL_ERROR';
    LOG.warn(LOG_TAG, `${idTag(rec)} link ${rec.linkGen} failed code=${code}`);
    // A direct path that cannot exist is not final when both daemons allow a relay: the source retries
    // with relay allowed, the target waits (paused) for that retry like for any lost link.
    if (code === 'DIRECT_UNAVAILABLE' && !run.relay && this.relayAllowed()) {
      this.setState(rec, 'paused', 'paused');
      try { run.link?.close(); } catch { /* ignore */ }
      run.link = undefined; run.session = undefined;
      if (rec.role === 'source') this.escalateToRelay(rec, run);
      return;
    }
    if (code === 'LINK_LOST' || code === 'PEER_ABORT') {
      this.setState(rec, 'paused', 'paused');
      try { run.link?.close(); } catch { /* ignore */ }
      run.link = undefined; run.session = undefined;
      if (rec.role === 'source') this.scheduleRetry(rec, run);
      return;
    }
    this.terminate(rec, 'failed', code, true);
  }

  /** Direct attempts are over and this daemon allows a relay: retry the link with TURN candidates. */
  private escalateToRelay(rec: TransferRecord, run: RunCtx): void {
    run.relay = true;
    run.retries = 0;
    LOG.info(LOG_TAG, `${idTag(rec)} direct connection unavailable; retrying with relay allowed`);
    run.retryTimer = setTimeout(() => {
      if (TERMINAL_STATES.has(rec.state)) return;
      this.openSourceLink(rec, run).catch((e) => this.onSessionFailure(rec, run, e instanceof Error ? e : new SessionError('INTERNAL_ERROR', String(e))));
    }, 0);
    run.retryTimer.unref?.();
  }

  private scheduleRetry(rec: TransferRecord, run: RunCtx): void {
    if (!run.relay && run.retries >= TRANSFER_LIMITS.directRetriesBeforeRelay && this.relayAllowed()) { this.escalateToRelay(rec, run); return; }
    if (run.retries >= 5) { this.terminate(rec, 'failed', 'DIRECT_UNAVAILABLE', true); return; }
    const delay = Math.min(30_000, 1000 * 2 ** run.retries++);
    LOG.info(LOG_TAG, `${idTag(rec)} retry ${run.retries}/5 scheduled in ${delay}ms`);
    run.retryTimer = setTimeout(() => {
      if (TERMINAL_STATES.has(rec.state)) return;
      this.openSourceLink(rec, run).catch((e) => this.onSessionFailure(rec, run, e instanceof Error ? e : new SessionError('INTERNAL_ERROR', String(e))));
    }, delay);
    run.retryTimer.unref?.();
  }

  // ── peer API (control plane) ─────────────────────────────────────────────────

  async handlePeerOp(sender: string, args: Record<string, any>): Promise<{ ok: boolean; code?: string; [k: string]: unknown }> {
    const op = String(args?.op ?? '');
    if (op === 'resolve_workspace') {
      // Which of MY registered workspaces does this loose name mean? Id and label only: no paths leave this machine.
      if (!sender || !this.ports.isPeerAuthorized(sender)) return fail('PEER_UNAUTHORIZED');
      const w = findWorkspace(String(args?.query ?? '').slice(0, 1024));
      return w ? { ok: true, workspaceId: w.id, ...(w.label ? { label: w.label } : {}) } : fail('WORKSPACE_NOT_REGISTERED');
    }
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
        case 'agent_approve': return await this.onAgentApprove(rec, args);
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

  private onOffer(sender: string, id: string, args: Record<string, any>): { ok: boolean; code?: string; [k: string]: unknown } {
    const unsupported = this.requireSupport();
    if (unsupported) return unsupported;
    if (this.records.has(id)) return fail('DUPLICATE');
    if ([...this.records.values()].filter((r) => !TERMINAL_STATES.has(r.state)).length >= MAX_OPEN_TRANSFERS) return fail('TOO_MANY_TRANSFERS');
    const selection = validateSelectionManifest(args.selection);
    const self = this.ports.selfDaemonId();
    if (selection.transferId !== id || !daemonIdsEquivalent(selection.sourceDaemonId, sender) || !daemonIdsEquivalent(selection.targetDaemonId, self)) return fail('PEER_UNAUTHORIZED');
    if (selectionDigest(selection) !== args.selectionDigest) return fail('APPROVAL_MISMATCH');
    const ws = this.ports.resolveWorkspace(selection.targetWorkspaceId);
    if (!ws) return fail('WORKSPACE_NOT_REGISTERED');
    try { probeRoot(ws.path, { requireAtomicNoReplace: true }); } catch { return fail('ATOMIC_NOREPLACE_UNSUPPORTED'); }
    try { requireFreeDisk(ws.path, selectionTotalBytes(selection)); } catch (e) { return fail((e as ManifestError).code ?? 'DISK_SPACE_EXHAUSTED'); }
    let overwrite: OverwriteInfo | undefined;
    if (selection.targetMode === 'existing_path') {
      try { overwrite = { ...this.scanTarget(selection) }; } catch (e) { return fail(e instanceof OverwriteError ? e.code : 'TARGET_PATH_UNSAFE'); }
    }
    const requestedBy = normalizeRequester(args.requestedBy);
    const t = this.now();
    this.persist({
      v: 1, id, role: 'target', peerDaemonId: sender, selection, selectionDigest: args.selectionDigest, state: 'offered',
      createdAt: t, updatedAt: t, activityAt: t, previewExpiresAt: t + TRANSFER_RETENTION_MS.preview,
      linkGen: 0, blocksDone: [], bytesDone: 0, totalBytes: selectionTotalBytes(selection),
      ...(requestedBy ? { requestedBy } : {}),
      ...(overwrite ? { overwrite } : {}),
    }, 'offered');
    const rec = this.records.get(id)!;
    return {
      ok: true,
      // The requester learns this machine's OWN setting; it is only ever a hint, the target re-checks on `agent_approve`.
      agentAutoApprove: !!requestedBy && this.agentAutoApproveAllowed(),
      ...(overwrite ? { overwrite: this.overwriteView(rec) } : {}),
    };
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
    const ovProblem = this.checkOverwriteApproval(rec, rec.overwrite?.digest);
    if (ovProblem) return ovProblem;
    if (!Number.isInteger(args.linkGen) || args.linkGen <= rec.linkGen) return fail('PROTOCOL_ERROR');
    const relay = args.relay === true;
    if (relay) {
      if (!this.relayAllowed()) return fail('RELAY_NOT_ALLOWED');
      try { this.checkRelayLimits(rec); } catch (e) { return fail((e as SessionError).code); }
    }
    const key = Buffer.from(String(args.linkKeyB64 ?? ''), 'base64');
    if (key.length !== 32) return fail('PROTOCOL_ERROR');
    if (this.activeCount() >= TRANSFER_LIMITS.maxConcurrentPerDaemon && !ACTIVE_STATES.has(rec.state)) return fail('TOO_MANY_TRANSFERS');
    const factory = this.ports.linkFactory;
    if (!factory) return fail('LINK_UNAVAILABLE');
    const ws = this.ports.resolveWorkspace(rec.selection.targetWorkspaceId);
    if (!ws) return fail('WORKSPACE_NOT_REGISTERED');

    const prev = this.runs.get(rec.id);
    if (prev) { clearInterval(prev.watchdog); try { prev.session?.abort('SUPERSEDED'); prev.link?.close(); } catch { /* ignore */ } prev.receiver?.dispose(); }
    const run: RunCtx = { ...newRun(), linkKey: key, ...(relay ? { relay: true } : {}) };
    rec.content = content;
    rec.linkGen = args.linkGen;
    if (rec.blocksDone.length !== content.files.length) rec.blocksDone = content.files.map(() => 0);
    const receiver = new TransferReceiver(ws.path, rec.selection, content, (fi, blocks, bytes) => {
      rec.blocksDone[fi] = blocks; rec.bytesDone = bytes; this.persist(rec);
      this.accountRelay(rec, run);
    });
    let resume: number[];
    try { resume = receiver.init(rec.blocksDone); } catch (e) { receiver.dispose(); throw e; }
    rec.blocksDone = [...resume];
    run.receiver = receiver;
    this.runs.set(rec.id, run);
    this.setState(rec, 'linking');
    LOG.info(LOG_TAG, `${idTag(rec)} link attempt ${rec.linkGen} started (responder)`);
    const link = factory.create({ transferId: rec.id, role: 'responder', linkGen: rec.linkGen, ...(relay ? { allowRelay: true } : {}) });
    run.link = link;
    link.onSignalOut((s) => { void this.ports.dispatchPeer(rec.peerDaemonId, { op: 'signal', transferId: rec.id, linkGen: rec.linkGen, signal: s }).catch(() => {}); });
    const session = new ReceiverSession(link, rec.id, rec.linkGen, key, receiver, resume);
    run.session = session;
    this.armWatchdog(rec, run);
    this.bindEstablished(rec, run, session);
    session.wait().then(() => this.finishTarget(rec, run), (e: Error) => this.onSessionFailure(rec, run, e));
    return { ok: true };
  }

  private onSignal(rec: TransferRecord, args: Record<string, any>): { ok: boolean; code?: string } {
    const run = this.runs.get(rec.id);
    if (!run?.link || args.linkGen !== rec.linkGen) return fail('STALE_LINK');
    const s = args.signal as TransferSignal;
    if (!s || !['offer', 'answer', 'candidate'].includes(s.kind)) return fail('PROTOCOL_ERROR');
    if (!run.relay && typeof s.candidate === 'string' && / typ relay\b/.test(s.candidate)) return fail('RELAY_CANDIDATE_REFUSED');
    if (s.kind !== 'candidate') {
      // A remote SDP may embed candidates and must carry exactly one DTLS fingerprint value.
      if (typeof s.sdp !== 'string') return fail('PROTOCOL_ERROR');
      if (!run.relay && sdpHasRelayCandidate(s.sdp)) return fail('RELAY_CANDIDATE_REFUSED');
      if (!extractSdpFingerprint(s.sdp)) return fail('SDP_FINGERPRINT_INVALID');
    }
    run.link.signalIn(s);
    return { ok: true };
  }

  private onPeerState(rec: TransferRecord, args: Record<string, any>): { ok: boolean; code?: string } {
    if (rec.role !== 'source') return { ok: true };
    if (args.state === 'completed') {
      // Only meaningful once every block was acknowledged (we are verifying); anything earlier is a lie.
      if (rec.state !== 'verifying' && rec.state !== 'transferring') return fail('PROTOCOL_ERROR');
      if (!rec.content || rec.content.files.some((f, i) => (rec.blocksDone[i] ?? 0) < blockCount(f.size))) return fail('PROTOCOL_ERROR');
      if (typeof args.publishedName === 'string') {
        try { rec.publishedName = validateFinalName(args.publishedName); } catch { return fail('PROTOCOL_ERROR'); }
      }
      this.completeRecord(rec);
    } else if (args.state === 'failed') {
      this.terminate(rec, 'failed', safeTransferCode(args.code ?? 'TARGET_FAILED'), false);
    }
    return { ok: true };
  }

  private async finishTarget(rec: TransferRecord, run: RunCtx): Promise<void> {
    try {
      this.setState(rec, 'verifying');
      run.receiver!.verifyAll();
      this.guard(rec); // consent may have lapsed / authority changed while data was flowing
      this.setState(rec, 'publishing');
      if (rec.selection.targetMode === 'existing_path') {
        if (!rec.overwrite) throw new OverwriteError('TARGET_CHANGED', 'overwrite plan missing');
        run.receiver!.publishExisting({ targetDir: rec.overwrite.targetDir, newFiles: rec.overwrite.newFiles, replaced: rec.overwrite.replaced, digest: rec.overwrite.digest }, this.store.backupDir(rec.id));
        rec.publishedName = rec.overwrite.targetDir || undefined;
      } else rec.publishedName = run.receiver!.publish(rec.selection.finalName);
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
    this.notifyTerminal(rec);
  }

  /** Remove everything (tests / shutdown). */
  shutdown(): void {
    for (const id of [...this.runs.keys()]) this.teardownRun(id, false);
  }
}

function normalizeRequester(v: unknown): TransferRequester | undefined {
  const r = v as { role?: unknown; sessionId?: unknown } | null;
  if (!r || typeof r !== 'object' || (r.role !== 'coordinator' && r.role !== 'assistant')) return undefined;
  const sid = typeof r.sessionId === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(r.sessionId) ? r.sessionId : undefined;
  return { role: r.role, ...(sid ? { sessionId: sid } : {}) };
}

/** The target machine's overwrite preview as received by the source (no content hashes of foreign files). */
function parsePeerOverwrite(raw: unknown, targetDir: string): OverwriteInfo | null {
  const o = raw as { targetDir?: unknown; digest?: unknown; replaced?: unknown; newCount?: unknown } | null;
  if (!o || typeof o !== 'object' || o.targetDir !== targetDir || typeof o.digest !== 'string' || !/^[0-9a-f]{64}$/.test(o.digest) || !Array.isArray(o.replaced)) return null;
  const replaced: OverwriteInfo['replaced'] = [];
  for (const r of o.replaced.slice(0, TRANSFER_LIMITS.maxEntries)) {
    const x = r as { path?: unknown; size?: unknown };
    if (typeof x?.path !== 'string' || !Number.isSafeInteger(x.size)) return null;
    replaced.push({ path: x.path, size: x.size as number, sha256: '' });
  }
  const newCount = Number.isSafeInteger(o.newCount) ? (o.newCount as number) : 0;
  return { targetDir, digest: o.digest, replaced, newFiles: Array.from({ length: Math.min(newCount, TRANSFER_LIMITS.maxEntries) }, () => '') };
}

export type { TransferRole };
export function defaultTransferBaseDir(configDir: string): string { return path.join(configDir, 'project-transfers'); }
export function ensureBaseDir(dir: string): void { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
