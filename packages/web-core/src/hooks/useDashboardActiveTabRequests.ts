import { useCallback, useMemo } from 'react'
import type { SetURLSearchParams } from 'react-router-dom'

import type { ActiveConversation } from '../components/dashboard/types'

interface UseDashboardActiveTabRequestsOptions {
    isMobile: boolean
    urlActiveTab: string | null
    resolveConversationByTarget: (target: string | null | undefined) => ActiveConversation | undefined
    setSearchParams: SetURLSearchParams
}

export function useDashboardActiveTabRequests({
    isMobile,
    urlActiveTab,
    resolveConversationByTarget,
    setSearchParams,
}: UseDashboardActiveTabRequestsOptions) {
    const requestedDesktopTabKey = useMemo(() => {
        if (isMobile || !urlActiveTab) return null
        return resolveConversationByTarget(urlActiveTab)?.tabKey ?? null
    }, [isMobile, resolveConversationByTarget, urlActiveTab])

    const requestedMobileTabKey = useMemo(() => {
        if (!isMobile || !urlActiveTab) return null
        return resolveConversationByTarget(urlActiveTab)?.tabKey ?? null
    }, [isMobile, resolveConversationByTarget, urlActiveTab])

    const consumeRequestedActiveTab = useCallback(() => {
        if (!urlActiveTab) return
        setSearchParams(prev => {
            const next = new URLSearchParams(prev)
            next.delete('activeTab')
            return next
        }, { replace: true })
    }, [setSearchParams, urlActiveTab])

    return {
        requestedDesktopTabKey,
        requestedMobileTabKey,
        consumeRequestedActiveTab,
    }
}
