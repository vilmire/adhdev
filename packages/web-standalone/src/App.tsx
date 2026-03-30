/**
 * ADHDev Standalone — App Shell
 *
 * Imports shared components and pages from web-core,
 * wraps them with StandaloneDaemonContext + TransportContext.
 */
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { StandaloneDaemonProvider, sendCommandViaWs } from './StandaloneDaemonContext'
import { TransportProvider, MachineDetail, Dashboard, IDEPage, CapabilitiesPage, useBaseDaemons, initChatTheme } from '@adhdev/web-core'
import StandaloneLayout from './StandaloneLayout'
import StandaloneAbout from './StandaloneAbout'
import StandaloneSettings from './StandaloneSettings'
import '@adhdev/web-core/index.css'

// Restore chat theme from localStorage on app load
initChatTheme()

/**
 * SingleMachineRedirect — standalone only has 1 machine.
 * Redirect /machines and /machine to the single machine's detail page.
 */
function SingleMachineRedirect() {
    const { ides } = useBaseDaemons()
    // In standalone, there's typically one daemon entry with the machine ID
    const daemonEntry = ides.find((d: any) => d.daemonMode || d.id?.startsWith('standalone'))
    if (daemonEntry) {
        return <Navigate to={`/machines/${daemonEntry.id}`} replace />
    }
    // Fallback: use first available entry's ID
    if (ides.length > 0) {
        return <Navigate to={`/machines/${ides[0].id}`} replace />
    }
    // No data yet — show machine detail with fallback
    return <Navigate to="/dashboard" replace />
}

export default function App() {
    return (
        <BrowserRouter>
            <StandaloneDaemonProvider>
                <TransportProvider value={{
                    sendCommand: sendCommandViaWs,
                    sendData: () => false,
                }}>
                    <StandaloneLayout>
                        <Routes>
                            <Route path="/dashboard" element={<Dashboard />} />
                            <Route path="/ide/:id" element={<IDEPage />} />
                            <Route path="/machine" element={<SingleMachineRedirect />} />
                            <Route path="/machines/:id" element={<MachineDetail />} />
                            <Route path="/machines" element={<SingleMachineRedirect />} />
                            <Route path="/capabilities" element={<CapabilitiesPage />} />
                            <Route path="/about" element={<StandaloneAbout />} />
                            <Route path="/settings" element={<StandaloneSettings />} />
                            <Route path="*" element={<Navigate to="/dashboard" replace />} />
                        </Routes>
                    </StandaloneLayout>
                </TransportProvider>
            </StandaloneDaemonProvider>
        </BrowserRouter>
    )
}
