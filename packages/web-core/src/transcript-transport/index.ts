/**
 * Public surface of the transcript worker transport — the dashboard's only
 * live chat lane (design 2026-09-28 §5.4, §6.4). Always on: there is no build
 * flag; the web-cloud and web-standalone assemblies start it unconditionally.
 *
 * `transcript-worker-entry.ts` (the real browser Worker global-scope script)
 * is intentionally NOT re-exported here — it is loaded as a Worker module
 * URL (`new Worker(new URL('./transcript-worker-entry.js', import.meta.url))`),
 * never imported as a value.
 */
export {
    assertBrowserSafeFinalityPolicy,
    browserRejectAuthority,
    guardBrowserSafeDefineTopic,
    isBrowserSafeFinalityPolicy,
    type BrowserSafeDefineTopicTarget,
} from './browser-reject-authority.js';
export {
    isTranscriptBridgeBaseRequestMessage,
    isTranscriptBridgeControlEvent,
    isTranscriptBridgeFrameMessage,
    isTranscriptSessionActivation,
    transcriptBridgeBaseRequestMessage,
    transcriptBridgeControlEvent,
    transcriptBridgeFrameMessage,
    transcriptSessionActivation,
    type TranscriptBridgeBaseRequestMessage,
    type TranscriptBridgeControlEvent,
    type TranscriptBridgeControlEventName,
    type TranscriptBridgeFrameMessage,
    type TranscriptSessionActivation,
    type TranscriptViewMeta,
} from './bridge-protocol.js';
export {
    BASE_REQUEST_AFTER,
    subscribeSessionChat,
    type TranscriptSessionSubscriptionHandle,
    type TranscriptSessionSubscriptionOptions,
} from './transcript-session-subscription.js';
export {
    TranscriptViewMirror,
    compareTranscriptOrd,
    type TranscriptSessionView,
} from './transcript-view-mirror.js';
export {
    runTranscriptWorkerSession,
    type TranscriptWorkerSessionHandle,
    type TranscriptWorkerSessionOptions,
    type TranscriptWorkerSessionPort,
} from './transcript-worker-session.js';
export { workerPortChannel, type MessagePortLike, type WorkerPortChannel } from './message-port-channel.js';
export {
    DEFAULT_RTC_PRE_OPEN_CAP,
    rtcDataChannelTransport,
    type RtcDataChannelLike,
    type RtcDataChannelTransportOptions,
    type RtcTransportHandle,
} from './rtc-data-channel-transport.js';
export {
    SEQSCRIBE_DATA_CHANNEL_LABEL,
    SEQSCRIBE_SESSION_INTEREST_TYPE,
    sessionInterestFrame,
    type SessionInterestFrame,
} from './session-interest-protocol.js';
export {
    MAX_TRANSCRIPT_TOPICS_AVAILABLE,
    TRANSCRIPT_TOPICS_AVAILABLE_TYPE,
    parseTranscriptTopicsAvailable,
    sessionsToResubscribeOnAvailable,
} from './topic-availability.js';
export {
    bridgeTranscriptTransport,
    type BridgeOverflowReason,
    type MainThreadBridgeHandle,
    type MainThreadBridgeOptions,
    type MainThreadBridgePortLike,
} from './main-thread-bridge.js';
export {
    startTranscriptWorkerHost,
    type TranscriptMessageChannelLike,
    type TranscriptWorkerHostHandle,
    type TranscriptWorkerHostOptions,
    type TranscriptWorkerLike,
} from './transcript-worker-host.js';
export {
    ADHDEV_AUTHORITY_ID,
    CHAT_TOMBSTONE_KIND,
    safeSessionId,
    sessionChatPolicy,
    sessionChatTopic,
} from './topic-addressing.js';
export {
    TranscriptWorkerNode,
    type TranscriptWorkerAttachOptions,
    type TranscriptWorkerNodeEnv,
    type TranscriptWorkerNodeStats,
    type TranscriptWorkerStorage,
    type TranscriptWorkerSubscribeOptions,
} from './transcript-worker-node.js';
