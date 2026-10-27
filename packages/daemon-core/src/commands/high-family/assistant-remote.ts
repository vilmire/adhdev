import { environmentInventory } from '../../assistant/environment-inventory.js';
import { readTerminalEvents } from '../../assistant/terminal-watch.js';
import { MeshRuntimeStore } from '../../mesh/mesh-runtime-store.js';
import { parseReportContinuation } from '../../assistant/report-continuation.js';
/**
 * Host side of a remote-hosted assistant project (owner decision 2026-10-08,
 * closing design Q4 of docs/design/2026-10-07-assistant-layer.md): another
 * daemon's assistant drives a mesh THIS daemon hosts by relaying here.
 *
 * One verb, `assistant_remote_project {meshId, op, …}`, ops:
 *   - `status` — the `project_status` body (assistant.ts `localProjectStatus`);
 *   - `send`   — ensure a coordinator here + `send_chat` (origin `assistant`,
 *                queue) of the text the caller composed (`localProjectSend`).
 *                No thread opens HERE: the caller's assistant owns it;
 *   - `read`   — the `project_read` body (`localProjectRead`);
 *   - `poll`   — the coordinator's turns this daemon's ledger committed after
 *                the caller's cursor, the coordinator's latest reply, open /
 *                modal state, content-free work counts and `[Mesh]` line;
 *   - `note`   — record / forget an operating note. The caller already
 *                classified the origin and applied its staging rules; the
 *                text checks run again here (defence in depth).
 *
 * ─── Who may call it (security) ─────────────────────────────────────────
 * Source `mesh` ONLY: it is reachable solely through the daemon↔daemon mesh
 * transport, never from the dashboard, the HTTP API or an MCP server on this
 * daemon. The router's mesh-sender gate runs first with class `roster`: the
 * transport-stamped (authenticated) sender must be on the roster of the named
 * mesh in THIS daemon's own mesh record — the host's meshes.json, which is
 * authoritative; ids in the payload are claims. The handler then requires that
 * this daemon actually hosts that mesh (inventory-only reads may answer from a roster member) (a roster from an `inlineMesh` the
 * payload carried is never enough). It never takes a session id: the only
 * session it writes to is the coordinator of that one mesh, picked here
 * (`ensureCoordinator`), so a roster member cannot reach any other session.
 *
 * What this grants beyond the existing mesh trust: a roster member can put
 * text into the mesh's coordinator — the owner's decision (manage every
 * reachable project). Every peer is a daemon of the same account (cloud: the
 * server pairs only same-account daemons; standalone: the pairing code
 * admitted it), and a member already runs code its coordinator dispatches.
 * The text enters with origin `assistant` (the coordinator's prompt frames it
 * as relayed instructions), each send/note logs the sender here, and a
 * revoked/removed member drops off the roster and is refused.
 */

import { createHash } from 'crypto';
import {
    ASSISTANT_ACCOUNT_SLOT,
    ASSISTANT_FOLLOWER_ALLOWED_OPS,
    ASSISTANT_REMOTE_PROJECT_ACCESS_COMMAND,
    ASSISTANT_REMOTE_PROJECT_CATALOG_COMMAND,
    canonicalDaemonId,
    daemonIdsEquivalent,
    isAssistantFollowerAllowedOp,
    sanitizeRemoteRepoIdentity,
    type AssistantRemoteAccessBinding,
    type RemoteProjectCatalogItem,
} from '@adhdev/mesh-shared';
import { defineCommandSpecs } from '../command-registry.js';
import { isTrustedOwnerIngress } from '../command-args.js';
import { componentsNotReadyResult, isDaemonComponentsNotReady } from '../daemon-components-port.js';
import { readMeshSender } from '../mesh-sender.js';
import type { CommandRouterResult } from '../router.js';
import type { HighFamilyContext, HighFamilyHandler } from './types.js';
import { LOG } from '../../logging/logger.js';
import { getAssistantServices } from '../../assistant/assistant-services.js';
import {
    ensureCoordinator,
    isConfirmedTerminalCoordinator,
    isLiveSessionHostRuntimeMetadata,
    pickCoordinator,
    type AssistantCoordinatorView,
} from '../../assistant/coordinator-lifecycle.js';
import { compactTranscriptTail, coordinatorState, followerStatusView } from '../../assistant/project-views.js';
import { ASSISTANT_REMOTE_PROJECT_COMMAND, ASSISTANT_REMOTE_OPS, type AssistantRemoteOp } from '../../assistant/assistant-remote-host.js';
import type { AssistantProjectPorts, CoordinatorLiveness } from '../../assistant/assistant-project-ports.js';
import { coordinatorPorts, localArtifactList, localArtifactRead, localProjectRead, localProjectSend, localProjectStatus, localAttemptReport, readTailArg } from './assistant.js';
import { applyNote, noteTextRefusal, parseNoteOp, projectPortsFor } from './assistant-store.js';
import { normalizeAssistantRemoteAccessBinding } from '../../config/mesh-config.js';
import {
    MeshConfigStrictLockError,
    loadMeshConfigStrict,
    readMeshConfigFromDisk,
    saveMeshConfigDurable,
    withStrictMeshConfigWriteLock,
} from '../../config/mesh-config-store.js';
import type { LocalMeshEntry } from '../../repo-mesh-types.js';

/** Largest composed text a remote send carries (the caller composes; skills are capped at 12 k there). */
export const REMOTE_SEND_MAX_CHARS = 64_000;
/** Commits returned per poll (older ones fold into the relay's "earlier turns"). */
export const REMOTE_POLL_MAX_COMMITS = 5;

export const ASSISTANT_REMOTE_OWNER_SOURCES = ['p2p', 'ws', 'standalone'] as const;

function str(v: unknown): string {
    return typeof v === 'string' ? v.trim() : '';
}

function record(v: unknown): Record<string, unknown> | undefined {
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
}

function fail(code: string, error: string = code, extra: Record<string, unknown> = {}): CommandRouterResult {
    return { success: false, code, error, ...extra };
}

/**
 * Per-mesh async mutex serializing host ACL grant/revoke mutations with
 * follower send admission + enqueue so a concurrent revoke cannot interleave
 * with an in-flight follower send check.
 */
const meshRemoteAccessQueues = new Map<string, Promise<unknown>>();

export async function withMeshRemoteAccessMutex<T>(meshId: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = meshRemoteAccessQueues.get(meshId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const next = prev.then(() => gate, () => gate);
    meshRemoteAccessQueues.set(meshId, next);
    await prev.catch(() => undefined);
    try {
        return await fn();
    } finally {
        release();
        if (meshRemoteAccessQueues.get(meshId) === next) {
            meshRemoteAccessQueues.delete(meshId);
        }
    }
}

import {
    FOLLOWER_COORDINATOR_WAKE_EVENT_KIND,
    FOLLOWER_SEND_RECEIPT_MAX_ENTRIES,
    FOLLOWER_SEND_RECEIPT_TTL_MS,
    FOLLOWER_WAKE_COOLDOWN_MS,
    FOLLOWER_WAKE_FUTURE_SKEW_MS,
    FOLLOWER_WAKE_MAX_PER_WINDOW,
    FOLLOWER_WAKE_RECONCILE_MAX_DRIFT_MS,
    FOLLOWER_WAKE_WINDOW_MS,
    UNTRUSTED_RELAY_NOTICE,
    clearFollowerSendReceiptsForTest,
    clearFollowerWakeRateLimitForTest,
    frameFollowerWakeRelayText,
    getFollowerSendReceiptCountForTest,
    hasInFlightFollowerWakeReservation,
    readFollowerSendReceipt,
    rebuildFollowerWakeRateLimitFromStore,
    recordFollowerSendReceipt,
    recordFollowerWakeAuditEvent,
    reserveFollowerWakeSlot,
    settleFollowerWakeReservation,
    type FollowerWakeReservation,
    type WakeAuditContext,
} from './assistant-follower-wake-quota.js';

export {
    FOLLOWER_COORDINATOR_WAKE_EVENT_KIND,
    FOLLOWER_SEND_RECEIPT_MAX_ENTRIES,
    FOLLOWER_SEND_RECEIPT_TTL_MS,
    FOLLOWER_WAKE_COOLDOWN_MS,
    FOLLOWER_WAKE_FUTURE_SKEW_MS,
    FOLLOWER_WAKE_MAX_PER_WINDOW,
    FOLLOWER_WAKE_RECONCILE_MAX_DRIFT_MS,
    FOLLOWER_WAKE_WINDOW_MS,
    UNTRUSTED_RELAY_NOTICE,
    clearFollowerSendReceiptsForTest,
    clearFollowerWakeRateLimitForTest,
    frameFollowerWakeRelayText,
    getFollowerSendReceiptCountForTest,
    rebuildFollowerWakeRateLimitFromStore,
};

/** The coordinator's latest assistant-role bubble (the same projection a local relay reads). */
async function coordinatorTail(ports: AssistantProjectPorts, sessionId: string): Promise<string | null> {
    const chat = await ports.execute('read_chat', { targetSessionId: sessionId, limit: 40 });
    if (!chat.success) return null;
    const messages = (compactTranscriptTail(chat, 20).messages as Array<{ role: string; text: string }>) ?? [];
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === 'assistant') return messages[i]!.text;
    return null;
}

async function poll(ports: AssistantProjectPorts, meshId: string, args: Record<string, unknown>): Promise<CommandRouterResult> {
    const views = ports.coordinators(meshId);
    const live = pickCoordinator(views);
    const queue = ports.queueCounts(meshId);
    const missions = ports.activeMissionCount(meshId);
    const work = queue ? { activeMissions: missions ?? 0, pending: queue.pending, assigned: queue.assigned } : null;
    const statusLine = ports.meshStatusLine(meshId);
    const sessionId = live?.sessionId ?? ports.lastCoordinatorSessionId(meshId);
    if (!sessionId) {
        return { success: true, coordinator: 'none', coordinatorSessionId: null, open: false, modal: false, commits: [], cursor: null, cursorFound: false, work, statusLine };
    }
    const turns = ports.coordinatorTurns(sessionId, REMOTE_POLL_MAX_COMMITS);
    if (args.cursorOnly === true) {
        return {
            success: true, coordinator: coordinatorState(views), coordinatorSessionId: sessionId,
            open: turns.open, modal: !!live?.modalParked, commits: [],
            cursor: turns.committed[0]?.attemptId ?? null, cursorFound: true, work, statusLine,
        };
    }
    const after = str(args.afterAttemptId);
    const idx = after ? turns.committed.findIndex((c) => c.attemptId === after) : -1;
    const fresh = idx >= 0 ? turns.committed.slice(0, idx) : turns.committed;
    const now = Date.now();
    const commits = fresh.slice().reverse().map((c) => ({ attemptId: c.attemptId, outcome: c.outcome, ageMs: Math.max(0, now - c.at) }));
    return {
        success: true, coordinator: coordinatorState(views), coordinatorSessionId: sessionId,
        open: turns.open, modal: !!live?.modalParked, commits,
        cursor: turns.committed[0]?.attemptId ?? null, cursorFound: idx >= 0,
        ...(commits.length ? { body: await coordinatorTail(ports, sessionId) } : {}),
        work, statusLine,
    };
}

async function note(meshId: string, args: Record<string, unknown>): Promise<CommandRouterResult> {
    const op = parseNoteOp(args);
    if (typeof op === 'string') return fail('invalid_args', op);
    const callerSessionId = str(args.callerSessionId);
    if (op.action === 'list' || op.action === 'read') {
        const out = await applyNote(getAssistantServices(), meshId, op, 'human', callerSessionId || undefined);
        if (out.result === 'note_not_found') {
            return fail('note_not_found', String(out.error || 'note_not_found'), {
                ...(typeof out.noteId === 'string' ? { noteId: out.noteId } : {}),
            });
        }
        return { success: true, ...out };
    }
    const origin = str(args.origin);
    if (origin !== 'human' && origin !== 'owner') return fail('invalid_args', 'origin must be human or owner');
    const refusal = noteTextRefusal(op.text);
    if (refusal) return fail(refusal.result, refusal.result, refusal.pattern ? { pattern: refusal.pattern } : {});
    const applied = await applyNote(getAssistantServices(), meshId, op, origin, callerSessionId || undefined);
    return { success: true, ...applied };
}

function isSenderOnWorkerRoster(mesh: LocalMeshEntry, selfDaemonId: string, sender: string): boolean {
    if (!sender) return false;
    if (selfDaemonId && daemonIdsEquivalent(sender, selfDaemonId)) return true;
    return (mesh.nodes ?? []).some((n) => typeof n.daemonId === 'string' && daemonIdsEquivalent(n.daemonId, sender));
}

function hasExplicitFollowerClaim(args: Record<string, unknown>): boolean {
    return record(args.followerAccess) !== undefined || typeof args.bindingRevision === 'number' || typeof args.grantRevision === 'number';
}

function readHostMeshStrict(
    ports: AssistantProjectPorts,
    meshId: string,
): { ok: true; mesh: LocalMeshEntry | undefined } | { ok: false; result: CommandRouterResult } {
    try {
        const disk = loadMeshConfigStrict().meshes.find((m) => m.id === meshId);
        if (disk) return { ok: true, mesh: disk };
        return { ok: true, mesh: ports.listMeshes().find((m) => m.id === meshId) };
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
            ok: false,
            result: fail(
                'host_unavailable_transient',
                `host_unavailable_transient: host could not read mesh config for ${meshId} (${msg}); retry`,
            ),
        };
    }
}

function verifyFollowerAcl(
    ports: AssistantProjectPorts,
    mesh: LocalMeshEntry | undefined,
    meshId: string,
    sender: string,
    op: string,
    args: Record<string, unknown>,
): { ok: true; acl: AssistantRemoteAccessBinding } | { ok: false; result: CommandRouterResult } {
    if (!mesh) {
        const strictRead = readHostMeshStrict(ports, meshId);
        if (!strictRead.ok) return strictRead;
        mesh = strictRead.mesh;
    }
    if (!mesh) return { ok: false, result: fail('project_not_found', `mesh ${meshId} is not in this daemon's project inventory`) };
    if (!ports.isHostedHere(mesh)) return { ok: false, result: fail('project_not_hosted_here', `this daemon does not host mesh ${meshId}`) };
    const self = ports.selfDaemonId();
    const acl = normalizeAssistantRemoteAccessBinding(mesh.assistantRemoteAccess, meshId);
    if (!acl) return { ok: false, result: fail('remote_access_denied', `No valid assistantRemoteAccess grant for mesh ${meshId}.`) };
    if (self && !daemonIdsEquivalent(acl.hostDaemonId, self)) {
        return { ok: false, result: fail('remote_access_denied', `Host daemon identity mismatch for mesh ${meshId}.`) };
    }
    if (acl.status !== 'active') {
        return {
            ok: false,
            result: fail('host_revoked', `Assistant remote access for mesh ${meshId} has been revoked by the host.`, {
                grantRevision: acl.grantRevision, bindingRevision: acl.bindingRevision,
            }),
        };
    }
    if (!sender || !daemonIdsEquivalent(acl.activeDaemonId, sender)) {
        return { ok: false, result: fail('remote_access_denied', `Sender is not the active authorized assistant daemon for mesh ${meshId}.`) };
    }
    const followerClaim = record(args.followerAccess);
    const claimedSlot = str(followerClaim?.accountSlot) || str(args.accountSlot) || ASSISTANT_ACCOUNT_SLOT;
    if (claimedSlot !== ASSISTANT_ACCOUNT_SLOT) return { ok: false, result: fail('remote_access_denied', `Invalid assistant accountSlot '${claimedSlot}'.`) };
    const claimedBindingRev = typeof args.bindingRevision === 'number'
        ? args.bindingRevision : typeof followerClaim?.bindingRevision === 'number' ? (followerClaim.bindingRevision as number) : null;
    const claimedGrantRev = typeof args.grantRevision === 'number'
        ? args.grantRevision : typeof followerClaim?.grantRevision === 'number' ? (followerClaim.grantRevision as number) : null;
    if (claimedBindingRev !== acl.bindingRevision || claimedGrantRev !== acl.grantRevision) {
        return {
            ok: false,
            result: fail('remote_access_denied', `Follower revision mismatch for mesh ${meshId}.`, {
                actualBindingRevision: acl.bindingRevision, actualGrantRevision: acl.grantRevision,
            }),
        };
    }
    if ((op === 'artifact_list' || op === 'artifact_read') && acl.allowArtifactRead !== true) {
        return {
            ok: false,
            result: fail('artifact_read_disabled', `Remote follower artifact reading is disabled for mesh ${meshId}.`, {
                bindingRevision: acl.bindingRevision, grantRevision: acl.grantRevision,
            }),
        };
    }
    if (!isAssistantFollowerAllowedOp(op) || !acl.allowedOps.includes(op)) {
        return { ok: false, result: fail('remote_op_forbidden', `Operation '${op}' is not permitted for checkout-less remote followers.`) };
    }
    return { ok: true, acl };
}

const MISSING_OR_DEAD_SESSION_REASONS = new Set([
    'session_exited', 'no_target', 'not_running', 'session_not_found',
    'instance_not_found', 'runtime_missing', 'runtime_dead', 'coordinator_missing',
]);

function isMissingOrDeadCoordinatorRuntime(sent: Record<string, unknown>): boolean {
    const code = str(sent.reason) || str(sent.code);
    if (code && MISSING_OR_DEAD_SESSION_REASONS.has(code.toLowerCase())) return true;
    const err = str(sent.error).toLowerCase();
    return err.includes('cli instance not found') || err.includes('no live session')
        || err.includes('session has ended') || err.includes('session not found')
        || err.includes('instance not found') || err.includes('not running')
        || err.includes('process exited') || err.includes('runtime not found for session')
        || err.includes('unknown session');
}

export async function classifyCoordinatorRuntimeLivenessForFollower(
    ports: AssistantProjectPorts,
    target: AssistantCoordinatorView,
): Promise<CoordinatorLiveness> {
    if (isConfirmedTerminalCoordinator(target)) return 'dead';
    const targetRec = target as unknown as Record<string, unknown>;
    if (targetRec.runtime !== undefined && !isLiveSessionHostRuntimeMetadata(targetRec.runtime)) return 'dead';
    const liveStates = ports.liveSessionStates?.() ?? [];
    for (const s of liveStates) {
        if (!s || typeof s !== 'object') continue;
        const sRec = s as Record<string, unknown>;
        const sid = typeof sRec.instanceId === 'string' ? sRec.instanceId : typeof sRec.sessionId === 'string' ? sRec.sessionId : '';
        if (sid !== target.sessionId) continue;
        if (isConfirmedTerminalCoordinator(s)) return 'dead';
        if (sRec.runtime !== undefined && !isLiveSessionHostRuntimeMetadata(sRec.runtime)) return 'dead';
    }
    if (typeof ports.isCoordinatorLive === 'function') {
        try {
            const live = await ports.isCoordinatorLive(target.sessionId);
            if (live === false || live === 'dead') return 'dead';
            if (live === 'unknown') return 'unknown';
            return 'live';
        } catch {
            return 'unknown';
        }
    }
    return 'live';
}

function verifyRemoteFollowerBindingForWake(
    ports: AssistantProjectPorts,
    mesh: LocalMeshEntry | undefined,
    meshId: string,
    sender: string,
    args: Record<string, unknown>,
): { ok: true; acl: AssistantRemoteAccessBinding } | { ok: false; result: CommandRouterResult } {
    if (!mesh || !ports.isHostedHere(mesh)) return { ok: false, result: fail('project_not_hosted_here', `this daemon does not host mesh ${meshId}`) };
    const acl = normalizeAssistantRemoteAccessBinding(mesh.assistantRemoteAccess, meshId);
    if (!acl) return { ok: false, result: fail('remote_access_denied', `No valid assistantRemoteAccess grant for mesh ${meshId}.`) };
    const self = ports.selfDaemonId();
    if (!self || !daemonIdsEquivalent(acl.hostDaemonId, self)) {
        return { ok: false, result: fail('remote_access_denied', `assistantRemoteAccess hostDaemonId mismatch for mesh ${meshId}.`) };
    }
    if (acl.status !== 'active') {
        return {
            ok: false,
            result: fail('host_revoked', `Assistant remote access for mesh ${meshId} has been revoked by the host.`, {
                grantRevision: acl.grantRevision, bindingRevision: acl.bindingRevision,
            }),
        };
    }
    if (acl.accountSlot !== ASSISTANT_ACCOUNT_SLOT) return { ok: false, result: fail('remote_access_denied', `Invalid assistant accountSlot '${acl.accountSlot}'.`) };
    const canonSender = canonicalDaemonId(sender);
    if (!canonSender || daemonIdsEquivalent(canonSender, self) || !daemonIdsEquivalent(acl.activeDaemonId, canonSender)) {
        return { ok: false, result: fail('remote_access_denied', `Sender is not the active authorized assistant daemon for mesh ${meshId}.`) };
    }
    const followerClaim = record(args.followerAccess);
    const localBindingErr = str(followerClaim?.localBindingError);
    if (localBindingErr) return { ok: false, result: fail(localBindingErr, `Follower reported local owner-binding error: ${localBindingErr}`) };
    const claimedSlot = str(followerClaim?.accountSlot) || str(args.accountSlot) || ASSISTANT_ACCOUNT_SLOT;
    if (claimedSlot !== acl.accountSlot) return { ok: false, result: fail('remote_access_denied', `Invalid assistant accountSlot '${claimedSlot}'.`) };
    const claimedActiveDaemonId = str(followerClaim?.activeDaemonId);
    if (claimedActiveDaemonId && !daemonIdsEquivalent(claimedActiveDaemonId, acl.activeDaemonId)) {
        return { ok: false, result: fail('remote_access_denied', `Follower activeDaemonId does not match host grant for mesh ${meshId}.`) };
    }
    const claimedHostDaemonId = str(followerClaim?.hostDaemonId);
    if (claimedHostDaemonId && !daemonIdsEquivalent(claimedHostDaemonId, acl.hostDaemonId)) {
        return { ok: false, result: fail('remote_access_denied', `Follower hostDaemonId does not match host grant for mesh ${meshId}.`) };
    }
    const claimedBindingRev = typeof args.bindingRevision === 'number'
        ? args.bindingRevision : typeof followerClaim?.bindingRevision === 'number' ? (followerClaim.bindingRevision as number) : null;
    const claimedGrantRev = typeof args.grantRevision === 'number'
        ? args.grantRevision : typeof followerClaim?.grantRevision === 'number' ? (followerClaim.grantRevision as number) : null;
    if (claimedBindingRev !== acl.bindingRevision || claimedGrantRev !== acl.grantRevision) {
        return {
            ok: false,
            result: fail('remote_access_denied', `Follower revision mismatch for mesh ${meshId}.`, {
                actualBindingRevision: acl.bindingRevision, actualGrantRevision: acl.grantRevision,
            }),
        };
    }
    return { ok: true, acl };
}

async function followerProjectSend(
    ports: AssistantProjectPorts,
    meshId: string,
    sender: string,
    args: Record<string, unknown>,
): Promise<CommandRouterResult> {
    const text = typeof args.text === 'string' ? args.text : '';
    if (!text.trim()) return fail('invalid_args', 'text required');
    if (text.length > REMOTE_SEND_MAX_CHARS) return fail('invalid_args', `text over ${REMOTE_SEND_MAX_CHARS} characters`);
    const clientId = str(args.clientId);
    if (!clientId || clientId.length > 200) return fail('invalid_args', 'clientId required (at most 200 characters)');
    const expectedCoordinatorSessionId = str(args.expectedCoordinatorSessionId);

    const bodyHash = createHash('sha256').update(text, 'utf8').digest('hex');
    const canonSender = canonicalDaemonId(sender) ?? sender;
    const deadSessionIds = new Set<string>();

    const admitted = await withMeshRemoteAccessMutex(meshId, async () => {
        const freshRead = readHostMeshStrict(ports, meshId);
        if (!freshRead.ok) return freshRead;
        const verified = verifyFollowerAcl(ports, freshRead.mesh, meshId, sender, 'send', args);
        if (!verified.ok) return { ok: false as const, result: verified.result };
        const acl = verified.acl;
        const now = Date.now();
        const idempotencyKey = `${acl.hostDaemonId}::${meshId}::${acl.accountSlot}::${acl.activeDaemonId}::b${acl.bindingRevision}::g${acl.grantRevision}::${clientId}`;
        const prior = readFollowerSendReceipt(idempotencyKey, now);
        const live = pickCoordinator(ports.coordinators(meshId));
        return { ok: true as const, acl, now, idempotencyKey, prior, live };
    });
    if (!admitted.ok) return admitted.result;

    let { acl, live } = admitted;
    const { idempotencyKey, prior } = admitted;
    let launched = false;
    let pickedCoordinatorLiveness: CoordinatorLiveness = 'live';

    if (live) {
        pickedCoordinatorLiveness = await classifyCoordinatorRuntimeLivenessForFollower(ports, live);
        if (pickedCoordinatorLiveness === 'dead') {
            deadSessionIds.add(live.sessionId);
            live = null;
        }
    }

    if (prior) {
        if (prior.bodyHash !== bodyHash) return fail('idempotency_body_mismatch', 'Retry with the same clientId carried a different message body.');
        if (!live || prior.coordinatorSessionId !== live.sessionId) {
            return fail('coordinator_replaced', 'The coordinator session changed since the original send; refusing to replay to a replacement session.', {
                originalCoordinatorSessionId: prior.coordinatorSessionId, currentCoordinatorSessionId: live?.sessionId ?? null,
            });
        }
        return withMeshRemoteAccessMutex(meshId, async () => {
            const latestRead = readHostMeshStrict(ports, meshId);
            if (!latestRead.ok) return latestRead.result;
            const recheck = verifyFollowerAcl(ports, latestRead.mesh, meshId, sender, 'send', args);
            if (!recheck.ok) return recheck.result;
            return {
                success: true,
                result: {
                    status: 'duplicate', launched: false, coordinatorSessionId: live!.sessionId,
                    ...(prior.receiptUnverified ? { receiptUnverified: true, deliveryNote: prior.deliveryNote } : {}),
                    messageId: prior.messageId, cursor: prior.cursor,
                },
            };
        });
    }

    const auditCtx = (atMs: number = Date.now(), reservation?: FollowerWakeReservation | null): WakeAuditContext => ({
        acl, meshId, clientId, senderDaemonId: canonSender, now: atMs,
        ...(reservation?.wakeId ? { wakeId: reservation.wakeId } : {}),
        ...(reservation ? { wakeAtMs: reservation.atMs } : {}),
    });

    const wakeFollowerCoordinator = async (): Promise<
        | { ok: true; live: AssistantCoordinatorView; launched: boolean; acl: AssistantRemoteAccessBinding }
        | { ok: false; result: CommandRouterResult }
    > => {
        let reservation: FollowerWakeReservation | null = null;
        let preLaunchDeniedResult: CommandRouterResult | null = null;

        const preLaunch = await withMeshRemoteAccessMutex(meshId, async () => {
            const preNow = Date.now();
            const meshRead = readHostMeshStrict(ports, meshId);
            const diskOrPortMesh = meshRead.ok ? meshRead.mesh : undefined;
            const wakeCheck = meshRead.ok ? verifyFollowerAcl(ports, diskOrPortMesh, meshId, sender, 'send', args) : meshRead;
            if (!wakeCheck.ok) {
                const reason = str((wakeCheck.result as Record<string, unknown>).code) || 'remote_access_denied';
                recordFollowerWakeAuditEvent(auditCtx(preNow), { sessionId: 'none', verdict: 'rejected', rule: 'pre_launch_denied', status: 'denied', stage: 'pre_launch', reason });
                return { ok: false as const, result: wakeCheck.result };
            }
            acl = wakeCheck.acl;
            const bindingCheck = verifyRemoteFollowerBindingForWake(ports, diskOrPortMesh, meshId, sender, args);
            if (!bindingCheck.ok) {
                const reason = str((bindingCheck.result as Record<string, unknown>).code) || 'remote_access_denied';
                recordFollowerWakeAuditEvent(auditCtx(preNow), { sessionId: 'none', verdict: 'rejected', rule: 'pre_launch_denied', status: 'denied', stage: 'pre_launch', reason });
                return { ok: false as const, result: bindingCheck.result };
            }
            acl = bindingCheck.acl;
            if (acl.allowCoordinatorLaunch === false) {
                recordFollowerWakeAuditEvent(auditCtx(preNow), { sessionId: 'none', verdict: 'rejected', rule: 'pre_launch_denied', status: 'denied', stage: 'pre_launch', reason: 'wake_disabled' });
                return {
                    ok: false as const,
                    result: fail('wake_disabled', 'No live coordinator session is running on the host and remote follower coordinator wake is disabled for this project.', {
                        bindingRevision: acl.bindingRevision, grantRevision: acl.grantRevision,
                    }),
                };
            }
            if (!hasInFlightFollowerWakeReservation(meshId, sender)) {
                const reserved = reserveFollowerWakeSlot(meshId, sender, preNow);
                if (!reserved.ok) {
                    recordFollowerWakeAuditEvent(auditCtx(preNow), { sessionId: 'none', verdict: 'rejected', rule: 'pre_launch_denied', status: 'denied', stage: 'pre_launch', reason: 'wake_rate_limited' });
                    return {
                        ok: false as const,
                        result: fail(
                            'wake_rate_limited',
                            reserved.reason === 'cooldown' ? 'Remote follower coordinator wake is in its 60s cooldown window.' : 'Remote follower coordinator wake rate limit (2 per 15m) exceeded.',
                            { reason: reserved.reason, retryAfterMs: reserved.retryAfterMs },
                        ),
                    };
                }
                reservation = reserved.reservation;
            }
            return { ok: true as const };
        });
        if (!preLaunch.ok) return preLaunch;

        let coord: Awaited<ReturnType<typeof ensureCoordinator>>;
        try {
            coord = await ensureCoordinator(meshId, {
                coordinators: (id) => ports.coordinators(id).filter((c) => !deadSessionIds.has(c.sessionId)),
                beforeLaunch: async () =>
                    withMeshRemoteAccessMutex(meshId, () => {
                        const checkNow = Date.now();
                        const meshRead = readHostMeshStrict(ports, meshId);
                        const latestMesh = meshRead.ok ? meshRead.mesh : undefined;
                        const wakeCheck = meshRead.ok ? verifyFollowerAcl(ports, latestMesh, meshId, sender, 'send', args) : meshRead;
                        if (!wakeCheck.ok) {
                            if (reservation && !reservation.settled) settleFollowerWakeReservation(reservation, checkNow, { charge: false });
                            const reason = str((wakeCheck.result as Record<string, unknown>).code) || 'remote_access_denied';
                            recordFollowerWakeAuditEvent(auditCtx(checkNow), { sessionId: 'none', verdict: 'rejected', rule: 'pre_launch_denied', status: 'denied', stage: 'pre_launch', reason });
                            preLaunchDeniedResult = wakeCheck.result;
                            return { success: false, code: reason, error: str((wakeCheck.result as Record<string, unknown>).error) || reason };
                        }
                        acl = wakeCheck.acl;
                        const bindingCheck = verifyRemoteFollowerBindingForWake(ports, latestMesh, meshId, sender, args);
                        if (!bindingCheck.ok) {
                            if (reservation && !reservation.settled) settleFollowerWakeReservation(reservation, checkNow, { charge: false });
                            const reason = str((bindingCheck.result as Record<string, unknown>).code) || 'remote_access_denied';
                            recordFollowerWakeAuditEvent(auditCtx(checkNow), { sessionId: 'none', verdict: 'rejected', rule: 'pre_launch_denied', status: 'denied', stage: 'pre_launch', reason });
                            preLaunchDeniedResult = bindingCheck.result;
                            return { success: false, code: reason, error: str((bindingCheck.result as Record<string, unknown>).error) || reason };
                        }
                        acl = bindingCheck.acl;
                        if (acl.allowCoordinatorLaunch === false) {
                            if (reservation && !reservation.settled) settleFollowerWakeReservation(reservation, checkNow, { charge: false });
                            recordFollowerWakeAuditEvent(auditCtx(checkNow), { sessionId: 'none', verdict: 'rejected', rule: 'pre_launch_denied', status: 'denied', stage: 'pre_launch', reason: 'wake_disabled' });
                            preLaunchDeniedResult = fail('wake_disabled', 'No live coordinator session is running on the host and remote follower coordinator wake is disabled for this project.', {
                                bindingRevision: acl.bindingRevision, grantRevision: acl.grantRevision,
                            });
                            return { success: false, code: 'wake_disabled', error: 'wake_disabled' };
                        }
                        if (!reservation || reservation.settled) {
                            const reserved = reserveFollowerWakeSlot(meshId, sender, checkNow);
                            if (!reserved.ok) {
                                recordFollowerWakeAuditEvent(auditCtx(checkNow), { sessionId: 'none', verdict: 'rejected', rule: 'pre_launch_denied', status: 'denied', stage: 'pre_launch', reason: 'wake_rate_limited' });
                                preLaunchDeniedResult = fail(
                                    'wake_rate_limited',
                                    reserved.reason === 'cooldown' ? 'Remote follower coordinator wake is in its 60s cooldown window.' : 'Remote follower coordinator wake rate limit (2 per 15m) exceeded.',
                                    { reason: reserved.reason, retryAfterMs: reserved.retryAfterMs },
                                );
                                return { success: false, code: 'wake_rate_limited', error: 'wake_rate_limited', reason: reserved.reason, retryAfterMs: reserved.retryAfterMs };
                            }
                            reservation = reserved.reservation;
                        }
                        return { success: true };
                    }),
                launch: async (input) => {
                    try {
                        const out = await ports.execute('launch_mesh_coordinator', {
                            meshId: input.meshId, extraSystemPrompt: '', managedByAssistant: true,
                        });
                        const settledAt = Date.now();
                        await withMeshRemoteAccessMutex(meshId, () => {
                            if (reservation && !reservation.settled) settleFollowerWakeReservation(reservation, settledAt, { charge: true });
                        });
                        return out;
                    } catch (err) {
                        const settledAt = Date.now();
                        await withMeshRemoteAccessMutex(meshId, () => {
                            if (reservation && !reservation.settled) settleFollowerWakeReservation(reservation, settledAt, { charge: true });
                        });
                        throw err;
                    }
                },
                hide: coordinatorPorts(ports).hide,
            });
        } catch (err) {
            const failAt = Date.now();
            await withMeshRemoteAccessMutex(meshId, () => {
                if (reservation && !reservation.settled) settleFollowerWakeReservation(reservation, failAt, { charge: false });
            });
            throw err;
        }
        const postLaunchNow = Date.now();

        return withMeshRemoteAccessMutex(meshId, async () => {
            if (reservation && !reservation.settled) {
                settleFollowerWakeReservation(reservation, postLaunchNow, { charge: !coord.ok || coord.launched });
            }
            if (preLaunchDeniedResult) return { ok: false as const, result: preLaunchDeniedResult };
            if (!coord.ok) {
                const failReason = str(coord.code) || 'launch_failed';
                recordFollowerWakeAuditEvent(auditCtx(postLaunchNow, reservation), { sessionId: 'none', verdict: 'rejected', rule: 'launch_failed', status: 'failed', stage: 'launch', reason: failReason });
                return {
                    ok: false as const,
                    result: fail('launch_failed', coord.error || 'Failed to launch coordinator on host.', { ...coord.detail, launchCode: coord.code }),
                };
            }
            if (coord.launched) {
                recordFollowerWakeAuditEvent(auditCtx(postLaunchNow, reservation), { sessionId: coord.sessionId, verdict: 'recorded', rule: 'cold_wake_launched', status: 'launched', stage: 'launch' });
            }

            // Re-validate grant & binding revision, follower binding, and toggle under a short mutex in case a revoke raced the wake.
            const meshRead = readHostMeshStrict(ports, meshId);
            const postWakeMesh = meshRead.ok ? meshRead.mesh : undefined;
            const postWakeCheck = meshRead.ok ? verifyFollowerAcl(ports, postWakeMesh, meshId, sender, 'send', args) : meshRead;
            if (!postWakeCheck.ok) {
                const reason = str((postWakeCheck.result as Record<string, unknown>).code) || 'remote_access_denied';
                recordFollowerWakeAuditEvent(auditCtx(postLaunchNow, reservation), { sessionId: coord.sessionId, verdict: 'rejected', rule: 'post_launch_denied', status: 'denied', stage: 'post_launch', reason });
                return { ok: false as const, result: postWakeCheck.result };
            }
            acl = postWakeCheck.acl;
            const postBindingCheck = verifyRemoteFollowerBindingForWake(ports, postWakeMesh, meshId, sender, args);
            if (!postBindingCheck.ok) {
                const reason = str((postBindingCheck.result as Record<string, unknown>).code) || 'remote_access_denied';
                recordFollowerWakeAuditEvent(auditCtx(postLaunchNow, reservation), { sessionId: coord.sessionId, verdict: 'rejected', rule: 'post_launch_denied', status: 'denied', stage: 'post_launch', reason });
                return { ok: false as const, result: postBindingCheck.result };
            }
            acl = postBindingCheck.acl;
            if (acl.allowCoordinatorLaunch === false) {
                recordFollowerWakeAuditEvent(auditCtx(postLaunchNow, reservation), { sessionId: coord.sessionId, verdict: 'rejected', rule: 'post_launch_denied', status: 'denied', stage: 'post_launch', reason: 'wake_disabled' });
                return {
                    ok: false as const,
                    result: fail('wake_disabled', 'Remote follower coordinator wake was disabled on the host during coordinator launch.'),
                };
            }
            return {
                ok: true as const, launched: coord.launched,
                live: { sessionId: coord.sessionId, idle: true, modalParked: false, managedByAssistant: coord.managedByAssistant },
                acl,
            };
        });
    };

    if (live) {
        if (expectedCoordinatorSessionId && live.sessionId !== expectedCoordinatorSessionId) {
            return fail('coordinator_replaced', 'The live coordinator session on the host does not match expectedCoordinatorSessionId.', {
                expectedCoordinatorSessionId, currentCoordinatorSessionId: live.sessionId,
            });
        }
    } else {
        const woken = await wakeFollowerCoordinator();
        if (!woken.ok) return woken.result;
        live = woken.live; launched = woken.launched; acl = woken.acl;
        if (!launched) {
            pickedCoordinatorLiveness = await classifyCoordinatorRuntimeLivenessForFollower(ports, live);
            if (pickedCoordinatorLiveness === 'dead') {
                deadSessionIds.add(live.sessionId);
                const rewoken = await wakeFollowerCoordinator();
                if (!rewoken.ok) return rewoken.result;
                live = rewoken.live; launched = rewoken.launched; acl = rewoken.acl;
            }
        }
    }

    const attemptSendToCoordinator = async (target: AssistantCoordinatorView, isLaunched: boolean) => {
        const preSend = await withMeshRemoteAccessMutex(meshId, async () => {
            const checkNow = Date.now();
            const meshRead = readHostMeshStrict(ports, meshId);
            const latestMesh = meshRead.ok ? meshRead.mesh : undefined;
            const recheck = meshRead.ok ? verifyFollowerAcl(ports, latestMesh, meshId, sender, 'send', args) : meshRead;
            if (!recheck.ok) {
                if (isLaunched) {
                    const reason = str((recheck.result as Record<string, unknown>).code) || 'remote_access_denied';
                    recordFollowerWakeAuditEvent(auditCtx(checkNow), { sessionId: target.sessionId, verdict: 'rejected', rule: 'post_launch_denied', status: 'denied', stage: 'post_launch', reason });
                }
                return { ok: false as const, result: recheck.result };
            }
            acl = recheck.acl;

            if (isLaunched) {
                const bindingCheck = verifyRemoteFollowerBindingForWake(ports, latestMesh, meshId, sender, args);
                if (!bindingCheck.ok) {
                    const reason = str((bindingCheck.result as Record<string, unknown>).code) || 'remote_access_denied';
                    recordFollowerWakeAuditEvent(auditCtx(checkNow), { sessionId: target.sessionId, verdict: 'rejected', rule: 'post_launch_denied', status: 'denied', stage: 'post_launch', reason });
                    return { ok: false as const, result: bindingCheck.result };
                }
                acl = bindingCheck.acl;
                if (acl.allowCoordinatorLaunch === false) {
                    recordFollowerWakeAuditEvent(auditCtx(checkNow), { sessionId: target.sessionId, verdict: 'rejected', rule: 'post_launch_denied', status: 'denied', stage: 'post_launch', reason: 'wake_disabled' });
                    return { ok: false as const, result: fail('wake_disabled', 'Remote follower coordinator wake was disabled on the host during coordinator launch.') };
                }
            }

            const cursor = ports.coordinatorTurns(target.sessionId, 1).committed[0]?.attemptId ?? null;
            const messageId = `assistant_follower:${acl.hostDaemonId}:${meshId}:${acl.accountSlot}:${acl.activeDaemonId}:b${acl.bindingRevision}:g${acl.grantRevision}:${target.sessionId}:${bodyHash.slice(0, 16)}:${clientId}`;
            return { ok: true as const, cursor, messageId };
        });
        if (!preSend.ok) return preSend;
        const { cursor, messageId } = preSend;
        const deliveredText = isLaunched ? frameFollowerWakeRelayText(text) : text;
        const sent = await ports.execute('send_chat', {
            targetSessionId: target.sessionId, text: deliveredText, origin: 'assistant', policy: { mode: 'queue' }, messageId,
        });
        return { ok: true as const, sent, cursor, messageId };
    };

    let sendAttempt = await attemptSendToCoordinator(live, launched);
    if (!sendAttempt.ok) return sendAttempt.result;

    if (!sendAttempt.sent.success && !launched && pickedCoordinatorLiveness !== 'unknown' && isMissingOrDeadCoordinatorRuntime(sendAttempt.sent)) {
        deadSessionIds.add(live.sessionId);
        const woken = await wakeFollowerCoordinator();
        if (!woken.ok) return woken.result;
        live = woken.live; launched = woken.launched; acl = woken.acl;
        sendAttempt = await attemptSendToCoordinator(live, launched);
        if (!sendAttempt.ok) return sendAttempt.result;
    }

    const { sent, cursor, messageId } = sendAttempt;
    if (!sent.success) {
        return fail(str(sent.reason) || str(sent.code) || 'send_failed', str(sent.error) || 'send_failed', {
            launched, coordinatorSessionId: live.sessionId, messageId,
        });
    }
    const status = sent.deduplicated === true ? 'duplicate' : sent.queued === true ? 'queued' : 'accepted';
    const receiptAt = Date.now();
    await withMeshRemoteAccessMutex(meshId, () => {
        recordFollowerSendReceipt(idempotencyKey, {
            coordinatorSessionId: live!.sessionId, bodyHash, messageId, cursor, recordedAt: receiptAt,
            ...(sent.receiptUnverified ? { receiptUnverified: true, deliveryNote: str(sent.deliveryNote) } : {}),
        }, receiptAt);
    });
    return {
        success: true,
        result: {
            status, ...(sent.receiptUnverified ? { receiptUnverified: true, deliveryNote: sent.deliveryNote } : {}),
            launched, coordinatorSessionId: live.sessionId, messageId, cursor,
            bindingRevision: acl.bindingRevision, grantRevision: acl.grantRevision,
        },
    };
}

async function run(
    ports: AssistantProjectPorts,
    op: AssistantRemoteOp,
    meshId: string,
    args: Record<string, unknown>,
    isFollower: boolean,
    sender: string,
    ctx?: HighFamilyContext,
): Promise<CommandRouterResult> {
    const meshRead = readHostMeshStrict(ports, meshId);
    if (!meshRead.ok) return meshRead.result;
    const mesh = meshRead.mesh!;
    switch (op) {
        case 'status': {
            const status = await localProjectStatus(ports, mesh);
            return { success: true, result: isFollower ? followerStatusView(status, mesh) : status };
        }
        case 'send': {
            if (isFollower) {
                return followerProjectSend(ports, meshId, sender, args);
            }
            const text = typeof args.text === 'string' ? args.text : '';
            if (!text.trim()) return fail('invalid_args', 'text required');
            if (text.length > REMOTE_SEND_MAX_CHARS) return fail('invalid_args', `text over ${REMOTE_SEND_MAX_CHARS} characters`);
            const clientId = str(args.clientId);
            if (!clientId || clientId.length > 200) return fail('invalid_args', 'clientId required (at most 200 characters)');
            const sent = await localProjectSend(ports, mesh, text, clientId);
            if (!sent.ok) return fail(sent.code, sent.error, sent.detail);
            const { ok: _ok, ...result } = sent;
            return { success: true, result };
        }
        case 'read': {
            const continuation = parseReportContinuation(args);
            if (typeof continuation === 'string') return fail('invalid_args', continuation);
            const r = await localProjectRead(ports, meshId, readTailArg(args.tail), continuation);
            return r.ok ? { success: true, result: r.result } : fail('project_read_failed', r.error, { coordinatorSessionId: r.coordinatorSessionId });
        }
        case 'report': {
            if (typeof args.attemptId !== 'string' || !args.attemptId || args.attemptId.length > 200 || typeof args.coordinatorSessionId !== 'string' || !args.coordinatorSessionId || args.coordinatorSessionId.length > 200) return fail('invalid_args');
            return { success: true, result: await localAttemptReport(ports, meshId, args.coordinatorSessionId, args.attemptId) };
        }
        case 'artifact_list':
            return { success: true, result: localArtifactList(meshId, args) };
        case 'artifact_read': {
            const read = await localArtifactRead(ports, meshId, args, ctx);
            return read.ok ? { success: true, result: read.result } : fail(read.code, read.error);
        }
        case 'inventory':
            if (isFollower) return fail('remote_op_forbidden', 'inventory is not permitted for remote followers');
            return { success: true, result: environmentInventory([mesh], Date.now(), ports.localNodeFacts ? { daemonId: ports.selfDaemonId(), facts: ports.localNodeFacts() } : undefined) };
        case 'terminal': {
            if (isFollower) return fail('remote_op_forbidden', 'terminal is not permitted for remote followers');
            if (!['task', 'mission'].includes(String(args.kind)) || typeof args.entityId !== 'string' || !args.entityId || args.entityId.length > 200
                || !Array.isArray(args.receipts) || args.receipts.length > 256 || args.receipts.some(id => typeof id !== 'string' || id.length > 200)) return fail('invalid_args');
            return { success: true, result: { events: readTerminalEvents(MeshRuntimeStore.getInstance().db, meshId, args.kind as 'task' | 'mission', args.entityId, 0, args.receipts as string[]) } };
        }
        case 'poll':
            return poll(ports, meshId, args);
        case 'note':
            if (isFollower) return fail('remote_op_forbidden', 'note is not permitted for remote followers');
            return note(meshId, args);
    }
}

const assistantRemoteProject: HighFamilyHandler = async (ctx: HighFamilyContext, rawArgs: any) => {
    const args: Record<string, unknown> = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
    const meshId = str(args.meshId);
    const op = str(args.op) as AssistantRemoteOp;
    if (!meshId) return fail('invalid_args', 'meshId required');
    if (!(ASSISTANT_REMOTE_OPS as readonly string[]).includes(op)) return fail('invalid_args', `op must be one of ${ASSISTANT_REMOTE_OPS.join(', ')}`);
    try {
        const ports = await projectPortsFor(ctx);
        const meshRead = readHostMeshStrict(ports, meshId);
        if (!meshRead.ok) return meshRead.result;
        const mesh = meshRead.mesh;
        if (!mesh) return fail('project_not_found', `mesh ${meshId} is not in this daemon's project inventory`);
        const sender = readMeshSender(args);
        const self = ports.selfDaemonId();
        const onRoster = isSenderOnWorkerRoster(mesh, self, sender);
        const isFollower = !onRoster || hasExplicitFollowerClaim(args);

        if (isFollower) {
            const verified = verifyFollowerAcl(ports, mesh, meshId, sender, op, args);
            if (!verified.ok) return verified.result;
        } else if (op !== 'inventory' && !ports.isHostedHere(mesh)) {
            return fail('project_not_hosted_here', `this daemon does not host mesh ${meshId}`);
        }

        if (op === 'send' || op === 'note') {
            const who = sender && self && daemonIdsEquivalent(sender, self) ? 'self' : sender.slice(0, 24) || 'unknown';
            LOG.info('Assistant', `remote ${op} (${isFollower ? 'follower' : 'roster'}) for mesh ${meshId} from ${who}`);
        }
        return await run(ports, op, meshId, args, isFollower, sender, ctx);
    } catch (e) {
        if (isDaemonComponentsNotReady(e)) return componentsNotReadyResult(e);
        throw e;
    }
};

/**
 * Owner-only discovery catalog (`assistant_remote_project_catalog`):
 * Returns bounded content-free canonical metadata for projects actually hosted
 * on this daemon. Never exposes workspace paths, rosters, session IDs, prompts,
 * notes, or secrets.
 */
const assistantRemoteProjectCatalog: HighFamilyHandler = async (ctx: HighFamilyContext, rawArgs: any) => {
    if (!isTrustedOwnerIngress(rawArgs)) return fail('owner_ingress_required', 'Remote project catalog requires verified owner ingress.');
    try {
        const ports = await projectPortsFor(ctx);
        const rawSelf = ports.selfDaemonId();
        const hostDaemonId = canonicalDaemonId(rawSelf) ?? rawSelf;
        if (!hostDaemonId) return fail('host_identity_unavailable', 'This daemon has no canonical daemon identity.');
        const now = Date.now();
        const hostedMeshes = ports.listMeshes().filter((m) => ports.isHostedHere(m));
        const projects: RemoteProjectCatalogItem[] = hostedMeshes.map((m) => {
            const views = ports.coordinators(m.id);
            const live = pickCoordinator(views);
            const lastSessionId = ports.lastCoordinatorSessionId(m.id);
            const acl = normalizeAssistantRemoteAccessBinding(m.assistantRemoteAccess, m.id);
            const allowCoordinatorLaunch = acl ? acl.allowCoordinatorLaunch !== false : true;
            const allowArtifactRead = acl ? acl.allowArtifactRead === true : false;
            return {
                hostDaemonId, meshId: m.id, name: m.name,
                sanitizedRepoIdentity: sanitizeRemoteRepoIdentity(m.repoRemoteUrl || m.repoIdentity),
                coordinatorState: coordinatorState(views),
                allowCoordinatorLaunch, allowArtifactRead,
                capabilities: {
                    status: true, read: true, poll: true, report: true, send: true,
                    artifact_list: allowArtifactRead, artifact_read: allowArtifactRead,
                    coordinatorPresent: Boolean(live?.sessionId || lastSessionId),
                    allowCoordinatorLaunch, allowArtifactRead,
                },
                observedAt: now,
            };
        });
        return { success: true, hostDaemonId, projects, observedAt: now };
    } catch (e) {
        if (isDaemonComponentsNotReady(e)) return componentsNotReadyResult(e);
        throw e;
    }
};

/**
 * Owner-only host ACL management (`assistant_remote_project_access`):
 * Grants or revokes narrow `assistantRemoteAccess` for the single account-level
 * `'personal'` assistant slot and one active deputy daemon on a locally hosted mesh.
 */
const assistantRemoteProjectAccess: HighFamilyHandler = async (ctx: HighFamilyContext, rawArgs: any) => {
    if (!isTrustedOwnerIngress(rawArgs)) return fail('owner_ingress_required', 'Remote project access changes require verified owner ingress.');
    const args: Record<string, unknown> = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
    const action = str(args.action) || 'get';
    const meshId = str(args.meshId);
    if (!meshId) return fail('invalid_args', 'meshId required');
    if (action !== 'grant' && action !== 'revoke' && action !== 'get' && action !== 'set_policy') {
        return fail('invalid_args', 'action must be grant, revoke, set_policy, or get');
    }

    try {
        const ports = await projectPortsFor(ctx);
        const rawSelf = ports.selfDaemonId();
        const hostDaemonId = canonicalDaemonId(rawSelf) ?? rawSelf;
        if (!hostDaemonId) return fail('host_identity_unavailable', 'This daemon has no canonical daemon identity.');

        if (action === 'get') {
            const mesh = ports.listMeshes().find((m) => m.id === meshId);
            if (!mesh) return fail('project_not_found', `mesh ${meshId} is not in this daemon's project inventory`);
            if (!ports.isHostedHere(mesh)) return fail('project_not_hosted_here', `this daemon does not host mesh ${meshId}`);
            if (mesh.assistantRemoteAccess !== undefined && !normalizeAssistantRemoteAccessBinding(mesh.assistantRemoteAccess, meshId)) {
                return fail('remote_access_corrupt', `Persisted assistantRemoteAccess on mesh ${meshId} is corrupt.`);
            }
            return { success: true, action: 'get', access: normalizeAssistantRemoteAccessBinding(mesh.assistantRemoteAccess, meshId) };
        }

        return await withMeshRemoteAccessMutex(meshId, () => {
            try {
                return withStrictMeshConfigWriteLock(() => {
                    const config = readMeshConfigFromDisk();
                    if (!config) return fail('project_storage_unavailable', 'meshes.json is unavailable');
                    const mesh = config.meshes.find((m) => m.id === meshId);
                    if (!mesh) return fail('project_not_found', `mesh ${meshId} is not in this daemon's project inventory`);
                    if (!ports.isHostedHere(mesh)) return fail('project_not_hosted_here', `this daemon does not host mesh ${meshId}`);

                    const rawAcl = mesh.assistantRemoteAccess;
                    const existing = normalizeAssistantRemoteAccessBinding(rawAcl, meshId);
                    const rawGrantRev = typeof record(rawAcl)?.grantRevision === 'number' && Number.isInteger(record(rawAcl)!.grantRevision) && (record(rawAcl)!.grantRevision as number) > 0
                        ? (record(rawAcl)!.grantRevision as number)
                        : 0;
                    const baseGrantRevision = Math.max(existing?.grantRevision ?? 0, rawGrantRev);
                    const now = Date.now();

                    if (action === 'set_policy') {
                        const hasLaunchToggle = typeof args.allowCoordinatorLaunch === 'boolean';
                        const hasArtifactToggle = typeof args.allowArtifactRead === 'boolean';
                        if (!hasLaunchToggle && !hasArtifactToggle) return fail('invalid_args', 'allowCoordinatorLaunch or allowArtifactRead boolean is required');
                        if (rawAcl !== undefined && !existing) return fail('remote_access_corrupt', `Persisted assistantRemoteAccess on mesh ${meshId} is corrupt.`);
                        if (!existing) return fail('remote_access_denied', `No valid assistantRemoteAccess grant for mesh ${meshId}.`);
                        if (existing.status !== 'active') {
                            return fail('host_revoked', `Assistant remote access for mesh ${meshId} has been revoked by the host.`, {
                                grantRevision: existing.grantRevision, bindingRevision: existing.bindingRevision,
                            });
                        }
                        const updated: AssistantRemoteAccessBinding = {
                            ...existing,
                            ...(hasLaunchToggle ? { allowCoordinatorLaunch: args.allowCoordinatorLaunch as boolean } : {}),
                            ...(hasArtifactToggle ? { allowArtifactRead: args.allowArtifactRead as boolean } : {}),
                        };
                        mesh.assistantRemoteAccess = updated;
                        mesh.updatedAt = new Date(now).toISOString();
                        const saved = saveMeshConfigDurable(config);
                        if (!saved.ok) return fail('persistence_failed', saved.reason);
                        LOG.info('Assistant', `Updated remote assistant policy on mesh ${meshId} (allowCoordinatorLaunch=${String(updated.allowCoordinatorLaunch)}, allowArtifactRead=${String(updated.allowArtifactRead)}, grantRev=${updated.grantRevision})`);
                        return { success: true, action: 'set_policy', access: updated };
                    }

                    if (action === 'grant') {
                        const rawActiveDaemonId = str(args.activeDaemonId);
                        const activeDaemonId = canonicalDaemonId(rawActiveDaemonId);
                        if (!activeDaemonId || !activeDaemonId.startsWith('daemon_mach_')) return fail('invalid_active_daemon_id', 'activeDaemonId is required and must be a canonical daemon id.');
                        if (hostDaemonId && daemonIdsEquivalent(activeDaemonId, hostDaemonId)) return fail('grant_self_not_allowed', 'Cannot grant remote follower access to the host daemon itself.');
                        const slot = str(args.accountSlot) || ASSISTANT_ACCOUNT_SLOT;
                        if (slot !== ASSISTANT_ACCOUNT_SLOT) return fail('invalid_args', `accountSlot must be '${ASSISTANT_ACCOUNT_SLOT}'`);
                        const bindingRevision = typeof args.bindingRevision === 'number' && Number.isInteger(args.bindingRevision) && args.bindingRevision >= 1 ? args.bindingRevision : null;
                        if (bindingRevision === null) return fail('invalid_args', 'bindingRevision must be a positive integer');
                        if (existing && daemonIdsEquivalent(existing.activeDaemonId, activeDaemonId) && bindingRevision < existing.bindingRevision) {
                            return fail('binding_revision_stale', 'Requested bindingRevision is older than the host ACL bindingRevision.', { actualBindingRevision: existing.bindingRevision });
                        }
                        const nextGrantRevision = baseGrantRevision + 1;
                        const allowCoordinatorLaunch = typeof args.allowCoordinatorLaunch === 'boolean' ? args.allowCoordinatorLaunch : (existing?.allowCoordinatorLaunch ?? true);
                        // Artifact read is explicit opt-in: an explicit boolean always wins, and an omitted
                        // field NEVER inherits from a revoked tombstone (only from a live grant).
                        const allowArtifactRead = typeof args.allowArtifactRead === 'boolean'
                            ? args.allowArtifactRead
                            : (existing?.status === 'active' ? (existing.allowArtifactRead === true) : false);
                        const binding: AssistantRemoteAccessBinding = {
                            hostDaemonId, meshId, accountSlot: ASSISTANT_ACCOUNT_SLOT, activeDaemonId,
                            bindingRevision, grantRevision: nextGrantRevision, status: 'active',
                            allowedOps: [...ASSISTANT_FOLLOWER_ALLOWED_OPS],
                            allowCoordinatorLaunch, allowArtifactRead, grantedAt: now,
                        };
                        mesh.assistantRemoteAccess = binding;
                        mesh.updatedAt = new Date(now).toISOString();
                        const saved = saveMeshConfigDurable(config);
                        if (!saved.ok) return fail('persistence_failed', saved.reason);
                        LOG.info('Assistant', `Granted remote assistant access on mesh ${meshId} to ${activeDaemonId.slice(0, 24)} (bindingRev=${bindingRevision}, grantRev=${nextGrantRevision})`);
                        return { success: true, action: 'grant', access: binding };
                    }

                    // action === 'revoke'
                    const nextGrantRevision = baseGrantRevision + 1;
                    const revokedActiveDaemonId = existing?.activeDaemonId ?? (canonicalDaemonId(str(args.activeDaemonId)) ?? (str(args.activeDaemonId) || 'revoked'));
                    const revokedBindingRevision = existing?.bindingRevision ?? 1;
                    const tombstone: AssistantRemoteAccessBinding = {
                        hostDaemonId, meshId, accountSlot: ASSISTANT_ACCOUNT_SLOT, activeDaemonId: revokedActiveDaemonId,
                        bindingRevision: revokedBindingRevision, grantRevision: nextGrantRevision, status: 'revoked',
                        allowedOps: [...ASSISTANT_FOLLOWER_ALLOWED_OPS],
                        allowCoordinatorLaunch: existing?.allowCoordinatorLaunch ?? true,
                        allowArtifactRead: existing?.allowArtifactRead ?? false,
                        grantedAt: existing?.grantedAt ?? now, revokedAt: now,
                    };
                    mesh.assistantRemoteAccess = tombstone;
                    mesh.updatedAt = new Date(now).toISOString();
                    const saved = saveMeshConfigDurable(config);
                    if (!saved.ok) return fail('persistence_failed', saved.reason);
                    LOG.info('Assistant', `Revoked remote assistant access on mesh ${meshId} (grantRev=${nextGrantRevision})`);
                    return { success: true, action: 'revoke', access: tombstone };
                });
            } catch (err) {
                if (err instanceof MeshConfigStrictLockError) return fail(err.code, err.message);
                throw err;
            }
        });
    } catch (e) {
        if (isDaemonComponentsNotReady(e)) return componentsNotReadyResult(e);
        throw e;
    }
};

export const assistantRemoteHandlers: Record<string, HighFamilyHandler> = {
    [ASSISTANT_REMOTE_PROJECT_COMMAND]: assistantRemoteProject,
    [ASSISTANT_REMOTE_PROJECT_CATALOG_COMMAND]: assistantRemoteProjectCatalog,
    [ASSISTANT_REMOTE_PROJECT_ACCESS_COMMAND]: assistantRemoteProjectAccess,
};

export const assistantRemoteSpecs = defineCommandSpecs('high', assistantRemoteHandlers, {
    [ASSISTANT_REMOTE_PROJECT_COMMAND]: { sources: ['mesh'], meshSender: 'roster' },
    [ASSISTANT_REMOTE_PROJECT_CATALOG_COMMAND]: { sources: [...ASSISTANT_REMOTE_OWNER_SOURCES] },
    [ASSISTANT_REMOTE_PROJECT_ACCESS_COMMAND]: { sources: [...ASSISTANT_REMOTE_OWNER_SOURCES] },
});

