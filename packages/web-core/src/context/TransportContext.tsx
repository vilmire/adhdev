/**
 * TransportContext — abstract transport layer for command execution
 *
 * standalone: commands via localhost WS/HTTP
 * cloud: commands via P2P data channel
 */
import { createContext, useContext, type ReactNode } from 'react'

export interface TransportContextValue {
    /**
     * Send command to daemon.
     *
     * ⚠️ Response shape differs by transport and all call sites MUST handle both:
     *   - Standalone (sendCommandViaWs): resolves the daemon's raw response, e.g.
     *       { success: true, controlResult: { ... }, ... }
     *   - Cloud (sendDaemonCommand): wraps the P2P response once, e.g.
     *       { success: true, result: { success: true, controlResult: { ... }, ... } }
     *
     * When reading fields off the response, either:
     *   (1) use an extractor that falls back `response.<field> ?? response.result?.<field>`,
     *   (2) or start from the inner body: `const body = response?.result ?? response`.
     * Historical bug: model selector in ControlsBar silently returned empty because
     * it only inspected `response.controlResult` and missed the Cloud wrapper.
     */
    sendCommand: (daemonId: string, type: string, payload?: any) => Promise<any>

    /** Send data directly via connection (returns false if unsupported) */
    sendData?: (daemonId: string, data: any) => boolean

    /** Send raw PTY input via the transport's explicit terminal-input path */
    sendPtyInput?: (daemonId: string, sessionId: string, data: string) => boolean

    /** Check connection state */
    isConnected?: (daemonId: string) => boolean

    /** Start/stop screenshot streaming */
    startScreenshot?: (daemonId: string) => void
    stopScreenshot?: (daemonId: string) => void
}

const defaultTransport: TransportContextValue = {
    sendCommand: async () => { throw new Error('TransportContext not initialized') },
}

const TransportCtx = createContext<TransportContextValue>(defaultTransport)

export function TransportProvider({ value, children }: { value: TransportContextValue; children: ReactNode }) {
    return <TransportCtx.Provider value={value}>{children}</TransportCtx.Provider>
}

export function useTransport(): TransportContextValue {
    return useContext(TransportCtx)
}
