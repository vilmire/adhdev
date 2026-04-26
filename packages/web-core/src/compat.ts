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

export let dashboardWS: any = new DashboardWSStub()

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
    get(_daemonId: string): any { return undefined }

    /** Screenshot callback */
    onScreenshot(_key: string, _callback: (sourceDaemonId: string, blob: Blob) => void): () => void {
        return () => {}
    }

    onRuntimeEvent(
        _sessionId: string,
        _callback: (event: { type: string; sessionId: string; seq?: number; text?: string; data?: string; truncated?: boolean; cols?: number; rows?: number; force?: boolean }) => void,
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

export let connectionManager: any = new ConnectionManagerStub()

/** Inject real implementations from the host app */
export function setupCompat(deps: { dashboardWS?: any; connectionManager?: any; useDaemonsHook?: () => BaseDaemonContextValue }) {
    if (deps.dashboardWS) dashboardWS = deps.dashboardWS
    if (deps.connectionManager) connectionManager = deps.connectionManager
    if (deps.useDaemonsHook) _useDaemonsHook = deps.useDaemonsHook
}
