import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { getDashboardWireCompat, subscribeDashboardWireCompat } from '../managers/dashboard-wire-compat'

/**
 * The page and a daemon speak different dashboard wire versions, so nothing
 * that daemon sends is rendered (no dual-format serving):
 *   - a daemon is NEWER than this page → a non-dismissable reload overlay (the
 *     bundle cannot read the daemon's frames; stale state is never shown);
 *   - a daemon is OLDER → a persistent notice naming how many machines need a
 *     daemon update (the rest of the dashboard keeps working).
 */
export default function DashboardWireCompatOverlay() {
    const state = useSyncExternalStore(subscribeDashboardWireCompat, getDashboardWireCompat, getDashboardWireCompat)
    const { t } = useTranslation('common')

    if (state.reloadRequired) {
        return (
            <div
                className="fixed inset-0 z-[var(--z-modal,1000)] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="dashboard-wire-reload-title"
                data-testid="dashboard-wire-reload-overlay"
            >
                <div className="max-w-[420px] w-full rounded-2xl border border-border-default bg-bg-primary p-5 shadow-2xl text-text-primary">
                    <h2 id="dashboard-wire-reload-title" className="text-base font-semibold mb-2">{t('app.dashboardWire.reloadTitle')}</h2>
                    <p className="text-sm text-text-secondary mb-4">{t('app.dashboardWire.reloadBody')}</p>
                    <button
                        type="button"
                        className="w-full rounded-lg px-3 py-2 text-sm font-semibold bg-accent-primary text-white hover:opacity-90"
                        onClick={() => window.location.reload()}
                    >
                        {t('app.dashboardWire.reload')}
                    </button>
                </div>
            </div>
        )
    }

    if (state.daemonUpdateRequired.length === 0) return null
    return (
        <div
            className="fixed left-1/2 top-[calc(env(safe-area-inset-top,0px)+12px)] z-[var(--z-toast)] max-w-[min(720px,calc(100vw-24px))] rounded-2xl border px-4 py-2.5 text-[13px] leading-[1.6] shadow-[0_18px_40px_rgba(2,6,23,0.24)] backdrop-blur-xl"
            style={{
                transform: 'translateX(-50%)',
                background: 'color-mix(in srgb, var(--status-warning, #f59e0b) 14%, var(--bg-primary))',
                border: '1px solid color-mix(in srgb, var(--status-warning, #f59e0b) 40%, transparent)',
            }}
            role="status"
            data-testid="dashboard-wire-daemon-update"
        >
            <div className="font-semibold">{t('app.dashboardWire.daemonUpdateTitle')}</div>
            <div className="text-text-secondary">{t('app.dashboardWire.daemonUpdateBody', { count: state.daemonUpdateRequired.length })}</div>
        </div>
    )
}
