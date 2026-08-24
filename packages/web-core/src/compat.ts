/**
 * Compatibility layer — wraps functions used by existing page code
 * with web-core abstractions. Host apps must inject real implementations;
 * missing injection should fail explicitly, not silently fall back.
 */
import { useBaseDaemons } from './context/BaseDaemonContext'
import type { BaseDaemonContextValue } from './context/BaseDaemonContext'

let _useDaemonsHook: () => BaseDaemonContextValue = useBaseDaemons

/** useDaemons() wrapper with dependency injection */
export function useDaemons() {
    return _useDaemonsHook()
}

type EventCallback = (...args: any[]) => void

/**
 * The typed contract for both injection seams below (fragmentation audit).
 * These used to be `any`, so the two hosts' real implementations drifted
 * silently: `requestRuntimeSnapshot` existed only on standalone (cloud
 * `?.`-calls no-oped), `sendData` was a hardcoded `false` on standalone, and
 * `onRuntimeEvent` grew a third `daemonId` argument only on cloud — all
 * invisible to the typechecker. Members genuinely absent on one host today
 * are OPTIONAL; call them with `?.` and handle absence. Growing a required
 * member means implementing it on BOTH hosts first.
 */
export type WebConnectionRuntimeEvent =
    | { type: 'runtime_snapshot'; sessionId: string; seq: number; text: string; truncated?: boolean; cols?: number; rows?: number; force?: boolean }
    | { type: 'session_output'; sessionId: string; seq?: number; data: string }
    | { type: 'session_cleared'; sessionId: string }

/**
 * The per-daemon connection object `get()` hands back. Both hosts return an
 * adapter with this shape (standalone: StandaloneConnectionAdapter; cloud: the
 * P2P connection wrapper); members a host may lack are optional.
 */
export interface WebConnectionAdapter {
    hasCommandChannel?: boolean
    connectionState?: string
    sendCommand?(cmd: string, data: unknown): Promise<unknown>
    sendInput(action: string, params: unknown, targetSessionId?: string): Promise<unknown>
    startScreenshots(ideTypeOrSessionId?: string): void
    stopScreenshots(ideTypeOrSessionId?: string): void
}

export interface WebConnectionManager {
    /** Connection adapter for a daemon (undefined when not connected). */
    get(daemonId: string): WebConnectionAdapter | undefined | null
    getState(daemonId: string): string
    retryConnection(daemonId: string): void
    sendPtyInput(daemonId: string, sessionId: string, data: string): boolean
    onScreenshot(key: string, callback: (sourceDaemonId: string, blob: Blob) => void): () => void
    /** Cloud sends over the DataChannel; standalone has no equivalent (hardcoded false today). */
    sendData?(daemonId: string, data: unknown): boolean
    onStatus?(callback: (sourceDaemonId: string, payload: unknown) => void): () => void
    onStateChange?(callback: (daemonId: string, state: string) => void): () => void
    /** Cloud threads `daemonId` for its subscription manager; standalone ignores it. */
    onRuntimeEvent?(sessionId: string, callback: (event: WebConnectionRuntimeEvent) => void, daemonId?: string): () => void
    /** Standalone-only today (HTTP snapshot fetch); cloud has no implementation. */
    requestRuntimeSnapshot?(daemonId: string, sessionId: string, options?: { sinceSeq?: number; force?: boolean }): Promise<{ success: true } | { success: false; error: string }>
}

export interface WebDashboardWS {
    send(data: unknown): void
    isConnected(): boolean
    on(event: string, callback: EventCallback): () => void
    emit?(event: string, ...args: any[]): void
}

/**
 * dashboardWS stub — no-op in standalone,
 * host app can inject the real WS instance.
 */
class DashboardWSStub {
    private listeners = new Map<string, Set<EventCallback>>()

    send(_data: any) { /* no-op in core */ }
    isConnected() { return false }

    on(event: string, callback: EventCallback): () => void {
        if (!this.listeners.has(event)) this.listeners.set(event, new Set())
        this.listeners.get(event)!.add(callback)
        return () => { this.listeners.get(event)?.delete(callback) }
    }

    emit(event: string, ...args: any[]) {
        this.listeners.get(event)?.forEach(cb => cb(...args))
    }
}

export let dashboardWS: WebDashboardWS = new DashboardWSStub()

/**
 * ConnectionManager stub — abstract connection interface.
 * Host app injects the real implementation.
 */
class ConnectionManagerStub {
    sendPtyInput(_daemonId: string, _sessionId: string, _data: string) { return false }
    retryConnection(_daemonId: string) {}
    getState(_daemonId: string) { return 'disconnected' as string }
    sendData(_daemonId: string, _data: any) { return false }

    /** Get connection instance for a daemon (undefined when not connected) */
    get(_daemonId: string): WebConnectionAdapter | undefined { return undefined }

    /** Screenshot callback */
    onScreenshot(_key: string, _callback: (sourceDaemonId: string, blob: Blob) => void): () => void {
        return () => {}
    }

    onRuntimeEvent(
        _sessionId: string,
        _callback: (event: WebConnectionRuntimeEvent) => void,
        _daemonId?: string,
    ): () => void {
        return () => {}
    }

    requestRuntimeSnapshot(
        _daemonId: string,
        _sessionId: string,
        _options?: { sinceSeq?: number; force?: boolean },
    ): Promise<{ success: true } | { success: false; error: string }> {
        return Promise.resolve({ success: false, error: 'Connection manager not configured; host app must inject requestRuntimeSnapshot' })
    }
}

export let connectionManager: WebConnectionManager = new ConnectionManagerStub()

/** Inject real implementations from the host app */
export function setupCompat(deps: { dashboardWS?: WebDashboardWS; connectionManager?: WebConnectionManager; useDaemonsHook?: () => BaseDaemonContextValue }) {
    if (deps.dashboardWS) dashboardWS = deps.dashboardWS
    if (deps.connectionManager) connectionManager = deps.connectionManager
    if (deps.useDaemonsHook) _useDaemonsHook = deps.useDaemonsHook
}
