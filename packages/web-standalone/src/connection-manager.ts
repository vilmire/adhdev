import type { ConnectionStatus } from '@adhdev/web-core'

export interface StandaloneConnectionAdapter {
    hasCommandChannel: boolean
    connectionState: string
    sendCommand(cmd: string, data: any): Promise<any>
    sendInput(action: string, params: any): Promise<any>
    startScreenshots(ideType?: string): void
    stopScreenshots(ideType?: string): void
}

type PtyOutputCallback = (cliId: string, data: string, meta?: { scrollback?: boolean }) => void
type ScreenshotCallback = (sourceDaemonId: string, blob: Blob) => void
type StatusCallback = (sourceDaemonId: string, payload: any) => void
type RuntimeEvent =
    | { type: 'runtime_snapshot'; sessionId: string; seq: number; text: string; truncated?: boolean }
    | { type: 'session_output'; sessionId: string; seq: number; data: string }
    | { type: 'session_cleared'; sessionId: string }

class StandaloneConnectionManager {
    private adapters = new Map<string, StandaloneConnectionAdapter>()
    private states = new Map<string, string>()
    private ptyCallbacks = new Set<PtyOutputCallback>()
    private runtimeListeners = new Map<string, Set<(event: RuntimeEvent) => void>>()
    private runtimeBuffers = new Map<string, string>()
    private runtimeSeqs = new Map<string, number>()
    private screenshotCallbacks = new Map<string, ScreenshotCallback>()
    private statusCallbacks = new Set<StatusCallback>()

    private resolveDaemonId(id: string): string | null {
        if (this.adapters.has(id)) return id
        if (id.startsWith('standalone')) {
            for (const daemonId of this.adapters.keys()) {
                if (daemonId.startsWith('standalone')) return daemonId
            }
        }
        return null
    }

    register(daemonId: string, adapter: StandaloneConnectionAdapter): void {
        this.adapters.set(daemonId, adapter)
        this.states.set(daemonId, adapter.connectionState)
    }

    unregister(daemonId: string): void {
        this.adapters.delete(daemonId)
        this.states.delete(daemonId)
    }

    setState(daemonId: string, state: ConnectionStatus | string): void {
        this.states.set(daemonId, state)
    }

    retryConnection(_daemonId: string): void {}

    get(daemonId: string): StandaloneConnectionAdapter | undefined {
        const resolved = this.resolveDaemonId(daemonId)
        return resolved ? this.adapters.get(resolved) : undefined
    }

    getState(daemonId: string): string {
        const resolved = this.resolveDaemonId(daemonId)
        return resolved ? (this.states.get(resolved) || 'disconnected') : 'disconnected'
    }

    sendData(_daemonId: string, _data: any): boolean { return false }
    sendPtyInput(_daemonId: string, _cliId: string, _data: string): boolean { return false }
    sendPtyResize(_daemonId: string, _cliId: string, _cols: number, _rows: number): boolean { return false }

    onScreenshot(key: string, callback: ScreenshotCallback): () => void {
        this.screenshotCallbacks.set(key, callback)
        return () => { this.screenshotCallbacks.delete(key) }
    }

    emitScreenshot(daemonId: string, blob: Blob): void {
        this.screenshotCallbacks.forEach((callback) => callback(daemonId, blob))
    }

    onStatus(callback: StatusCallback): () => void {
        this.statusCallbacks.add(callback)
        return () => { this.statusCallbacks.delete(callback) }
    }

    emitStatus(daemonId: string, payload: any): void {
        this.statusCallbacks.forEach((callback) => callback(daemonId, payload))
    }

    onPtyOutput(callback: PtyOutputCallback): () => void {
        this.ptyCallbacks.add(callback)
        return () => { this.ptyCallbacks.delete(callback) }
    }

    emitPtyOutput(cliId: string, data: string, meta?: { scrollback?: boolean }): void {
        if (meta?.scrollback) {
            const seq = (this.runtimeSeqs.get(cliId) || 0) + 1
            this.runtimeBuffers.set(cliId, typeof data === 'string' ? data : '')
            this.runtimeSeqs.set(cliId, seq)
            this.emitRuntimeEvent(cliId, {
                type: 'runtime_snapshot',
                sessionId: cliId,
                seq,
                text: typeof data === 'string' ? data : '',
                truncated: false,
            })
        } else if (typeof data === 'string' && data) {
            const prev = this.runtimeBuffers.get(cliId) || ''
            const next = prev + data
            const trimmed = next.length > 64 * 1024 ? next.slice(-(64 * 1024)) : next
            const seq = (this.runtimeSeqs.get(cliId) || 0) + 1
            this.runtimeBuffers.set(cliId, trimmed)
            this.runtimeSeqs.set(cliId, seq)
            this.emitRuntimeEvent(cliId, {
                type: 'session_output',
                sessionId: cliId,
                seq,
                data,
            })
        }
        this.ptyCallbacks.forEach((callback) => callback(cliId, data, meta))
    }

    emitRuntimeSnapshot(sessionId: string, text: string, seq = 0, truncated = false): void {
        this.runtimeBuffers.set(sessionId, text)
        this.runtimeSeqs.set(sessionId, seq)
        this.emitRuntimeEvent(sessionId, {
            type: 'runtime_snapshot',
            sessionId,
            seq,
            text,
            truncated,
        })
    }

    onRuntimeEvent(sessionId: string, callback: (event: RuntimeEvent) => void): () => void {
        const listeners = this.runtimeListeners.get(sessionId) || new Set<(event: RuntimeEvent) => void>()
        listeners.add(callback)
        this.runtimeListeners.set(sessionId, listeners)
        const snapshot = this.getCachedRuntimeSnapshot(sessionId)
        if (snapshot) callback(snapshot)
        return () => {
            const current = this.runtimeListeners.get(sessionId)
            if (!current) return
            current.delete(callback)
            if (current.size === 0) this.runtimeListeners.delete(sessionId)
        }
    }

    private emitRuntimeEvent(sessionId: string, event: RuntimeEvent): void {
        this.runtimeListeners.get(sessionId)?.forEach((callback) => callback(event))
    }

    private getCachedRuntimeSnapshot(sessionId: string): RuntimeEvent | null {
        if (!this.runtimeBuffers.has(sessionId) && !this.runtimeSeqs.has(sessionId)) return null
        return {
            type: 'runtime_snapshot',
            sessionId,
            seq: this.runtimeSeqs.get(sessionId) || 0,
            text: this.runtimeBuffers.get(sessionId) || '',
            truncated: false,
        }
    }
}

export const standaloneConnectionManager = new StandaloneConnectionManager()
