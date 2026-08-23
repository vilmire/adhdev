import { useTranslation } from 'react-i18next'
import type {
    AutoApproveMode,
    AutoApproveModeRisk,
    AutoApproveModesConfig,
} from '@adhdev/daemon-core'
import LaunchConfirmDialog from '../machine/LaunchConfirmDialog'
import { deriveAutoApproveModeRisk } from '../../utils/auto-approve-modes'

interface AutoApproveModeSelectorProps {
    config: AutoApproveModesConfig
    selectedModeId: string
    disabled?: boolean
    onSelectMode: (mode: AutoApproveMode) => void
}

const RISK_CLASS: Record<AutoApproveModeRisk, string> = {
    safe: 'border-status-online/25 bg-status-online/10 text-status-online',
    caution: 'border-status-warning/30 bg-status-warning/10 text-status-warning',
    dangerous: 'border-status-error/30 bg-status-error/10 text-status-error',
}

export function AutoApproveRiskBadge({ risk }: { risk: AutoApproveModeRisk }) {
    const { t } = useTranslation()
    return (
        <span className={`rounded-full border px-2 py-0.5 text-3xs font-semibold uppercase tracking-wide ${RISK_CLASS[risk]}`}>
            {t(`newSession.autoApproveRisk.${risk}`)}
        </span>
    )
}

export function AutoApproveModeSelector({
    config,
    selectedModeId,
    disabled = false,
    onSelectMode,
}: AutoApproveModeSelectorProps) {
    const { t } = useTranslation()
    return (
        <div className="space-y-2">
            <div className="text-2xs text-text-muted">
                {t('newSession.autoApproveModeDescription')}
            </div>
            <div className="grid grid-cols-1 gap-2" role="radiogroup" aria-label={t('newSession.autoApproveMode')}>
                {config.modes.map(mode => {
                    const effectiveRisk = deriveAutoApproveModeRisk(mode)
                    const selected = selectedModeId === mode.id
                    return (
                        <button
                            key={mode.id}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            className={`flex w-full items-center justify-between gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors ${
                                selected
                                    ? 'border-accent bg-accent/10'
                                    : 'border-border-subtle bg-bg-secondary/40 hover:bg-bg-secondary/70'
                            }`}
                            onClick={() => onSelectMode(mode)}
                            disabled={disabled}
                        >
                            <span className="min-w-0 text-sm font-semibold text-text-primary">{mode.label}</span>
                            <AutoApproveRiskBadge risk={effectiveRisk} />
                        </button>
                    )
                })}
            </div>
        </div>
    )
}

interface LegacyAutoApproveToggleProps {
    checked: boolean
    disabled?: boolean
    onChange: (checked: boolean) => void
}

export function LegacyAutoApproveToggle({
    checked,
    disabled = false,
    onChange,
}: LegacyAutoApproveToggleProps) {
    const { t } = useTranslation()
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            className="flex w-full items-center justify-between gap-3 rounded-xl border border-border-subtle bg-bg-secondary/40 px-3.5 py-3 text-left"
            onClick={() => onChange(!checked)}
            disabled={disabled}
        >
            <span>
                <span className="block text-sm font-semibold text-text-primary">{t('newSession.autoApproveLegacy')}</span>
                <span className="mt-0.5 block text-2xs text-text-muted">{t('newSession.autoApproveLegacyDescription')}</span>
            </span>
            <span className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? 'bg-accent-primary' : 'bg-surface-secondary'}`}>
                <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </span>
        </button>
    )
}

interface DangerousAutoApproveModeDialogProps {
    mode: AutoApproveMode
    onConfirm: () => void
    onCancel: () => void
}

export function DangerousAutoApproveModeDialog({
    mode,
    onConfirm,
    onCancel,
}: DangerousAutoApproveModeDialogProps) {
    const { t } = useTranslation()
    return (
        <LaunchConfirmDialog
            title={t('newSession.dangerousModeTitle')}
            description={mode.warning || t('newSession.dangerousModeFallbackWarning')}
            details={[
                {
                    label: t('newSession.dangerousModeRisk'),
                    value: t('newSession.autoApproveRisk.dangerous'),
                },
                {
                    label: t('newSession.dangerousModeLaunchArgs'),
                    value: JSON.stringify(mode.launchArgs || []),
                },
            ]}
            confirmLabel={t('newSession.dangerousModeConfirm')}
            onConfirm={onConfirm}
            onCancel={onCancel}
        />
    )
}
