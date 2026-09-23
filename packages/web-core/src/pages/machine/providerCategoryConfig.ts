/**
 * Single source of truth for provider-category color coding.
 *
 * `ide` / `cli` / `acp` / `extension` are a classification axis (which kind
 * of provider this is) and must render as the same color everywhere they
 * appear, or the color stops carrying meaning. Every hue here is chosen to
 * stay clear of TrustBadge's violet/green/emerald/sky/amber palette (they
 * co-occur in the same InstalledProviderRow line) and of the red/orange/
 * yellow/green already used for status (detected/error/generating/warning)
 * in these same screens.
 */
// Wiring-unification A4: the one ProviderCategory lives in daemon-core
// (providers/contracts.ts); type-only import, re-exported for the row/badge
// consumers that import it from here.
import type { ProviderCategory } from '@adhdev/daemon-core'
export type { ProviderCategory }

interface ProviderCategoryColor {
    // Badge classes (bg + text + border), for compact category chips.
    badge: string
    /** Low-opacity border-only class, for accenting a larger panel/card. */
    accent: string
}

export const PROVIDER_CATEGORY_COLOR: Record<ProviderCategory, ProviderCategoryColor> = {
    ide: {
        badge: 'bg-blue-500/10 text-blue-300 border-blue-500/20',
        accent: 'border-blue-500/[0.12]',
    },
    cli: {
        badge: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/20',
        accent: 'border-indigo-500/[0.12]',
    },
    acp: {
        badge: 'bg-fuchsia-500/10 text-fuchsia-300 border-fuchsia-500/20',
        accent: 'border-fuchsia-500/[0.12]',
    },
    extension: {
        badge: 'bg-teal-500/10 text-teal-300 border-teal-500/20',
        accent: 'border-teal-500/[0.12]',
    },
}
