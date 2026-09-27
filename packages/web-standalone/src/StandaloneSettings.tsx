/**
 * StandaloneSettings — Settings page for self-hosted ADHDev.
 *
 * Uses shared components from web-core (CoordinatorPromptsSection etc.) plus
 * standalone-specific sections. Notification/sound settings live on the
 * dedicated /notifications page, not here. Standalone is single-machine, so
 * there is deliberately no per-machine section (cloud keeps its own).
 */
import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
    AppPage,
    Section,
    AlertBanner,
    Button,
    Input,
    CoordinatorPromptsSection,
    AppearanceSettingsSection,
    useBaseDaemons,
    useTransport,
    IconSettings,
    IconUser,
    InfoTip,
    Tooltip,
} from '@adhdev/web-core'
import { Link } from 'react-router-dom'
import {
    DEFAULT_STANDALONE_FONT_PREFERENCES,
    applyStandaloneFontPreferences,
    cacheStandaloneFontPreferences,
    normalizeStandaloneFontPreferences,
    type StandaloneFontPreferences,
} from './standalone-font-preferences'
import StandaloneFontSettingsSection from './StandaloneFontSettingsSection'
import {
    standaloneFetch,
    stripStandaloneTokenFromLocation,
    type StandaloneAuthSessionStatus,
    type StandalonePreferencesStatus,
} from './standalone-auth-client'

declare const __APP_VERSION__: string

export default function StandaloneSettings() {
    const { t } = useTranslation('common')
    const { ides } = useBaseDaemons()

    const daemonEntry: any = ides.find((d: any) => d.type === 'adhdev-daemon')

    const { sendCommand } = useTransport()

    // Preferences
    const { userName } = useBaseDaemons()
    const [localUserName, setLocalUserName] = useState<string>(userName || '')
    const [authStatus, setAuthStatus] = useState<StandaloneAuthSessionStatus | null>(null)
    const [preferences, setPreferences] = useState<StandalonePreferencesStatus | null>(null)
    const [fontPreferences, setFontPreferences] = useState<StandaloneFontPreferences>(DEFAULT_STANDALONE_FONT_PREFERENCES)
    const [fontSaving, setFontSaving] = useState(false)
    const [fontError, setFontError] = useState('')
    const [fontNotice, setFontNotice] = useState('')
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
        const normalizedFonts = normalizeStandaloneFontPreferences(data.standaloneFontPreferences)
        setFontPreferences(normalizedFonts)
        applyStandaloneFontPreferences(normalizedFonts)
        cacheStandaloneFontPreferences(normalizedFonts)
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

    useEffect(() => {
        applyStandaloneFontPreferences(fontPreferences)
    }, [fontPreferences])

    const handleSaveUserName = (e: React.FocusEvent<HTMLInputElement>) => {
        const val = e.target.value.trim()
        if (daemonEntry?.id && val !== userName) {
            sendCommand(daemonEntry.id, 'set_user_name', { userName: val }).catch(console.error)
        }
    }

    const handleSaveFontPreferences = async () => {
        setFontError('')
        setFontNotice('')
        setFontSaving(true)
        try {
            const normalizedFonts = normalizeStandaloneFontPreferences(fontPreferences)
            const res = await standaloneFetch('/api/v1/standalone/preferences', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ standaloneFontPreferences: normalizedFonts }),
            })
            const data = await res.json() as StandalonePreferencesStatus & { error?: string }
            if (!res.ok) {
                throw new Error(data?.error || 'Failed to save standalone font preferences')
            }
            const savedFonts = normalizeStandaloneFontPreferences(data.standaloneFontPreferences)
            setPreferences(data)
            setFontPreferences(savedFonts)
            applyStandaloneFontPreferences(savedFonts)
            cacheStandaloneFontPreferences(savedFonts)
            setFontNotice(t('standalone.settings.fontsSaved'))
        } catch (err) {
            setFontError(err instanceof Error ? err.message : String(err))
        } finally {
            setFontSaving(false)
        }
    }

    const handleResetFontPreferencesToSaved = () => {
        const savedFonts = normalizeStandaloneFontPreferences(preferences?.standaloneFontPreferences)
        setFontError('')
        setFontNotice('')
        setFontPreferences(savedFonts)
        applyStandaloneFontPreferences(savedFonts)
    }

    const handleResetFontPreferencesToDefaults = () => {
        setFontError('')
        setFontNotice('')
        setFontPreferences(DEFAULT_STANDALONE_FONT_PREFERENCES)
        applyStandaloneFontPreferences(DEFAULT_STANDALONE_FONT_PREFERENCES)
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
                ? t('standalone.settings.networkSavedAll')
                : t('standalone.settings.networkSavedLocal'))
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
            setAuthError(t('standalone.settings.passwordTooShort'))
            return
        }
        if (newPassword !== confirmPassword) {
            setAuthError(t('standalone.settings.passwordMismatch'))
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
            setAuthNotice(authStatus?.hasPasswordAuth ? t('standalone.settings.passwordUpdated') : t('standalone.settings.passwordEnabled'))
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
            setAuthNotice(t('standalone.settings.passwordDisabled'))
        } catch (err) {
            setAuthError(err instanceof Error ? err.message : String(err))
        } finally {
            setAuthSaving(false)
        }
    }

    return (
        <AppPage
            icon={<IconSettings className="text-text-primary" />}
            title={t('standalone.settings.title')}
            subtitle={t('standalone.settings.subtitle')}
            widthClassName="max-w-5xl"
        >
            {authStatus?.publicHostWarning && (
                <AlertBanner variant="warning">
                    {t('standalone.settings.publicHostWarning')}
                </AlertBanner>
            )}

            {/* ═══ Daemon Info ═══ */}
            <Section title={t('standalone.settings.daemonSection')}>
                <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between px-3.5 py-3 bg-bg-glass rounded-xl border border-border-subtle">
                        <span className="text-sm text-text-muted">{t('standalone.settings.versionLabel')}</span>
                        <span className="font-mono text-xs text-text-primary">v{typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '?'}</span>
                    </div>
                    <div className="flex items-center justify-between px-3.5 py-3 bg-bg-glass rounded-xl border border-border-subtle">
                        <span className="text-sm text-text-muted">{t('standalone.settings.statusLabel')}</span>
                        <span className={`text-xs font-medium ${daemonEntry ? 'text-green-400' : 'text-yellow-400'}`}>
                            {daemonEntry ? t('standalone.settings.statusRunning') : t('standalone.settings.statusNotConnected')}
                        </span>
                    </div>
                    <div className="flex items-center justify-between px-3.5 py-3 bg-bg-glass rounded-xl border border-border-subtle">
                        <span className="text-sm text-text-muted">{t('standalone.settings.authLabel')}</span>
                        <span className="text-xs text-text-primary">
                            {authStatus?.hasPasswordAuth ? t('standalone.settings.authPassword') : authStatus?.hasTokenAuth ? t('standalone.settings.authToken') : t('standalone.settings.authNone')}
                        </span>
                    </div>
                    {/* Detected IDEs and agents are managed with every other provider. */}
                    {daemonEntry?.id && (
                        <div className="px-1 pt-1 text-xs text-text-muted" data-testid="standalone-providers-link">
                            {t('standalone.settings.providersIntro')}{' '}
                            <Link to={`/machines/${daemonEntry.id}`} state={{ initialMachineTab: 'providers' }} className="text-accent-primary hover:underline">
                                {t('standalone.settings.providersLink')}
                            </Link>
                        </div>
                    )}
                </div>
            </Section>

            <Section title={t('standalone.settings.networkSection')} description={t('standalone.settings.networkHint')}>
                <div className="flex flex-col gap-3">
                    <div className="grid gap-3 md:grid-cols-2" role="radiogroup" aria-label={t('standalone.settings.networkSection')}>
                        {([
                            { host: '127.0.0.1' as const, label: t('standalone.settings.localhostLabel'), hint: t('standalone.settings.localhostHint') },
                            { host: '0.0.0.0' as const, label: t('standalone.settings.allInterfacesLabel'), hint: t('standalone.settings.allInterfacesHint') },
                        ]).map(option => (
                            <label key={option.host} className={`rounded-xl border px-4 py-3 text-sm flex gap-3 items-center cursor-pointer ${bindHostInput === option.host ? 'border-accent-primary/40 bg-accent-primary/5' : 'border-border-subtle bg-bg-glass'}`}>
                                <input
                                    type="radio"
                                    name="standalone-bind-host"
                                    checked={bindHostInput === option.host}
                                    onChange={() => setBindHostInput(option.host)}
                                />
                                <span className="font-medium text-text-primary">{option.label}</span>
                                <InfoTip content={option.hint} />
                            </label>
                        ))}
                    </div>
                    <div className="flex flex-wrap gap-2 items-center">
                        <Button
                            type="button"
                            variant="primary"
                            size="sm"
                            onClick={() => { void handleSaveBindHost() }}
                            disabled={authSaving}
                        >
                            {authSaving ? t('standalone.settings.saving') : t('standalone.settings.saveNetworkMode')}
                        </Button>
                        {/* Saved default differs from what this run is bound to. */}
                        {preferences?.standaloneBindHost && (preferences.currentBindHost || authStatus?.boundHost)
                            && preferences.standaloneBindHost !== (preferences.currentBindHost || authStatus?.boundHost) && (
                            <Tooltip content={t('standalone.settings.networkRestartHint', { host: preferences.currentBindHost || authStatus?.boundHost || '127.0.0.1' })}>
                                <span className="inline-flex items-center rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-3xs font-semibold text-amber-400" data-testid="standalone-restart-chip">
                                    {t('standalone.settings.restartToApply')}
                                </span>
                            </Tooltip>
                        )}
                    </div>
                </div>
            </Section>

            <Section title={t('standalone.settings.securitySection')}>
                <div className="flex flex-col gap-3">
                    <div className="rounded-xl border border-border-subtle bg-bg-glass px-4 py-3 text-sm text-text-muted">
                        {authStatus?.hasPasswordAuth
                            ? t('standalone.settings.passwordSet')
                            : t('standalone.settings.passwordNotSet')}
                    </div>
                    {authError && <AlertBanner variant="error">{authError}</AlertBanner>}
                    {authNotice && <AlertBanner variant="success">{authNotice}</AlertBanner>}
                    <div className="grid gap-3 md:grid-cols-2">
                        <Input
                            type="password"
                            placeholder={authStatus?.hasPasswordAuth ? t('standalone.settings.currentPasswordPlaceholder') : t('standalone.settings.currentPasswordFirstTimePlaceholder')}
                            value={currentPassword}
                            onChange={e => setCurrentPassword(e.target.value)}
                        />
                        <Input
                            type="password"
                            placeholder={authStatus?.hasPasswordAuth ? t('standalone.settings.newPasswordPlaceholder') : t('standalone.settings.newPasswordFirstTimePlaceholder')}
                            value={newPassword}
                            onChange={e => setNewPassword(e.target.value)}
                        />
                        <Input
                            type="password"
                            className="md:col-span-2"
                            placeholder={t('standalone.settings.confirmPasswordPlaceholder')}
                            value={confirmPassword}
                            onChange={e => setConfirmPassword(e.target.value)}
                        />
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <Button
                            type="button"
                            variant="primary"
                            size="sm"
                            onClick={() => { void handleSavePassword() }}
                            disabled={authSaving}
                        >
                            {authSaving ? t('standalone.settings.saving') : authStatus?.hasPasswordAuth ? t('standalone.settings.updatePassword') : t('standalone.settings.enablePassword')}
                        </Button>
                        {authStatus?.hasPasswordAuth && (
                            <Button
                                type="button"
                                variant="danger"
                                size="sm"
                                onClick={() => { void handleClearPassword() }}
                                disabled={authSaving}
                            >
                                {t('standalone.settings.disablePassword')}
                            </Button>
                        )}
                    </div>
                </div>
            </Section>

            {/* No "Connected Machine" section here: standalone is single-machine
                by construction (this page only renders in standalone mode), so a
                separate machine card is redundant — the Daemon Info section above
                already carries version/status. Cloud keeps its own machine UI
                (multi-machine) untouched. Removed 2026-08-24 (owner decision). */}

            {/* ═══ Theme ═══ */}
            <Section title={t('standalone.settings.appearanceSection')}>
                <AppearanceSettingsSection
                    fontsSlot={
                        <div className="border-t border-border-subtle pt-4">
                            <div className="text-xs text-text-muted mb-2 font-medium flex items-center gap-1">
                                {t('standalone.settings.fontsLabel')}
                                <InfoTip content={t('standalone.settings.fontsDescription')} size={12} />
                            </div>
                            <StandaloneFontSettingsSection
                                value={fontPreferences}
                                savedValue={normalizeStandaloneFontPreferences(preferences?.standaloneFontPreferences)}
                                saving={fontSaving}
                                error={fontError}
                                notice={fontNotice}
                                onChange={setFontPreferences}
                                onSave={() => { void handleSaveFontPreferences() }}
                                onResetToSaved={handleResetFontPreferencesToSaved}
                                onResetToDefaults={handleResetFontPreferencesToDefaults}
                            />
                        </div>
                    }
                />
            </Section>

            {/* Notifications live on the dedicated /notifications page (sidebar) —
                the settings-page duplicate section was removed (owner decision
                2026-08-24) when that page gained a standalone route. */}

            {/* ═══ Preferences ═══ */}
            <Section title={t('standalone.settings.profileSection')}>
                <div className="flex flex-col gap-3">
                    <div className="flex items-center justify-between px-3.5 py-4 bg-bg-glass rounded-xl border border-border-subtle hover:border-border-default transition-colors">
                        <div className="flex flex-col gap-1 pr-4 max-w-[500px]">
                            <span className="text-sm font-semibold flex items-center gap-2">
                                <IconUser size={16} className="text-text-secondary" /> {t('standalone.settings.displayNameLabel')}
                                <InfoTip content={t('standalone.settings.displayNameHint')} />
                            </span>
                        </div>
                        <Input
                            type="text"
                            className="w-48 text-right"
                            placeholder={t('standalone.settings.displayNamePlaceholder')}
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

            {/* ═══ Advanced (collapsed) — coordinator prompts ═══
                 Edits ~/.adhdev/coordinator-prompts/<cli>.{md,append.md} on this
                 daemon. Mounted here because those files are per-machine config —
                 mesh-level prompts stay on the Repo Mesh page. This is also the
                 only UI for the layer that the
                 mesh_coordinator_prompt_append MCP tool (action "set") writes. */}
            <Section title={t('settings.advancedTitle')} collapsible defaultOpen={false}>
                <div className="mb-2 flex items-center gap-1 text-xs font-medium text-text-secondary">
                    {t('settings.coordinatorPrompts.sectionTitle')}
                    <InfoTip content={t('settings.coordinatorPrompts.sectionDescription')} size={12} />
                </div>
                <CoordinatorPromptsSection daemonId={daemonEntry?.id} embedded />
            </Section>
        </AppPage>
    )
}
