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
    statusPayloadToEntries,
} from '@adhdev/web-core'
import type { ConnectionStatus } from '@adhdev/web-core'
import type { StatusResponse } from '@adhdev/daemon-core'
import { standaloneConnectionManager } from './connection-manager'

// dev: vite proxy (ws://localhost:3000/ws → ws://localhost:3847/ws)
// prod: same origin (daemon-standalone serves both HTTP + WS)
function getWsUrl(): string {
    if (typeof window === 'undefined') return 'ws://localhost:3847/ws'
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const base = `${proto}://${window.location.host}/ws`
    // Pass token from URL if present (e.g. ?token=abc123)
    const params = new URLSearchParams(window.location.search)
    const token = params.get('token')
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

function resolveCommandRoute(routeId: string, payload: Record<string, unknown> = {}) {
    const parts = routeId.split(':')
    if (parts.length >= 3 && (parts[1] === 'ide' || parts[1] === 'cli' || parts[1] === 'acp')) {
        return {
            daemonId: parts[0],
            payload: {
                ...payload,
                targetSessionId: payload.targetSessionId || parts.slice(2).join(':'),
            },
        }
    }
    return { daemonId: routeId, payload }
}

/** Send a command via the shared WS connection. Falls back to HTTP if WS unavailable. */
export async function sendCommandViaWs(
    daemonId: string, command: string, data?: Record<string, unknown>
): Promise<any> {
    const route = resolveCommandRoute(daemonId, data || {})
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
    // Fallback to HTTP if WS not connected
    const res = await fetch('/api/v1/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: command, payload: route.payload }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
}

/**
 * WS-based connection adapter — implements the same interface as
 * connectionManager connections so IDE.tsx works without any code changes.
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

    useEffect(() => {
        mountedRef.current = true

        function connect() {
            if (!mountedRef.current) return
            if (wsRef.current?.readyState === WebSocket.OPEN ||
                wsRef.current?.readyState === WebSocket.CONNECTING) return

            updateWsStatus('connecting')
            console.log(`[Standalone WS] Connecting to ${WS_URL}...`)

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

                    if (msg.type === 'pty_output') {
                        standaloneConnectionManager.emitPtyOutput(msg.cliId, msg.data)
                        return
                    }

                    if (msg.type === 'status' || msg.type === 'initial_state') {
                        const statusData = msg.data as StatusResponse
                        if (!statusData) return

                        const { injectEntries, markLoaded } = actionsRef.current
                        const daemonId = statusData.id || 'standalone'

                        const adapter = getOrCreateWsAdapter(daemonId)
                        standaloneConnectionManager.register(daemonId, adapter)
                        standaloneConnectionManager.setState(daemonId, 'connected')
                        // Notify parent with daemonId so connectionStates can be updated
                        updateWsStatus('connected', daemonId)
                        standaloneConnectionManager.emitStatus(daemonId, statusData)

                        // Convert StatusResponse → DaemonData[] using shared utility
                        const entries = statusPayloadToEntries(statusData, { daemonId })

                        if (entries.length > 0) injectEntries(entries)
                        markLoaded()

                        // Inject userName from daemon config
                        if (statusData.userName && setUserNameRef.current) {
                            setUserNameRef.current(statusData.userName)
                        }
                    }
                } catch (e) {
                    console.error('[Standalone WS] Parse error:', e)
                }
            }

            ws.onclose = () => {
                if (!mountedRef.current) return
                if (_wsAdapter) {
                    standaloneConnectionManager.setState((_wsAdapter as any).daemonId, 'disconnected')
                }
                updateWsStatus('disconnected')
                wsRef.current = null
                scheduleReconnect()
            }

            ws.onerror = (err) => {
                console.warn('[Standalone WS] Error, will reconnect:', err)
                // Don't close here — onclose will fire automatically
            }
        }

        function scheduleReconnect() {
            if (!mountedRef.current) return
            clearTimeout(reconnectTimer.current)
            const delay = reconnectDelay.current
            console.log(`[Standalone WS] Reconnecting in ${delay}ms...`)
            reconnectTimer.current = setTimeout(() => {
                // Exponential backoff
                reconnectDelay.current = Math.min(reconnectDelay.current * 1.5, MAX_RECONNECT_INTERVAL)
                connect()
            }, delay)
        }

        connect()

        return () => {
            mountedRef.current = false
            clearTimeout(reconnectTimer.current)
            if (wsRef.current) {
                wsRef.current.onclose = null // Prevent reconnect on cleanup
                wsRef.current.close()
                wsRef.current = null
                _wsInstance = null
            }
            if (_wsAdapter) {
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
        const states: Record<string, string> = {}
        if (knownDaemonId) states[knownDaemonId] = isConn ? 'connected' : 'connecting'
        // Also map 'standalone' prefix so doId extraction works
        states['standalone'] = isConn ? 'connected' : 'connecting'
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
