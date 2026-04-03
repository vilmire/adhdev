import { useCallback, useMemo } from 'react'
import type { SetURLSearchParams } from 'react-router-dom'

import type { ActiveConversation } from '../components/dashboard/types'

interface UseDashboardActiveTabRequestsOptions {
    isMobile: boolean
    urlActiveTab: string | null
    resolveConversationBySessionId: (sessionId: string | null | undefined) => ActiveConversation | undefined
    setSearchParams: SetURLSearchParams
}

export function useDashboardActiveTabRequests({
    isMobile,
    urlActiveTab,
    resolveConversationBySessionId,
    setSearchParams,
}: UseDashboardActiveTabRequestsOptions) {
    const requestedDesktopTabKey = useMemo(() => {
        if (isMobile || !urlActiveTab) return null
        return resolveConversationBySessionId(urlActiveTab)?.tabKey ?? null
    }, [isMobile, resolveConversationBySessionId, urlActiveTab])

    const requestedMobileTabKey = useMemo(() => {
        if (!isMobile || !urlActiveTab) return null
        return resolveConversationBySessionId(urlActiveTab)?.tabKey ?? null
    }, [isMobile, resolveConversationBySessionId, urlActiveTab])

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
