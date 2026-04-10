import type { ProviderSettingsEntry, ProviderInfo } from './types'

export interface ProviderSettingsPayload {
    settings: Record<string, ProviderSettingsEntry['schema']>
    values: Record<string, Record<string, unknown>>
}

interface ProviderSettingsResponse {
    success?: boolean
    result?: unknown
    settings?: unknown
    values?: unknown
}

export function extractProviderSettingsPayload(response: unknown): ProviderSettingsPayload | null {
    if (!response || typeof response !== 'object') return null

    const commandResponse = response as ProviderSettingsResponse
    const payload = commandResponse.result && typeof commandResponse.result === 'object'
        ? commandResponse.result as { settings?: unknown; values?: unknown }
        : commandResponse

    if (!payload.settings || typeof payload.settings !== 'object') return null

    return {
        settings: payload.settings as Record<string, ProviderSettingsEntry['schema']>,
        values: payload.values && typeof payload.values === 'object'
            ? payload.values as Record<string, Record<string, unknown>>
            : {},
    }
}

export function buildProviderSettingsEntries(
    payload: ProviderSettingsPayload,
    providers: ProviderInfo[],
    options?: {
        filterSchema?: (schema: ProviderSettingsEntry['schema']) => ProviderSettingsEntry['schema']
    },
): ProviderSettingsEntry[] {
    const entries: ProviderSettingsEntry[] = []

    for (const [type, rawSchema] of Object.entries(payload.settings)) {
        const schema = options?.filterSchema ? options.filterSchema(rawSchema) : rawSchema
        if (schema.length === 0) continue

        const provider = providers.find((item) => item.type === type)
        entries.push({
            type,
            displayName: provider?.displayName || type,
            icon: provider?.icon || '',
            category: provider?.category || 'unknown',
            schema,
            values: payload.values[type] || {},
        })
    }

    return entries
}
