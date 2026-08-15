/**
 * ProviderInstallOptionsModal — the options a user gets to set AT INSTALL time,
 * shown when a provider is switched on from the machine page.
 *
 * WHY THIS EXISTS: both settings below were already reachable, but only after
 * the fact and in two different places (the provider row's quota switch, and
 * the provider's own `autoApprove` setting further down the same row). A user
 * enabling a provider had no idea either existed, so the effective choice was
 * whatever the default happened to be. This surfaces them at the one moment the
 * user is already thinking about the provider.
 *
 * IT INTRODUCES NO NEW STORAGE AND NO NEW SEMANTICS. Both controls write the
 * exact commands the existing surfaces write — `set_quota_provider_enabled` and
 * `set_provider_setting autoApprove` — so the machine page, `adhdev setup` and
 * this modal are three views of one stored value in the daemon's config.json.
 * Anything that changes here changes there, in both directions.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import ModalPortal from '../../components/ui/ModalPortal'

export interface ProviderInstallOptions {
    /** Undefined when the provider has no quota fetcher — the row is not shown. */
    quotaEnabled?: boolean
    autoApprove: boolean
}

interface ProviderInstallOptionsModalProps {
    providerType: string
    displayName: string
    /**
     * Whether to offer the quota row at all. False for providers with no
     * shipped fetcher (cursor-cli, antigravity-cli, hermes-cli): a switch that
     * cannot collect anything would be a promise the daemon can't keep, so the
     * row is omitted rather than shown disabled.
     */
    supportsQuota: boolean
    /**
     * True when enabling this provider's quota ALSO installs the Claude
     * statusLine wrapper into ~/.claude/settings.json. Claude Code has no quota
     * API, so that wrapper is the only collection path — and it is the one
     * quota choice here with a side effect outside ADHDev's own config, which
     * the user is told about before confirming rather than after.
     */
    quotaInstallsClaudeStatusline: boolean
    onCancel: () => void
    onConfirm: (options: ProviderInstallOptions) => void
}

export default function ProviderInstallOptionsModal({
    providerType,
    displayName,
    supportsQuota,
    quotaInstallsClaudeStatusline,
    onCancel,
    onConfirm,
}: ProviderInstallOptionsModalProps) {
    const { t } = useTranslation('common')
    // Both default ON (owner decision). They are the values that get written
    // only if the user confirms — cancelling enables nothing at all.
    const [quotaEnabled, setQuotaEnabled] = useState(true)
    const [autoApprove, setAutoApprove] = useState(true)

    return (
        <ModalPortal>
            {/* Overlay markup is this component's own — ModalPortal is a bare
                portal-to-body primitive and supplies no backdrop. Clicking the
                backdrop cancels, which enables nothing (see onCancel). */}
            <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
                onClick={onCancel}
            >
            <div
                className="w-[min(520px,92vw)] rounded-xl border border-border-default bg-surface-primary p-5 shadow-2xl"
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
            >
                <div className="text-[13px] font-semibold text-text-primary">
                    {t('machine.installOptions.title', { provider: displayName })}
                </div>
                <div className="mt-1 text-[11px] text-text-muted">
                    {t('machine.installOptions.subtitle')}
                </div>

                <div className="mt-4 flex flex-col gap-3">
                    {supportsQuota && (
                        <label className="flex cursor-pointer items-start gap-2.5">
                            <input
                                type="checkbox"
                                checked={quotaEnabled}
                                onChange={(e) => setQuotaEnabled(e.target.checked)}
                                className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-accent-primary"
                            />
                            <span className="min-w-0">
                                <span className="block text-[12px] font-medium text-text-primary">
                                    {t('machine.installOptions.quotaLabel')}
                                </span>
                                <span className="mt-0.5 block text-[11px] text-text-muted">
                                    {t('machine.installOptions.quotaHint')}
                                </span>
                                {quotaInstallsClaudeStatusline && quotaEnabled && (
                                    <span className="mt-1 block text-[11px] text-amber-400">
                                        {t('machine.installOptions.quotaClaudeNote')}
                                    </span>
                                )}
                            </span>
                        </label>
                    )}

                    <label className="flex cursor-pointer items-start gap-2.5">
                        <input
                            type="checkbox"
                            checked={autoApprove}
                            onChange={(e) => setAutoApprove(e.target.checked)}
                            className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-accent-primary"
                        />
                        <span className="min-w-0">
                            <span className="block text-[12px] font-medium text-text-primary">
                                {t('machine.installOptions.autoApproveLabel')}
                            </span>
                            {/* Spells out what is SKIPPED, not just that something
                                is "automatic" — this defaults ON, so the user has
                                to be able to understand the consequence by
                                reading it once. */}
                            <span className="mt-0.5 block text-[11px] text-text-muted">
                                {t('machine.installOptions.autoApproveHint')}
                            </span>
                            {autoApprove && (
                                <span className="mt-1 block text-[11px] text-amber-400">
                                    {t('machine.installOptions.autoApproveWarning')}
                                </span>
                            )}
                        </span>
                    </label>
                </div>

                <div className="mt-3 text-[10px] text-text-muted">
                    {t('machine.installOptions.changeableLater')}
                </div>

                <div className="mt-4 flex justify-end gap-2">
                    <button onClick={onCancel} className="machine-btn text-[11px] px-3 py-1">
                        {t('machine.installOptions.cancel')}
                    </button>
                    <button
                        onClick={() => onConfirm({
                            quotaEnabled: supportsQuota ? quotaEnabled : undefined,
                            autoApprove,
                        })}
                        className="machine-btn text-[11px] px-3 py-1 border-accent-primary/30 bg-accent-primary/15 text-accent-primary"
                        data-provider-type={providerType}
                    >
                        {t('machine.installOptions.confirm')}
                    </button>
                </div>
            </div>
            </div>
        </ModalPortal>
    )
}
