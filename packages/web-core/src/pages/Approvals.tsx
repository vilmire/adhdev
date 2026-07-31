/**
 * Approvals — the account-wide approval inbox.
 *
 * Every agent session that is blocked on a human decision, across EVERY connected machine,
 * collected into one list so an operator can clear the whole set from a single screen instead
 * of hunting session by session.
 *
 * Data source: no new backend. The dashboard already folds all daemons' sessions into a flat
 * `ActiveConversation[]` (dedupeChatIdes → buildConversations), each row carrying daemonId,
 * machineName, normalized status, and — once hydrated — the modal message and button labels.
 * `deriveApprovalsFromConversations` filters that to the blocking set. This is the same data
 * the dashboard renders, so the inbox can never disagree with the per-session ApprovalBanner.
 *
 * Resolution reuses the existing `resolve_action` daemon command — the identical path the
 * per-session banner and the keyboard shortcut already use. Nothing new is introduced on the
 * daemon side; this screen is purely a second view onto an existing capability.
 *
 * Known freshness caveat (deliberate, not a bug in this file): the live P2P status profile
 * strips `activeModal` (status/normalize.ts LIVE_STATUS_ACTIVE_CHAT_OPTIONS), so a session the
 * user has not opened yet arrives status-only. Such a row still lists — correctly flagged as
 * awaiting approval — but shows its title instead of the question text, and carries no button
 * labels. Approve/Reject still work: `resolve_action` resolves by action, not by button index,
 * when no index is known.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useDaemons } from '../compat'
import { useTransport } from '../context/TransportContext'
import { dedupeChatIdes } from '../hooks/useDashboardConversations'
import { buildConversations } from '../components/dashboard/buildConversations'
import PendingApprovalsInbox, {
    deriveApprovalsFromConversations,
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
        const conversations = buildConversations(dedupeChatIdes(ides), ides, connectionStates)
        return deriveApprovalsFromConversations(conversations)
    }, [ides, connectionStates])

    const resolve = useCallback(
        async (nodeId: string, sessionId: string, action: PendingApprovalAction) => {
            // Reuses the existing per-session resolve path. `button`/`buttonIndex` are omitted:
            // the inbox resolves by intent, and the daemon picks the matching button itself.
            await sendCommand(nodeId, 'resolve_action', { action, sessionId })
        },
        [sendCommand],
    )

    return (
        <AppPage
            icon={<IconWarning size={18} />}
            title={t('approvals.pageTitle')}
            subtitle={t('approvals.pageSubtitle')}
            badge={approvals.length > 0 ? { text: t('approvals.pending'), count: approvals.length } : undefined}
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
                        <div className="text-[11px] opacity-50 text-center">{t('approvals.emptyHint')}</div>
                    )}
                </>
            )}
        </AppPage>
    )
}
