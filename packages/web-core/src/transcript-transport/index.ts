/**
 * Public surface of the Phase 3 worker transport foundation (design §3.6,
 * §8 unit 4). Consumer cutover (§8 units 5+) builds ON these primitives; it
 * does not live here yet.
 *
 * `transcript-worker-entry.ts` (the real browser Worker global-scope script)
 * is intentionally NOT re-exported here — it is loaded as a Worker module
 * URL (`new Worker(new URL('./transcript-worker-entry.js', import.meta.url))`),
 * never imported as a value.
 */
export {
    assertRingOnlyPolicy,
    browserRejectAuthority,
    guardRingOnlyDefineTopic,
    isRingOnlyPolicy,
    type RingOnlyDefineTopicTarget,
} from './browser-reject-authority.js';
export {
    isTranscriptBridgeControlEvent,
    isTranscriptBridgeSnapshotMessage,
    isTranscriptSessionActivation,
    transcriptBridgeControlEvent,
    transcriptBridgeSnapshotMessage,
    transcriptSessionActivation,
    type TranscriptBridgeControlEvent,
    type TranscriptBridgeControlEventName,
    type TranscriptBridgeSnapshotMessage,
    type TranscriptSessionActivation,
} from './bridge-protocol.js';
export {
    subscribeSessionTranscript,
    type TranscriptSessionSubscriptionHandle,
    type TranscriptSessionSubscriptionOptions,
    type TranscriptSessionUpdate,
} from './transcript-session-subscription.js';
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
    SESSION_TRANSCRIPT_RING,
    safeSessionId,
    sessionTranscriptPolicy,
    sessionTranscriptTopic,
} from './topic-addressing.js';
export { isTranscriptWorkerEnabled, type TranscriptFlagEnv } from './web-transcript-flag.js';
export {
    TranscriptWorkerNode,
    type TranscriptWorkerAttachOptions,
    type TranscriptWorkerNodeEnv,
    type TranscriptWorkerNodeStats,
    type TranscriptWorkerStorage,
    type TranscriptWorkerSubscribeOptions,
} from './transcript-worker-node.js';
