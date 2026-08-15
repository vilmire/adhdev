/**
 * ProviderLogo — deterministic monogram tile for provider branding.
 *
 * Deliberate design decision (owner-approved, 2026-08-15): we do NOT ship
 * third-party logo artwork. Official brand assets would have to live in a
 * public AGPL repo and appear in commercial marketing captures, and the
 * written brand guidelines of the major vendors (OpenAI, Google, Microsoft,
 * Anthropic) require permission for exactly that kind of use. A monogram tile
 * with a brand-adjacent hue (colors are not trademarks) identifies each tool
 * without using anyone's mark. If a vendor later grants logo permission, add a
 * per-type override HERE — every consumer renders through this component.
 *
 * The provider manifest `icon` field (emoji) is untouched for backward
 * compatibility; it is simply no longer rendered by the dashboard.
 */

import { IconPackage } from './Icons'

interface BrandEntry {
    monogram: string
    hue: string
}

/** Curated monogram + hue for the first-party supported set (constants/supported.ts). */
const BRAND: Record<string, BrandEntry> = {
    // CLI agents
    'claude-cli': { monogram: 'CL', hue: '#D97757' },
    'codex-cli': { monogram: 'CX', hue: '#10A37F' },
    'gemini-cli': { monogram: 'GM', hue: '#4285F4' },
    'kimi-cli': { monogram: 'KM', hue: '#6366F1' },
    'antigravity-cli': { monogram: 'AG', hue: '#8B5CF6' },
    'cursor-cli': { monogram: 'CU', hue: '#64748B' },
    'opencode-cli': { monogram: 'OC', hue: '#CA8A04' },
    'hermes-cli': { monogram: 'HM', hue: '#14B8A6' },
    'grok-cli': { monogram: 'GK', hue: '#475569' },
    // IDEs
    'antigravity': { monogram: 'AG', hue: '#8B5CF6' },
    'cursor': { monogram: 'CU', hue: '#64748B' },
    'kiro': { monogram: 'KI', hue: '#F59E0B' },
    'pearai': { monogram: 'PA', hue: '#22C55E' },
    'trae': { monogram: 'TR', hue: '#EF4444' },
    'vscode': { monogram: 'VS', hue: '#3B82F6' },
    'vscodium': { monogram: 'VC', hue: '#2DD4BF' },
    'windsurf': { monogram: 'WS', hue: '#0EA5E9' },
    // IDE extensions
    'cline': { monogram: 'CN', hue: '#0284C7' },
    'roo-code': { monogram: 'RC', hue: '#F97316' },
}

/** Stable, readable hues for types outside the curated set (ACP agents etc.). */
const FALLBACK_HUES = [
    '#0EA5E9', '#8B5CF6', '#10B981', '#F59E0B', '#EF4444', '#14B8A6',
    '#6366F1', '#EC4899', '#84CC16', '#F97316', '#06B6D4', '#A855F7',
]

function hashString(value: string): number {
    let hash = 0
    for (let i = 0; i < value.length; i += 1) {
        hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0
    }
    return Math.abs(hash)
}

/** First letters of the first two words ("Roo Code" → RC); one word → first two chars. */
function deriveMonogram(source: string): string {
    const words = source
        .replace(/[-_./]+/g, ' ')
        .split(/\s+/)
        .map(word => word.trim())
        .filter(Boolean)
    if (words.length === 0) return '?'
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
    return (words[0][0] + words[1][0]).toUpperCase()
}

export interface ProviderLogoProps {
    /** Provider type key, e.g. 'claude-cli'. Drives the curated monogram/hue. */
    type?: string | null
    /** Display name — monogram fallback for types outside the curated set. */
    label?: string | null
    size?: number
    className?: string
}

export function ProviderLogo({ type, label, size = 16, className }: ProviderLogoProps) {
    const key = (type || '').trim().toLowerCase()
    const source = label?.trim() || key
    if (!source) {
        return <IconPackage size={size} className={className} />
    }
    const brand = BRAND[key]
    // Strip the '-cli' suffix from monogram derivation so 'foo-cli' reads 'FO', not 'FC'.
    const monogram = brand?.monogram ?? deriveMonogram(label?.trim() || key.replace(/-cli$/, ''))
    const hue = brand?.hue ?? FALLBACK_HUES[hashString(key || source) % FALLBACK_HUES.length]
    return (
        <span
            aria-hidden
            className={`inline-flex shrink-0 select-none items-center justify-center font-semibold ${className ?? ''}`}
            style={{
                width: size,
                height: size,
                borderRadius: Math.max(4, Math.round(size * 0.3)),
                backgroundColor: `${hue}21`,
                border: `1px solid ${hue}4D`,
                color: hue,
                fontSize: Math.max(7, Math.round(size * 0.42)),
                letterSpacing: '0.02em',
                lineHeight: 1,
            }}
        >
            {monogram}
        </span>
    )
}

export default ProviderLogo
