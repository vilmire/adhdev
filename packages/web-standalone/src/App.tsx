/**
 * ADHDev Standalone — App Shell
 *
 * Imports shared components and pages from web-core,
 * wraps them with StandaloneDaemonContext + TransportContext.
 */
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { StandaloneDaemonProvider, sendCommandViaWs, sendDataViaWs, sendPtyInputViaWs } from './StandaloneDaemonContext'
import { getStandaloneToken, standaloneFetch, stripStandaloneTokenFromLocation, type StandaloneAuthSessionStatus, type StandalonePreferencesStatus } from './standalone-auth-client'
import {
    applyStandaloneFontPreferences,
    cacheStandaloneFontPreferences,
    initStandaloneFontPreferences,
    normalizeStandaloneFontPreferences,
} from './standalone-font-preferences'
import { TransportProvider, MachineDetail, Dashboard, useBaseDaemons, initTheme, initChatTheme, ApiProvider, createApiClient } from '@adhdev/web-core'
import StandaloneLayout from './StandaloneLayout'
import StandaloneAbout from './StandaloneAbout'
import StandaloneSettings from './StandaloneSettings'
import '@adhdev/web-core/index.css'

// Restore persisted appearance before first render so CSS vars resolve correctly.
initTheme()
initChatTheme()
initStandaloneFontPreferences()

const standaloneApiClient = createApiClient({
    baseUrl: '',
    getToken: getStandaloneToken,
})

function StandaloneAuthGate({ children }: { children: ReactNode }) {
    const [status, setStatus] = useState<StandaloneAuthSessionStatus | null>(null)
    const [loading, setLoading] = useState(true)
    const [password, setPassword] = useState('')
    const [error, setError] = useState('')
    const [submitting, setSubmitting] = useState(false)

    const refreshStatus = async () => {
        setLoading(true)
        setError('')
        try {
            const res = await standaloneFetch('/auth/session')
            const data = await res.json() as StandaloneAuthSessionStatus
            setStatus(data)
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        void refreshStatus()
    }, [])

    useEffect(() => {
        if (!status || (status.required && !status.authenticated)) return
        let cancelled = false
        void (async () => {
            try {
                const res = await standaloneFetch('/api/v1/standalone/preferences')
                if (!res.ok) return
                const data = await res.json() as StandalonePreferencesStatus
                if (cancelled) return
                const normalizedFonts = normalizeStandaloneFontPreferences(data.standaloneFontPreferences)
                applyStandaloneFontPreferences(normalizedFonts)
                cacheStandaloneFontPreferences(normalizedFonts)
            } catch {
                // keep cached standalone fonts when the preferences endpoint is unavailable
            }
        })()
        return () => { cancelled = true }
    }, [status?.authenticated, status?.required])

    const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        setSubmitting(true)
        setError('')
        try {
            const res = await standaloneFetch('/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password }),
            })
            const data = await res.json()
            if (!res.ok) {
                throw new Error(data?.error || 'Login failed')
            }
            setStatus(data as StandaloneAuthSessionStatus)
            setPassword('')
            stripStandaloneTokenFromLocation()
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setSubmitting(false)
        }
    }

    if (loading) {
        return <div className="min-h-screen flex items-center justify-center text-sm text-text-muted">Loading standalone dashboard…</div>
    }

    if (!status) {
        return <div className="min-h-screen flex items-center justify-center text-sm text-red-400">Failed to load standalone auth status: {error || 'unknown error'}</div>
    }

    if (!status.required || status.authenticated) {
        return <>{children}</>
    }

    return (
        <div className="min-h-screen bg-bg-base flex items-center justify-center px-4">
            <div className="w-full max-w-md rounded-2xl border border-border-subtle bg-bg-panel p-6 shadow-2xl flex flex-col gap-4">
                <div>
                    <div className="text-lg font-semibold text-text-primary">Standalone sign-in</div>
                    <p className="text-sm text-text-muted mt-1">
                        {status.hasPasswordAuth
                            ? 'This self-hosted dashboard is protected by a local password.'
                            : 'This standalone server is protected by a token. Open it using the tokenized URL or set a password from an already-authenticated session.'}
                    </p>
                </div>
                {status.hasPasswordAuth ? (
                    <form className="flex flex-col gap-3" onSubmit={handleLogin}>
                        <input
                            type="password"
                            value={password}
                            onChange={e => setPassword(e.target.value)}
                            className="bg-bg-primary border border-border-strong rounded-lg px-3 py-2.5 text-sm focus:border-accent focus:outline-none transition-colors"
                            placeholder="Enter standalone password"
                            autoFocus
                        />
                        <button
                            type="submit"
                            disabled={submitting || !password}
                            className="rounded-lg bg-accent text-white px-3 py-2.5 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {submitting ? 'Signing in…' : 'Unlock dashboard'}
                        </button>
                    </form>
                ) : (
                    <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-sm text-yellow-300">
                        Password login is not enabled on this server.
                    </div>
                )}
                {error && (
                    <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                        {error}
                    </div>
                )}
            </div>
        </div>
    )
}

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
        sendPtyInput: sendPtyInputViaWs,
    }), [])

    return (
        <BrowserRouter
            future={{
                v7_startTransition: true,
                v7_relativeSplatPath: true,
            }}
        >
            <ApiProvider client={standaloneApiClient}>
                <StandaloneAuthGate>
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
                </StandaloneAuthGate>
            </ApiProvider>
        </BrowserRouter>
    )
}
