import { useCallback, useMemo, useState } from 'react'
import type { DaemonData } from '../types'
import { buildDaemonUpgradePayload, getDaemonUpdateTargetVersion } from '../utils/daemon-update-policy'
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
            return isVersionMismatch(daemon, getDaemonUpdateTargetVersion(daemon, appVersion))
        })
            .sort((a, b) => Number(isVersionUpdateRequired(b, getDaemonUpdateTargetVersion(b, appVersion))) - Number(isVersionUpdateRequired(a, getDaemonUpdateTargetVersion(a, appVersion)))),
        [appVersion, ides],
    )
    const hasRequiredVersionDaemons = useMemo(
        () => versionMismatchDaemons.some((daemon) => isVersionUpdateRequired(daemon, getDaemonUpdateTargetVersion(daemon, appVersion))),
        [appVersion, versionMismatchDaemons],
    )
    const targetVersion = useMemo(
        () => versionMismatchDaemons
            .map((daemon) => getDaemonUpdateTargetVersion(daemon, appVersion))
            .find((version): version is string => typeof version === 'string' && version.trim().length > 0) || appVersion,
        [appVersion, versionMismatchDaemons],
    )
    const [versionBannerDismissed, setVersionBannerDismissed] = useState(false)
    const [upgradingDaemons, setUpgradingDaemons] = useState<Record<string, 'upgrading' | 'done' | 'error'>>({})

    const handleBannerUpgrade = useCallback(async (daemonId: string) => {
        const daemon = ides.find((entry) => entry.id === daemonId)
        if (!daemon) return
        setUpgradingDaemons(prev => ({ ...prev, [daemonId]: 'upgrading' }))
        try {
            const result = await sendDaemonCommand(daemonId, 'daemon_upgrade', buildDaemonUpgradePayload(daemon))
            if (result?.result?.upgraded || result?.result?.success) {
                setUpgradingDaemons(prev => ({ ...prev, [daemonId]: 'done' }))
            } else {
                setUpgradingDaemons(prev => ({ ...prev, [daemonId]: 'error' }))
            }
        } catch {
            setUpgradingDaemons(prev => ({ ...prev, [daemonId]: 'error' }))
        }
    }, [ides, sendDaemonCommand])

    return {
        versionMismatchDaemons,
        hasRequiredVersionDaemons,
        targetVersion,
        versionBannerDismissed,
        setVersionBannerDismissed,
        upgradingDaemons,
        handleBannerUpgrade,
    }
}
