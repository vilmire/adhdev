import { useTranslation } from 'react-i18next'
import { IconWarning } from '../Icons'

interface Props {
    pendingCount: number
    onOpen: () => void
}

/** Cloud mobile: always-visible entry to `/approvals` (sidebar flag stays off). */
export default function DashboardMobileApprovalsLink({ pendingCount, onOpen }: Props) {
    const { t } = useTranslation('common')
    const showCount = Number.isFinite(pendingCount) && pendingCount > 0

    return (
        <button
            type="button"
            data-testid="mobile-approvals-entry"
            className="mobile-approvals-entry flex w-full min-h-[44px] items-center justify-between gap-3 rounded-2xl border px-4 py-2.5 text-left transition-colors active:scale-[0.995]"
            style={{
                borderColor: 'color-mix(in srgb, var(--status-warning) 35%, transparent)',
                background: 'color-mix(in srgb, var(--status-warning) 8%, transparent)',
            }}
            onClick={onOpen}
        >
            <span className="flex min-h-[44px] min-w-0 flex-1 items-center gap-2.5">
                <span
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
                    style={{
                        color: 'var(--status-warning)',
                        background: 'color-mix(in srgb, var(--status-warning) 14%, transparent)',
                    }}
                >
                    <IconWarning size={18} />
                </span>
                <span className="min-w-0">
                    <span className="block text-sm font-bold text-text-primary leading-tight">
                        {t('mobileInbox.approvalsStatus')}
                    </span>
                    <span className="block text-3xs text-text-muted leading-snug mt-0.5">
                        {t('mobileInbox.approvalsStatusHint')}
                    </span>
                </span>
            </span>
            {showCount ? (
                <span
                    className="shrink-0 min-h-[28px] min-w-[28px] px-2 inline-flex items-center justify-center rounded-full text-2xs font-bold tabular-nums"
                    style={{
                        color: 'var(--status-warning)',
                        background: 'color-mix(in srgb, var(--status-warning) 18%, transparent)',
                        border: '1px solid color-mix(in srgb, var(--status-warning) 35%, transparent)',
                    }}
                    aria-label={t('mobileInbox.approvalsPendingCount', { count: pendingCount })}
                >
                    {pendingCount}
                </span>
            ) : null}
        </button>
    )
}
