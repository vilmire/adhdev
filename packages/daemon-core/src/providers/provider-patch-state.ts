import type { ProviderControlDef } from './contracts.js'
import { extractProviderControlValues } from './control-effects.js'
import { resolveProviderStateSummaryMetadata } from './summary-metadata.js'


export type ProviderControlValue = string | number | boolean
export type ProviderControlValueMap = Record<string, ProviderControlValue>

function isControlValue(value: unknown): value is ProviderControlValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function asControlValueMap(value: unknown): ProviderControlValueMap | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined

  const result: ProviderControlValueMap = {}
  for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
    if (isControlValue(entryValue)) result[entryKey] = entryValue
  }

  return Object.keys(result).length > 0 ? result : undefined
}

function getLegacyModelModeValues(data: any): ProviderControlValueMap | undefined {
  if (!data || typeof data !== 'object') return undefined

  const legacy: ProviderControlValueMap = {}
  if (typeof data.model === 'string' && data.model.trim()) legacy.model = data.model.trim()
  if (typeof data.mode === 'string' && data.mode.trim()) legacy.mode = data.mode.trim()

  return Object.keys(legacy).length > 0 ? legacy : undefined
}

export function mergeProviderPatchState(params: {
  providerControls?: ProviderControlDef[]
  data: any
  currentControlValues?: ProviderControlValueMap
  currentSummaryMetadata?: unknown
  mergeWithCurrent?: boolean
}): {
  controlValues: ProviderControlValueMap
  summaryMetadata: unknown
} {
  const {
    providerControls,
    data,
    currentControlValues,
    currentSummaryMetadata,
    mergeWithCurrent = true,
  } = params

  const sources = [
    mergeWithCurrent ? asControlValueMap(currentControlValues) : undefined,
    asControlValueMap(data?.controlValues),
    asControlValueMap(extractProviderControlValues(providerControls, data)),
    getLegacyModelModeValues(data),
  ]

  const controlValues = Object.assign({}, ...sources.filter(Boolean)) as ProviderControlValueMap
  return {
    controlValues,
    summaryMetadata: data?.summaryMetadata !== undefined ? data.summaryMetadata : currentSummaryMetadata,
  }
}

export function normalizeProviderStateControlValues(
  controlValues: ProviderControlValueMap | undefined,
): ProviderControlValueMap | undefined {
  return controlValues && Object.keys(controlValues).length > 0 ? controlValues : undefined
}

export function resolveProviderStateSurface(params: {
  controlValues?: ProviderControlValueMap
  summaryMetadata?: unknown
  modelLabel?: string | null
  modeLabel?: string | null
}): {
  controlValues: ProviderControlValueMap | undefined
  summaryMetadata: unknown
} {
  const controlValues = normalizeProviderStateControlValues(params.controlValues)
  return {
    controlValues,
    summaryMetadata: resolveProviderStateSummaryMetadata({
      summaryMetadata: params.summaryMetadata as any,
      controlValues,
      modelLabel: params.modelLabel,
      modeLabel: params.modeLabel,
    }),
  }
}
