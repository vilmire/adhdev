/** Owner Inbox provider decision lane; ordinary worker conversations remain hidden. */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useDaemons } from '../compat'
import { useTransport } from '../context/TransportContext'
import { deriveProviderApprovalInbox } from '../components/MeshGraph/providerApprovalInbox'
import type { ProviderApprovalTarget } from '@adhdev/mesh-shared'
import PendingApprovalsInbox, {
    type PendingApprovalAction,
} from '../components/MeshGraph/PendingApprovalsInbox'
import AppPage from '../components/ui/AppPage'
import { IconWarning } from '../components/Icons'

/** How often the "waiting for N" ages re-render. Display-only; no fetching. */
const WAIT_TICK_MS = 10_000

export default function Approvals() {
    const { t } = useTranslation('common')
    const { ides, connectionStates, initialLoaded } = useDaemons()
    const { sendCommand } = useTransport()

    // Tick only to refresh the rendered wait ages — the approval data itself is push-driven.
    const [nowMs, setNowMs] = useState(() => Date.now())
    useEffect(() => {
        const timer = setInterval(() => setNowMs(Date.now()), WAIT_TICK_MS)
        return () => clearInterval(timer)
    }, [])

    const approvals = useMemo(() => {
        return deriveProviderApprovalInbox(ides, connectionStates)
    }, [ides, connectionStates])

    const resolve = useCallback(
        async (nodeId: string, sessionId: string, action: PendingApprovalAction, approvalTarget?: ProviderApprovalTarget) => {
            if (!approvalTarget) return
            await sendCommand(nodeId, 'resolve_action', { action, sessionId, approvalTarget })
        },
        [sendCommand],
    )

    return (
        <AppPage
            icon={<IconWarning size={18} />}
            title={t('approvals.pageTitle')}
            subtitle={t('approvals.pageSubtitle')}
            badge={approvals.some(item => item.actionable) ? { text: t('approvals.pending'), count: approvals.filter(item => item.actionable).length } : undefined}
        >
            {!initialLoaded ? (
                <div className="text-xs opacity-60 py-6 text-center">{t('approvals.loading')}</div>
            ) : (
                <>
                    <PendingApprovalsInbox
                        approvals={approvals}
                        onResolve={resolve}
                        hideWhenEmpty={false}
                        nowMs={nowMs}
                    />
                    {approvals.length === 0 && (
                        <div className="text-2xs opacity-50 text-center">{t('approvals.emptyHint')}</div>
                    )}
                </>
            )}
        </AppPage>
    )
}
