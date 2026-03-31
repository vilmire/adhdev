import type { ConnectionStatus } from '@adhdev/web-core'

export interface StandaloneConnectionAdapter {
    hasCommandChannel: boolean
    connectionState: string
    sendCommand(cmd: string, data: any): Promise<any>
    sendInput(action: string, params: any): Promise<any>
    startScreenshots(ideType?: string): void
    stopScreenshots(ideType?: string): void
}

type PtyOutputCallback = (cliId: string, data: string) => void
type ScreenshotCallback = (sourceDaemonId: string, blob: Blob) => void
type StatusCallback = (sourceDaemonId: string, payload: any) => void

class StandaloneConnectionManager {
    private adapters = new Map<string, StandaloneConnectionAdapter>()
    private states = new Map<string, string>()
    private ptyCallbacks = new Set<PtyOutputCallback>()
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

    emitPtyOutput(cliId: string, data: string): void {
        this.ptyCallbacks.forEach((callback) => callback(cliId, data))
    }
}

export const standaloneConnectionManager = new StandaloneConnectionManager()
