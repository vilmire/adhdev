/**
 * TransportContext — abstract transport layer for command execution
 *
 * standalone: commands via WS (sendCommand via WebSocket)
 * cloud: connection-first → fallback HTTP
 */
import { createContext, useContext, type ReactNode } from 'react'

export interface TransportContextValue {
    /** Send command to daemon */
    sendCommand: (daemonId: string, type: string, payload?: any, target?: string) => Promise<any>

    /** Send data directly via connection (returns false if unsupported) */
    sendData?: (daemonId: string, data: any) => boolean

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
