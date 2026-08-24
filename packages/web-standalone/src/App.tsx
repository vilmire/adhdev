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
import { TransportProvider, LaunchCliProvider, MachineDetail, Dashboard, RepoMesh, StandaloneRepoMeshProvider, ApprovalsPage, NotificationsPage, useBaseDaemons, initTheme, initChatTheme, initI18n, ApiProvider, createApiClient, InteractivePromptModal, useInteractivePrompt, AlertBanner, Button, Input, getMachineNickname, getMachineHostnameLabel } from '@adhdev/web-core'
import { useTranslation } from 'react-i18next'
import StandaloneLayout from './StandaloneLayout'
import SetupWizardPage from './SetupWizardPage'
import StandaloneAbout from './StandaloneAbout'
import StandaloneSettings from './StandaloneSettings'
import StandaloneOnboarding, { hasCompletedOnboarding } from './StandaloneOnboarding'
import '@adhdev/web-core/index.css'

// Restore persisted appearance before first render so CSS vars resolve correctly.
initTheme()
initChatTheme()
initI18n()
initStandaloneFontPreferences()

const standaloneApiClient = createApiClient({
    baseUrl: '',
    getToken: getStandaloneToken,
})

function StandaloneAuthGate({ children }: { children: ReactNode }) {
    const { t } = useTranslation('common')
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
        return <div className="min-h-screen flex items-center justify-center text-sm text-text-muted">{t('standalone.auth.loading')}</div>
    }

    if (!status) {
        return <div className="min-h-screen flex items-center justify-center text-sm text-red-400">{t('standalone.auth.loadError', { error: error || 'unknown error' })}</div>
    }

    if (!status.required || status.authenticated) {
        return <>{children}</>
    }

    return (
        <div className="min-h-screen bg-bg-base flex items-center justify-center px-4">
            <div className="w-full max-w-md rounded-2xl border border-border-subtle bg-bg-panel p-6 shadow-2xl flex flex-col gap-4">
                <div>
                    <div className="text-lg font-semibold text-text-primary">{t('standalone.auth.signInTitle')}</div>
                    <p className="text-sm text-text-muted mt-1">
                        {status.hasPasswordAuth
                            ? t('standalone.auth.passwordProtected')
                            : t('standalone.auth.tokenProtected')}
                    </p>
                </div>
                {status.hasPasswordAuth ? (
                    <form className="flex flex-col gap-3" onSubmit={handleLogin}>
                        <Input
                            type="password"
                            value={password}
                            onChange={e => setPassword(e.target.value)}
                            placeholder={t('standalone.auth.passwordPlaceholder')}
                            autoFocus
                        />
                        <Button
                            type="submit"
                            variant="primary"
                            disabled={submitting || !password}
                            className="justify-center"
                        >
                            {submitting ? t('standalone.auth.signingIn') : t('standalone.auth.unlock')}
                        </Button>
                    </form>
                ) : (
                    <AlertBanner variant="warning">
                        {t('standalone.auth.noPasswordEnabled')}
                    </AlertBanner>
                )}
                {error && (
                    <AlertBanner variant="error">{error}</AlertBanner>
                )}
            </div>
        </div>
    )
}

/**
 * SingleMachineRedirect — standalone only has 1 machine.
 * Redirect /machines and /machine to the single machine's detail page.
 */
/**
 * NotificationsPage needs the connected machines (for per-provider toggles);
 * this thin wrapper mirrors web-cloud's mapping minus the cloud-only push
 * section. Browser-notification prefs are local, so no onBrowserPrefChange.
 */
function StandaloneNotificationsPage() {
    const { ides, initialLoaded } = useBaseDaemons()
    const machines = (ides as any[]).filter((i: any) => i.type === 'adhdev-daemon').map((d: any) => ({
        id: d.id,
        machineId: d.machineId || d.id,
        nickname: getMachineNickname(d) || undefined,
        hostname: getMachineHostnameLabel(d, { fallbackId: d.id }),
        status: d.status,
        providers: (d.availableProviders || []).map((p: any) => ({
            type: p.type, displayName: p.displayName, icon: p.icon, category: p.category,
        })),
    }))
    return <NotificationsPage machines={machines} initialLoaded={initialLoaded ?? true} />
}

function SingleMachineRedirect() {
    const { t } = useTranslation('common')
    const { ides, initialLoaded } = useBaseDaemons()
    // In standalone, redirect only after the initial status payload has arrived.
    // Otherwise `/machines` briefly bounces back to `/dashboard` before daemon data exists.
    if (!initialLoaded) {
        return <div className="p-10 text-center text-text-muted">{t('standalone.machine.loading')}</div>
    }

    const daemonEntry = ides.find((d: any) => d.daemonMode || d.type === 'adhdev-daemon')
    if (daemonEntry) {
        return <Navigate to={`/machines/${daemonEntry.id}`} replace />
    }

    return <Navigate to="/dashboard" replace />
}

/**
 * Show the first-boot onboarding dialog when:
 *   - the user has not completed onboarding before (localStorage flag), AND
 *   - the daemon currently has 0 installed providers.
 *
 * If either is false, render nothing. After Done/Skip, the dialog persists
 * the flag and never reopens.
 */
function OnboardingGate() {
    const [show, setShow] = useState(false)

    useEffect(() => {
        let cancelled = false
        if (hasCompletedOnboarding()) return
        fetch('/api/v1/providers/installed')
            .then(r => r.ok ? r.json() : { providers: [] })
            .then((data: { providers?: unknown[] }) => {
                if (cancelled) return
                if ((data.providers ?? []).length === 0) setShow(true)
            })
            .catch(() => { /* ignore — likely no daemon yet */ })
        return () => { cancelled = true }
    }, [])

    if (!show) return null
    return <StandaloneOnboarding onDone={() => setShow(false)} />
}

// Global interactive prompt dialog — shown whenever any session has waiting_choice status
function InteractivePromptGate() {
    const { t } = useTranslation('common')
    const { ides } = useBaseDaemons()
    // Find the first session with an active interactive prompt
    const activeSessionId = useMemo(() => {
        for (const ide of ides) {
            if (ide.activeInteractivePrompt) return ide.instanceId ?? ide.id
        }
        return null
    }, [ides])
    const { promptSession, hasActivePrompt, responseError, isSubmitting, submit, cancel, reopen } = useInteractivePrompt(activeSessionId)

    if (!hasActivePrompt) return null

    return (
        <div className="relative">
            {!promptSession && (
                <button
                    type="button"
                    onClick={reopen}
                    className="fixed bottom-4 right-4 z-[79] btn btn-primary btn-sm shadow-lg"
                >
                    {t('standalone.machine.awaitingInput')}
                </button>
            )}
            <InteractivePromptModal
                promptSession={promptSession}
                isSubmitting={isSubmitting}
                error={responseError}
                onSubmit={submit}
                onCancel={cancel}
            />
        </div>
    )
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
                            <LaunchCliProvider sendDaemonCommand={sendCommandViaWs}>
                            <InteractivePromptGate />
                            <StandaloneLayout>
                                <OnboardingGate />
                                <Routes>
                                    <Route path="/dashboard" element={<Dashboard />} />
                                    <Route path="/machine" element={<SingleMachineRedirect />} />
                                    <Route path="/machines/:id" element={<MachineDetail />} />
                                    <Route path="/machines" element={<SingleMachineRedirect />} />
                                    {/* Platform-neutral web-core pages (fragmentation audit: the
                                        daemon fully supports both over the standalone WS, the UI
                                        existed, only the routes were missing). */}
                                    <Route path="/approvals" element={<ApprovalsPage />} />
                                    <Route path="/notifications" element={<StandaloneNotificationsPage />} />
                                    <Route path="/about" element={<StandaloneAbout />} />
                                    <Route path="/settings" element={<StandaloneSettings />} />
                                    <Route path="/mesh" element={<StandaloneRepoMeshProvider><RepoMesh /></StandaloneRepoMeshProvider>} />
                                    <Route path="/setup" element={<SetupWizardPage />} />
                                    <Route path="*" element={<Navigate to="/dashboard" replace />} />
                                </Routes>
                            </StandaloneLayout>
                            </LaunchCliProvider>
                        </TransportProvider>
                    </StandaloneDaemonProvider>
                </StandaloneAuthGate>
            </ApiProvider>
        </BrowserRouter>
    )
}
