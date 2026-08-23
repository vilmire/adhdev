/**
 * TrustBadge — small visual element rendered next to a provider name
 * to surface where its manifest came from and whether the daemon will
 * run untrusted JavaScript from it.
 *
 * Values map 1:1 to the daemon-core `ProviderTrust` union exposed via
 * list_provider_availability.
 */
import type { ReactElement } from 'react'

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

const LABEL: Record<ProviderTrust, string> = {
    'user-custom': 'Custom',
    'trusted': 'Official',
    'trusted-with-scripts': 'Official · runs JS',
    'external-safe': 'External · spec-only',
    'external-untrusted': 'External · untrusted JS',
}

const TONE: Record<ProviderTrust, string> = {
    'user-custom': 'bg-violet-500/[0.10] border-violet-500/25 text-violet-300',
    'trusted': 'bg-green-500/[0.10] border-green-500/25 text-green-400',
    'trusted-with-scripts': 'bg-emerald-500/[0.10] border-emerald-500/25 text-emerald-400',
    'external-safe': 'bg-sky-500/[0.10] border-sky-500/25 text-sky-400',
    'external-untrusted': 'bg-amber-500/[0.10] border-amber-500/30 text-amber-300',
}

export default function TrustBadge({ trust, sourceName, description }: TrustBadgeProps): ReactElement {
    const label = sourceName && (trust === 'external-safe' || trust === 'external-untrusted')
        ? `${LABEL[trust]} · ${sourceName}`
        : LABEL[trust]
    return (
        <span
            className={`text-3xs px-1.5 py-0.5 rounded border whitespace-nowrap ${TONE[trust]}`}
            title={description}
        >
            {label}
        </span>
    )
}
