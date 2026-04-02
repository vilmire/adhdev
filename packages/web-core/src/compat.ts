/**
 * Compatibility layer — wraps functions used by existing page code
 * with web-core abstractions. Supports gradual migration.
 */
import { useBaseDaemons } from './context/BaseDaemonContext'

let _useDaemonsHook: any = useBaseDaemons

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

type PtyOutputCallback = (cliId: string, data: string, meta?: { scrollback?: boolean }) => void

/**
 * ConnectionManager stub — abstract connection interface.
 * Host app injects the real implementation.
 */
class ConnectionManagerStub {
    private ptyCallbacks = new Set<PtyOutputCallback>()

    sendPtyInput(_daemonId: string, _cliId: string, _data: string) { return false }
    sendPtyResize(_daemonId: string, _cliId: string, _cols: number, _rows: number) { return false }
    retryConnection(_daemonId: string) {}
    getState(_daemonId: string) { return 'disconnected' as string }
    sendData(_daemonId: string, _data: any) { return false }

    /** Get connection instance for a daemon (undefined when not connected) */
    get(_daemonId: string): any { return undefined }

    /** Screenshot callback */
    onScreenshot(_key: string, _callback: (sourceDaemonId: string, blob: Blob) => void): () => void {
        return () => {}
    }

    onPtyOutput(callback: PtyOutputCallback): () => void {
        this.ptyCallbacks.add(callback)
        return () => { this.ptyCallbacks.delete(callback) }
    }

    emitPtyOutput(cliId: string, data: string, meta?: { scrollback?: boolean }) {
        this.ptyCallbacks.forEach(cb => cb(cliId, data, meta))
    }

    onRuntimeEvent(
        _sessionId: string,
        _callback: (event: { type: string; sessionId: string; seq?: number; text?: string; data?: string; truncated?: boolean }) => void,
    ): () => void {
        return () => {}
    }

    requestRuntimeSnapshot(_daemonId: string, _sessionId: string): Promise<void> {
        return Promise.resolve()
    }
}

export let connectionManager: any = new ConnectionManagerStub()

/** Inject real implementations from the host app */
export function setupCompat(deps: { dashboardWS?: any; connectionManager?: any; useDaemonsHook?: any }) {
    if (deps.dashboardWS) dashboardWS = deps.dashboardWS
    if (deps.connectionManager) connectionManager = deps.connectionManager
    if (deps.useDaemonsHook) _useDaemonsHook = deps.useDaemonsHook
}
