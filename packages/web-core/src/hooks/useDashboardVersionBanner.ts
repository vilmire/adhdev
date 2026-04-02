import { useCallback, useMemo, useState } from 'react'
import type { DaemonData } from '../types'

declare const __APP_VERSION__: string

interface UseDashboardVersionBannerOptions {
    ides: DaemonData[]
    sendDaemonCommand: (id: string, type: string, data: Record<string, unknown>) => Promise<any>
}

export function useDashboardVersionBanner({
    ides,
    sendDaemonCommand,
}: UseDashboardVersionBannerOptions) {
    const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null
    const versionMismatchDaemons = useMemo(
        () => ides.filter((daemon: any) => {
            if (daemon.type !== 'adhdev-daemon') return false
            const daemonVersion = daemon.version || daemon.daemonVersion || null
            if (!daemonVersion || !appVersion) return false
            return daemonVersion !== appVersion
        }),
        [appVersion, ides],
    )
    const [versionBannerDismissed, setVersionBannerDismissed] = useState(false)
    const [upgradingDaemons, setUpgradingDaemons] = useState<Record<string, 'upgrading' | 'done' | 'error'>>({})

    const handleBannerUpgrade = useCallback(async (daemonId: string) => {
        setUpgradingDaemons(prev => ({ ...prev, [daemonId]: 'upgrading' }))
        try {
            const result = await sendDaemonCommand(daemonId, 'daemon_upgrade', {})
            if (result?.result?.upgraded || result?.result?.success) {
                setUpgradingDaemons(prev => ({ ...prev, [daemonId]: 'done' }))
            } else {
                setUpgradingDaemons(prev => ({ ...prev, [daemonId]: 'error' }))
            }
        } catch {
            setUpgradingDaemons(prev => ({ ...prev, [daemonId]: 'error' }))
        }
    }, [sendDaemonCommand])

    return {
        versionMismatchDaemons,
        appVersion,
        versionBannerDismissed,
        setVersionBannerDismissed,
        upgradingDaemons,
        handleBannerUpgrade,
    }
}
