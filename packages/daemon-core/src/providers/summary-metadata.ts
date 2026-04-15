import type { ProviderSummaryItem, ProviderSummaryMetadata } from '../shared-types.js'

function normalizeSummaryItem(item: ProviderSummaryItem | null | undefined): ProviderSummaryItem | null {
  if (!item || typeof item !== 'object') return null

  const id = String(item.id || '').trim()
  const value = String(item.value || '').trim()
  if (!id || !value) return null

  const normalized: ProviderSummaryItem = {
    id,
    value,
  }

  if (typeof item.label === 'string' && item.label.trim()) normalized.label = item.label.trim()
  if (typeof item.shortValue === 'string' && item.shortValue.trim()) normalized.shortValue = item.shortValue.trim()
  if (typeof item.icon === 'string' && item.icon.trim()) normalized.icon = item.icon.trim()
  if (typeof item.order === 'number' && Number.isFinite(item.order)) normalized.order = item.order

  return normalized
}

export function normalizeProviderSummaryMetadata(
  summary: ProviderSummaryMetadata | null | undefined,
): ProviderSummaryMetadata | undefined {
  if (!summary || !Array.isArray(summary.items)) return undefined

  const items = summary.items
    .map((item) => normalizeSummaryItem(item))
    .filter((item): item is ProviderSummaryItem => !!item)
    .sort((left, right) => {
      const orderDiff = (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER)
      if (orderDiff !== 0) return orderDiff
      return left.id.localeCompare(right.id)
    })

  return items.length > 0 ? { items } : undefined
}

export function buildProviderSummaryMetadata(
  items: Array<ProviderSummaryItem | null | undefined>,
): ProviderSummaryMetadata | undefined {
  return normalizeProviderSummaryMetadata({ items: items.filter(Boolean) as ProviderSummaryItem[] })
}

export function getProviderSummaryItem(
  summary: ProviderSummaryMetadata | null | undefined,
  id: string,
): ProviderSummaryItem | undefined {
  const normalized = normalizeProviderSummaryMetadata(summary)
  const targetId = String(id || '').trim()
  if (!normalized || !targetId) return undefined
  return normalized.items.find((item) => item.id === targetId)
}

export function getProviderSummaryValue(
  summary: ProviderSummaryMetadata | null | undefined,
  id: string,
  options: { preferShortValue?: boolean } = {},
): string | undefined {
  const item = getProviderSummaryItem(summary, id)
  if (!item) return undefined
  if (options.preferShortValue) return item.shortValue || item.value
  return item.value || item.shortValue
}

export function buildLegacyModelModeSummaryMetadata(params: {
  model?: string | null
  mode?: string | null
  modelLabel?: string | null
  modeLabel?: string | null
}): ProviderSummaryMetadata | undefined {
  return buildProviderSummaryMetadata([
    params.model
      ? {
          id: 'model',
          label: 'Model',
          value: String(params.modelLabel || params.model).trim(),
          shortValue: String(params.model).trim(),
          order: 10,
        }
      : null,
    params.mode
      ? {
          id: 'mode',
          label: 'Mode',
          value: String(params.modeLabel || params.mode).trim(),
          shortValue: String(params.mode).trim(),
          order: 20,
        }
      : null,
  ])
}

export function resolveProviderStateSummaryMetadata(params: {
  summaryMetadata?: ProviderSummaryMetadata | null
  controlValues?: Record<string, string | number | boolean> | null
  modelLabel?: string | null
  modeLabel?: string | null
}): ProviderSummaryMetadata | undefined {
  const explicit = normalizeProviderSummaryMetadata(params.summaryMetadata)
  if (explicit) return explicit

  const model = typeof params.controlValues?.model === 'string' ? params.controlValues.model : undefined
  const mode = typeof params.controlValues?.mode === 'string' ? params.controlValues.mode : undefined
  return buildLegacyModelModeSummaryMetadata({
    model,
    mode,
    modelLabel: params.modelLabel,
    modeLabel: params.modeLabel,
  })
}

export function normalizePersistedSummaryMetadata(params: {
  summaryMetadata?: ProviderSummaryMetadata | null
}): ProviderSummaryMetadata | undefined {
  return normalizeProviderSummaryMetadata(params.summaryMetadata)
}
