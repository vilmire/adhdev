/**
 * StandaloneSettings — Settings page for self-hosted ADHDev.
 *
 * Uses shared components from web-core (ToggleRow, BrowserNotificationSettings,
 * ConnectedMachinesSection) plus standalone-specific sections.
 */
import { useState, useEffect } from 'react'
import {
    AppPage,
    Section,
    AlertBanner,
    BrowserNotificationSettings,
    ConnectedMachinesSection,
    GeneralThemeSection,
    ChatThemeSection,
    MobileDashboardModeSection,
    ToggleRow,
    useBaseDaemons,
    useTransport,
    IconSettings,
    IconVolume,
    IconUser,
} from '@adhdev/web-core'
import {
    standaloneFetch,
    stripStandaloneTokenFromLocation,
    type StandaloneAuthSessionStatus,
    type StandalonePreferencesStatus,
} from './standalone-auth-client'

declare const __APP_VERSION__: string

export default function StandaloneSettings() {
    const { ides } = useBaseDaemons()

    const daemonEntry: any = ides.find((d: any) => d.type === 'adhdev-daemon')
    const detectedIdes: { type: string; name: string; running: boolean }[] = daemonEntry?.detectedIdes || []

    const { sendCommand } = useTransport()

    // Preferences
    const { userName } = useBaseDaemons()
    const [localUserName, setLocalUserName] = useState<string>(userName || '')
    const [authStatus, setAuthStatus] = useState<StandaloneAuthSessionStatus | null>(null)
    const [preferences, setPreferences] = useState<StandalonePreferencesStatus | null>(null)
    const [bindHostInput, setBindHostInput] = useState<'127.0.0.1' | '0.0.0.0'>('127.0.0.1')
    const [currentPassword, setCurrentPassword] = useState('')
    const [newPassword, setNewPassword] = useState('')
    const [confirmPassword, setConfirmPassword] = useState('')
    const [authError, setAuthError] = useState('')
    const [authNotice, setAuthNotice] = useState('')
    const [authSaving, setAuthSaving] = useState(false)

    const refreshAuthStatus = async () => {
        const res = await standaloneFetch('/auth/session')
        const data = await res.json() as StandaloneAuthSessionStatus
        setAuthStatus(data)
    }

    const refreshPreferences = async () => {
        const res = await standaloneFetch('/api/v1/standalone/preferences')
        const data = await res.json() as StandalonePreferencesStatus
        setPreferences(data)
        setBindHostInput(data.standaloneBindHost)
    }

    useEffect(() => {
        if (userName !== undefined) {
            setLocalUserName(userName)
        }
    }, [userName])

    useEffect(() => {
        void Promise.all([refreshAuthStatus(), refreshPreferences()]).catch((err) => {
            setAuthError(err instanceof Error ? err.message : String(err))
        })
    }, [])

    const handleSaveUserName = (e: React.FocusEvent<HTMLInputElement>) => {
        const val = e.target.value.trim()
        if (daemonEntry?.id && val !== userName) {
            sendCommand(daemonEntry.id, 'set_user_name', { userName: val }).catch(console.error)
        }
    }

    // Theme preference (read from localStorage)
    const [soundEnabled, setSoundEnabled] = useState(() => {
        try { return localStorage.getItem('adhdev_sound') !== '0' } catch { return true }
    })

    const handleSoundToggle = (v: boolean) => {
        setSoundEnabled(v)
        try { localStorage.setItem('adhdev_sound', v ? '1' : '0') } catch {}
    }

    const handleSaveBindHost = async () => {
        setAuthError('')
        setAuthNotice('')
        setAuthSaving(true)
        try {
            const res = await standaloneFetch('/api/v1/standalone/preferences', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ standaloneBindHost: bindHostInput }),
            })
            const data = await res.json() as StandalonePreferencesStatus & { error?: string }
            if (!res.ok) {
                throw new Error(data?.error || 'Failed to save standalone network preference')
            }
            setPreferences(data)
            setBindHostInput(data.standaloneBindHost)
            setAuthNotice(data.standaloneBindHost === '0.0.0.0'
                ? 'Default standalone network mode set to all interfaces (0.0.0.0). Restart standalone to apply it.'
                : 'Default standalone network mode set to localhost only. Restart standalone to apply it.')
        } catch (err) {
            setAuthError(err instanceof Error ? err.message : String(err))
        } finally {
            setAuthSaving(false)
        }
    }

    const handleSavePassword = async () => {
        setAuthError('')
        setAuthNotice('')
        if (newPassword.trim().length < 4) {
            setAuthError('Password must be at least 4 characters.')
            return
        }
        if (newPassword !== confirmPassword) {
            setAuthError('New password and confirmation do not match.')
            return
        }
        setAuthSaving(true)
        try {
            const res = await standaloneFetch('/auth/password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    currentPassword,
                    newPassword,
                }),
            })
            const data = await res.json()
            if (!res.ok) {
                throw new Error(data?.error || 'Failed to save password')
            }
            setAuthStatus(data as StandaloneAuthSessionStatus)
            await refreshPreferences()
            setCurrentPassword('')
            setNewPassword('')
            setConfirmPassword('')
            setAuthNotice(authStatus?.hasPasswordAuth ? 'Standalone password updated.' : 'Standalone password enabled.')
            stripStandaloneTokenFromLocation()
        } catch (err) {
            setAuthError(err instanceof Error ? err.message : String(err))
        } finally {
            setAuthSaving(false)
        }
    }

    const handleClearPassword = async () => {
        setAuthError('')
        setAuthNotice('')
        setAuthSaving(true)
        try {
            const res = await standaloneFetch('/auth/password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    currentPassword,
                    clear: true,
                }),
            })
            const data = await res.json()
            if (!res.ok) {
                throw new Error(data?.error || 'Failed to clear password')
            }
            setAuthStatus(data as StandaloneAuthSessionStatus)
            await refreshPreferences()
            setCurrentPassword('')
            setNewPassword('')
            setConfirmPassword('')
            setAuthNotice('Standalone password disabled.')
        } catch (err) {
            setAuthError(err instanceof Error ? err.message : String(err))
        } finally {
            setAuthSaving(false)
        }
    }

    return (
        <AppPage
            icon={<IconSettings className="text-text-primary" />}
            title="Settings"
            subtitle="Local daemon configuration, appearance, and on-device preferences"
            widthClassName="max-w-5xl"
        >
            <AlertBanner variant="info">
                Standalone settings stay on this machine. The browser only talks to your local daemon over localhost or your self-hosted LAN endpoint.
            </AlertBanner>

            {authStatus?.publicHostWarning && (
                <AlertBanner variant="warning">
                    This standalone server is currently bound to 0.0.0.0 without auth. Anyone on your LAN can open the dashboard until you set a password or token.
                </AlertBanner>
            )}

            {/* ═══ Daemon Info ═══ */}
            <Section title="Daemon" description="Connection health and local endpoints for the self-hosted runtime.">
                <div className="grid grid-cols-[100px_1fr] gap-x-4 gap-y-2.5 text-sm">
                    <span className="text-text-muted">Version</span>
                    <span className="font-mono text-xs">v{typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '?'}</span>
                    <span className="text-text-muted">Status</span>
                    <span className={daemonEntry ? 'text-green-400' : 'text-yellow-400'}>
                        {daemonEntry ? '● Running' : '○ Not connected'}
                    </span>
                    <span className="text-text-muted">Current bind</span>
                    <span className="font-mono text-xs">{preferences?.currentBindHost || authStatus?.boundHost || '127.0.0.1'}</span>
                    <span className="text-text-muted">Default bind</span>
                    <span className="font-mono text-xs">{preferences?.standaloneBindHost || '127.0.0.1'}</span>
                    <span className="text-text-muted">Auth</span>
                    <span className="text-xs">
                        {authStatus?.hasPasswordAuth ? 'Password enabled' : authStatus?.hasTokenAuth ? 'Token enabled' : 'No auth configured'}
                    </span>
                </div>
            </Section>

            <Section title="Network Access" description="Choose the default bind host for future standalone launches. CLI --host still overrides this for one-off runs.">
                <div className="flex flex-col gap-3">
                    <div className="rounded-xl border border-border-subtle bg-bg-glass px-4 py-3 text-sm text-text-muted">
                        Use localhost-only if this dashboard should stay on the current machine. Use all interfaces if you usually access it from phones, tablets, or other devices on your LAN. If you expose that machine more broadly, set a password or token.
                    </div>
                    <div className="grid gap-3 md:grid-cols-2">
                        <label className="rounded-xl border border-border-subtle bg-bg-glass px-4 py-3 text-sm flex gap-3 items-start cursor-pointer">
                            <input
                                type="radio"
                                name="standalone-bind-host"
                                checked={bindHostInput === '127.0.0.1'}
                                onChange={() => setBindHostInput('127.0.0.1')}
                            />
                            <span>
                                <span className="block font-medium text-text-primary">Localhost only</span>
                                <span className="block text-text-muted text-xs mt-1">Bind to 127.0.0.1. Best when only this machine should open the dashboard.</span>
                            </span>
                        </label>
                        <label className="rounded-xl border border-border-subtle bg-bg-glass px-4 py-3 text-sm flex gap-3 items-start cursor-pointer">
                            <input
                                type="radio"
                                name="standalone-bind-host"
                                checked={bindHostInput === '0.0.0.0'}
                                onChange={() => setBindHostInput('0.0.0.0')}
                            />
                            <span>
                                <span className="block font-medium text-text-primary">All interfaces</span>
                                <span className="block text-text-muted text-xs mt-1">Bind to 0.0.0.0. Good for LAN access, reverse proxies, or other external entry points.</span>
                            </span>
                        </label>
                    </div>
                    <div className="flex flex-wrap gap-2 items-center">
                        <button
                            type="button"
                            onClick={() => { void handleSaveBindHost() }}
                            disabled={authSaving}
                            className="rounded-lg bg-accent text-white px-3 py-2 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {authSaving ? 'Saving…' : 'Save default network mode'}
                        </button>
                        <span className="text-xs text-text-muted">Applies on next standalone restart. Current run stays bound to {preferences?.currentBindHost || authStatus?.boundHost || '127.0.0.1'}.</span>
                    </div>
                </div>
            </Section>

            <Section title="Dashboard Security" description="Self-hosted-only password protection for browsers using this standalone dashboard.">
                <div className="flex flex-col gap-3">
                    <div className="rounded-xl border border-border-subtle bg-bg-glass px-4 py-3 text-sm text-text-muted">
                        {authStatus?.hasPasswordAuth
                            ? 'A local password is currently required for browser access. Existing sessions are rotated when you change it.'
                            : 'No standalone password is set yet. If you usually run with --host, setting one is strongly recommended.'}
                    </div>
                    {authError && <AlertBanner variant="error">{authError}</AlertBanner>}
                    {authNotice && <AlertBanner variant="success">{authNotice}</AlertBanner>}
                    <div className="grid gap-3 md:grid-cols-2">
                        <input
                            type="password"
                            className="bg-bg-primary border border-border-strong rounded-lg px-3 py-2.5 text-sm focus:border-accent focus:outline-none transition-colors"
                            placeholder={authStatus?.hasPasswordAuth ? 'Current password' : 'Current password (not needed for first setup)'}
                            value={currentPassword}
                            onChange={e => setCurrentPassword(e.target.value)}
                        />
                        <input
                            type="password"
                            className="bg-bg-primary border border-border-strong rounded-lg px-3 py-2.5 text-sm focus:border-accent focus:outline-none transition-colors"
                            placeholder={authStatus?.hasPasswordAuth ? 'New password' : 'New standalone password'}
                            value={newPassword}
                            onChange={e => setNewPassword(e.target.value)}
                        />
                        <input
                            type="password"
                            className="bg-bg-primary border border-border-strong rounded-lg px-3 py-2.5 text-sm focus:border-accent focus:outline-none transition-colors md:col-span-2"
                            placeholder="Confirm new password"
                            value={confirmPassword}
                            onChange={e => setConfirmPassword(e.target.value)}
                        />
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <button
                            type="button"
                            onClick={() => { void handleSavePassword() }}
                            disabled={authSaving}
                            className="rounded-lg bg-accent text-white px-3 py-2 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {authSaving ? 'Saving…' : authStatus?.hasPasswordAuth ? 'Update password' : 'Enable password'}
                        </button>
                        {authStatus?.hasPasswordAuth && (
                            <button
                                type="button"
                                onClick={() => { void handleClearPassword() }}
                                disabled={authSaving}
                                className="rounded-lg border border-red-500/30 bg-red-500/10 text-red-300 px-3 py-2 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                Disable password
                            </button>
                        )}
                    </div>
                </div>
            </Section>

            {/* ═══ Detected IDEs ═══ */}
            <Section title="Detected IDEs" description="Editors discovered by the local daemon on this machine.">
                {detectedIdes.length === 0 ? (
                    <p className="text-sm text-text-muted">No IDEs detected. Start an IDE to see it here.</p>
                ) : (
                    <div className="flex flex-col gap-1.5">
                        {detectedIdes.map((ide) => (
                            <div key={ide.type} className="flex justify-between items-center bg-bg-glass rounded-lg px-3.5 py-2.5">
                                <div className="flex items-center gap-2.5">
                                    <span className={`w-2 h-2 rounded-full ${ide.running ? 'bg-green-400' : 'bg-text-muted/30'}`} />
                                    <span className="text-sm font-medium">{ide.name}</span>
                                </div>
                                <span className="text-[11px] text-text-muted font-mono">{ide.type}</span>
                            </div>
                        ))}
                    </div>
                )}
            </Section>

            {/* ═══ Connected Machine ═══ */}
            <Section title="Machine" description="The local burrow exposed by your standalone daemon.">
                <ConnectedMachinesSection
                    ides={ides}
                    emptyMessage="Daemon not connected. Run 'adhdev-standalone' to start."
                />
            </Section>

            {/* ═══ Theme ═══ */}
            <Section title="Appearance" description="Match the rest of the dashboard with a single place for mode and theme.">
                <div className="flex flex-col gap-4">
                    <div>
                        <div className="text-xs text-text-muted mb-2 font-medium">Mode</div>
                        <GeneralThemeSection />
                    </div>
                    <div className="border-t border-border-subtle pt-4">
                        <div className="text-xs text-text-muted mb-1 font-medium">Theme</div>
                        <p className="text-[11px] text-text-muted mb-3">Choose a preset or create a custom surface, accent, and chat palette for the standalone UI.</p>
                        <ChatThemeSection />
                    </div>
                    <div className="border-t border-border-subtle pt-4">
                        <div className="text-xs text-text-muted mb-1 font-medium">Mobile</div>
                        <p className="text-[11px] text-text-muted mb-3">Choose whether phones open the dashboard as a chat app first or in the full workspace layout.</p>
                        <MobileDashboardModeSection />
                    </div>
                </div>
            </Section>

            {/* ═══ Notifications ═══ */}
            <Section title="Notifications" description="Browser prompts and local sound cues for agent activity.">
                <div className="flex flex-col gap-3">
                    <BrowserNotificationSettings />
                    <ToggleRow
                        label={<span className="flex items-center gap-1.5"><IconVolume size={15} /> Sound Effects</span>}
                        description="Play a sound when agent completes or needs approval"
                        checked={soundEnabled}
                        onChange={handleSoundToggle}
                    />
                </div>
            </Section>

            {/* ═══ Preferences ═══ */}
            <Section title="Profile" description="How your name appears in local chat threads and dashboard views.">
                <div className="flex flex-col gap-3">
                    <div className="flex items-center justify-between px-3.5 py-4 bg-bg-glass rounded-xl border border-border-subtle hover:border-border-default transition-colors">
                        <div className="flex flex-col gap-1 pr-4 max-w-[500px]">
                            <span className="text-sm font-semibold flex items-center gap-2">
                                <IconUser size={16} className="text-text-secondary" /> Display Name
                            </span>
                            <span className="text-[12px] text-text-muted leading-relaxed">
                                Your name shown in chat threads and on the team dashboard.
                            </span>
                        </div>
                        <input
                            type="text"
                            className="bg-bg-primary border border-border-strong rounded-lg px-3 py-1.5 text-sm w-48 text-right focus:border-accent focus:outline-none transition-colors"
                            placeholder="Anonymous"
                            value={localUserName}
                            onChange={e => setLocalUserName(e.target.value)}
                            onBlur={handleSaveUserName}
                            onKeyDown={e => {
                                if (e.key === 'Enter') {
                                    e.currentTarget.blur()
                                }
                            }}
                        />
                    </div>
                </div>
            </Section>
        </AppPage>
    )
}
