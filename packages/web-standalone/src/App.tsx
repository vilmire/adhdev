/**
 * ADHDev Standalone — App Shell
 *
 * Imports shared components and pages from web-core,
 * wraps them with StandaloneDaemonContext + TransportContext.
 */
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useMemo } from 'react'
import { StandaloneDaemonProvider, sendCommandViaWs, sendDataViaWs } from './StandaloneDaemonContext'
import { TransportProvider, MachineDetail, Dashboard, useBaseDaemons, initTheme, initChatTheme, ApiProvider, createApiClient } from '@adhdev/web-core'
import StandaloneLayout from './StandaloneLayout'
import StandaloneAbout from './StandaloneAbout'
import StandaloneSettings from './StandaloneSettings'
import '@adhdev/web-core/index.css'

// Restore persisted appearance before first render so CSS vars resolve correctly.
initTheme()
initChatTheme()

const standaloneApiClient = createApiClient({
    baseUrl: (import.meta as any).env?.DEV ? 'http://127.0.0.1:3847' : '',
})

/**
 * SingleMachineRedirect — standalone only has 1 machine.
 * Redirect /machines and /machine to the single machine's detail page.
 */
function SingleMachineRedirect() {
    const { ides, initialLoaded } = useBaseDaemons()
    // In standalone, redirect only after the initial status payload has arrived.
    // Otherwise `/machines` briefly bounces back to `/dashboard` before daemon data exists.
    if (!initialLoaded) {
        return <div className="p-10 text-center text-text-muted">⏳ Loading machine...</div>
    }

    const daemonEntry = ides.find((d: any) => d.daemonMode || d.type === 'adhdev-daemon')
    if (daemonEntry) {
        return <Navigate to={`/machines/${daemonEntry.id}`} replace />
    }

    return <Navigate to="/dashboard" replace />
}

export default function App() {
    const transportValue = useMemo(() => ({
        sendCommand: sendCommandViaWs,
        sendData: sendDataViaWs,
    }), [])

    return (
        <BrowserRouter
            future={{
                v7_startTransition: true,
                v7_relativeSplatPath: true,
            }}
        >
            <ApiProvider client={standaloneApiClient}>
                <StandaloneDaemonProvider>
                    <TransportProvider value={transportValue}>
                        <StandaloneLayout>
                            <Routes>
                                <Route path="/dashboard" element={<Dashboard />} />
                                <Route path="/machine" element={<SingleMachineRedirect />} />
                                <Route path="/machines/:id" element={<MachineDetail />} />
                                <Route path="/machines" element={<SingleMachineRedirect />} />
                                <Route path="/about" element={<StandaloneAbout />} />
                                <Route path="/settings" element={<StandaloneSettings />} />
                                <Route path="*" element={<Navigate to="/dashboard" replace />} />
                            </Routes>
                        </StandaloneLayout>
                    </TransportProvider>
                </StandaloneDaemonProvider>
            </ApiProvider>
        </BrowserRouter>
    )
}
