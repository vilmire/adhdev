/**
 * Localized copy for provider settings.
 *
 * Provider settings arrive from the daemon with English `label`/`description`
 * strings — some synthesized by daemon-core (`getSyntheticSettings`: enabled,
 * autoApprove, executablePath, …), the rest from provider manifests, which are
 * English-only by design. The dashboard translates by SETTING KEY: every key
 * shared across the shipped providers has an i18n entry here, and any key we
 * don't know (a 3rd-party or brand-new manifest setting) falls back to the
 * daemon-supplied label, then the raw key.
 *
 * Manifest descriptions for the same key vary slightly per provider ("Show
 * notification when Kimi requires approval"); the translated copy is one
 * canonical sentence per key, with the provider name interpolated where the
 * manifests mention it.
 */
import type { TFunction } from 'i18next'

/** Setting keys with a translated label + description (`machine.providerSettings.<key>`). */
export const LOCALIZED_PROVIDER_SETTING_KEYS = [
    'enabled',
    'autoApprove',
    'executablePath',
    'executableArgs',
    'cliPathOverride',
    'appPathOverride',
    'approvalAlert',
    'longGeneratingAlert',
    'longGeneratingThresholdSec',
    'showThinking',
    'showToolCalls',
    'showTerminal',
    'showCoordinatorSystemPrompt',
    'notifications',
] as const

const KNOWN = new Set<string>(LOCALIZED_PROVIDER_SETTING_KEYS)

export interface ProviderSettingCopyInput {
    key: string
    label?: string
    description?: string
}

export function localizeProviderSetting(
    t: TFunction,
    setting: ProviderSettingCopyInput,
    providerName?: string,
): { label: string; description: string } {
    if (!KNOWN.has(setting.key)) {
        return { label: setting.label || setting.key, description: setting.description || '' }
    }
    const params = { provider: providerName || t('machine.providerSettings.thisProvider') }
    return {
        label: t(`machine.providerSettings.${setting.key}.label`, params),
        description: t(`machine.providerSettings.${setting.key}.description`, params),
    }
}

/**
 * A select option's display text. Known values (low/medium/high, on/off, …)
 * are translated; anything else is humanized ("fast-mode" → "Fast mode")
 * instead of shown as a raw manifest token. The stored value never changes.
 */
export function localizeProviderSettingOption(t: TFunction, value: string): string {
    const raw = String(value ?? '')
    const humanized = raw
        .replace(/[-_]+/g, ' ')
        .trim()
        .replace(/^./, c => c.toUpperCase())
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(raw)) return humanized || raw
    return t(`machine.providerSettings.option.${raw.toLowerCase()}`, { defaultValue: humanized || raw })
}
