// @vitest-environment jsdom
/**
 * ★ STUCK-GENERATING-NEW-SESSION: a freshly launched session's pane showed
 * "Waiting for messages…" + "Agent generating…" forever although the session
 * went idle ~8 s after start; a reload rendered it correctly.
 *
 * The daemon was right on every lane. This replays the live frame sequence
 * (standalone, session 5ea123b8…, captured 2026-09-29) through the REAL code:
 *
 *   daemon.metadata snapshot → delta: session added `starting` → pane mounts
 *   → keyed chat SNAP (meta starting, 0 bubbles) → chat frame (meta idle, 0 bubbles)
 *   → daemon.metadata delta: that session `idle` (partial row)
 *
 * SubscriptionManager fold → statusPayloadToEntries → reconcileIdes →
 * buildConversations → PaneGroupContent → the status ChatPane receives; the
 * keyed frames go TranscriptViewMirror → applyTranscriptViewToControllers →
 * the controller snapshot ChatPane reads.
 *
 * Root cause: a second status lane. PaneGroupContent laid the `session.modal`
 * topic's status over the conversation, and that topic was only pushed on
 * modal / prompt / command edges — never on a plain status transition — so a
 * pane mounted at launch kept its subscribe answer (`starting`) forever after
 * daemon.metadata had delivered idle. The topic is removed: status, the
 * approval modal and the interactive prompt ride ONE lane, the session row in
 * daemon.metadata. These tests pin that the pane follows that lane alone.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActiveConversation } from '../../../src/components/dashboard/types'
import type { DaemonData } from '../../../src/types'
import type { TranscriptBridgeFrameMessage, TranscriptViewMeta } from '../../../src/transcript-transport/bridge-protocol'

const DAEMON = 'standalone_mach_bb6980e431ad45a8bdff1c289e91ee48'
const SESSION = '5ea123b8-63ee-474d-a9ed-01bce03d0a98'
const OTHER = '00947959-daff-436e-b65b-bab377e95df0'
const META_KEY = `daemon:metadata:${DAEMON}`

// The daemon side of the page's subscriptions, as the pre-fix daemon behaved:
// a `session.modal` subscribe (the retired second lane) was answered ONCE with
// the session's status at that moment and never again for a plain status
// transition. Answers are delivered after the render that subscribed.
const pendingDaemonAnswers: unknown[] = []
let sessionStatusAtDaemon = 'starting'
const sendData = vi.fn((_daemonId: string, data: unknown) => {
    const request = data as { type?: string; topic?: string; key?: string; params?: { targetSessionId?: string } }
    if (request?.type === 'subscribe' && request.topic === 'session.modal') {
        pendingDaemonAnswers.push({
            topic: 'session.modal', key: request.key, sessionId: request.params?.targetSessionId,
            status: sessionStatusAtDaemon, title: 'keyed-live', seq: 1, timestamp: 1790675261250,
        })
    }
    return true
})
vi.mock('../../../src/context/TransportContext', () => ({
    useTransport: () => ({ sendData, isConnected: () => true }),
}))

// What the pane was handed. ChatPane itself is stubbed: everything it renders
// for an empty pane is a pure function of (activeConv.status, controller
// snapshot) — `paneState` below replays that decision with the real helper.
let lastPaneConv: ActiveConversation | null = null
vi.mock('../../../src/components/dashboard/ChatPane', () => ({
    default: (props: { activeConv: ActiveConversation }) => {
        lastPaneConv = props.activeConv
        return null
    },
}))
vi.mock('../../../src/components/dashboard/CliTerminalPane', () => ({ default: () => null }))
vi.mock('../../../src/components/dashboard/ApprovalBanner', () => ({ default: () => null }))

const { default: PaneGroupContent } = await import('../../../src/components/dashboard/PaneGroupContent')
const { subscriptionManager } = await import('../../../src/managers/SubscriptionManager')
const { statusPayloadToEntries } = await import('../../../src/utils/status-transform')
const { reconcileIdes } = await import('../../../src/context/ides-reconcile')
const { buildConversations } = await import('../../../src/components/dashboard/buildConversations')
const { getChatPaneFirstViewState } = await import('../../../src/components/dashboard/DashboardMobileChatShared')
const {
    applyTranscriptViewToControllers,
    getOrCreateSessionChatController,
    resetSessionChatControllersForTest,
} = await import('../../../src/components/dashboard/session-chat-controller')
const { TranscriptViewMirror } = await import('../../../src/transcript-transport/transcript-view-mirror')

function sessionRow(id: string, status: string, lastUpdated: number, extra: Record<string, unknown> = {}) {
    return {
        id,
        parentId: null,
        providerType: 'claude-cli',
        providerName: 'Claude Code',
        kind: 'agent',
        transport: 'pty',
        status,
        title: 'keyed-live',
        workspace: '/tmp/keyed-live',
        mode: 'chat',
        activeChat: { id: `prov-${id}`, title: 'keyed-live', status, activeModal: null, activeInteractivePrompt: null },
        activeInteractivePrompt: null,
        capabilities: ['read_chat', 'send_message', 'resolve_action'],
        lastUpdated,
        surfaceHidden: false,
        muted: false,
        lastSeenAt: 0,
        unread: false,
        inboxBucket: status === 'idle' ? 'idle' : 'working',
        completionMarker: '',
        seenCompletionMarker: '',
        ...extra,
    }
}

function metadataSnapshot() {
    return {
        topic: 'daemon.metadata', key: META_KEY, mode: 'snapshot', wireVersion: 2, daemonId: DAEMON, seq: 1, timestamp: 1790675259500,
        status: {
            instanceId: DAEMON,
            timestamp: 1790675259500,
            machine: { hostname: 'h', platform: 'darwin' },
            sessions: [sessionRow(OTHER, 'idle', 1790675200000)],
        },
    }
}

function metadataDelta(seq: number, timestamp: number, delta: Record<string, unknown>) {
    return { topic: 'daemon.metadata', key: META_KEY, mode: 'delta', daemonId: DAEMON, seq, timestamp, delta }
}

/** A partial row as the daemon diffs it: a status change moves `activeChat.status` with it. */
function statusChange(status: string, lastUpdated: number, extra: Record<string, unknown> = {}) {
    return {
        id: SESSION,
        status,
        activeChat: { id: `prov-${SESSION}`, title: 'keyed-live', status, activeModal: null, activeInteractivePrompt: null },
        inboxBucket: status === 'idle' ? 'idle' : 'working',
        lastUpdated,
        ...extra,
    }
}

function chatMeta(status: string, frame: number, extra: Partial<TranscriptViewMeta> = {}): TranscriptViewMeta {
    return {
        schemaVersion: 2, sessionId: SESSION, historySessionId: null, providerType: 'claude-cli', providerSessionId: null,
        producerDaemonId: DAEMON, producerWriterId: 'w1', epoch: 'e1', frame, observedAt: 'now', status,
        providerObservedStatus: null, title: null, activeModal: null, activeInteractivePrompt: null, turn: null,
        provenance: { messageSource: 'native-history', transcriptProvenance: null }, terminalMarkers: [],
        coverage: { mode: 'full', omittedBefore: false, totalMessageCount: 0, returnedMessageCount: 0 },
        ...extra,
    }
}

function chatFrame(partial: Partial<TranscriptBridgeFrameMessage>): TranscriptBridgeFrameMessage {
    return { kind: 'transcript-bridge-frame', sessionId: SESSION, epoch: 'e1', frame: 1, reset: false, upserts: [], deletes: [], meta: null, ...partial }
}

let ides: DaemonData[] = []
let unsubscribeMetadata: (() => void) | null = null
let container: HTMLDivElement
let root: Root
const mirror = new TranscriptViewMirror()

function conversation(): ActiveConversation {
    const conv = buildConversations(ides, ides, { [DAEMON]: 'connected' }).find((c) => c.sessionId === SESSION)
    if (!conv) throw new Error('session conversation missing')
    return conv
}

const commands = {
    handleModalButton: vi.fn(), handleRelaunch: vi.fn(), handleSendChat: vi.fn(), handleSendNowQueued: vi.fn(),
    handleCancelQueued: vi.fn(), isSendingChat: false, sendFeedbackMessage: null, pendingLocalMessage: null,
    pendingLocalMessages: [], retireEchoedPendingMessages: vi.fn(), handleFocusAgent: vi.fn(), isFocusingAgent: false,
}

function renderPane() {
    act(() => {
        root.render(createElement(PaneGroupContent, {
            activeConv: conversation(),
            clearToken: 0,
            isCliTerminal: false,
            terminalRef: { current: null },
            commands,
            actionLogs: [],
            isVisible: true,
        } as never))
    })
    while (pendingDaemonAnswers.length > 0) {
        const answer = pendingDaemonAnswers.shift()
        act(() => {
            subscriptionManager.publish(answer as never)
        })
    }
}

function publishMetadata(frame: unknown) {
    act(() => {
        subscriptionManager.publish(frame as never)
    })
    // The dashboard re-renders the pane with the rebuilt conversation.
    renderPane()
}

function applyChat(frame: TranscriptBridgeFrameMessage) {
    const applied = mirror.apply(frame)
    if (!applied) throw new Error('chat frame not applicable')
    act(() => {
        applyTranscriptViewToControllers(DAEMON, SESSION, applied.view)
    })
}

/** ChatPane's own empty-pane decision, replayed with the real first-view helper. */
function paneState() {
    const conv = lastPaneConv!
    const snapshot = controller.getSnapshot()
    const first = getChatPaneFirstViewState({
        status: conv.status,
        connectionState: conv.connectionState,
        hasLiveSnapshot: snapshot.hasLiveSnapshot,
        visibleMessageCount: snapshot.liveMessages.length,
    })
    return {
        status: conv.status,
        awaitingFirstView: first.awaitingFirstView,
        workingIndicator: first.showWorkingIndicator,
        // ChatPane: past the first view, `status === 'idle'` + no history = "No messages yet".
        noMessagesYet: !first.awaitingFirstView && conv.status === 'idle' && snapshot.liveMessages.length === 0,
        modalButtons: conv.modalButtons,
    }
}

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let controller: ReturnType<typeof getOrCreateSessionChatController>

beforeEach(() => {
    resetSessionChatControllersForTest()
    mirror.clear()
    ides = []
    lastPaneConv = null
    pendingDaemonAnswers.length = 0
    sessionStatusAtDaemon = 'starting'
    sendData.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    unsubscribeMetadata = subscriptionManager.subscribe(
        { sendData },
        DAEMON,
        { type: 'subscribe', topic: 'daemon.metadata', key: META_KEY, params: { includeSessions: true } } as never,
        (update: any) => {
            const entries = statusPayloadToEntries(update.status, {
                daemonId: DAEMON,
                existingDaemon: ides.find((entry) => entry.id === DAEMON),
                existingEntries: ides,
                timestamp: update.timestamp,
            })
            ides = ides.length === 0 ? entries : reconcileIdes(entries, ides, { authoritativeDaemonIds: [DAEMON] })
        },
    )
    controller = getOrCreateSessionChatController({ sendData, daemonId: DAEMON, sessionId: SESSION })
    controller.retain()
})

afterEach(() => {
    act(() => root.unmount())
    container.remove()
    unsubscribeMetadata?.()
    unsubscribeMetadata = null
    resetSessionChatControllersForTest()
})

/** Every topic the page asked a daemon for — the pane must add none beyond daemon.metadata. */
function subscribedTopics(): string[] {
    return sendData.mock.calls
        .map(([, data]) => data as { type?: string; topic?: string })
        .filter((data) => data?.type === 'subscribe')
        .map((data) => String(data.topic))
}

/** Snapshot → session added `starting` → pane mounts. */
function launchNewSession() {
    act(() => {
        subscriptionManager.publish(metadataSnapshot() as never)
    })
    act(() => {
        subscriptionManager.publish(metadataDelta(2, 1790675261161, {
            collections: { 'status.sessions': { upsert: [sessionRow(SESSION, 'starting', 1790675261152)], order: [OTHER, SESSION] } },
        }) as never)
    })
    renderPane()
}

describe('★ new session: a status change with unchanged (empty) messages reaches the pane', () => {
    it('replays the live launch: starting → idle clears the working indicator and shows the empty idle state', () => {
        launchNewSession()
        expect(paneState()).toMatchObject({ status: 'starting', awaitingFirstView: true, workingIndicator: false })

        applyChat(chatFrame({ reset: true, frame: 1, meta: chatMeta('starting', 1) }))
        // Past the first view, a `starting` session reads as working.
        expect(paneState()).toMatchObject({ status: 'starting', awaitingFirstView: false, workingIndicator: true })

        applyChat(chatFrame({ frame: 2, meta: chatMeta('idle', 2) }))
        publishMetadata(metadataDelta(3, 1790675269306, {
            collections: { 'status.sessions': { upsert: [{
                id: SESSION,
                status: 'idle',
                activeChat: { id: `prov-${SESSION}`, title: 'keyed-live', status: 'idle', activeModal: null, activeInteractivePrompt: null },
                inboxBucket: 'idle',
                lastUpdated: 1790675269296,
            }] } },
        }))

        expect(conversation().status).toBe('idle')
        expect(paneState()).toMatchObject({
            status: 'idle',
            awaitingFirstView: false,
            workingIndicator: false,
            noMessagesYet: true,
        })
        // One lane: the pane subscribed to nothing but daemon.metadata.
        expect(subscribedTopics()).toEqual(['daemon.metadata'])
    })

    it('generating → idle with an unchanged transcript clears the indicator', () => {
        launchNewSession()
        applyChat(chatFrame({
            reset: true,
            frame: 1,
            meta: chatMeta('generating', 1),
            upserts: [{
                messageId: 'm1', ord: 'a0', rev: 1, role: 'user', kind: 'standard', content: 'hi', receivedAt: 1790675262000,
                timestamp: null, turnKey: 't1', bubbleState: 'final', senderName: null, toolName: null, streaming: null,
                expandable: false, srcId: null,
            }],
        }))
        publishMetadata(metadataDelta(3, 1790675262110, {
            collections: { 'status.sessions': { upsert: [statusChange('generating', 1790675262105)] } },
        }))
        expect(paneState()).toMatchObject({ status: 'generating', workingIndicator: true })

        const before = controller.getSnapshot().liveMessages
        applyChat(chatFrame({ frame: 2, meta: chatMeta('idle', 2) }))
        expect(controller.getSnapshot().liveMessages).toBe(before)
        publishMetadata(metadataDelta(4, 1790675270000, {
            collections: { 'status.sessions': { upsert: [statusChange('idle', 1790675269990)] } },
        }))
        expect(paneState()).toMatchObject({ status: 'idle', workingIndicator: false })
    })

    it('a modal appearing and clearing reaches the pane through daemon.metadata alone', () => {
        launchNewSession()
        applyChat(chatFrame({ reset: true, frame: 1, meta: chatMeta('idle', 1) }))
        publishMetadata(metadataDelta(3, 1790675270000, {
            collections: { 'status.sessions': { upsert: [{
                id: SESSION,
                status: 'waiting_approval',
                activeChat: { id: `prov-${SESSION}`, title: 'keyed-live', status: 'waiting_approval', activeModal: { message: 'Run rm -rf build/?', buttons: ['Yes', 'No'] }, activeInteractivePrompt: null },
                lastUpdated: 1790675269990,
            }] } },
        }))
        expect(paneState()).toMatchObject({ status: 'waiting_approval', modalButtons: ['Yes', 'No'] })
        expect(lastPaneConv!.modalMessage).toBe('Run rm -rf build/?')

        publishMetadata(metadataDelta(4, 1790675275000, {
            collections: { 'status.sessions': { upsert: [{
                id: SESSION,
                status: 'idle',
                activeChat: { id: `prov-${SESSION}`, title: 'keyed-live', status: 'idle', activeModal: null, activeInteractivePrompt: null },
                lastUpdated: 1790675274990,
            }] } },
        }))
        expect(paneState()).toMatchObject({ status: 'idle', workingIndicator: false, modalButtons: undefined })
    })
})
