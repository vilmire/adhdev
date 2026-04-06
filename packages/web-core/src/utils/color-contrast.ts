function normalizeHex(value: string): string | null {
    const trimmed = value.trim()
    if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed
    if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
        return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`
    }
    return null
}

function hexToRgb(hex: string) {
    return {
        r: parseInt(hex.slice(1, 3), 16),
        g: parseInt(hex.slice(3, 5), 16),
        b: parseInt(hex.slice(5, 7), 16),
    }
}

function channelToLinear(channel: number): number {
    const normalized = channel / 255
    return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4
}

function getRelativeLuminance(hex: string): number {
    const { r, g, b } = hexToRgb(hex)
    return 0.2126 * channelToLinear(r) + 0.7152 * channelToLinear(g) + 0.0722 * channelToLinear(b)
}

function getContrastRatio(left: string, right: string): number {
    const leftLum = getRelativeLuminance(left)
    const rightLum = getRelativeLuminance(right)
    const lighter = Math.max(leftLum, rightLum)
    const darker = Math.min(leftLum, rightLum)
    return (lighter + 0.05) / (darker + 0.05)
}

export function getReadableAccentTextColor(accentHex: string): '#111827' | '#ffffff' {
    const normalized = normalizeHex(accentHex)
    if (!normalized) return '#111827'

    const darkText = '#111827'
    const lightText = '#ffffff'

    return getContrastRatio(normalized, darkText) >= getContrastRatio(normalized, lightText)
        ? darkText
        : lightText
}
