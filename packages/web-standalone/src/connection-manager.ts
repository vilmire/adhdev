import type { ConnectionStatus } from '@adhdev/web-core'
import { standaloneFetch } from './standalone-auth-client'

export interface StandaloneConnectionAdapter {
    hasCommandChannel: boolean
    connectionState: string
    sendCommand(cmd: string, data: any): Promise<any>
    sendInput(action: string, params: any): Promise<any>
    startScreenshots(ideType?: string): void
    stopScreenshots(ideType?: string): void
}

type ScreenshotCallback = (sourceDaemonId: string, blob: Blob) => void
type StatusCallback = (sourceDaemonId: string, payload: any) => void
type RuntimeEvent =
    | { type: 'runtime_snapshot'; sessionId: string; seq: number; text: string; truncated?: boolean; cols?: number; rows?: number }
    | { type: 'session_output'; sessionId: string; seq?: number; data: string }
    | { type: 'session_cleared'; sessionId: string }

class StandaloneConnectionManager {
    private adapters = new Map<string, StandaloneConnectionAdapter>()
    private states = new Map<string, string>()
    private runtimeListeners = new Map<string, Set<(event: RuntimeEvent) => void>>()
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
    sendPtyInput(_daemonId: string, _sessionId: string, _data: string): boolean { return false }

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

    emitRuntimeSnapshot(sessionId: string, text: string, seq = 0, truncated = false): void {
        this.emitRuntimeEvent(sessionId, {
            type: 'runtime_snapshot',
            sessionId,
            seq,
            text,
            truncated,
        })
    }

    emitSessionOutput(sessionId: string, data: string, seq?: number): void {
        if (!sessionId || typeof data !== 'string' || !data) return
        this.emitRuntimeEvent(sessionId, {
            type: 'session_output',
            sessionId,
            ...(typeof seq === 'number' ? { seq } : {}),
            data,
        })
    }

    onRuntimeEvent(sessionId: string, callback: (event: RuntimeEvent) => void): () => void {
        const listeners = this.runtimeListeners.get(sessionId) || new Set<(event: RuntimeEvent) => void>()
        listeners.add(callback)
        this.runtimeListeners.set(sessionId, listeners)
        return () => {
            const current = this.runtimeListeners.get(sessionId)
            if (!current) return
            current.delete(callback)
            if (current.size === 0) this.runtimeListeners.delete(sessionId)
        }
    }

    async requestRuntimeSnapshot(_daemonId: string, sessionId: string): Promise<void> {
        if (!sessionId) return
        const res = await standaloneFetch(`/api/v1/runtime/${encodeURIComponent(sessionId)}/snapshot`)
        if (!res.ok) return
        const snapshot = await res.json() as { seq?: number; text?: string; truncated?: boolean; cols?: number; rows?: number }
        this.emitRuntimeEvent(sessionId, {
            type: 'runtime_snapshot',
            sessionId,
            seq: typeof snapshot.seq === 'number' ? snapshot.seq : 0,
            text: typeof snapshot.text === 'string' ? snapshot.text : '',
            truncated: !!snapshot.truncated,
            cols: typeof snapshot.cols === 'number' ? snapshot.cols : undefined,
            rows: typeof snapshot.rows === 'number' ? snapshot.rows : undefined,
        })
    }

    private emitRuntimeEvent(sessionId: string, event: RuntimeEvent): void {
        this.runtimeListeners.get(sessionId)?.forEach((callback) => callback(event))
    }
}

export const standaloneConnectionManager = new StandaloneConnectionManager()
