/**
 * TrustBadge — small visual element rendered next to a provider name
 * to surface where its manifest came from and whether the daemon will
 * run untrusted JavaScript from it.
 *
 * Values map 1:1 to the daemon-core `ProviderTrust` union exposed via
 * list_provider_availability.
 */
import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

export type ProviderTrust =
    | 'user-custom'
    | 'trusted'
    | 'trusted-with-scripts'
    | 'external-safe'
    | 'external-untrusted'

interface TrustBadgeProps {
    trust: ProviderTrust
    sourceName?: string | null
    /** When provided, hover surfaces the daemon-side description. */
    description?: string
}

/** i18n keys (`machine.trustBadge.*`) — plain words, no manifest-tier jargon. */
const LABEL_KEY: Record<ProviderTrust, string> = {
    'user-custom': 'machine.trustBadge.userCustom',
    'trusted': 'machine.trustBadge.trusted',
    'trusted-with-scripts': 'machine.trustBadge.trustedWithScripts',
    'external-safe': 'machine.trustBadge.externalSafe',
    'external-untrusted': 'machine.trustBadge.externalUntrusted',
}
const TOOLTIP_KEY: Record<ProviderTrust, string> = {
    'user-custom': 'machine.trustBadge.userCustomHint',
    'trusted': 'machine.trustBadge.trustedHint',
    'trusted-with-scripts': 'machine.trustBadge.trustedWithScriptsHint',
    'external-safe': 'machine.trustBadge.externalSafeHint',
    'external-untrusted': 'machine.trustBadge.externalUntrustedHint',
}

const TONE: Record<ProviderTrust, string> = {
    'user-custom': 'bg-violet-500/[0.10] border-violet-500/25 text-violet-300',
    'trusted': 'bg-green-500/[0.10] border-green-500/25 text-green-400',
    'trusted-with-scripts': 'bg-emerald-500/[0.10] border-emerald-500/25 text-emerald-400',
    'external-safe': 'bg-sky-500/[0.10] border-sky-500/25 text-sky-400',
    'external-untrusted': 'bg-amber-500/[0.10] border-amber-500/30 text-amber-300',
}

export default function TrustBadge({ trust, sourceName, description }: TrustBadgeProps): ReactElement {
    const { t } = useTranslation('common')
    const base = LABEL_KEY[trust] ? t(LABEL_KEY[trust]) : trust
    const label = sourceName && (trust === 'external-safe' || trust === 'external-untrusted')
        ? `${base} · ${sourceName}`
        : base
    // The daemon's `description` is English developer copy; the localized
    // plain-language hint is what the user hovers. Unknown tiers fall back.
    const title = TOOLTIP_KEY[trust] ? t(TOOLTIP_KEY[trust]) : description
    return (
        <span
            className={`text-3xs px-1.5 py-0.5 rounded border whitespace-nowrap ${TONE[trust] ?? ''}`}
            title={title}
        >
            {label}
        </span>
    )
}
