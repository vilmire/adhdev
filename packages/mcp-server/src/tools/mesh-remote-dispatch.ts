// Remote direct dispatch (coordinator → a node served by another daemon): the
// `agent_command` relay plus the typed refusals every direct-dispatch path shares
// (provider-pin, quota gate, relay-unsafe session, missing coordinator anchor,
// session busy). Split out of mesh-tools-internal.ts; re-exported there.

import type { MeshContext } from './mesh-tools-internal.js';
import {
    type LocalMeshNodeEntry,
    buildP2pRelayFailurePayload,
    type ProviderQuotaGateBlock,
    evaluateProviderQuotaGate,
    providerPinsFromRequiredTags,
    filterProvidersByRequiredTags,
    classifySessionBusyWithTask,
    SESSION_BUSY_WITH_TASK_CODE,
} from '@adhdev/daemon-core';
import type { MeshNodeFactsProviderQuota } from '@adhdev/mesh-shared';
import { type MeshTaskInput, readString } from './mesh-tool-shared.js';
import { IpcTransport } from '../transports/ipc.js';
import { readProviderPriority, classifyRemoteDelegateRelaySafety, chooseDispatchableSession } from './mesh-tools-internal-core.js';
import { resolveSessionProviderType, readSessionRecordId, unwrapCommandPayload } from './mesh-session-helpers.js';
import { readNodeRuntime } from './mesh-held-node-state.js';

// (moved to ./mesh-session-helpers.ts — session/payload record helpers)


function buildRelayUnsafeRemoteSessionFailure(ctx: MeshContext, node: LocalMeshNodeEntry, sessionId: string, providerType?: string): ({ success: false; error: string } & Record<string, unknown>) {
    return {
        success: false,
        recoverable: true,
        code: 'mesh_delegate_session_missing_relay_metadata',
        reason: 'mesh_delegate_session_missing_relay_metadata',
        transport: 'mesh_transport',
        retryRecommended: true,
        meshId: ctx.mesh.id,
        nodeId: node.id,
        daemonId: node.daemonId,
        workspace: node.workspace,
        sessionId,
        unsafeTranscriptAlias: true,
        ...(providerType ? { resolvedProviderType: providerType } : {}),
        error: `Remote session '${sessionId}' is not relay-safe for mesh '${ctx.mesh.id}': missing meshNodeFor/meshCoordinatorDaemonId metadata, so completion events would not reach the coordinator ledger. This session may be the coordinator itself or an unrelated session (unsafe_transcript_alias risk).`,
        nextAction: `Launch a fresh relay-safe session with mesh_launch_session(node_id: '${node.id}'${providerType ? `, type: '${providerType}'` : ''}) or dispatch without session_id so Repo Mesh can choose a valid delegate session.`,
        noFallbackReason: 'Blindly reusing a remote session without mesh relay metadata would silently drop task_completed / generating_completed events.',
    };
}

export function buildMissingCoordinatorDaemonIdFailure(ctx: MeshContext, node: LocalMeshNodeEntry, providerType?: string): ({ success: false; error: string } & Record<string, unknown>) {
    return {
        success: false,
        recoverable: true,
        code: 'mesh_coordinator_daemon_unknown',
        reason: 'mesh_coordinator_daemon_unknown',
        transport: 'mesh_transport',
        retryRecommended: true,
        meshId: ctx.mesh.id,
        nodeId: node.id,
        daemonId: node.daemonId,
        workspace: node.workspace,
        ...(providerType ? { resolvedProviderType: providerType } : {}),
        error: `Cannot launch a remote mesh delegate for node '${node.id}': coordinator daemon identity is unavailable, so the worker would be unable to relay completion events back to the coordinator.`,
        nextAction: 'Retry after the coordinator daemon identity is available (for example from an attached daemon-backed MCP session) so meshCoordinatorDaemonId can be stamped on the worker session.',
        noFallbackReason: 'Launching without meshCoordinatorDaemonId would create a worker session that can finish work but cannot emit task_completed / generating_completed back to the coordinator.',
    };
}

export type RemoteAgentDispatchResult =
    | { success: true; dispatched: true; sessionId: string; providerType?: string }
    | ({ success: false; error: string } & Record<string, unknown>);

export function buildCoordinatorP2pRelayFailure(
    error: unknown,
    context: { command: string; targetDaemonId?: string; nodeId?: string; sessionId?: string },
): { success: false; error: string } & Record<string, unknown> {
    const payload = buildP2pRelayFailurePayload(error, {
        command: context.command,
        targetDaemonId: context.targetDaemonId,
    });
    return {
        ...payload,
        ...(context.nodeId ? { nodeId: context.nodeId } : {}),
        ...(context.sessionId ? { sessionId: context.sessionId } : {}),
        retryHint: payload.retryRecommended ? payload.nextAction : 'Do not retry as a P2P transport recovery; inspect the command/provider error first.',
    };
}


/**
 * ★PROVIDER-PIN-BYPASS — refusal returned when a dispatch cannot honor the task's
 * `required_tags: ["provider=X"]` pin on this node.
 *
 * ★WHY THIS REFUSES RATHER THAN FALLING BACK. The alternative — dispatch to some
 * other provider and note it somewhere — is the exact defect this closes: the work
 * silently ran on the wrong agent while both the ledger and the enqueue response
 * reported the pin as satisfied. A pin is a hard constraint (the claim path has
 * always treated it as one), so the accelerator must decline when it cannot meet it.
 *
 * ★WHY DECLINING DOES NOT STRAND THE TASK. This is the enqueue-and-push
 * ACCELERATOR, not the scheduler — its own contract (selectEagerPushReceiver) is
 * "if the chosen node cannot take the task, the row stays `pending` and the
 * queue-claim path hands it to whichever node claims it". The row is already
 * inserted before any push is attempted, and the claim path enforces the pin
 * per-session via buildMeshNodeCapabilityTags(node, providerType). So a refusal
 * here costs a delay and returns the task to the path that routes it correctly —
 * it is `recoverable: true` for exactly that reason. This is why the design choice
 * is "stay pending", not "fail the task": a pinned task whose provider is merely
 * BUSY must wait, and only a coordinator can tell a busy pin from an impossible one.
 */
function buildProviderPinUnsatisfiableFailure(
    node: LocalMeshNodeEntry,
    providerPins: string[],
    nodeProviders: string[],
    resolvedProviderType?: string,
): { success: false; error: string } & Record<string, unknown> {
    const pinList = providerPins.join(', ');
    return {
        success: false,
        recoverable: true,
        code: 'mesh_provider_pin_unsatisfiable',
        reason: 'mesh_provider_pin_unsatisfiable',
        nodeId: node.id,
        requiredProviders: providerPins,
        nodeProviders,
        ...(resolvedProviderType ? { resolvedProviderType } : {}),
        error: `Node '${node.id}' cannot honor the task's provider pin [${pinList}]`
            + (resolvedProviderType
                ? `: dispatch resolved to '${resolvedProviderType}', which is not pinned.`
                : `: the node declares [${nodeProviders.join(', ') || 'none'}].`)
            + ' Refusing to dispatch onto a different provider — the task stays pending for the queue-claim path.',
        nextAction: `Leave the task queued (the claim path enforces the pin per session), or launch a '${providerPins[0]}' session on this node with mesh_launch_session, or re-enqueue without the provider pin if any provider is acceptable.`,
    };
}

/**
 * QUOTA GATE (direct-dispatch path, preview rc.43 run 10). The queue CLAIM
 * path (mesh-queue-assignment.ts's `evaluateQuotaClaimGateForAssignment`,
 * daemon-side) already refuses to pull a pending task onto an idle session
 * whose provider is measurably quota-exhausted — but `mesh_send_task`'s
 * DIRECT dispatch (this file, naming a node/session_id explicitly) went
 * straight to `agent_command`/local inject with no such check. Live evidence:
 * the owner ledger's mesh_direct attempt `ed31090f…` spent ~10 minutes
 * talking to a MainPC claude-cli worker session whose own chat already showed
 * "You've hit your session limit · resets 10:10pm (Asia/Seoul)" — the claim
 * path would have diverted this candidate; the direct path had nothing to
 * divert it.
 *
 * Reuses `evaluateProviderQuotaGate` — the SAME predicate the claim gate and
 * the manual-launch path (`meshLaunchSession` below) already call — so this
 * path can never independently decide what "out of quota" means. Called with
 * no `QuotaFactsContext` (mirrors the manual-launch call site): a direct
 * dispatch reads only the node's reported `nodeFacts.quota` snapshot, never
 * triggers a fetch. Fail-open is therefore inherited unchanged: a missing,
 * stale, or unmarked-fresh snapshot never blocks — only a FRESH measured
 * block (an 'ok' window under threshold, or the provider's own
 * 'quota-exhausted' verdict) does.
 *
 * Returns `null` when the dispatch may proceed (unknown/healthy). Returns the
 * block plus, when resolvable, the offending window's own `resetsAt` (read
 * directly off `node.nodeFacts.quota[providerType]` — the same bundle
 * `evaluateProviderQuotaGate` itself reads) so a refusal names WHEN the
 * window resets instead of just that it is closed. Antigravity's per-pool
 * bucket decomposition and the exhausted-with-no-named-window case are not
 * resolvable this way (the exact window is internal to mesh-quota-routing.ts)
 * — `resetsAt` is omitted rather than guessed.
 */
export function checkDirectDispatchQuotaGate(
    node: LocalMeshNodeEntry,
    providerType: string,
    quotaRoutingPolicy: unknown,
): { block: ProviderQuotaGateBlock; resetsAt: number | null } | null {
    if (!providerType) return null;
    const block = evaluateProviderQuotaGate(node, providerType, (quotaRoutingPolicy as never) ?? null);
    if (!block) return null;
    const quota = (node as any)?.nodeFacts?.quota?.[providerType] as MeshNodeFactsProviderQuota | undefined;
    const window = block.window === 'session' ? quota?.session : block.window === 'weekly' ? quota?.weekly : null;
    const resetsAt = typeof window?.resetsAt === 'number' && Number.isFinite(window.resetsAt) ? window.resetsAt : null;
    return { block, resetsAt };
}

/** Shared refusal payload for `checkDirectDispatchQuotaGate` — same shape from every call site. */
export function buildQuotaExhaustedDispatchFailure(
    node: LocalMeshNodeEntry,
    providerType: string,
    sessionId: string | undefined,
    gate: { block: ProviderQuotaGateBlock; resetsAt: number | null },
): Record<string, unknown> {
    const { block, resetsAt } = gate;
    return {
        success: false,
        recoverable: true,
        code: 'provider_quota_exhausted',
        reason: 'provider_quota_exhausted',
        nodeId: node.id,
        ...(sessionId ? { sessionId } : {}),
        providerType,
        quotaBlock: {
            reason: block.reason,
            window: block.window,
            remainingPercent: block.remainingPercent,
            thresholdPercent: block.thresholdPercent,
            ...(resetsAt !== null ? { resetsAt } : {}),
        },
        error: `Provider '${providerType}' on node '${node.id}' is quota-gated (${block.reason}; ${block.window} window at ${block.remainingPercent}% remaining, threshold ${block.thresholdPercent}%)`
            + (resetsAt !== null ? ` — resets at ${new Date(resetsAt).toISOString()}.` : '.')
            + ' Refusing this direct dispatch rather than spending a turn on a session that cannot work right now.',
        nextAction: 'Wait for the quota window to reset, target a different node/session, or pass allow_quota_exhausted: true to dispatch anyway (e.g. deliberately testing the provider\'s own quota error).',
    };
}

/** Input of {@link ipcDispatchToRemoteAgent}. */
export interface RemoteAgentDispatchArgs {
    session_id?: string;
    message: string;
    /** MESH-IMAGE-DISPATCH: optional multipart envelope forwarded to the remote agent. */
    input?: MeshTaskInput;
    providerType?: string;
    verifiedSession?: any;
    /**
     * ★PROVIDER-PIN-BYPASS — the task's required_tags, when this dispatch carries a
     * queue task. Only the `provider=` axis is consumed here (see
     * resolveRemoteDispatchProvider); the other axes are node properties already
     * enforced by the caller's node filter. Absent/empty → no provider constraint,
     * i.e. exactly the previous behavior for every unpinned dispatch.
     */
    requiredTags?: string[];
    meshContext?: {
        meshId: string; nodeId?: string; taskId?: string; coordinatorDaemonId?: string;
        coordinatorSessionId?: string;
        /** C-W6c: the turn-ledger attempt this dispatch opened — stamped onto the worker session. */
        attemptId?: string; attemptGeneration?: number;
    };
    /**
     * D2 (applied in C-W8): the message identity + admission policy the worker's
     * one send funnel (SessionInputService) dedupes on. Absent → the worker mints
     * a legacy id (never deduplicated), exactly the pre-D2 behaviour.
     */
    messageId?: string;
    policy?: { mode: 'queue' | 'send_now' | 'interrupt' };
    origin?: 'mcp' | 'mesh';
    /** QUOTA GATE opt-out — see checkDirectDispatchQuotaGate's doc comment. */
    allowQuotaExhausted?: boolean;
}

type DispatchFailure = { success: false; error: string } & Record<string, unknown>;

/** Provider resolution state threaded through the dispatch steps. */
interface RemoteDispatchProvider {
    providerPins: string[];
    /** The provider the dispatch will name as agentType ('' = not resolved yet). */
    resolvedProviderType: string;
    /**
     * ★PROVIDER-PIN-BYPASS — the `resolvedProviderType ||= <session's provider>`
     * fills are the other way a non-pinned provider used to enter: when the
     * priority list gave nothing, the provider was adopted from whatever session was
     * found. Every such adoption goes through this predicate so a session running
     * the wrong provider leaves resolvedProviderType empty (→ the explicit
     * `providerType unknown` refusal) instead of silently becoming the target.
     */
    adoptSessionProviderType(session: any): string;
}

/**
 * ── ★PROVIDER-PIN-BYPASS (D2) — the pin must survive provider resolution ──────
 *
 * Resolve provider type: caller arg > node policy providerPriority (slots-derived
 * when unset — readProviderPriority applies the fallback) > empty (fuzzy fallback).
 *
 * ★The providerPriority[0] fallback is what silently broke required_tags. The
 * caller's node filter asks "could SOME provider here satisfy the pin?" and a node
 * declaring several slots answers yes — then this picked priority[0] with no idea
 * a pin existed. Live: required_tags ["provider=antigravity-cli"] resolved to
 * `claude-cli` (Jupiter's priority[0]) and the ledger recorded the pin as honored.
 * Whichever provider names reach `resolvedProviderType`, they are now intersected
 * with the pin first, so an unpinnable candidate can never be selected.
 */
function resolveRemoteDispatchProvider(node: LocalMeshNodeEntry, args: RemoteAgentDispatchArgs): RemoteDispatchProvider | DispatchFailure {
    const providerPins = providerPinsFromRequiredTags(args.requiredTags);
    const providerPriorityList: string[] = filterProvidersByRequiredTags(
        readProviderPriority(node.policy),
        args.requiredTags,
    );
    // An explicit caller-supplied providerType is honored ONLY when it satisfies the
    // pin. It normally comes from a cached session record, so a stale cache must not
    // become a second bypass of the same constraint.
    const callerProviderType = args.providerType?.trim() || '';
    const callerProviderAllowed = !callerProviderType
        || providerPins.length === 0
        || providerPins.includes(callerProviderType);
    if (providerPins.length && !callerProviderAllowed && !providerPriorityList.length) {
        // The node advertises no provider satisfying the pin (and the caller's hint does
        // not either). Fail-closed rather than dispatch onto some other provider — the
        // task stays pending for the claim path, which enforces the pin per-session.
        return buildProviderPinUnsatisfiableFailure(node, providerPins, readProviderPriority(node.policy));
    }
    return {
        providerPins,
        resolvedProviderType: (callerProviderAllowed ? callerProviderType : '') || providerPriorityList[0] || '',
        adoptSessionProviderType: (session: any): string => {
            const type = resolveSessionProviderType(session);
            if (!type) return '';
            return providerPins.length === 0 || providerPins.includes(type) ? type : '';
        },
    };
}

/**
 * An explicitly named session must be a relay-safe mesh-owned worker before we
 * dispatch into it. 'safe' or 'self_heal' → null (dispatch; the remote router
 * stamps the relay anchor from meshContext.coordinatorDaemonId when
 * self-healing) and the session's provider is adopted when none resolved yet.
 */
function checkExplicitRemoteSession(
    ctx: MeshContext,
    node: LocalMeshNodeEntry,
    sessionId: string,
    session: any,
    provider: RemoteDispatchProvider,
    coordinatorDaemonId: string,
): DispatchFailure | null {
    const relaySafety = classifyRemoteDelegateRelaySafety(session, ctx.mesh.id, node.id, coordinatorDaemonId);
    const providerType = provider.resolvedProviderType || resolveSessionProviderType(session) || undefined;
    if (relaySafety === 'unsafe_alias') return buildRelayUnsafeRemoteSessionFailure(ctx, node, sessionId, providerType);
    if (relaySafety === 'missing_anchor') return buildMissingCoordinatorDaemonIdFailure(ctx, node, providerType);
    if (!provider.resolvedProviderType) provider.resolvedProviderType = provider.adoptSessionProviderType(session);
    return null;
}

/**
 * Pick (sessionless) or verify (named) the target session from the member's
 * pushed runtime, held by the coordinator (owner principle ④): the member is
 * never read. A node with nothing held yet auto-picks nothing (the dispatch goes
 * sessionless and the worker picks / creates the session); a named session not
 * in the held list is refused as not found (retryable once the member's next
 * push lands). Returns the session id to target ('' = sessionless).
 */
async function resolveRemoteDispatchSession(
    ctx: MeshContext,
    node: LocalMeshNodeEntry,
    args: RemoteAgentDispatchArgs,
    provider: RemoteDispatchProvider,
    coordinatorDaemonId: string,
): Promise<{ sessionId: string } | DispatchFailure> {
    const sessionId = args.session_id?.trim() || '';
    if (sessionId && args.verifiedSession) {
        return checkExplicitRemoteSession(ctx, node, sessionId, args.verifiedSession, provider, coordinatorDaemonId) ?? { sessionId };
    }
    try {
        // ★PROVIDER-PIN-BYPASS — chooseDispatchableSession treats an EMPTY
        // providerType as "any provider will do" (its matchingProvider is
        // `!providerType || ...`). With a pin in play that is precisely the
        // wrong default, so pass the single pinned provider as the filter when
        // the node resolution left the type blank. Unpinned dispatches still
        // pass '' and keep the any-session behavior.
        const { providerPins } = provider;
        const sessionProviderFilter = provider.resolvedProviderType || (providerPins.length === 1 ? providerPins[0] : '');
        const runtime = await readNodeRuntime(ctx, node);
        const sessions = runtime.probe.sessions;
        if (sessionId) {
            const explicitSession = sessions.find((session: any) => readSessionRecordId(session) === sessionId);
            if (!explicitSession) {
                const resolvedProviderType = provider.resolvedProviderType;
                return {
                    success: false,
                    recoverable: true,
                    code: 'mesh_target_session_not_found',
                    reason: 'mesh_target_session_not_found',
                    transport: 'mesh_transport',
                    retryRecommended: true,
                    meshId: ctx.mesh.id,
                    nodeId: node.id,
                    daemonId: node.daemonId!,
                    workspace: node.workspace,
                    sessionId,
                    ...(resolvedProviderType ? { resolvedProviderType } : {}),
                    error: `Remote session '${sessionId}' is not in the coordinator's held runtime for node '${node.id}'${runtime.known ? '' : ' (nothing held for this node yet)'}.`,
                    nextAction: `Launch a fresh session with mesh_launch_session(node_id: '${node.id}'${resolvedProviderType ? `, type: '${resolvedProviderType}'` : ''}) or retry without session_id so Repo Mesh can target a live delegate session.`,
                };
            }
            return checkExplicitRemoteSession(ctx, node, sessionId, explicitSession, provider, coordinatorDaemonId) ?? { sessionId };
        }
        // QUOTA GATE (sessionless auto-pick): mirror the claim path's candidate
        // filtering — never auto-pick an idle session whose provider is
        // measurably quota-exhausted, the same predicate checkDirectDispatchQuotaGate
        // applies to an explicit session_id. A pre-filter here (rather than
        // gating only the final pick) lets chooseDispatchableSession fall through
        // to the NEXT idle session on this node when one exists, instead of
        // treating "the first idle session happens to be gated" as "no session
        // available". allowQuotaExhausted also disables this pre-filter, so the
        // opt-out has one consistent meaning across both call sites.
        // Prefer live idle sessions launched for this mesh node. Never route
        // a new task into restored/stopped session records; that produces the
        // coordinator-visible "pending only, chat never received it" failure.
        const candidates = args.allowQuotaExhausted ? sessions : sessions.filter((session: any) => {
            const sessionProviderType = resolveSessionProviderType(session);
            if (!sessionProviderType) return true;
            return !checkDirectDispatchQuotaGate(node, sessionProviderType, ctx.mesh.policy?.quotaRouting ?? null);
        });
        const targetSession = chooseDispatchableSession(candidates, sessionProviderFilter, ctx.mesh.id, node.id, coordinatorDaemonId);
        if (targetSession?.id || targetSession?.sessionId) {
            if (!provider.resolvedProviderType) provider.resolvedProviderType = provider.adoptSessionProviderType(targetSession);
            return { sessionId: targetSession.id || targetSession.sessionId };
        }
        return { sessionId: '' };
    } catch (e: any) {
        if (sessionId) {
            return {
                ...buildCoordinatorP2pRelayFailure(e, {
                    command: 'mesh_status',
                    targetDaemonId: node.daemonId!,
                    nodeId: node.id,
                    sessionId,
                }),
                success: false,
                error: `Cannot verify remote session '${sessionId}' before dispatch: ${e?.message || String(e)}`,
            };
        }
        // fall through — will attempt dispatch with just providerType (fuzzy)
        return { sessionId: '' };
    }
}

/** A worker-side refusal of the relayed agent_command (typed busy refusal first). */
function remoteDispatchFailure(
    node: LocalMeshNodeEntry,
    sessionId: string,
    error: unknown,
    errorMessage: string,
    source?: Record<string, unknown>,
): RemoteAgentDispatchResult {
    const daemonId = node.daemonId!;
    const busyRefusal = sessionBusyRefusalFields(source ? errorMessage : error, sessionId);
    if (busyRefusal) return { success: false, error: `P2P dispatch refused: ${errorMessage}`, nodeId: node.id, targetDaemonId: daemonId, ...busyRefusal };
    return {
        ...buildCoordinatorP2pRelayFailure(error, {
            command: 'agent_command',
            targetDaemonId: daemonId,
            nodeId: node.id,
            sessionId,
        }),
        ...(source && typeof source === 'object' ? source : {}),
        success: false,
        error: `P2P dispatch failed: ${errorMessage}`,
    };
}

/**
 * For IpcTransport + remote node: resolve an active session on the node and
 * dispatch an agent_command directly via P2P relay (mesh_relay_command).
 *
 * This bypasses the local queue (which remote daemons cannot read) and sends
 * the message directly to the session running on the remote daemon.
 *
 * Returns { success, sessionId } or throws.
 */
export async function ipcDispatchToRemoteAgent(
    ctx: MeshContext,
    node: LocalMeshNodeEntry,
    args: RemoteAgentDispatchArgs,
): Promise<RemoteAgentDispatchResult> {
    const transport = ctx.transport as IpcTransport;
    const daemonId = node.daemonId!;

    // The coordinator anchor the remote router will stamp onto the worker session
    // at dispatch time (router.ts buildMeshWorkerRelayStamp). When present, a
    // mesh-owned session that was never launch-stamped can still self-heal to
    // relay-safe — exactly like the local direct-dispatch path.
    const dispatchCoordinatorDaemonId = readString(args.meshContext?.coordinatorDaemonId) || '';

    const provider = resolveRemoteDispatchProvider(node, args);
    if ('success' in provider) return provider;
    const session = await resolveRemoteDispatchSession(ctx, node, args, provider, dispatchCoordinatorDaemonId);
    if ('success' in session) return session;
    const { sessionId } = session;
    const { providerPins, resolvedProviderType } = provider;

    // agent_command requires agentType — fail if we cannot determine provider type
    if (!resolvedProviderType) {
        return { success: false, error: `Cannot dispatch to remote node '${node.id}': providerType unknown. Set providerPriority on the node policy or call mesh_launch_session first.` };
    }
    // ★PROVIDER-PIN-BYPASS — single fail-closed assert over EVERY route that can reach
    // here (caller hint / priority list / any session adoption / the catch-block
    // fall-through). The individual guards each narrow one route; this one makes it
    // structurally impossible for a future edit to open a new one, because the pin is
    // re-checked on the value actually about to be sent as agentType. Deliberately
    // placed BELOW the unknown-provider refusal so the more specific message wins when
    // nothing resolved at all.
    if (providerPins.length && !providerPins.includes(resolvedProviderType)) {
        return buildProviderPinUnsatisfiableFailure(node, providerPins, readProviderPriority(node.policy), resolvedProviderType);
    }
    // QUOTA GATE (direct dispatch) — see checkDirectDispatchQuotaGate's doc comment.
    // Placed after pin resolution (a pin refusal is more specific and should win) and
    // before the actual send. The sessionless auto-pick already pre-filtered
    // candidate sessions, but this still catches an EXPLICIT session_id (the run-10
    // case) and the sessionless-fallback-to-priority-list route, where no session
    // filtering ran at all.
    if (!args.allowQuotaExhausted) {
        const quotaGate = checkDirectDispatchQuotaGate(node, resolvedProviderType, ctx.mesh.policy?.quotaRouting ?? null);
        if (quotaGate) {
            return buildQuotaExhaustedDispatchFailure(node, resolvedProviderType, sessionId || undefined, quotaGate) as RemoteAgentDispatchResult;
        }
    }

    try {
        const dispatchResult = await transport.meshCommand(daemonId, 'agent_command', {
            ...(sessionId ? { targetSessionId: sessionId } : {}),
            agentType: resolvedProviderType,
            cliType: resolvedProviderType,
            action: 'send_chat',
            message: args.message,
            // MESH-IMAGE-DISPATCH: forward the attachment over P2P. Oversized payloads are
            // split by the mesh transport's frame chunking (daemon-mesh-manager
            // writeEnvelope) and reassembled on the worker before the command is handled.
            ...(args.input ? { input: args.input } : {}),
            ...(args.messageId ? { messageId: args.messageId } : {}),
            ...(args.policy ? { policy: args.policy } : {}),
            ...(args.origin ? { origin: args.origin } : {}),
            // DISPATCH-SOURCE-TRACE: call-site tag echoed in the worker daemon log.
            dispatchSource: 'mesh-tools-internal:ipcDispatchToRemoteAgent',
            // WTCLAIM (B): carry the node workspace so a sessionless dispatch can be
            // scoped to THIS node's session on the worker (findAdapter dir match /
            // findMeshNodeAdapter). Without it, a worker hosting both a base node and a
            // cloned worktree node (same daemonId) would fall through to a provider-only
            // fuzzy match and could land worktree work on the base session.
            ...(node.workspace ? { dir: node.workspace } : {}),
            ...(args.meshContext ? { meshContext: args.meshContext } : {}),
        });
        const dispatchPayload = unwrapCommandPayload(dispatchResult);
        if (dispatchPayload?.success === false || dispatchResult?.success === false) {
            const source = dispatchPayload?.success === false ? dispatchPayload : dispatchResult;
            const errorMessage = dispatchPayload?.error || dispatchResult?.error || 'agent_command rejected the task';
            return remoteDispatchFailure(node, sessionId, source?.error || errorMessage, errorMessage, source ?? {});
        }
        // Do NOT fall back to resolvedProviderType for sessionId: a sessionless
        // dispatch (no targetSessionId above) lets the worker pick/create the real
        // session, so the provider type ('claude-cli', …) is NOT a session id.
        // Returning it here used to poison assigned_session_id downstream, breaking
        // findAssignedBySession (provider type vs real session id) and orphaning the
        // task_completed match. Leave it empty so completion matching falls back to
        // taskId via the meshContext.taskId carried in the dispatch.
        return { success: true, dispatched: true, sessionId: sessionId || '', providerType: resolvedProviderType };
    } catch (e: any) {
        return remoteDispatchFailure(node, sessionId, e, e?.message || String(e));
    }
}

/**
 * SESSION-BUSY (preview rc.37): the worker refused the dispatch because the target session
 * is still working a DIFFERENT task (provider-instance-manager's stamp guard). That is an
 * application answer, not a P2P transport failure — report it as the typed
 * `session_busy_with_task` refusal with the task the session is running, and never as a
 * retryable relay outage. Only the error message crosses the P2P + IPC hops, so the
 * worker's machine token is read back via daemon-core's classifier.
 */
function sessionBusyRefusalFields(error: unknown, sessionId: string): Record<string, unknown> | null {
    const busy = classifySessionBusyWithTask(error);
    if (!busy) return null;
    return {
        code: SESSION_BUSY_WITH_TASK_CODE,
        reason: SESSION_BUSY_WITH_TASK_CODE,
        recoverable: true,
        retryRecommended: false,
        ...(sessionId ? { sessionId } : {}),
        currentTaskId: busy.currentTaskId,
        ...(busy.currentAttemptId ? { currentAttemptId: busy.currentAttemptId } : {}),
        nextAction: `Session${sessionId ? ` '${sessionId}'` : ''} is still running task '${busy.currentTaskId}'. Nothing was delivered. `
            + 'Use mesh_enqueue_task (the queue delivers when the session goes idle), target another idle session, or retry after the current task completes.',
    };
}
