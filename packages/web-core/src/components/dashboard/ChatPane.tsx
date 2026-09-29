
/**
 * ChatPane — Chat view for IDE and CLI chat-mode sessions.
 */
import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import ChatMessageList, { getChatMessageStableKey, type ToolExpandAddress } from '../ChatMessageList';
import ChatControlsSection, { readSessionLaunchSurface } from './ChatControlsSection';
import ChatInputBar, { type ImageAttachment } from './ChatInputBar';
import PendingQueueStrip from './PendingQueueStrip';
import ChatMachineReconnectButton from './ChatMachineReconnectButton';
import { getVisibleBarControls } from './ControlsBar';
import { useControlsBarVisibility } from '../../hooks/useControlsBarVisibility';
import { useTransport } from '../../context/TransportContext';
import { useDaemons } from '../../compat';
import { unwrapCommandResult } from '../../hooks/useDashboardConversationCommands';
import { buildChatDebugBundleClipboardText, buildChatDebugBundleToastMessage, buildChatFrontendDebugSnapshot, copyChatDebugBundleTextToClipboard, recordControlsToggleDebugGesture, type ControlsToggleDebugGestureState } from './chat-debug-bundle';
import { eventManager } from '../../managers/EventManager';
import { getChatPaneFirstViewState, getConversationViewStates } from './DashboardMobileChatShared';
import type { ToolExpandFailureReason, ToolExpandState } from '../ChatMessageList/chatMessageBubbles';
import type { ActiveConversation, DashboardMessage } from './types';
import type { DaemonData } from '../../types';
import { useDaemonMetadataLoader } from '../../hooks/useDaemonMetadataLoader';
import { useDevRenderTrace } from '../../hooks/useDevRenderTrace';
import { IconChat, IconEye, IconFolder, IconPlug, IconSpinner } from '../Icons';
import {
    getMessageTimestamp,
} from './message-utils';
import {
    getConversationControlsContext,
    getConversationDaemonRouteId,
    getConversationDisplayLabel,
    getConversationProviderLabel,
    getCoordinatorRoutingHint,
} from './conversation-selectors';
import { getConversationSendBlockMessage, getConversationSendBlockedPlaceholder } from '../../hooks/dashboardCommandUtils'
import { getDefaultVisibleLiveMessages, getRememberedVisibleLiveCount, rememberVisibleLiveCount } from './chat-visibility';
import { useSessionChatController } from './session-chat-controller';
import { buildTranscriptPaneAttributes } from './transcript-chat-pane-adapter';
import { buildVisibleConversationMessages, getConversationLiveMessages, withPendingLocalMessages, type PendingLocalMessage } from './conversation-message-snapshot';
import { shouldShowOpenPanelAction } from './dashboardSessionCapabilities';
import { publishChatTyping } from './chat-typing-indicator-store';
import { buildGitSystemBubbleMessages } from './git-system-bubbles';
import {
    filterChatActivityMessages,
    readChatActivityVisiblePreference,
    setChatActivityVisiblePreference,
    subscribeChatActivityVisiblePreference,
} from './chat-activity-visibility';

export interface ChatPaneProps {
    activeConv: ActiveConversation;
    ideEntry?: DaemonData;
    handleSendChat: (message: string, attachments?: ImageAttachment[]) => Promise<boolean>;
    /**
     * SEND-NOW: interrupt the agent's turn in flight so the queued optimistic
     * bubble is delivered as a real turn. Rendered inside that bubble by
     * ChatMessageRow, which is why every layout gets it from this one prop.
     */
    handleSendNowQueued?: (pendingId?: string) => Promise<boolean>;
    /** (QUEUED-SEND-CANCEL) Withdraw one still-waiting body by its pending id. */
    handleCancelQueued?: (pendingId: string) => Promise<boolean>;
    isSendingChat?: boolean;
    sendFeedbackMessage?: string | null;
    /** (OPTIMISTIC-USER-BUBBLE) Newest locally-rendered message awaiting its echo. */
    pendingLocalMessage?: PendingLocalMessage | null;
    /**
     * (MULTI-QUEUE) Every body still waiting, oldest first. Takes precedence over
     * `pendingLocalMessage` when provided — that single-entry prop remains only
     * for surfaces that have not been migrated.
     */
    pendingLocalMessages?: readonly PendingLocalMessage[] | null;
    /**
     * ★ (QUEUED-SEND-STUCK-FOREVER) Hand the daemon's transcript tail back to the
     * queue's owner so echoed bodies are retired from state, not merely hidden by
     * the render. Optional so the read-only share viewer — which renders a
     * transcript it does not own and has no queue to reconcile — can omit it.
     */
    retireEchoedPendingMessages?: (liveMessages: DashboardMessage[]) => void;
    handleFocusAgent: () => void;
    isFocusingAgent: boolean;
    actionLogs: { routeId: string; text: string; timestamp: number }[];
    /** Display name for user messages */
    userName?: string;
    showMetaChips?: boolean;
    scrollToBottomRequestNonce?: number;
    isInputActive?: boolean;
    isVisible?: boolean;
}

const LIVE_MESSAGE_PAGE_SIZE = 60;

/**
 * (QUEUED-SEND-STUCK-FOREVER) How often the pane re-checks whether a waiting body
 * has outlived the window in which calling it "waiting" is still true.
 *
 * Only runs while the queue is non-empty, and only writes when a row actually
 * crosses the threshold. Coarse on purpose: it enforces a minutes-scale bound, so
 * checking every 30s bounds the lag to a small fraction of it while staying far
 * away from anything that could be mistaken for polling.
 */
const PENDING_QUEUE_STALE_SWEEP_INTERVAL_MS = 30_000;

/**
 * (CHAT-TAB-SWITCH-STALE-FALLBACK ①) Build the chat controller options for a
 * pane. `isVisible` is dockview PANEL visibility — it flips on every
 * session-tab switch — and deliberately does NOT gate `enabled`: tearing the
 * controller down while a pane is merely hidden would empty the live snapshot
 * and flash the stale status-meta `conversation.messages` list on return. The
 * controller is refcounted and shared through the module-level registry, so a
 * hidden pane keeps its keyed view.
 *
 * Exported for the regression test: this is the whole of the decision.
 */
export function buildChatPaneControllerOptions(options: {
    sessionId?: string;
    isVisible: boolean;
}): { enabled: boolean } {
    return { enabled: !!options.sessionId };
}

export function buildBusyChatInputStatusMessage(
    conversation: Pick<ActiveConversation, 'status' | 'modalButtons'>,
    t: (key: string) => string,
): string | null {
    if (conversation.status === 'no_progress' || conversation.status === 'long_generating') {
        return t('chatPane.busyNoProgress')
    }
    if (conversation.status === 'generating') {
        return t('chatPane.busyGenerating')
    }
    if (conversation.status === 'waiting_approval' && (!conversation.modalButtons || conversation.modalButtons.length === 0)) {
        return t('chatPane.busyWaitingApproval')
    }
    return null
}

/**
 * (TOOL-EXPAND) The five refusal reasons the daemon may return, as an
 * allow-list.
 *
 * ★ An allow-list rather than a cast for the usual reason: this value crosses a
 * process boundary from a daemon whose version we do not control, and it ends
 * up selecting UI copy. Accepting only these five means a newer/tampered daemon
 * can at worst land `undefined` (→ the generic "could not be fetched" branch),
 * never an unrecognised label that leaks into the rendered string.
 */
const TOOL_EXPAND_FAILURE_REASONS: readonly ToolExpandFailureReason[] = [
    'unsupported_source',
    'source_unavailable',
    'source_changed',
    'block_not_found',
    'not_a_tool_block',
];

/** Narrow a daemon-supplied reason to the known taxonomy; undefined otherwise. */
export function toExpandFailureReason(value: unknown): ToolExpandFailureReason | undefined {
    return TOOL_EXPAND_FAILURE_REASONS.find(reason => reason === value);
}

export default function ChatPane({
    activeConv, ideEntry,
    handleSendChat,
    handleSendNowQueued,
    handleCancelQueued,
    isSendingChat = false,
    sendFeedbackMessage = null,
    pendingLocalMessage = null,
    pendingLocalMessages = null,
    retireEchoedPendingMessages,
    handleFocusAgent, isFocusingAgent, actionLogs, userName,
    scrollToBottomRequestNonce,
    isInputActive = true,
    isVisible = true,
}: ChatPaneProps) {
    const { t } = useTranslation('common');
    const receivedAtCache = useRef<Map<string, number>>(new Map());
    const debugGestureStateRef = useRef<ControlsToggleDebugGestureState | undefined>(undefined);
    const loadDaemonMetadata = useDaemonMetadataLoader();
    const { sendCommand } = useTransport();
    const { isVisible: areControlsVisible } = useControlsBarVisibility();
    const daemonCtx = useDaemons();

    // Inline manual reconnect for a machine that auto-reconnect has PARKED.
    //
    // `connectionRetryStatuses` is keyed by the machine-level daemon id — the same
    // `daemon.id` (type 'adhdev-daemon') that `groupByMachine` uses as `machineId`
    // and that P2PManager tracks via `syncDaemons`. `getConversationDaemonRouteId`
    // resolves the open chat to that machine, so the two sides agree by construction.
    //
    // The equivalence fallback is the known multi-identifier hazard: the same machine
    // can appear as `mach_…` / `daemon_mach_…` / `standalone_mach_…`, and a raw ===
    // lookup is exactly the recurring-defect class `check:canon-identity` guards. An
    // exact hit is preferred; the scan only runs when that misses.
    const chatMachineId = getConversationDaemonRouteId(activeConv);
    const machineRetryStatus = React.useMemo(() => {
        const statuses = daemonCtx.connectionRetryStatuses;
        if (!statuses || !chatMachineId) return undefined;
        const exact = statuses[chatMachineId];
        if (exact) return exact;
        const equivalentKey = Object.keys(statuses).find(key => daemonIdsEquivalent(key, chatMachineId));
        return equivalentKey ? statuses[equivalentKey] : undefined;
    }, [daemonCtx.connectionRetryStatuses, chatMachineId]);
    useDevRenderTrace('ChatPane', {
        tabKey: activeConv.tabKey,
        messageCount: activeConv.messages.length,
        actionLogCount: actionLogs.length,
        isSendingChat,
    });

    const viewStates = React.useMemo(() => getConversationViewStates(activeConv), [activeConv.status, activeConv.connectionState]);

    // The chat-bubble "Agent generating..." indicator is the
    // authoritative signal for "this session is currently generating".
    // Publish it to the shared store so the tab spinner reads the same
    // value (the user reported the two surfaces could diverge for ~25s+
    // because each computed isGenerating from its own snapshot of
    // conversation.status).
    React.useEffect(() => {
        const sessionId = activeConv.sessionId;
        if (!sessionId) return;
        publishChatTyping(sessionId, viewStates.isGenerating);
        return () => {
            // Clear our claim when this ChatPane instance unmounts (tab
            // closed, tab switched away). The next ChatPane to mount for
            // the same session re-publishes from its own viewStates.
            publishChatTyping(sessionId, false);
        };
    }, [activeConv.sessionId, viewStates.isGenerating]);
    const controlsContext = useMemo(
        () => getConversationControlsContext(activeConv, ideEntry),
        [activeConv, ideEntry],
    )
    // Phase E: the session's model / source chip.
    const launchSurface = useMemo(
        () => readSessionLaunchSurface(controlsContext.targetEntry),
        [controlsContext.targetEntry],
    )
    const visibleBarControls = useMemo(
        () => getVisibleBarControls(controlsContext.targetEntry?.providerControls, {
            hostIdeType: activeConv.hostIdeType,
            providerType: controlsContext.providerType,
        }),
        [activeConv.hostIdeType, controlsContext.providerType, controlsContext.targetEntry?.providerControls],
    )
    const defaultVisibleLiveMessages = getDefaultVisibleLiveMessages({
        isCliLike: controlsContext.isCli,
    })
    // The keyed chat lane is the pane's only live source; see
    // `buildChatPaneControllerOptions` for why panel visibility does not gate it.
    const chatState = useSessionChatController(activeConv, buildChatPaneControllerOptions({
        sessionId: activeConv.sessionId,
        isVisible,
    }))

    const [visibleLiveCount, setVisibleLiveCount] = useState(
        () => getRememberedVisibleLiveCount(activeConv.tabKey, defaultVisibleLiveMessages),
    );
    const [showActivityMessages, setShowActivityMessages] = useState(() => readChatActivityVisiblePreference());

    const tabKey = activeConv.tabKey;
    const historyMessages = chatState.historyMessages;
    const hasMoreHistory = chatState.hasMoreHistory;
    const loadError = chatState.historyError;
    // (OPTIMISTIC-USER-BUBBLE) Layer the owner's just-sent message on top of the
    // live tail so it appears immediately instead of after the daemon round trip
    // (which, on a busy agent, waits for the send queue to drain). It is retired
    // the moment a matching user bubble arrives in the tail — see
    // `withPendingLocalMessage` for the dedup contract.
    //
    // ★ Applied HERE rather than inside the controller deliberately: the
    // controller's window is the daemon's committed keyed view, and injecting a
    // client-authored row into it would be wiped by the next frame. This is a
    // render-time overlay, so the controller's contract is untouched.
    //
    // (QUEUE-PINNED-COMPOSER) PARKED bodies are excluded here and rendered by
    // `PendingQueueStrip` above the composer instead. Appending them to the tail
    // pinned them only until the agent said anything else, after which they
    // scrolled out of view along with the controls that withdraw them — and a
    // body the agent has not received does not belong in the transcript at all.
    //
    // Entries whose send is still in its round trip DO stay in the tail: the
    // instant optimistic bubble is the point, and such a send may yet resolve as
    // delivered rather than parked.
    //
    // ★ (QUEUED-SEND-STUCK-FOREVER) The DAEMON's tail, before any local bubble is
    // overlaid, is kept separate because it — and only it — is valid evidence that
    // a body was delivered. Matching echoes against the overlaid list would let a
    // pending entry match ITSELF and retire on the frame it was created.
    const daemonLiveMessages = getConversationLiveMessages(activeConv, chatState);
    // Before the keyed lane's first committed view: a neutral loading state,
    // and the typing bubble only when the status source really says
    // `generating` (see `getChatPaneFirstViewState`).
    const firstViewState = getChatPaneFirstViewState({
        status: activeConv.status,
        connectionState: activeConv.connectionState,
        hasLiveSnapshot: chatState.hasLiveSnapshot,
        visibleMessageCount: daemonLiveMessages.length,
    });
    const liveMessages = withPendingLocalMessages(
        daemonLiveMessages,
        // MULTI-QUEUE: prefer the full list; fall back to the single-entry prop
        // for callers that still pass only the newest bubble.
        pendingLocalMessages ?? (pendingLocalMessage ? [pendingLocalMessage] : null),
        undefined,
        { excludeQueued: true },
    );

    // ★ (QUEUED-SEND-STUCK-FOREVER) Hand the authoritative tail to the queue's
    // owner so an echoed body is retired from STATE — and therefore from
    // localStorage and from the pinned strip — instead of merely being skipped by
    // the render above. Before this, the transcript hid a delivered body while the
    // store kept it forever, which is what left "Waiting to send" rows pinned above
    // the composer for messages the agent had already answered.
    //
    // ★ Two triggers, because there are two ways a body stops deserving its row.
    // The TAIL moving is how a delivered body is detected. But the case that
    // produced the bug report is a session torn down while bodies were parked —
    // its transcript never moves again, so a tail-only trigger would never fire
    // and the row would stay pinned exactly as before. Hence the timer as well:
    // coarse (the threshold it enforces is minutes), only while the queue is
    // non-empty, and a no-op write unless something actually changed.
    const hasPendingEntries = (pendingLocalMessages?.length ?? 0) > 0;
    useEffect(() => {
        if (!retireEchoedPendingMessages) return;
        retireEchoedPendingMessages(daemonLiveMessages);
        if (!hasPendingEntries) return;
        const timer = setInterval(
            () => retireEchoedPendingMessages(daemonLiveMessages),
            PENDING_QUEUE_STALE_SWEEP_INTERVAL_MS,
        );
        return () => clearInterval(timer);
    }, [retireEchoedPendingMessages, daemonLiveMessages, hasPendingEntries]);
    // Only the COUNT is consumed (activity-toggle affordance), but the filter
    // classifies every live message. Memoized on `liveMessages` so it runs when
    // the tail actually changes rather than on every render of this pane.
    const activityToggleCount = useMemo(
        () => filterChatActivityMessages(liveMessages).length,
        [liveMessages],
    );

    // (CHAT-TAB-SWITCH-STALE-FALLBACK ②) Restore this tab's remembered expanded
    // window instead of collapsing to the default. Switching to a DIFFERENT tab
    // still re-reads for THAT tab's key, so a fresh session opens at its default
    // — the memory is per-tab, never carried across sessions.
    useEffect(() => {
        setVisibleLiveCount(getRememberedVisibleLiveCount(tabKey, defaultVisibleLiveMessages));
    }, [defaultVisibleLiveMessages, tabKey]);
    const hiddenLiveCount = Math.max(0, liveMessages.length - visibleLiveCount);
    const panelLabel = getConversationDisplayLabel(activeConv)
    const daemonId = getConversationDaemonRouteId(activeConv);
    const canOpenPanel = shouldShowOpenPanelAction(activeConv)
    const sendBlockMessage = getConversationSendBlockMessage(activeConv)
    const busyStatusMessage = buildBusyChatInputStatusMessage(activeConv, t)
    // The blocked state lives in the placeholder as a short one-liner — the
    // approval banner above already explains itself, and a long placeholder
    // must never wrap and grow the box. The dedicated line below the input is
    // reserved for send errors (kept visible while typing); the block reason
    // reappears there via getInlineSendFailureMessage only when a send bounces.
    const inlineStatusMessage = sendFeedbackMessage || null
    const chatInputStatusMessage = getConversationSendBlockedPlaceholder(activeConv)
        || sendFeedbackMessage
        || busyStatusMessage
    const isChatInputBlocked = !!sendBlockMessage

    const [isLoadingMore, setIsLoadingMore] = useState(false);
    useEffect(() => {
        const targetEntry = controlsContext.targetEntry;
        const needsMetadata = !!daemonId && (
            !targetEntry
            || targetEntry.providerControls === undefined
            || targetEntry.controlValues === undefined
        );

        if (!needsMetadata) return;
        void loadDaemonMetadata(daemonId, { minFreshMs: 30_000 }).catch(() => {});
    }, [
        daemonId,
        controlsContext.targetEntry?.providerControls,
        controlsContext.targetEntry?.controlValues,
        loadDaemonMetadata,
    ]);

    const handleLoadMore = useCallback(async () => {
        if (isLoadingMore) return;
        if (liveMessages.length > visibleLiveCount) {
            setVisibleLiveCount((current) => {
                const next = Math.min(liveMessages.length, current + LIVE_MESSAGE_PAGE_SIZE);
                rememberVisibleLiveCount(tabKey, next);
                return next;
            });
            return;
        }
        setIsLoadingMore(true);
        try {
            await chatState.loadHistoryPage()
        } finally {
            setIsLoadingMore(false);
        }
    }, [chatState, isLoadingMore, liveMessages.length, tabKey, visibleLiveCount]);

    const { allMessages, receivedAtMap } = useMemo(() => {
        const visibleMessages = buildVisibleConversationMessages({
            historyMessages,
            liveMessages,
            visibleLiveCount,
        });
        const gitSystemMessages = buildGitSystemBubbleMessages(activeConv);
        const allMessages = gitSystemMessages.length > 0
            ? [...visibleMessages, ...gitSystemMessages]
            : visibleMessages;
        const nextReceivedAtMap: Record<string, number> = {};
        allMessages.forEach((message, index: number) => {
            // Compute the stable key ONCE per message: it was previously derived
            // twice here (cache key + map key) for the same (message, index), and
            // the key builder hashes message content on its fallback path.
            const stableKey = getChatMessageStableKey(message, index);
            const messageKey = `${activeConv.tabKey}:${stableKey}`;
            let receivedAt = getMessageTimestamp(message) || receivedAtCache.current.get(messageKey) || 0;
            if (!receivedAt) {
                receivedAt = Date.now();
                receivedAtCache.current.set(messageKey, receivedAt);
            }
            nextReceivedAtMap[stableKey] = receivedAt;
        });
        return { allMessages, receivedAtMap: nextReceivedAtMap };
    }, [
        activeConv.tabKey,
        activeConv.sessionId,
        activeConv.status,
        activeConv.inboxBucket,
        activeConv.completionMarker,
        activeConv.lastMessageHash,
        activeConv.lastMessageAt,
        activeConv.lastUpdated,
        activeConv.workspacePath,
        activeConv.git,
        hiddenLiveCount,
        historyMessages,
        liveMessages,
        visibleLiveCount,
    ]);
    const visibleActionLogs = useMemo(
        () => actionLogs
            .filter(l => l.routeId === activeConv.tabKey)
            .sort((a, b) => a.timestamp - b.timestamp),
        [actionLogs, activeConv.tabKey],
    );

    /**
     * (TOOL-EXPAND) Per-bubble expansion state.
     *
     * The key is chosen by the list (`getToolExpandStateKey`, falling back to
     * the stable message key): a bubble carrying a `toolBlockRef` is keyed by
     * the tool BLOCK it was summarised from, so the expansion follows that
     * block rather than the bubble's rendered text. That matters on the replica
     * lane, where the stable key can fall back to a content hash and a tool
     * bubble's content is precisely what is rewritten as its result streams —
     * which used to drop the expansion mid-read. Bubbles with no ref keep the
     * stable key.
     */
    const [toolExpansions, setToolExpansions] = useState<Record<string, ToolExpandState>>({});

    // Expansions are transcript-position-specific; when the conversation changes
    // the old keys describe bubbles that are no longer on screen.
    useEffect(() => {
        setToolExpansions({});
    }, [activeConv.tabKey]);

    const handleExpandToolBlock = useCallback(async (
        messageKey: string,
        address: ToolExpandAddress,
    ) => {
        if (!daemonId) return;
        setToolExpansions(prev => ({ ...prev, [messageKey]: { status: 'loading' } }));
        try {
            // `{ toolBlockRef }` (read_chat lane) or `{ messageId }` (keyed
            // replica lane, design 2026-09-28 §5.9) — the daemon accepts either
            // and resolves a messageId through its identity ledger.
            const raw = await sendCommand(daemonId, 'expand_tool_block', {
                targetSessionId: activeConv.sessionId,
                agentType: controlsContext.providerType || activeConv.agentType,
                ...('messageId' in address ? { messageId: address.messageId } : { toolBlockRef: address.toolBlockRef }),
            });
            const body = unwrapCommandResult(raw) as {
                success?: boolean;
                toolName?: string;
                callArgs?: string;
                result?: string;
                reason?: string;
            } | null;
            // A refusal is surfaced as an error rather than an empty expansion:
            // the daemon declined to guess which block the ref now names, and
            // the UI must not imply the output was empty.
            const text = body?.success
                ? (body.callArgs !== undefined
                    ? `${body.toolName ? `${body.toolName}: ` : ''}${body.callArgs}`
                    : body.result)
                : undefined;
            setToolExpansions(prev => ({
                ...prev,
                [messageKey]: text !== undefined
                    ? { status: 'expanded', text }
                    // ★ Carry the daemon's typed reason through. It already
                    // travels on the command reply (`handleExpandToolBlock`
                    // returns `{success:false, reason}` on every refusal path);
                    // dropping it here is what made all five refusals render as
                    // one "the transcript changed" sentence, four of which were
                    // false. Validated rather than cast: an unrecognised or
                    // absent value becomes undefined and takes the generic
                    // branch, so a newer daemon cannot inject arbitrary text.
                    : { status: 'error', error: toExpandFailureReason(body?.reason) },
            }));
        } catch {
            setToolExpansions(prev => ({ ...prev, [messageKey]: { status: 'error' } }));
        }
    }, [activeConv.agentType, activeConv.sessionId, controlsContext.providerType, daemonId, sendCommand]);

    const handleCollapseToolBlock = useCallback((messageKey: string) => {
        setToolExpansions(prev => {
            if (!prev[messageKey]) return prev;
            const next = { ...prev };
            delete next[messageKey];
            return next;
        });
    }, []);

    const collectChatDebugBundle = useCallback(async () => {
        if (!daemonId) return;
        const frontendSnapshot = buildChatFrontendDebugSnapshot({
            activeConv,
            visibleMessages: allMessages,
            actionLogs,
            controls: controlsContext.targetEntry?.providerControls,
            controlValues: controlsContext.targetEntry?.controlValues,
            visibleBarControlCount: visibleBarControls.length,
            chatState: {
                liveMessages: chatState.liveMessages,
                hasLiveSnapshot: chatState.hasLiveSnapshot,
                hasMoreHistory,
                historyError: loadError,
                historyMessages,
            },
            ui: {
                controlsVisible: areControlsVisible,
                visibleLiveCount,
                activityVisible: showActivityMessages,
                activityCount: activityToggleCount,
                hiddenLiveCount,
                isInputActive,
                isVisible,
            },
        });
        const raw = await sendCommand(daemonId, 'get_chat_debug_bundle', {
            agentType: controlsContext.providerType || activeConv.agentType,
            targetSessionId: activeConv.sessionId,
            delivery: 'daemon_file',
            frontendSnapshot,
        });
        const result = unwrapCommandResult(raw);
        const text = buildChatDebugBundleClipboardText(result);
        const locatorCopyStatus = await copyChatDebugBundleTextToClipboard(text);
        if (locatorCopyStatus === 'failed') {
            console.warn('[chat-debug-bundle] failed to copy or present debug bundle locator');
        }
        eventManager.showToast(
            buildChatDebugBundleToastMessage(result, { locatorCopyStatus }),
            locatorCopyStatus === 'failed' ? 'warning' : 'success',
        );
    }, [
        activeConv,
        actionLogs,
        activityToggleCount,
        allMessages,
        areControlsVisible,
        chatState.hasLiveSnapshot,
        chatState.liveMessages,
        controlsContext.providerType,
        controlsContext.targetEntry?.controlValues,
        controlsContext.targetEntry?.providerControls,
        daemonId,
        hasMoreHistory,
        hiddenLiveCount,
        historyMessages,
        isInputActive,
        isVisible,
        loadError,
        sendCommand,
        showActivityMessages,
        visibleBarControls.length,
        visibleLiveCount,
    ]);

    // React to preference flips from the Settings toggle (same document, custom
    // event) and from other tabs (storage event).
    useEffect(() => subscribeChatActivityVisiblePreference(setShowActivityMessages), []);

    const handleActivityToggle = useCallback(() => {
        setShowActivityMessages((current) => {
            const next = !current;
            setChatActivityVisiblePreference(next);
            return next;
        });
    }, []);

    const handleControlsToggleDebugGesture = useCallback(() => {
        const result = recordControlsToggleDebugGesture(debugGestureStateRef.current);
        debugGestureStateRef.current = result.state;
        if (!result.shouldCollect) return;
        void collectChatDebugBundle().catch((error) => {
            console.warn('[chat-debug-bundle] failed to collect debug bundle', error);
            eventManager.showErrorToast(t('chatPane.debugBundleFailed'), error);
        });
    }, [collectChatDebugBundle, t]);
    const emptyState = useMemo(() => {
        if (liveMessages.length !== 0) return undefined;
        if (activeConv.connectionState === 'connecting' || activeConv.connectionState === 'new') {
            return (
                <div className="text-center mt-16 flex flex-col items-center gap-4">
                    <div className="connecting-logo-float">
                        <div style={{
                            width: 64, height: 64, borderRadius: '50%',
                            background: 'radial-gradient(circle, rgba(96,165,250,0.12), transparent 70%)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            boxShadow: '0 0 40px rgba(96,165,250,0.08)',
                        }}>
                            <img src="/otter-logo.png" alt="ADHDev" style={{ width: 40, height: 40, borderRadius: '50%', opacity: 0.85 }} />
                        </div>
                    </div>
                    <div className="flex flex-col items-center gap-1.5">
                        <div className="text-xxs text-blue-400 font-medium">{t('chatPane.connectingToMachine')}<span className="connecting-dots"></span></div>
                        <div className="text-2xs opacity-35">{t('chatPane.establishingP2P')}</div>
                    </div>
                </div>
            );
        }
        if (viewStates.isGenerating) {
            setIsLoadingMore(false);
        }
        if (activeConv.status === 'not_monitored' && canOpenPanel) {
            return (
                <div className="text-center mt-16 flex flex-col items-center gap-3">
                    <div className="text-3xl opacity-60"><IconPlug size={28} /></div>
                    <div className="text-xxs opacity-50">{t('chatPane.agentNotMonitored')}</div>
                    <button onClick={handleFocusAgent} disabled={isFocusingAgent} className="btn btn-primary">
                        {isFocusingAgent ? <span className="inline-flex items-center gap-1.5"><IconSpinner size={12} />{t('chatPane.switchingPanel')}</span> : <span className="flex items-center gap-1.5"><IconFolder size={14} /> {t('chatPane.openPanel', { label: panelLabel })}</span>}
                    </button>
                    <div className="text-2xs opacity-35 max-w-[280px]">{t('chatPane.clickToSwitchMonitoring')}</div>
                </div>
            );
        }
        if (activeConv.status === 'panel_hidden' && canOpenPanel) {
            return (
                <div className="text-center mt-16 flex flex-col items-center gap-3">
                    <div className="text-3xl opacity-60"><IconEye size={28} /></div>
                    <div className="text-xxs opacity-50">{t('chatPane.agentPanelHidden')}</div>
                    <button onClick={handleFocusAgent} disabled={isFocusingAgent} className="btn btn-primary">
                        {isFocusingAgent ? <span className="inline-flex items-center gap-1.5"><IconSpinner size={12} />{t('chatPane.openingPanel')}</span> : <span className="flex items-center gap-1.5"><IconFolder size={14} /> {t('chatPane.openPanel', { label: panelLabel })}</span>}
                    </button>
                    <div className="text-2xs opacity-35 max-w-[280px]">{t('chatPane.openPanelHint')}</div>
                </div>
            );
        }
        if (firstViewState.awaitingFirstView) {
            // The chat lane has not delivered this session's first committed
            // view yet — say so neutrally, whatever the status lane claims.
            return (
                <div className="text-center mt-16 flex flex-col items-center gap-3" data-chat-pane-state="awaiting-first-view">
                    <div className="opacity-40 animate-pulse"><IconChat size={26} /></div>
                    <div className="text-xxs opacity-40">{t('chatPane.loadingChat')}</div>
                </div>
            );
        }
        if (activeConv.status === 'idle' && !isLoadingMore) {
            // Chat tail connected and confirmed no more history — session is genuinely empty
            if (!hasMoreHistory && historyMessages.length === 0) {
                return (
                    <div className="text-center mt-16 flex flex-col items-center gap-3">
                        <div className="opacity-40"><IconChat size={26} /></div>
                        <div className="text-xxs opacity-40">{t('chatPane.noMessagesYet')}</div>
                    </div>
                );
            }
            return (
                <div className="text-center mt-16 flex flex-col items-center gap-3">
                    <div className="opacity-40 animate-pulse"><IconChat size={26} /></div>
                    <div className="text-xxs opacity-40">{t('chatPane.loadingChat')}</div>
                </div>
            );
        }
        return undefined;
    }, [activeConv.connectionState, activeConv.status, canOpenPanel, firstViewState.awaitingFirstView, handleFocusAgent, hasMoreHistory, historyMessages.length, isFocusingAgent, isLoadingMore, liveMessages.length, panelLabel, viewStates.isGenerating]);

    return (
        /* Keyed-view coverage readout — see `buildTranscriptPaneAttributes`
           for why it is a data attribute rather than visible UI. */
        <div
            className="flex-1 min-h-0 w-full flex flex-col relative"
            {...buildTranscriptPaneAttributes(chatState)}
        >
            {/* Message Stream */}
{/* Compact chat header. The Activity toggle was dropped once as noise, which
                left the visibility preference with readers but no writer — activity rows
                became permanently hidden for everyone (O5). Restored by owner decision:
                it flips the same global preference the Settings → Appearance toggle
                writes, with the live activity-row count as the affordance. */}
            <div className="chat-activity-toggle-bar">
                <button
                    type="button"
                    className={`chat-activity-toggle ${showActivityMessages ? 'chat-activity-toggle-active' : ''}`}
                    onClick={handleActivityToggle}
                    aria-pressed={showActivityMessages}
                    title={t('chatPane.activityToggleTitle')}
                >
                    <span className="chat-activity-toggle-dot" />
                    {t('chatPane.activityToggleLabel')}
                    {activityToggleCount > 0 && (
                        <span className="chat-activity-toggle-count">{activityToggleCount}</span>
                    )}
                </button>
                {/* Only present while this machine is parked. Mute and Session
                    info moved into the pane toolbar's "…" menu
                    (ConversationActionsMenu) so this row stays a single control. */}
                <div className="ml-auto flex items-center gap-1">
                    <ChatMachineReconnectButton
                        machineId={chatMachineId}
                        blocked={!!machineRetryStatus?.blocked}
                        retryConnection={daemonCtx.retryConnection}
                    />
                </div>
            </div>
            {/* When the keyed view does not reach the start of the conversation
                (`omittedBefore`), "Load older messages" below is the affordance —
                an explicit chat_history page. No banner: see
                `buildTranscriptPaneAttributes`. */}
            <ChatMessageList
                messages={allMessages}
                actionLogs={visibleActionLogs}
                agentName={getConversationProviderLabel(activeConv) || panelLabel || 'Agent'}
                userName={userName}
                isCliMode={controlsContext.isCli}
                isWorking={firstViewState.showWorkingIndicator}
                contextKey={activeConv.tabKey}
                receivedAtMap={receivedAtMap}
                lastMessageHash={activeConv.lastMessageHash}
                showActivityMessages={showActivityMessages}
                onLoadMore={handleLoadMore}
                isLoadingMore={isLoadingMore}
                hasMoreHistory={hasMoreHistory}
                hiddenLiveCount={hiddenLiveCount}
                loadError={loadError ?? undefined}
                emptyState={emptyState}
                scrollToBottomRequestNonce={scrollToBottomRequestNonce}
                isVisible={isVisible}
                onSendNow={handleSendNowQueued}
                isSendingNow={isSendingChat}
                onCancelQueued={handleCancelQueued}
                toolExpansions={toolExpansions}
                onExpandToolBlock={handleExpandToolBlock}
                onCollapseToolBlock={handleCollapseToolBlock}
            />

            {/* (QUEUE-PINNED-COMPOSER) Outside the scroll container by design: a
                body still parked in the daemon FIFO has not entered the
                conversation, so it sits with the composer it was typed into and
                stays put however far the transcript scrolls. */}
            <PendingQueueStrip
                entries={pendingLocalMessages ?? (pendingLocalMessage ? [pendingLocalMessage] : [])}
                onSendNow={handleSendNowQueued}
                onCancelQueued={handleCancelQueued}
                isSendingNow={isSendingChat}
            />

            <ChatControlsSection
                routeId={activeConv.routeId}
                sessionId={activeConv.sessionId}
                hostIdeType={activeConv.hostIdeType}
                providerType={controlsContext.providerType}
                displayLabel={controlsContext.displayLabel}
                controls={controlsContext.targetEntry?.providerControls}
                controlValues={controlsContext.targetEntry?.controlValues}
                currentStatus={activeConv.status}
                coordinatorHint={getCoordinatorRoutingHint(activeConv)}
                isActive={isInputActive}
                isCliTerminal={controlsContext.isCliTerminal}
                launchSurface={launchSurface}
            />
            {!controlsContext.isCliTerminal && (
                <ChatInputBar
                    contextKey={activeConv.tabKey}
                    panelLabel={panelLabel}
                    isSending={isSendingChat}
                    isBusy={isChatInputBlocked}
                    statusMessage={chatInputStatusMessage}
                    inlineStatusMessage={inlineStatusMessage}
                    onSend={handleSendChat}
                    isActive={isInputActive}
                    showControlsToggle={visibleBarControls.length > 0}
                    onControlsToggle={handleControlsToggleDebugGesture}
                    messageInput={activeConv.messageInput}
                />
            )}
        </div>
    );
}
