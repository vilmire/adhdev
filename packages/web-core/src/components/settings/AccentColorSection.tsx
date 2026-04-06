/**
 * AccentColorSection — Global accent color customizer.
 * Changes --accent-primary and derived variables.
 * Persisted in localStorage.
 */
import { useState, useEffect } from 'react'
import { getReadableAccentTextColor } from '../../utils/color-contrast'

const STORAGE_KEY = 'adhdev-accent-color'

const PRESETS = [
    { name: 'Amber', color: '#f59e0b' },
    { name: 'Orange', color: '#f97316' },
    { name: 'Violet', color: '#8b5cf6' },
    { name: 'Indigo', color: '#6366f1' },
    { name: 'Blue', color: '#3b82f6' },
    { name: 'Cyan', color: '#06b6d4' },
    { name: 'Emerald', color: '#10b981' },
    { name: 'Rose', color: '#f43f5e' },
]

const DEFAULT_COLOR = '#cf7a45'

function hexToHSL(hex: string): { h: number; s: number; l: number } {
    const r = parseInt(hex.slice(1, 3), 16) / 255
    const g = parseInt(hex.slice(3, 5), 16) / 255
    const b = parseInt(hex.slice(5, 7), 16) / 255
    const max = Math.max(r, g, b), min = Math.min(r, g, b)
    let h = 0, s = 0
    const l = (max + min) / 2
    if (max !== min) {
        const d = max - min
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
        switch (max) {
            case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break
            case g: h = ((b - r) / d + 2) / 6; break
            case b: h = ((r - g) / d + 4) / 6; break
        }
    }
    return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) }
}

function lighten(hex: string, amount: number): string {
    const { h, s, l } = hexToHSL(hex)
    const nl = Math.min(100, l + amount)
    return `hsl(${h}, ${s}%, ${nl}%)`
}

function withAlpha(hex: string, alpha: number): string {
    const r = parseInt(hex.slice(1, 3), 16)
    const g = parseInt(hex.slice(3, 5), 16)
    const b = parseInt(hex.slice(5, 7), 16)
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export function getAccentColor(): string {
    if (typeof window === 'undefined') return DEFAULT_COLOR
    return localStorage.getItem(STORAGE_KEY) || DEFAULT_COLOR
}

export function hasCustomAccentColor(): boolean {
    if (typeof window === 'undefined') return false
    try {
        return localStorage.getItem(STORAGE_KEY) != null
    } catch {
        return false
    }
}

export function applyAccentColor(color: string) {
    const root = document.documentElement
    root.style.setProperty('--accent-primary', color)
    root.style.setProperty('--accent-primary-light', lighten(color, 15))
    root.style.setProperty('--accent-on-primary', getReadableAccentTextColor(color))
    root.style.setProperty('--accent-gradient', `linear-gradient(135deg, ${color}, ${lighten(color, 20)})`)
    root.style.setProperty('--border-accent', withAlpha(color, 0.4))
    // Also update active nav glow
    root.style.setProperty('--nav-active-bg', withAlpha(color, 0.1))
    root.style.setProperty('--nav-active-shadow', `inset 3px 0 0 ${color}, 0 0 12px ${withAlpha(color, 0.06)}`)
}

function clearAccentColor() {
    const root = document.documentElement
    const vars = ['--accent-primary', '--accent-primary-light', '--accent-on-primary', '--accent-gradient', '--border-accent', '--nav-active-bg', '--nav-active-shadow']
    vars.forEach(v => root.style.removeProperty(v))
}

export function setAccentColor(color: string) {
    if (color === DEFAULT_COLOR) {
        localStorage.removeItem(STORAGE_KEY)
        clearAccentColor()
    } else {
        localStorage.setItem(STORAGE_KEY, color)
        applyAccentColor(color)
    }
}

/** Call on app init to restore persisted accent */
export function initAccentColor() {
    const color = getAccentColor()
    if (color !== DEFAULT_COLOR) {
        applyAccentColor(color)
    }
}

// ─── Component ──────────────────────────────────
export function AccentColorSection() {
    const [current, setCurrent] = useState(getAccentColor)
    const [customInput, setCustomInput] = useState('')

    useEffect(() => {
        setCurrent(getAccentColor())
    }, [])

    const select = (color: string) => {
        setCurrent(color)
        setAccentColor(color)
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* Preset swatches */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {PRESETS.map(p => {
                    const isActive = current === p.color
                    return (
                        <button
                            key={p.color}
                            onClick={() => select(p.color)}
                            title={p.name}
                            style={{
                                width: 36, height: 36,
                                borderRadius: 10,
                                background: p.color,
                                border: isActive ? '3px solid var(--text-primary)' : '3px solid transparent',
                                cursor: 'pointer',
                                position: 'relative',
                                transition: 'transform 0.15s, border-color 0.15s',
                                transform: isActive ? 'scale(1.1)' : 'scale(1)',
                                boxShadow: isActive ? `0 0 12px ${withAlpha(p.color, 0.4)}` : 'none',
                            }}
                        >
                            {isActive && (
                                <span style={{
                                    position: 'absolute', inset: 0,
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    color: '#fff', fontSize: 14, fontWeight: 700,
                                    textShadow: '0 1px 2px rgba(0,0,0,0.5)',
                                }}>✓</span>
                            )}
                        </button>
                    )
                })}
            </div>

            {/* Custom color */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Custom:</span>
                <input
                    type="color"
                    value={current}
                    onChange={e => select(e.target.value)}
                    style={{
                        width: 28, height: 28, border: 'none', borderRadius: 6,
                        cursor: 'pointer', background: 'transparent', padding: 0,
                    }}
                />
                <input
                    type="text"
                    value={customInput || current}
                    onChange={e => {
                        setCustomInput(e.target.value)
                        if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) select(e.target.value)
                    }}
                    onBlur={() => setCustomInput('')}
                    style={{
                        width: 80, fontSize: '0.7rem', fontFamily: 'monospace',
                        background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)',
                        borderRadius: 4, padding: '3px 6px', color: 'var(--text-primary)',
                    }}
                />
                {current !== DEFAULT_COLOR && (
                    <button
                        onClick={() => select(DEFAULT_COLOR)}
                        style={{
                            fontSize: '0.7rem', color: 'var(--text-muted)',
                            background: 'transparent', border: '1px solid var(--border-subtle)',
                            borderRadius: 5, padding: '3px 8px', cursor: 'pointer',
                        }}
                    >
                        Reset
                    </button>
                )}
            </div>
        </div>
    )
}
