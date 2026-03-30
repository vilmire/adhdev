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
    AccentColorSection,
    ToggleRow,
    useBaseDaemons,
    useTransport,
    IconSettings,
    IconVolume,
    IconUser,
} from '@adhdev/web-core'

declare const __APP_VERSION__: string

export default function StandaloneSettings() {
    const { ides } = useBaseDaemons()

    const daemonEntry: any = ides.find((d: any) => d.type === 'adhdev-daemon')
    const detectedIdes: { type: string; name: string; running: boolean }[] = daemonEntry?.detectedIdes || []

    const { sendCommand } = useTransport()

    // Preferences
    const { userName } = useBaseDaemons()
    const [localUserName, setLocalUserName] = useState<string>(userName || '')

    useEffect(() => {
        if (userName !== undefined) {
            setLocalUserName(userName)
        }
    }, [userName])

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

    return (
        <AppPage
            icon={<IconSettings className="text-text-primary" />}
            title="Settings"
            subtitle="Local daemon configuration, appearance, and on-device preferences"
            widthClassName="max-w-5xl"
        >
            <AlertBanner variant="info">
                Standalone settings stay on this machine. The browser only talks to your local daemon over localhost.
            </AlertBanner>

                {/* ═══ Daemon Info ═══ */}
                <Section title="Daemon" description="Connection health and local endpoints for the self-hosted runtime.">
                    <div className="grid grid-cols-[100px_1fr] gap-x-4 gap-y-2.5 text-sm">
                        <span className="text-text-muted">Version</span>
                        <span className="font-mono text-xs">v{typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '?'}</span>
                        <span className="text-text-muted">Status</span>
                        <span className={daemonEntry ? 'text-green-400' : 'text-yellow-400'}>
                            {daemonEntry ? '● Running' : '○ Not connected'}
                        </span>
                        <span className="text-text-muted">WebSocket</span>
                        <span className="font-mono text-xs">ws://localhost:19222</span>
                        <span className="text-text-muted">HTTP</span>
                        <span className="font-mono text-xs">http://localhost:19280</span>
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
                <Section title="Appearance" description="Match the rest of the dashboard with a single place for mode, theme, and accent.">
                    <div className="flex flex-col gap-4">
                        <div>
                            <div className="text-xs text-text-muted mb-2 font-medium">Mode</div>
                            <GeneralThemeSection />
                        </div>
                        <div className="border-t border-border-subtle pt-4">
                            <div className="text-xs text-text-muted mb-1 font-medium">Theme</div>
                            <p className="text-[11px] text-text-muted mb-3">Choose a preset or create a custom surface and chat palette for the standalone UI.</p>
                            <ChatThemeSection />
                        </div>
                        <div className="border-t border-border-subtle pt-4">
                            <div className="text-xs text-text-muted mb-1 font-medium">Accent color override</div>
                            <p className="text-[11px] text-text-muted mb-3">Override preset accents without changing your full theme definition.</p>
                            <AccentColorSection />
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
