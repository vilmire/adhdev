import { useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  addProviderPriorityItem,
  moveProviderPriorityItem,
  normalizeProviderPriority,
  removeProviderPriorityItem,
  type AvailableCliProviderOption,
} from '../../utils/provider-priority'
import { ProviderLogo } from '../ProviderLogo'

interface ProviderPriorityEditorProps {
  value: string[]
  availableProviders: AvailableCliProviderOption[]
  onChange: (next: string[]) => void
  disabled?: boolean
  saveButton?: ReactNode
}

function IconChevron({ direction }: { direction: 'up' | 'down' }) {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {direction === 'up' ? <polyline points="18 15 12 9 6 15" /> : <polyline points="6 9 12 15 18 9" />}
    </svg>
  )
}

export default function ProviderPriorityEditor({
  value,
  availableProviders,
  onChange,
  disabled = false,
  saveButton,
}: ProviderPriorityEditorProps) {
  const { t } = useTranslation('common')
  const [addType, setAddType] = useState('')
  const availableByType = useMemo(() => new Map(availableProviders.map(provider => [provider.type, provider])), [availableProviders])
  // Show the FULL saved order (not just detected providers) so the operator can
  // always see and reorder what they configured — undetected entries render greyed
  // out with an "unavailable" tag instead of vanishing behind a warning banner.
  const orderedValue = useMemo(() => normalizeProviderPriority(value), [value])
  const undetectedCount = orderedValue.filter(type => !availableByType.has(type)).length
  const addableProviders = availableProviders.filter(provider => !orderedValue.includes(provider.type))

  const handleAdd = () => {
    if (!addType) return
    onChange(addProviderPriorityItem(orderedValue, addType))
    setAddType('')
  }

  return (
    <div className="rounded-lg border border-border-subtle bg-bg-secondary/60 p-3">
      <div className="flex flex-col gap-2">
        {orderedValue.length === 0 ? (
          <div className="rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-300">
            No provider priority configured. Launches without an explicit CLI provider will fail closed.
          </div>
        ) : orderedValue.map((type, index) => {
          const provider = availableByType.get(type)
          const detected = !!provider
          return (
            <div key={type} className={`flex flex-col gap-2 rounded-md border border-border-subtle px-3 py-2 sm:flex-row sm:items-center sm:justify-between ${detected ? 'bg-bg-primary' : 'bg-bg-primary/40'}`}>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-3xs font-semibold text-text-muted">#{index + 1}</span>
                  <ProviderLogo type={type} label={provider?.label} size={14} />
                  <span className={`font-mono text-[12px] ${detected ? 'text-text-primary' : 'text-text-muted'}`}>{type}</span>
                  {detected ? (
                    <span className="rounded border border-green-500/20 bg-green-500/10 px-1.5 py-px text-4xs font-semibold text-green-400">{t('settings.providerPriority.available')}</span>
                  ) : (
                    <span className="rounded border border-amber-500/25 bg-amber-500/10 px-1.5 py-px text-4xs font-semibold text-amber-400">{t('settings.providerPriority.notOnMachine')}</span>
                  )}
                </div>
                <div className="mt-1 text-3xs text-text-muted">
                  {provider ? `${provider.label} · ${provider.statusLabel}` : 'Kept in order; skipped at launch until detected here.'}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm inline-flex h-8 w-8 items-center justify-center p-0"
                  aria-label="Move up"
                  disabled={disabled || index === 0}
                  title="Move up"
                  onClick={() => onChange(moveProviderPriorityItem(orderedValue, type, 'up'))}
                >
                  <IconChevron direction="up" />
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm inline-flex h-8 w-8 items-center justify-center p-0"
                  aria-label="Move down"
                  disabled={disabled || index === orderedValue.length - 1}
                  title="Move down"
                  onClick={() => onChange(moveProviderPriorityItem(orderedValue, type, 'down'))}
                >
                  <IconChevron direction="down" />
                </button>
                <button type="button" className="btn btn-secondary btn-sm text-red-400" disabled={disabled} onClick={() => onChange(removeProviderPriorityItem(orderedValue, type))}>{t('settings.providerPriority.remove')}</button>
              </div>
            </div>
          )
        })}
      </div>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="flex-1 text-2xs text-text-secondary">
          <span className="mb-1 block font-medium text-text-primary">{t('settings.providerPriority.addCliLabel')}</span>
          <select
            className="w-full rounded-lg border border-border-subtle bg-bg-secondary px-3 py-2 text-sm text-text-primary"
            value={addType}
            onChange={event => setAddType(event.target.value)}
            disabled={disabled || addableProviders.length === 0}
          >
            <option value="">{addableProviders.length ? 'Select provider…' : 'No additional detected CLI providers'}</option>
            {addableProviders.map(provider => (
              <option key={provider.type} value={provider.type}>{provider.label} ({provider.type})</option>
            ))}
          </select>
        </label>
        <button type="button" className="btn btn-secondary btn-sm" disabled={disabled || !addType} onClick={handleAdd}>{t('settings.providerPriority.addProvider')}</button>
        {saveButton}
      </div>
      <div className="mt-2 text-2xs text-text-muted">
        Launches use this order, top to bottom.
        {undetectedCount > 0 ? ` ${undetectedCount} provider${undetectedCount === 1 ? '' : 's'} not detected here — kept in order, skipped until available.` : ''}
      </div>
    </div>
  )
}
