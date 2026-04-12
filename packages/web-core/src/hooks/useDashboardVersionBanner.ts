import { useCallback, useMemo, useState } from 'react'
import type { DaemonData } from '../types'
import { isVersionMismatch, isVersionUpdateRequired } from '../utils/version-update'

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
        () => ides
            .filter((daemon: any) => {
            if (daemon.type !== 'adhdev-daemon') return false
            return isVersionMismatch(daemon, appVersion)
        })
            .sort((a, b) => Number(isVersionUpdateRequired(b, appVersion)) - Number(isVersionUpdateRequired(a, appVersion))),
        [appVersion, ides],
    )
    const hasRequiredVersionDaemons = useMemo(
        () => versionMismatchDaemons.some((daemon) => isVersionUpdateRequired(daemon, appVersion)),
        [appVersion, versionMismatchDaemons],
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
        hasRequiredVersionDaemons,
        appVersion,
        versionBannerDismissed,
        setVersionBannerDismissed,
        upgradingDaemons,
        handleBannerUpgrade,
    }
}
