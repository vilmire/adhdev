/**
 * getState() — the ProviderState projection (verbatim move out of
 * CliProviderInstance — M-FILE-SIZE-DEBT decomposition).
 *
 * This is the per-status-report read path: it samples the adapter (with the
 * sticky-approval overlay applied), runs the script-parsed status, resolves the
 * provider-session binding, hydrates/persists the transcript tail, and folds all
 * of it into the single ProviderState the daemon status reporter consumes.
 *
 * Invariants this path must keep (do not regress):
 *   - ZERO native transcript reads beyond the bounded hydration this method
 *     already performs — the status cadence is 30s/5s per session.
 *   - It must AGREE with the FSM-committed lastStatus rather than second-guess
 *     it from transcript shape (the generating→idle reconcile below is the only
 *     permitted narrowing).
 *   - No completion/stall/redrive verdict is taken here; the dashboard tail
 *     repair is display-only and reads a pre-cached summary.
 *
 * State lives ON THE HOST (the provider instance) exactly as before. Provenance
 * kept inline: AUTOAPPROVE-FLAP-INBOX-MISSING sticky overlay, STATUS-MISMATCH
 * mask-stall surfacing, the antigravity display-tail repair, and the
 * fresh-launch startup-replay suppression.
 */

import type { ProviderModule } from './contracts.js';
import { flattenContent } from './contracts.js';
import { getEffectiveMessageInputSupport } from './provider-input-support.js';
import type { ProviderState, ProviderErrorReason, ProviderEvent } from './provider-instance.js';
import type { InteractivePrompt } from './types/interactive-prompt.js';
import type { ChatMessage } from '../types.js';
import { ChatHistoryWriter } from '../config/chat-history.js';
import { normalizeProviderSessionId } from './provider-session-id.js';
import { resolveProviderStateSurface } from './provider-patch-state.js';
import { workingDirBasename } from './working-dir.js';
import { isCliGeneratingLikeStatus } from './cli-provider-status-helpers.js';
import { mergeConversationMessages } from './cli-provider-transcript-merge.js';
import { ParsedIngestTimestampStamper } from './cli-provider-ingest-times.js';
import { type PersistableCliHistoryMessage, buildIncrementalHistoryAppendMessages } from './cli-provider-history-dedup.js';
import type { PtyRuntimeMetadata } from '../cli-adapters/pty-transport.js';

/** The narrow surface of CliProviderInstance the state projection reads/writes. */
export interface ProviderStateHost {
    type: string;
    workingDir: string;
    instanceId: string;
    provider: ProviderModule;
    providerSessionId?: string;
    presentationMode: 'terminal' | 'chat';
    settings: Record<string, any>;
    lastStatus: string;
    errorMessage: string | undefined;
    errorReason: ProviderErrorReason | undefined;
    activeInteractivePrompt: InteractivePrompt | null;
    controlValues: Record<string, string | number | boolean>;
    summaryMetadata: unknown;
    suppressIdleHistoryReplay: boolean;
    autoApproveBusy: boolean;
    historyWriter: ChatHistoryWriter;
    runtimeMessages: Array<{ key: string; message: ChatMessage }>;
    parsedIngestTimestamps: ParsedIngestTimestampStamper;
    lastPersistedHistoryMessages: PersistableCliHistoryMessage[];
    lastCompletionSummary: { content: string; receivedAt: number; sourceTimestampMs?: number } | null;
    adapter: Record<string, any> & {
        getStatus(opts?: { allowParse: boolean }): any;
        getScriptParsedStatus?: () => any;
        getRuntimeMetadata(): PtyRuntimeMetadata | null;
    };
    stabilizeFlappingApprovalStatus(adapterStatus: any, now?: number): any;
    maybeAutoApproveStatus(adapterStatus: any, now?: number): boolean;
    autoApproveMaskStalled(now?: number): boolean;
    maybeAppendRuntimeRecoveryMessage(runtime: PtyRuntimeMetadata | null): void;
    shouldSuppressFreshLaunchStartupReplay(parsedMessages: unknown[], parsedStatus: any, adapterStatus: any, parsedProviderSessionId?: string): boolean;
    promoteProviderSessionId(sessionId: string, opts?: { authoritative?: boolean }): void;
    shouldHydrateExistingProviderHistory(): boolean;
    syncCanonicalSavedHistoryIfNeeded(options?: { full?: boolean }): boolean;
    shouldSuppressStaleParsedBusyStatus(parsedStatus: any, adapterStatus: any): boolean;
    applyProviderResponse(data: any, options: { phase: 'immediate' | 'turn_completed' }): void;
    flushEvents(): ProviderEvent[];
}

export function buildProviderState(host: ProviderStateHost): ProviderState {
    // TODO(phase5-sandbox): JS override scripts (detectStatus, parseApproval,
    // parseSession) are currently invoked by CliScriptRunner.invoke() via direct
    // function calls — the scripts run in the daemon process with full Node.js
    // access and no resource limits.
    //
    // When Phase 5 lands, CliScriptRunner should route these calls through a
    // SandboxedScriptRunner (see providers/sdk/v1/sandbox/script-runner.ts) so
    // that each call gets a fresh isolated-vm context with a 50 ms CPU limit and
    // a 32 MB memory cap.  The execution path to change is:
    //   CliScriptRunner.invoke() → SandboxedScriptRunner.run(scriptSource, context)
    //
    // This getState() call-site is NOT where the change goes — the wiring belongs
    // in cli-script-runner.ts (CliScriptRunner.detectStatus / parseApproval /
    // parseSession), with provider-loader.ts updated to store script source strings
    // alongside the loaded function references for extended-legacy providers.
    // AUTOAPPROVE-FLAP-INBOX-MISSING: apply the same sticky-approval overlay the
    // FSM path uses so the status this getState() surfaces to the mesh probe (and
    // thus mesh_active_work → the pending-approval inbox) stays waiting_approval
    // across a busy flap frame, instead of momentarily reading generating (count:0).
    const adapterStatus = host.stabilizeFlappingApprovalStatus(host.adapter.getStatus());
    if (Object.prototype.hasOwnProperty.call(adapterStatus, 'activeInteractivePrompt')) {
        host.activeInteractivePrompt = adapterStatus.activeInteractivePrompt ?? null;
    }
    let parsedStatus: any = null;
    let parseErrorMessage: string | undefined;
    if (typeof host.adapter.getScriptParsedStatus === 'function') {
        try {
            parsedStatus = host.adapter.getScriptParsedStatus() || null;
            const parsedErrorMessage = typeof parsedStatus?.errorMessage === 'string' && parsedStatus.errorMessage.trim()
                ? parsedStatus.errorMessage.trim()
                : undefined;
            const parsedErrorReason = typeof parsedStatus?.errorReason === 'string' && parsedStatus.errorReason.trim()
                ? parsedStatus.errorReason.trim() as ProviderErrorReason
                : undefined;
            host.errorMessage = parsedErrorMessage;
            host.errorReason = parsedErrorReason;
        } catch (error: any) {
            parseErrorMessage = error?.message || String(error);
            host.errorMessage = parseErrorMessage;
            host.errorReason = 'parse_error';
        }
    } else {
        host.errorMessage = undefined;
        host.errorReason = undefined;
    }
    const adapterProviderSessionId = normalizeProviderSessionId(
        host.provider,
        typeof adapterStatus?.providerSessionId === 'string' ? adapterStatus.providerSessionId : '',
    );
    const nowMs = Date.now();
    // STATUS-MISMATCH: maybeAutoApproveStatus still runs for its side effects (settle gate,
    // resolveModal fire), but the SURFACE mask is dropped once the episode has stalled past
    // AUTO_APPROVE_MASK_STALL_MS — otherwise a never-settling auto-approve hides the worker's
    // waiting_approval + modal from read_chat/mesh_status/dashboard forever.
    const autoApproveActive = host.maybeAutoApproveStatus(adapterStatus, nowMs)
        && !host.autoApproveMaskStalled(nowMs);
    const autoApproveHoldIdle = host.autoApproveBusy && adapterStatus.status === 'idle';
    let visibleStatus = parseErrorMessage || parsedStatus?.status === 'error'
        ? 'error'
        : (autoApproveActive || autoApproveHoldIdle ? 'generating' : adapterStatus.status);
    // getState() must agree with the status the FSM-driven detectStatusTransition()
    // already committed to lastStatus. The adapter's own status is authoritative; we do
    // not second-guess it with native-transcript shape. Only reconcile a generating-like
    // read down to idle when our own lastStatus has already flipped idle (avoids a
    // perpetual dashboard spinner during the brief window before the next getStatus()).
    if (isCliGeneratingLikeStatus(visibleStatus) && host.lastStatus === 'idle') {
        visibleStatus = 'idle';
    }
    const runtime = host.adapter.getRuntimeMetadata();
    host.maybeAppendRuntimeRecoveryMessage(runtime);
    let parsedMessages = Array.isArray(parsedStatus?.messages)
        ? parsedStatus.messages
        : [];
    const parsedProviderSessionId = normalizeProviderSessionId(
        host.provider,
        typeof parsedStatus?.providerSessionId === 'string' ? parsedStatus.providerSessionId : '',
    );
    const suppressFreshLaunchStartupReplay = host.shouldSuppressFreshLaunchStartupReplay(
        parsedMessages,
        parsedStatus,
        adapterStatus,
        parsedProviderSessionId,
    );
    if (adapterProviderSessionId && !suppressFreshLaunchStartupReplay) {
        host.promoteProviderSessionId(adapterProviderSessionId);
    }
    if (parsedProviderSessionId && !suppressFreshLaunchStartupReplay) {
        host.promoteProviderSessionId(parsedProviderSessionId);
    }
    if (suppressFreshLaunchStartupReplay) {
        parsedMessages = [];
    }
    // Adapter runtime metadata is transport-owned and is not guaranteed to
    // identify this conversation. Spec adapters historically exposed the
    // provider spec id (for example "codex-cli") as runtimeId, which made
    // concurrent sessions share one activeChat identity until their native
    // provider session ids were discovered.
    const activeChatId = host.providerSessionId || host.instanceId;
    const historyMessageCount = Number.isFinite(parsedStatus?.historyMessageCount)
        ? Math.max(0, Number(parsedStatus.historyMessageCount))
        : null;
    if (historyMessageCount !== null) {
        parsedMessages = historyMessageCount > 0
            ? parsedMessages.slice(-historyMessageCount)
            : [];
    }
    const mergedMessages = mergeConversationMessages(host.runtimeMessages, host.parsedIngestTimestamps.stamp(parsedMessages));
    const canonicalBackedHistory = host.shouldHydrateExistingProviderHistory()
        ? host.syncCanonicalSavedHistoryIfNeeded()
        : false;
    const statusMessages: any[] = canonicalBackedHistory && host.lastPersistedHistoryMessages.length > 0
        ? host.lastPersistedHistoryMessages.map((message) => ({
            role: message.role,
            content: message.content,
            kind: message.kind,
            senderName: message.senderName,
            receivedAt: message.receivedAt,
        }))
        : mergedMessages;

    // purpose: 'display-tail' (zero-read) — Dashboard-tail repair (native-source
    // providers, e.g. antigravity): the assistant answer lives only in native-history,
    // so the PTY-parsed statusMessages end on the user prompt / auto-approve system
    // lines and the snapshot's preview / lastMessageRole / completionMarker never see
    // the answer — the session looks stuck on the user turn. We already cached the
    // real final assistant summary at completion time (lastCompletionSummary), so
    // append it as the trailing assistant bubble when the current tail has no
    // assistant message at/after it. Purely additive to the status view; no per-tick
    // native read, no effect on providers whose PTY carries the assistant (they
    // surface it themselves and the guard below is a no-op).
    //
    // authority-ok: this is a DISPLAY-ONLY tail repair, never a completion/stall/
    // redrive verdict — it reads the pre-cached summary (zero native read) and only
    // paints the status view. It keys off the adapter's runtime chatMessagesOwnedExternally
    // capability (not a class predicate); a completion decision is never taken here.
    const adapterOwnsMessagesElsewhereForTail = (host.adapter as any)?.chatMessagesOwnedExternally === true;
    if (adapterOwnsMessagesElsewhereForTail && host.lastCompletionSummary) {
        const summary = host.lastCompletionSummary;
        let hasTrailingAssistant = false;
        for (let i = statusMessages.length - 1; i >= 0; i -= 1) {
            const m = statusMessages[i] as { role?: string; kind?: string; receivedAt?: number };
            const role = typeof m?.role === 'string' ? m.role : '';
            if (role === 'system') continue;
            if (typeof m?.kind === 'string' && m.kind === 'tool') continue;
            // First non-system/non-tool message from the tail: if it's already an
            // assistant reply not older than our cached summary, the tail is fine.
            hasTrailingAssistant = role === 'assistant'
                && typeof m?.receivedAt === 'number'
                && m.receivedAt >= summary.receivedAt - 1000;
            break;
        }
        if (!hasTrailingAssistant) {
            statusMessages.push({
                role: 'assistant',
                content: summary.content,
                kind: 'standard',
                receivedAt: summary.receivedAt,
            });
        }
    }

    const dirName = workingDirBasename(host.workingDir);
    const parsedChatStatus = typeof parsedStatus?.status === 'string' && parsedStatus.status.trim()
        ? parsedStatus.status.trim()
        : undefined;
    const suppressStaleParsedBusyStatus = host.shouldSuppressStaleParsedBusyStatus(parsedStatus, adapterStatus);

    if (parsedMessages.length > 0) {
        const shouldSkipReplayPersist =
            host.suppressIdleHistoryReplay
            && adapterStatus.status === 'idle'
            && parsedStatus?.status === 'idle';
        let messagesToSave = parsedMessages;
        if (!suppressStaleParsedBusyStatus && (parsedChatStatus === 'generating' || parsedChatStatus === 'no_progress' || parsedChatStatus === 'long_generating')) {
            const lastIdx = messagesToSave.length - 1;
            if (lastIdx >= 0 && messagesToSave[lastIdx]?.role === 'assistant') {
                messagesToSave = messagesToSave.slice(0, lastIdx);
            }
        }
        const normalizedMessagesToSave = messagesToSave.map((message: PersistableCliHistoryMessage & { timestamp?: number }) => ({
            role: message.role,
            content: flattenContent(message.content),
            kind: typeof message.kind === 'string' ? message.kind : undefined,
            senderName: typeof message.senderName === 'string' ? message.senderName : undefined,
            receivedAt: typeof message.receivedAt === 'number' ? message.receivedAt : message.timestamp,
        }));
        if (!canonicalBackedHistory && !shouldSkipReplayPersist && normalizedMessagesToSave.length > 0) {
            const incrementalMessages = buildIncrementalHistoryAppendMessages(host.lastPersistedHistoryMessages, normalizedMessagesToSave);
            if (incrementalMessages.length > 0) {
                host.historyWriter.appendNewMessages(
                    host.type,
                    incrementalMessages,
                    parsedStatus?.title || dirName,
                    host.instanceId,
                    host.providerSessionId,
                );
            }
        }
        if (!canonicalBackedHistory) {
            host.lastPersistedHistoryMessages = normalizedMessagesToSave;
        }
    }

    host.applyProviderResponse(
        suppressFreshLaunchStartupReplay && parsedStatus && typeof parsedStatus === 'object'
            ? { ...parsedStatus, providerSessionId: undefined }
            : parsedStatus,
        { phase: 'immediate' },
    );
    const surface = resolveProviderStateSurface({
        summaryMetadata: host.summaryMetadata as any,
        controlValues: host.controlValues,
    });
    const activeChatStatus = parseErrorMessage
        ? 'error'
        : (autoApproveActive && parsedStatus?.status === 'waiting_approval') || autoApproveHoldIdle
        ? 'generating'
        : (adapterStatus.status !== 'idle'
            ? visibleStatus
            : (suppressStaleParsedBusyStatus ? visibleStatus : (parsedChatStatus || visibleStatus)));

    // If an AskUserQuestion prompt is awaiting user input, overlay status as
    // waiting_choice. This is distinct from waiting_approval (tool-use consent)
    // — the engine's isWaitingForResponse state is unchanged, so completion
    // tracking continues normally once the user responds.
    const hasInteractivePrompt = !!host.activeInteractivePrompt;
    const finalStatus = hasInteractivePrompt ? 'waiting_choice' : visibleStatus;
    const finalChatStatus = hasInteractivePrompt ? 'waiting_choice' : activeChatStatus;

    return {
        type: host.type,
        name: host.provider.name,
        category: 'cli',
        status: finalStatus,
        mode: host.presentationMode,
        activeChat: {
            id: activeChatId,
            title: parsedStatus?.title || dirName,
            status: finalChatStatus,
            messages: statusMessages,
            activeModal: (autoApproveActive || autoApproveHoldIdle) ? null : (parsedStatus?.activeModal ?? adapterStatus.activeModal),
            activeInteractivePrompt: host.activeInteractivePrompt,
            inputContent: '',
        },
        activeInteractivePrompt: host.activeInteractivePrompt,
        workspace: host.workingDir,
        instanceId: host.instanceId,
        providerSessionId: host.providerSessionId,
        lastUpdated: Date.now(),
        settings: host.settings,
        pendingEvents: host.flushEvents(),
        runtime: runtime ? {
            runtimeId: runtime.runtimeId,
            runtimeKey: runtime.runtimeKey,
            displayName: runtime.displayName,
            workspaceLabel: runtime.workspaceLabel,
            lifecycle: runtime.lifecycle ?? null,
            surfaceKind: runtime.surfaceKind,
            writeOwner: runtime.writeOwner || null,
            attachedClients: runtime.attachedClients || [],
            restoredFromStorage: runtime.restoredFromStorage === true,
            recoveryState: runtime.recoveryState ?? null,
        } : undefined,
        resume: host.provider.resume,
        controlValues: surface.controlValues,
        providerControls: host.provider.controls,
        messageInput: getEffectiveMessageInputSupport(host.provider),
        summaryMetadata: surface.summaryMetadata as any,
        errorMessage: host.errorMessage,
        errorReason: host.errorReason,
        // Restart idle-gate (mesh-restart collectBlockingSessions): a queued
        // outbound coordinator message is restart-blocking, so the count must
        // reach the daemon-wide state collection.
        pendingOutboundCount: typeof adapterStatus.pendingOutboundCount === 'number'
            ? adapterStatus.pendingOutboundCount
            : undefined,
    };
}
