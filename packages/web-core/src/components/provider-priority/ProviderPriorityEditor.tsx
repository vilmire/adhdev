import { useMemo, useState, type ReactNode } from 'react'
import {
  addProviderPriorityItem,
  moveProviderPriorityItem,
  normalizeProviderPriorityForInventory,
  removeProviderPriorityItem,
  type AvailableCliProviderOption,
} from '../../utils/provider-priority'

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
  const [addType, setAddType] = useState('')
  const availableByType = useMemo(() => new Map(availableProviders.map(provider => [provider.type, provider])), [availableProviders])
  const visibleValue = useMemo(() => normalizeProviderPriorityForInventory(value, availableProviders), [value, availableProviders])
  const omittedCount = value.length - visibleValue.length
  const addableProviders = availableProviders.filter(provider => !visibleValue.includes(provider.type))

  const handleAdd = () => {
    if (!addType) return
    onChange(addProviderPriorityItem(visibleValue, addType))
    setAddType('')
  }

  return (
    <div className="rounded-lg border border-border-subtle bg-bg-secondary/60 p-3">
      <div className="flex flex-col gap-2">
        {visibleValue.length === 0 ? (
          <div className="rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-300">
            No provider priority configured. Launches without an explicit CLI provider will fail closed.
          </div>
        ) : visibleValue.map((type, index) => {
          const provider = availableByType.get(type)
          return (
            <div key={type} className="flex flex-col gap-2 rounded-md border border-border-subtle bg-bg-primary px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[10px] font-semibold text-text-muted">#{index + 1}</span>
                  {provider?.icon && <span aria-hidden="true">{provider.icon}</span>}
                  <span className="font-mono text-[12px] text-text-primary">{type}</span>
                  <span className="rounded border border-green-500/20 bg-green-500/10 px-1.5 py-px text-[9px] font-semibold text-green-400">available</span>
                </div>
                <div className="mt-1 text-[10px] text-text-muted">
                  {provider ? `${provider.label} · ${provider.statusLabel}` : type}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm inline-flex h-8 w-8 items-center justify-center p-0"
                  aria-label="Move up"
                  disabled={disabled || index === 0}
                  title="Move up"
                  onClick={() => onChange(moveProviderPriorityItem(visibleValue, type, 'up'))}
                >
                  <IconChevron direction="up" />
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm inline-flex h-8 w-8 items-center justify-center p-0"
                  aria-label="Move down"
                  disabled={disabled || index === visibleValue.length - 1}
                  title="Move down"
                  onClick={() => onChange(moveProviderPriorityItem(visibleValue, type, 'down'))}
                >
                  <IconChevron direction="down" />
                </button>
                <button type="button" className="btn btn-secondary btn-sm text-red-400" disabled={disabled} onClick={() => onChange(removeProviderPriorityItem(visibleValue, type))}>Remove</button>
              </div>
            </div>
          )
        })}
      </div>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="flex-1 text-[11px] text-text-secondary">
          <span className="mb-1 block font-medium text-text-primary">Add available CLI provider</span>
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
        <button type="button" className="btn btn-secondary btn-sm" disabled={disabled || !addType} onClick={handleAdd}>Add provider</button>
        {saveButton}
      </div>
      <div className="mt-2 text-[11px] text-text-muted">
        Inventory is filtered to CLI providers detected on this machine. New launches use this order; existing running sessions may need restart.
        {omittedCount > 0 ? ` ${omittedCount} provider${omittedCount === 1 ? '' : 's'} from the saved policy are not detected now and will be omitted when saved.` : ''}
      </div>
    </div>
  )
}
