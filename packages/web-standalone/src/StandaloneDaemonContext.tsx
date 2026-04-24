/**
 * StandaloneDaemonContext — localhost WS only (no P2P)
 *
 * When daemon-standalone serves WebSocket at localhost:3847/ws,
 * this Context connects and injects data into BaseDaemonContext.
 */
import { useEffect, useRef, useState, useCallback, useMemo, type ReactNode } from 'react'
import {
    BaseDaemonProvider,
    useBaseDaemonActions,
    useBaseDaemons,
    applyRouteTarget,
    subscriptionManager,
    statusPayloadToEntries,
} from '@adhdev/web-core'
import type { ConnectionStatus } from '@adhdev/web-core'
import type { StandaloneWsStatusPayload, SubscribeRequest, TopicUpdateEnvelope, UnsubscribeRequest } from '@adhdev/daemon-core'
import { standaloneConnectionManager } from './connection-manager'

import { getStandaloneToken } from './standalone-auth-client'

// dev: vite proxy (ws://localhost:3000/ws → ws://localhost:3847/ws)
// prod: same origin (daemon-standalone serves both HTTP + WS)
function getWsUrl(): string {
    if (typeof window === 'undefined') return 'ws://localhost:3847/ws'
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const base = `${proto}://${window.location.host}/ws`
    const token = getStandaloneToken()
    return token ? `${base}?token=${encodeURIComponent(token)}` : base
}
const WS_URL = getWsUrl()
const RECONNECT_INTERVAL = 3000
const MAX_RECONNECT_INTERVAL = 30000

// Module-level WS reference for command channel
let _wsInstance: WebSocket | null = null
let _reqCounter = 0
const _pendingRequests = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>()
let _screenshotTimer: any = null
let _wsStatusChangeCallback: ((status: ConnectionStatus, daemonId?: string) => void) | null = null

function logStandaloneStatusDebug(event: string, payload: Record<string, unknown>) {
    if (typeof window === 'undefined') return
    try {
        const debugEnabled = (import.meta as any).env?.DEV || window.localStorage.getItem('adhdev_mobile_debug') === '1'
        if (!debugEnabled) return
        console.debug(`[standalone-status] ${event}`, payload)
    } catch {
        // noop
    }
}

function logStandaloneWsDebug(event: string, payload: Record<string, unknown>) {
    if (typeof window === 'undefined') return
    try {
        const debugEnabled = (import.meta as any).env?.DEV || window.localStorage.getItem('adhdev_mobile_debug') === '1'
        if (!debugEnabled) return
        console.debug(`[standalone-ws] ${event}`, payload)
    } catch {
        // noop
    }
}

function mapStandaloneConnectionState(status: ConnectionStatus): ConnectionStatus {
    return status === 'connected' ? 'connected' : status
}

/**
 * Send a command via the shared WS connection. Commands must never bypass WS.
 *
 * Returns the daemon's raw response (e.g. `{ success, controlResult, ... }`).
 * Cloud's `sendDaemonCommand` wraps the same response in `{ success, result }`,
 * so helpers in `@adhdev/web-core` that consume command responses MUST accept
 * both shapes — see TransportContext.sendCommand docs.
 */
export async function sendCommandViaWs(
    daemonId: string, command: string, data?: Record<string, unknown>
): Promise<any> {
    const route = applyRouteTarget(daemonId, data || {})
    const ws = _wsInstance
    if (ws && ws.readyState === WebSocket.OPEN) {
        const requestId = `req_${++_reqCounter}_${Date.now()}`
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                _pendingRequests.delete(requestId)
                reject(new Error(`WS command timeout: ${command}`))
            }, 30000)
            _pendingRequests.set(requestId, {
                resolve: (v) => { clearTimeout(timeout); resolve(v) },
                reject: (e) => { clearTimeout(timeout); reject(e) },
            })
            ws.send(JSON.stringify({
                type: 'command',
                requestId,
                data: { type: command, payload: route.payload },
            }))
        })
    }
    throw new Error(`WS command channel unavailable: ${command}`)
}

export function sendDataViaWs(_daemonId: string, data: SubscribeRequest | UnsubscribeRequest): boolean {
    const ws = _wsInstance
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    if (!data || (data as any).type !== 'subscribe' && (data as any).type !== 'unsubscribe') return false
    try {
        ws.send(JSON.stringify(data))
        return true
    } catch {
        return false
    }
}

export function sendPtyInputViaWs(daemonId: string, sessionId: string, data: string): boolean {
    const ws = _wsInstance
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    const route = applyRouteTarget(daemonId, { sessionId, targetSessionId: sessionId, data })
    try {
        ws.send(JSON.stringify({
            type: 'command',
            data: {
                type: 'pty_input',
                payload: route.payload,
            },
        }))
        return true
    } catch {
        return false
    }
}

/**
 * WS-based connection adapter — implements the same interface as
 * connectionManager connections so dashboard/remote flows work without platform-specific code.
 */
class WsConnectionAdapter {
    private daemonId: string
    private screenshotIdeType: string | null = null

    constructor(daemonId: string) {
        this.daemonId = daemonId
    }

    get hasCommandChannel() { return _wsInstance?.readyState === WebSocket.OPEN }
    get connectionState() { return _wsInstance?.readyState === WebSocket.OPEN ? 'connected' : 'disconnected' }

    async sendCommand(cmd: string, data: any): Promise<any> {
        return sendCommandViaWs(this.daemonId, cmd, data)
    }

    async sendInput(action: string, params: any): Promise<any> {
        return sendCommandViaWs(this.daemonId, 'cdp_remote_action', {
            action,
            params,
            ...(this.screenshotIdeType && { targetSessionId: this.screenshotIdeType }),
        })
    }

    startScreenshots(ideType?: string) {
        this.screenshotIdeType = ideType || null
        // Clear any existing timer to avoid duplicates
        if (_screenshotTimer) {
            clearInterval(_screenshotTimer)
            _screenshotTimer = null
        }
        const poll = async () => {
            if (!this.hasCommandChannel) return
            try {
                const res = await sendCommandViaWs(this.daemonId, 'screenshot', {
                    width: 1280,
                    ...(this.screenshotIdeType && { targetSessionId: this.screenshotIdeType }),
                })
                if (res?.success && res?.base64) {
                    const blob = await fetch(`data:image/jpeg;base64,${res.base64}`).then(r => r.blob())
                    standaloneConnectionManager.emitScreenshot(this.daemonId, blob)
                }
            } catch { /* silent */ }
        }
        poll()
        _screenshotTimer = setInterval(poll, 2000)
    }

    stopScreenshots(_ideType?: string) {
        if (_screenshotTimer) {
            clearInterval(_screenshotTimer)
            _screenshotTimer = null
        }
    }
}

let _wsAdapter: WsConnectionAdapter | null = null

function getOrCreateWsAdapter(daemonId: string) {
    if (!_wsAdapter || (_wsAdapter as any).daemonId !== daemonId) {
        _wsAdapter = new WsConnectionAdapter(daemonId)
    }
    return _wsAdapter
}

function StandaloneWSConnector({ children }: { children: ReactNode }) {
    const actionsRef = useRef(useBaseDaemonActions())
    // Keep ref updated without re-triggering effect
    const actions = useBaseDaemonActions()
    actionsRef.current = actions

    // userName setter from context (ref to avoid retriggering WS effect)
    const { setUserName } = useBaseDaemons()
    const setUserNameRef = useRef(setUserName)
    setUserNameRef.current = setUserName
    const daemonMetadataUnsubscribeRef = useRef<(() => void) | null>(null)
    const subscribedMetadataDaemonIdRef = useRef<string | null>(null)

    const [, setWsStatus] = useState<ConnectionStatus>('disconnected')
    // Propagate WS status to parent provider
    const updateWsStatus = useCallback((status: ConnectionStatus, daemonId?: string) => {
        setWsStatus(status)
        _wsStatusChangeCallback?.(status, daemonId)
    }, [])
    const wsRef = useRef<WebSocket | null>(null)
    const reconnectTimer = useRef<ReturnType<typeof setTimeout>>()
    const reconnectDelay = useRef(RECONNECT_INTERVAL)
    const mountedRef = useRef(true)
    const cleaningUpRef = useRef(false)
    const reconnectReasonRef = useRef<string>('initial_connect')

    useEffect(() => {
        mountedRef.current = true
        cleaningUpRef.current = false

        function connect() {
            if (!mountedRef.current) return
            if (wsRef.current?.readyState === WebSocket.OPEN ||
                wsRef.current?.readyState === WebSocket.CONNECTING) return

            updateWsStatus('connecting')
            console.log(`[Standalone WS] Connecting to ${WS_URL}...`)
            logStandaloneWsDebug('connect_attempt', {
                url: WS_URL,
                reason: reconnectReasonRef.current,
                delayMs: reconnectDelay.current,
            })

            let ws: WebSocket
            try {
                ws = new WebSocket(WS_URL)
            } catch (e) {
                console.error('[Standalone WS] Failed to create WebSocket:', e)
                scheduleReconnect()
                return
            }
            wsRef.current = ws

            ws.onopen = () => {
                if (!mountedRef.current) { ws.close(); return }
                updateWsStatus('connected')
                reconnectDelay.current = RECONNECT_INTERVAL // Reset backoff
                logStandaloneWsDebug('open', {
                    url: WS_URL,
                    reason: reconnectReasonRef.current,
                })
                subscriptionManager.resubscribeAll({ sendData: sendDataViaWs })
                console.log('[Standalone WS] Connected')
            }

            // Expose WS instance for command channel
            _wsInstance = ws

            ws.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data)

                    // Handle command responses
                    if ((msg.type === 'command_result' || msg.type === 'error') && msg.requestId) {
                        const pending = _pendingRequests.get(msg.requestId)
                        if (pending) {
                            _pendingRequests.delete(msg.requestId)
                            if (msg.type === 'error') {
                                pending.reject(new Error(msg.data?.message || 'Command failed'))
                            } else {
                                pending.resolve(msg.data)
                            }
                        }
                        return
                    }

                    if (msg.type === 'session_output') {
                        const sessionId = msg.sessionId || msg.cliId || msg.cliType
                        if (sessionId) {
                            standaloneConnectionManager.emitSessionOutput(
                                sessionId,
                                typeof msg.data === 'string' ? msg.data : '',
                                typeof msg.seq === 'number' ? msg.seq : undefined,
                            )
                        }
                        return
                    }

                    if (msg.type === 'runtime_snapshot') {
                        standaloneConnectionManager.emitRuntimeSnapshot(
                            msg.sessionId,
                            typeof msg.text === 'string' ? msg.text : '',
                            typeof msg.seq === 'number' ? msg.seq : 0,
                            !!msg.truncated,
                            typeof msg.cols === 'number' ? msg.cols : undefined,
                            typeof msg.rows === 'number' ? msg.rows : undefined,
                        )
                        return
                    }

                    if (msg.type === 'topic_update') {
                        const update = msg.update as TopicUpdateEnvelope | undefined
                        if (update) subscriptionManager.publish(update)
                        return
                    }

                    if (msg.type === 'status' || msg.type === 'initial_state') {
                        const statusData = msg.data as StandaloneWsStatusPayload
                        if (!statusData) return

                        const { injectEntries, markLoaded, getIdes } = actionsRef.current
                        const daemonId = statusData.instanceId || 'standalone'
                        const existingDaemon = getIdes().find(entry => entry.id === daemonId)

                        const adapter = getOrCreateWsAdapter(daemonId)
                        standaloneConnectionManager.register(daemonId, adapter)
                        standaloneConnectionManager.setState(daemonId, 'connected')
                        // Notify parent with daemonId so connectionStates can be updated
                        updateWsStatus('connected', daemonId)
                        standaloneConnectionManager.emitStatus(daemonId, statusData)

                        // Convert StatusResponse → DaemonData[] using shared utility
                        const entries = statusPayloadToEntries(statusData, {
                            daemonId,
                            existingDaemon,
                            existingEntries: getIdes(),
                        })

                        logStandaloneStatusDebug('ws_status', {
                            type: msg.type,
                            daemonId,
                            sessions: (statusData.sessions || []).map(session => ({
                                id: session.id,
                                parentId: session.parentId,
                                providerType: session.providerType,
                                kind: session.kind,
                                transport: session.transport,
                                unread: session.unread,
                                inboxBucket: session.inboxBucket,
                                lastSeenAt: session.lastSeenAt,
                                lastUpdated: session.lastUpdated,
                                title: session.title,
                            })),
                            recentLaunches: (((statusData as any).recentLaunches || []) as any[]).map(launch => ({
                                id: launch.id,
                                providerType: launch.providerType,
                                kind: launch.kind,
                                workspace: launch.workspace,
                                lastLaunchedAt: launch.lastLaunchedAt,
                            })),
                        })
                        logStandaloneStatusDebug('entries', {
                            daemonId,
                            entries: entries
                                .filter(entry => entry.type !== 'adhdev-daemon')
                                .map(entry => ({
                                    id: entry.id,
                                    type: entry.type,
                                    unread: entry.unread,
                                    inboxBucket: entry.inboxBucket,
                                    lastSeenAt: entry.lastSeenAt,
                                    lastUpdated: (entry as any).lastUpdated,
                                    sessionId: entry.sessionId,
                                })),
                        })

                        if (entries.length > 0) {
                            injectEntries(entries, { authoritativeDaemonIds: [daemonId] })
                        }
                        markLoaded()

                        if (subscribedMetadataDaemonIdRef.current !== daemonId) {
                            daemonMetadataUnsubscribeRef.current?.()
                            subscribedMetadataDaemonIdRef.current = daemonId
                            daemonMetadataUnsubscribeRef.current = subscriptionManager.subscribe(
                                { sendData: sendDataViaWs },
                                daemonId,
                                {
                                    type: 'subscribe',
                                    topic: 'daemon.metadata',
                                    key: `daemon:metadata:${daemonId}`,
                                    params: {
                                        includeSessions: true,
                                    },
                                },
                                (update) => {
                                    if (update.topic !== 'daemon.metadata') return
                                    const currentEntries = actionsRef.current.getIdes()
                                    const currentDaemon = currentEntries.find(entry => entry.id === daemonId)
                                    const metadataEntries = statusPayloadToEntries(update.status, {
                                        daemonId,
                                        existingDaemon: currentDaemon,
                                        existingEntries: currentEntries,
                                        timestamp: update.timestamp,
                                    })
                                    if (metadataEntries.length > 0) {
                                        actionsRef.current.injectEntries(metadataEntries)
                                    }
                                    if (update.userName && setUserNameRef.current) {
                                        setUserNameRef.current(update.userName)
                                    }
                                },
                            )
                        }
                    }
                } catch (e) {
                    console.error('[Standalone WS] Parse error:', e)
                }
            }

            ws.onclose = (event) => {
                if (!mountedRef.current) return
                _wsAdapter?.stopScreenshots()
                if (_wsAdapter) {
                    standaloneConnectionManager.setState((_wsAdapter as any).daemonId, 'disconnected')
                }
                updateWsStatus('disconnected')
                wsRef.current = null
                reconnectReasonRef.current = `close:${event.code}${event.wasClean ? ':clean' : ':unclean'}`
                logStandaloneWsDebug('close', {
                    code: event.code,
                    reason: event.reason || '',
                    wasClean: event.wasClean,
                })
                scheduleReconnect()
            }

            ws.onerror = (err) => {
                if (cleaningUpRef.current || !mountedRef.current) return
                reconnectReasonRef.current = 'error'
                logStandaloneWsDebug('error', {
                    message: err instanceof Event ? 'event' : String(err),
                    readyState: ws.readyState,
                })
                console.warn('[Standalone WS] Error, will reconnect:', err)
                // Don't close here — onclose will fire automatically
            }
        }

        function scheduleReconnect() {
            if (!mountedRef.current) return
            clearTimeout(reconnectTimer.current)
            const delay = reconnectDelay.current
            console.log(`[Standalone WS] Reconnecting in ${delay}ms...`)
            logStandaloneWsDebug('schedule_reconnect', {
                reason: reconnectReasonRef.current,
                delayMs: delay,
            })
            reconnectTimer.current = setTimeout(() => {
                // Exponential backoff
                reconnectDelay.current = Math.min(reconnectDelay.current * 1.5, MAX_RECONNECT_INTERVAL)
                connect()
            }, delay)
        }

        connect()

        return () => {
            mountedRef.current = false
            cleaningUpRef.current = true
            daemonMetadataUnsubscribeRef.current?.()
            daemonMetadataUnsubscribeRef.current = null
            subscribedMetadataDaemonIdRef.current = null
            clearTimeout(reconnectTimer.current)
            if (wsRef.current) {
                wsRef.current.onerror = null
                wsRef.current.onclose = null // Prevent reconnect on cleanup
                wsRef.current.close()
                wsRef.current = null
                _wsInstance = null
            }
            if (_wsAdapter) {
                _wsAdapter.stopScreenshots()
                standaloneConnectionManager.unregister((_wsAdapter as any).daemonId)
            }
        }
    }, []) // Empty deps — connect once

    return <>{children}</>
}

export function StandaloneDaemonProvider({ children }: { children: ReactNode }) {
    const [wsConnStatus, setWsConnStatus] = useState<ConnectionStatus>('disconnected')
    const [knownDaemonId, setKnownDaemonId] = useState<string | null>(null)

    // Register callback so StandaloneWSConnector can notify us
    useEffect(() => {
        _wsStatusChangeCallback = (status, daemonId) => {
            setWsConnStatus(status)
            if (daemonId) setKnownDaemonId(daemonId)
        }
        return () => { _wsStatusChangeCallback = null }
    }, [])

    // Build connectionOverrides — map all known daemon IDs to current WS status
    const connectionOverrides = useMemo(() => {
        const isConn = wsConnStatus === 'connected'
        const connectionState = mapStandaloneConnectionState(wsConnStatus)
        const states: Record<string, string> = {}
        if (knownDaemonId) states[knownDaemonId] = connectionState
        // Also map 'standalone' prefix so doId extraction works
        states['standalone'] = connectionState
        return {
            wsStatus: wsConnStatus,
            isConnected: isConn,
            connectionStates: states,
        }
    }, [wsConnStatus, knownDaemonId])

    return (
        <BaseDaemonProvider connectionOverrides={connectionOverrides}>
            <StandaloneWSConnector>
                {children}
            </StandaloneWSConnector>
        </BaseDaemonProvider>
    )
}
