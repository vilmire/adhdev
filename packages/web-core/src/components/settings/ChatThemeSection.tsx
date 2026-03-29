/**
 * ChatThemeSection — Unified theme picker for Settings page.
 * Applies data-chat-theme attribute to :root for CSS variable overrides.
 * Persisted in localStorage. Supports light/dark mode preview.
 * Custom theme editor allows full app + chat color customization.
 */
import { useState, useEffect, useCallback } from 'react'

// ─── Theme Definitions ──────────────────────────
export interface ChatThemePreset {
    id: string
    name: string
    description: string
    preview: {
        dark: { userBubble: string; assistantBubble: string; assistantBorder: string; containerBg: string; textColor: string }
        light: { userBubble: string; assistantBubble: string; assistantBorder: string; containerBg: string; textColor: string }
    }
}

export interface CustomThemeColors {
    // ── App Global ──
    bgPrimary: string
    bgSecondary: string
    surfacePrimary: string
    textPrimary: string
    textSecondary: string
    textMuted: string
    borderSubtle: string
    borderDefault: string
    accentColor: string
    // ── Chat ──
    userBubble: string
    userText: string
    assistantBubble: string
    assistantText: string
    containerBg: string
    sendButton: string
    inputBorder: string
    bubbleRadius: number // px
}

const DEFAULT_CUSTOM_DARK: CustomThemeColors = {
    bgPrimary: '#0f0f13',
    bgSecondary: '#18181d',
    surfacePrimary: '#111116',
    textPrimary: '#fafafa',
    textSecondary: '#a8a8b3',
    textMuted: '#7e7e8a',
    borderSubtle: '#1a1a22',
    borderDefault: '#2a2a35',
    accentColor: '#8b5cf6',
    userBubble: '#6366f1',
    userText: '#ffffff',
    assistantBubble: '#1e1e24',
    assistantText: '#e0e0e0',
    containerBg: '#111114',
    sendButton: '#6366f1',
    inputBorder: '#2a2a35',
    bubbleRadius: 16,
}

const DEFAULT_CUSTOM_LIGHT: CustomThemeColors = {
    bgPrimary: '#f0f1f5',
    bgSecondary: '#e8eaf0',
    surfacePrimary: '#ffffff',
    textPrimary: '#1a1a2e',
    textSecondary: '#3f3f50',
    textMuted: '#5c5c6e',
    borderSubtle: '#d8d8e0',
    borderDefault: '#c0c0cc',
    accentColor: '#7c3aed',
    userBubble: '#6366f1',
    userText: '#ffffff',
    assistantBubble: '#f3f4f6',
    assistantText: '#1f2937',
    containerBg: '#f0f1f5',
    sendButton: '#6366f1',
    inputBorder: '#d1d5db',
    bubbleRadius: 16,
}

export const CHAT_THEMES: ChatThemePreset[] = [
    {
        id: 'midnight',
        name: 'Midnight',
        description: 'Default violet theme',
        preview: {
            dark: { userBubble: 'linear-gradient(135deg, #8b5cf6, #4f46e5)', assistantBubble: '#18181d', assistantBorder: '1px solid rgba(255,255,255,0.08)', containerBg: '#0f0f13', textColor: 'rgba(255,255,255,0.7)' },
            light: { userBubble: 'linear-gradient(135deg, #7c3aed, #0ea5e9)', assistantBubble: '#ffffff', assistantBorder: '1px solid rgba(0,0,0,0.08)', containerBg: '#f0f1f5', textColor: '#52525b' },
        },
    },
    {
        id: 'aurora',
        name: 'Aurora',
        description: 'Pink-orange gradient',
        preview: {
            dark: { userBubble: 'linear-gradient(135deg, #ec4899, #f97316)', assistantBubble: '#1e1b2e', assistantBorder: '1px solid rgba(236,72,153,0.12)', containerBg: '#0f0d17', textColor: 'rgba(255,255,255,0.7)' },
            light: { userBubble: 'linear-gradient(135deg, #ec4899, #f97316)', assistantBubble: '#fef2f8', assistantBorder: '1px solid rgba(236,72,153,0.15)', containerBg: '#f0f1f5', textColor: '#1a1a2e' },
        },
    },
    {
        id: 'honey',
        name: 'Honey',
        description: 'Warm yellow accents',
        preview: {
            dark: { userBubble: '#fbbf24', assistantBubble: '#1c1c1e', assistantBorder: '1px solid rgba(255,255,255,0.06)', containerBg: '#111113', textColor: 'rgba(255,255,255,0.7)' },
            light: { userBubble: '#fbbf24', assistantBubble: '#fffbeb', assistantBorder: '1px solid rgba(251,191,36,0.15)', containerBg: '#f0f1f5', textColor: '#1a1a2e' },
        },
    },
]

const STORAGE_KEY = 'adhdev-chat-theme'
const CUSTOM_STORAGE_KEY = 'adhdev-chat-theme-custom'

export function getChatTheme(): string {
    if (typeof window === 'undefined') return 'midnight'
    return localStorage.getItem(STORAGE_KEY) || 'midnight'
}

export function getCustomThemeColors(mode: 'dark' | 'light'): CustomThemeColors {
    try {
        const raw = localStorage.getItem(CUSTOM_STORAGE_KEY)
        if (raw) {
            const parsed = JSON.parse(raw)
            return { ...(mode === 'dark' ? DEFAULT_CUSTOM_DARK : DEFAULT_CUSTOM_LIGHT), ...parsed[mode] }
        }
    } catch { /* ignore */ }
    return mode === 'dark' ? DEFAULT_CUSTOM_DARK : DEFAULT_CUSTOM_LIGHT
}

function saveCustomThemeColors(dark: CustomThemeColors, light: CustomThemeColors) {
    localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify({ dark, light }))
}

function hexToRgba(hex: string, alpha: number): string {
    const r = parseInt(hex.slice(1, 3), 16)
    const g = parseInt(hex.slice(3, 5), 16)
    const b = parseInt(hex.slice(5, 7), 16)
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function lightenHex(hex: string, amount: number): string {
    const r = Math.min(255, parseInt(hex.slice(1, 3), 16) + amount)
    const g = Math.min(255, parseInt(hex.slice(3, 5), 16) + amount)
    const b = Math.min(255, parseInt(hex.slice(5, 7), 16) + amount)
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
}

function applyCustomCSSVars(colors: CustomThemeColors) {
    const root = document.documentElement

    // ── Global app variables ──
    root.style.setProperty('--bg-primary', colors.bgPrimary)
    root.style.setProperty('--bg-secondary', colors.bgSecondary)
    root.style.setProperty('--bg-card', hexToRgba(colors.surfacePrimary, 0.92))
    root.style.setProperty('--surface-primary', colors.surfacePrimary)
    root.style.setProperty('--surface-secondary', colors.bgSecondary)
    root.style.setProperty('--bg-glass', hexToRgba(colors.borderSubtle, 0.15))
    root.style.setProperty('--bg-glass-hover', hexToRgba(colors.borderSubtle, 0.25))
    root.style.setProperty('--text-primary', colors.textPrimary)
    root.style.setProperty('--text-secondary', colors.textSecondary)
    root.style.setProperty('--text-muted', colors.textMuted)
    root.style.setProperty('--border-subtle', hexToRgba(colors.borderSubtle, 0.5))
    root.style.setProperty('--border-default', hexToRgba(colors.borderDefault, 0.5))
    root.style.setProperty('--accent-primary', colors.accentColor)
    root.style.setProperty('--accent-primary-light', lightenHex(colors.accentColor, 30))
    root.style.setProperty('--accent-gradient', `linear-gradient(135deg, ${colors.accentColor}, ${lightenHex(colors.accentColor, 40)})`)
    root.style.setProperty('--border-accent', hexToRgba(colors.accentColor, 0.35))
    root.style.setProperty('--nav-active-bg', hexToRgba(colors.accentColor, 0.10))
    root.style.setProperty('--nav-active-shadow', `inset 3px 0 0 ${colors.accentColor}, 0 0 12px ${hexToRgba(colors.accentColor, 0.06)}`)

    // ── Chat variables ──
    root.style.setProperty('--chat-user-bg', colors.userBubble)
    root.style.setProperty('--chat-user-color', colors.userText)
    root.style.setProperty('--chat-user-radius', `${colors.bubbleRadius}px ${colors.bubbleRadius}px 4px ${colors.bubbleRadius}px`)
    root.style.setProperty('--chat-assistant-bg', colors.assistantBubble)
    root.style.setProperty('--chat-assistant-color', colors.assistantText)
    root.style.setProperty('--chat-assistant-radius', `${colors.bubbleRadius}px ${colors.bubbleRadius}px ${colors.bubbleRadius}px 4px`)
    root.style.setProperty('--chat-assistant-border', `1px solid ${hexToRgba(colors.accentColor, 0.12)}`)
    root.style.setProperty('--chat-container-bg', colors.containerBg)
    root.style.setProperty('--chat-thought-accent', colors.accentColor)
    root.style.setProperty('--chat-tool-accent', colors.accentColor)
    root.style.setProperty('--chat-action-color', colors.accentColor)
    root.style.setProperty('--chat-send-bg', colors.sendButton)
    root.style.setProperty('--chat-input-border', colors.inputBorder)
}

function clearCustomCSSVars() {
    const root = document.documentElement
    const vars = [
        // Global
        '--bg-primary', '--bg-secondary', '--bg-card', '--surface-primary', '--surface-secondary',
        '--bg-glass', '--bg-glass-hover',
        '--text-primary', '--text-secondary', '--text-muted',
        '--border-subtle', '--border-default',
        '--accent-primary', '--accent-primary-light', '--accent-gradient',
        '--border-accent', '--nav-active-bg', '--nav-active-shadow',
        // Chat
        '--chat-user-bg', '--chat-user-color', '--chat-user-radius',
        '--chat-assistant-bg', '--chat-assistant-color', '--chat-assistant-radius',
        '--chat-assistant-border', '--chat-container-bg',
        '--chat-thought-accent', '--chat-tool-accent', '--chat-action-color',
        '--chat-send-bg', '--chat-input-border',
    ]
    vars.forEach(v => root.style.removeProperty(v))
}

export function setChatTheme(themeId: string) {
    localStorage.setItem(STORAGE_KEY, themeId)
    document.documentElement.setAttribute('data-chat-theme', themeId)
    if (themeId === 'custom') {
        const mode = isDarkMode() ? 'dark' : 'light'
        applyCustomCSSVars(getCustomThemeColors(mode))
    } else {
        clearCustomCSSVars()
    }
}

/** Call on app init to restore persisted theme */
export function initChatTheme() {
    const theme = getChatTheme()
    if (theme !== 'midnight') {
        document.documentElement.setAttribute('data-chat-theme', theme)
    }
    if (theme === 'custom') {
        const mode = isDarkMode() ? 'dark' : 'light'
        applyCustomCSSVars(getCustomThemeColors(mode))
    }
}

function isDarkMode(): boolean {
    const explicit = document.documentElement.getAttribute('data-theme')
    if (explicit) return explicit === 'dark'
    return window.matchMedia('(prefers-color-scheme: dark)').matches
}

// ─── Color Picker Row ───────────────────────────
function ColorRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
    return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', minWidth: 110 }}>{label}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                    type="color"
                    value={value}
                    onChange={e => onChange(e.target.value)}
                    style={{
                        width: 28, height: 28, border: 'none', borderRadius: 6,
                        cursor: 'pointer', background: 'transparent', padding: 0,
                    }}
                />
                <input
                    type="text"
                    value={value}
                    onChange={e => { if (/^#[0-9a-fA-F]{0,6}$/.test(e.target.value)) onChange(e.target.value) }}
                    style={{
                        width: 72, fontSize: '0.7rem', fontFamily: 'monospace',
                        background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)',
                        borderRadius: 4, padding: '3px 6px', color: 'var(--text-primary)',
                    }}
                />
            </div>
        </div>
    )
}

// ─── Section Header ─────────────────────────────
function EditorSection({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div style={{ marginBottom: 14 }}>
            <div style={{
                fontSize: '0.65rem', fontWeight: 700, textTransform: 'uppercase' as const,
                color: 'var(--text-muted)', letterSpacing: '0.08em', marginBottom: 8,
                borderBottom: '1px solid var(--border-subtle)', paddingBottom: 4,
            }}>
                {title}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {children}
            </div>
        </div>
    )
}

// ─── Custom Theme Editor ────────────────────────
function CustomThemeEditor({ dark: isDark, onColorsChange }: { dark: boolean; onColorsChange: (c: CustomThemeColors) => void }) {
    const mode = isDark ? 'dark' : 'light'
    const [colors, setColors] = useState(() => getCustomThemeColors(mode))

    useEffect(() => {
        setColors(getCustomThemeColors(mode))
    }, [mode])

    const update = useCallback((key: keyof CustomThemeColors, value: string | number) => {
        setColors(prev => {
            const next = { ...prev, [key]: value }
            const otherMode = mode === 'dark' ? 'light' : 'dark'
            const other = getCustomThemeColors(otherMode as 'dark' | 'light')
            if (mode === 'dark') saveCustomThemeColors(next, other)
            else saveCustomThemeColors(other, next)
            applyCustomCSSVars(next)
            onColorsChange(next)
            return next
        })
    }, [mode, onColorsChange])

    return (
        <div style={{
            marginTop: 12, padding: '16px 18px',
            background: 'var(--bg-glass)', border: '1px solid var(--border-subtle)',
            borderRadius: 12,
        }}>
            <div style={{
                fontSize: '0.75rem', fontWeight: 700,
                color: 'var(--text-primary)', marginBottom: 14,
                display: 'flex', alignItems: 'center', gap: 8,
            }}>
                🎨 Custom Theme Editor
                <span style={{
                    fontSize: '0.65rem', fontWeight: 500,
                    color: 'var(--text-muted)', background: 'var(--bg-glass)',
                    padding: '2px 8px', borderRadius: 4,
                }}>
                    {isDark ? '🌙 Dark' : '☀️ Light'} mode
                </span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                {/* Left: App Colors */}
                <div>
                    <EditorSection title="App Background">
                        <ColorRow label="Background" value={colors.bgPrimary} onChange={v => update('bgPrimary', v)} />
                        <ColorRow label="Surface" value={colors.bgSecondary} onChange={v => update('bgSecondary', v)} />
                        <ColorRow label="Card" value={colors.surfacePrimary} onChange={v => update('surfacePrimary', v)} />
                    </EditorSection>

                    <EditorSection title="App Text">
                        <ColorRow label="Primary" value={colors.textPrimary} onChange={v => update('textPrimary', v)} />
                        <ColorRow label="Secondary" value={colors.textSecondary} onChange={v => update('textSecondary', v)} />
                        <ColorRow label="Muted" value={colors.textMuted} onChange={v => update('textMuted', v)} />
                    </EditorSection>

                    <EditorSection title="Borders & Accent">
                        <ColorRow label="Border subtle" value={colors.borderSubtle} onChange={v => update('borderSubtle', v)} />
                        <ColorRow label="Border default" value={colors.borderDefault} onChange={v => update('borderDefault', v)} />
                        <ColorRow label="Accent" value={colors.accentColor} onChange={v => update('accentColor', v)} />
                    </EditorSection>
                </div>

                {/* Right: Chat Colors */}
                <div>
                    <EditorSection title="Chat Bubbles">
                        <ColorRow label="User bubble" value={colors.userBubble} onChange={v => update('userBubble', v)} />
                        <ColorRow label="User text" value={colors.userText} onChange={v => update('userText', v)} />
                        <ColorRow label="Agent bubble" value={colors.assistantBubble} onChange={v => update('assistantBubble', v)} />
                        <ColorRow label="Agent text" value={colors.assistantText} onChange={v => update('assistantText', v)} />
                    </EditorSection>

                    <EditorSection title="Chat Layout">
                        <ColorRow label="Chat BG" value={colors.containerBg} onChange={v => update('containerBg', v)} />
                        <ColorRow label="Send button" value={colors.sendButton} onChange={v => update('sendButton', v)} />
                        <ColorRow label="Input border" value={colors.inputBorder} onChange={v => update('inputBorder', v)} />
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', minWidth: 110 }}>Bubble radius</span>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
                                <input
                                    type="range" min={4} max={24} value={colors.bubbleRadius}
                                    onChange={e => update('bubbleRadius', Number(e.target.value))}
                                    style={{ flex: 1, accentColor: 'var(--accent-primary)' }}
                                />
                                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', width: 28, textAlign: 'right' }}>{colors.bubbleRadius}px</span>
                            </div>
                        </div>
                    </EditorSection>
                </div>
            </div>

            <button
                onClick={() => {
                    const defaults = isDark ? DEFAULT_CUSTOM_DARK : DEFAULT_CUSTOM_LIGHT
                    const otherMode = isDark ? 'light' : 'dark'
                    const other = getCustomThemeColors(otherMode as 'dark' | 'light')
                    if (isDark) saveCustomThemeColors(defaults, other)
                    else saveCustomThemeColors(other, defaults)
                    setColors(defaults)
                    applyCustomCSSVars(defaults)
                    onColorsChange(defaults)
                }}
                style={{
                    marginTop: 10, fontSize: '0.7rem', color: 'var(--text-muted)',
                    background: 'transparent', border: '1px solid var(--border-subtle)',
                    borderRadius: 6, padding: '4px 10px', cursor: 'pointer',
                }}
            >
                Reset to defaults
            </button>
        </div>
    )
}

// ─── Component ──────────────────────────────────
export function ChatThemeSection() {
    const [activeTheme, setActiveTheme] = useState(getChatTheme)
    const [dark, setDark] = useState(true)
    const [customColors, setCustomColors] = useState<CustomThemeColors>(() => getCustomThemeColors('dark'))

    useEffect(() => {
        setDark(isDarkMode())
        const observer = new MutationObserver(() => {
            const d = isDarkMode()
            setDark(d)
            if (getChatTheme() === 'custom') {
                applyCustomCSSVars(getCustomThemeColors(d ? 'dark' : 'light'))
            }
        })
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
        const mq = window.matchMedia('(prefers-color-scheme: dark)')
        const handler = () => {
            const d = isDarkMode()
            setDark(d)
            if (getChatTheme() === 'custom') {
                applyCustomCSSVars(getCustomThemeColors(d ? 'dark' : 'light'))
            }
        }
        mq.addEventListener('change', handler)
        return () => { observer.disconnect(); mq.removeEventListener('change', handler) }
    }, [])

    useEffect(() => {
        if (activeTheme !== 'midnight') {
            document.documentElement.setAttribute('data-chat-theme', activeTheme)
        }
        if (activeTheme === 'custom') {
            applyCustomCSSVars(getCustomThemeColors(dark ? 'dark' : 'light'))
        }
    }, [])

    useEffect(() => {
        setCustomColors(getCustomThemeColors(dark ? 'dark' : 'light'))
    }, [dark])

    const handleSelect = (themeId: string) => {
        setActiveTheme(themeId)
        setChatTheme(themeId)
        if (themeId === 'midnight') {
            document.documentElement.removeAttribute('data-chat-theme')
        }
    }

    // Build the full list: presets + custom
    const allThemes = [
        ...CHAT_THEMES,
        {
            id: 'custom',
            name: 'Custom',
            description: 'Full app + chat customization',
            preview: {
                dark: {
                    userBubble: customColors.userBubble,
                    assistantBubble: customColors.assistantBubble,
                    assistantBorder: `1px solid ${customColors.accentColor}22`,
                    containerBg: customColors.containerBg,
                    textColor: customColors.assistantText,
                },
                light: {
                    userBubble: customColors.userBubble,
                    assistantBubble: customColors.assistantBubble,
                    assistantBorder: `1px solid ${customColors.accentColor}22`,
                    containerBg: customColors.containerBg,
                    textColor: customColors.assistantText,
                },
            },
        },
    ]

    return (
        <div>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                {allThemes.map((theme) => {
                    const isActive = activeTheme === theme.id
                    const p = dark ? theme.preview.dark : theme.preview.light
                    const userTextColor = theme.id === 'honey' ? '#1a1a1a'
                        : theme.id === 'custom' ? customColors.userText : '#fff'
                    return (
                        <button
                            key={theme.id}
                            onClick={() => handleSelect(theme.id)}
                            className="text-left rounded-xl p-3 transition-all"
                            style={{
                                background: isActive ? 'var(--bg-glass-hover)' : 'var(--bg-glass)',
                                border: isActive ? '2px solid var(--accent-primary)' : '2px solid var(--border-subtle)',
                                opacity: isActive ? 1 : 0.75,
                            }}
                        >
                            <div
                                className="rounded-lg p-3 mb-2.5 flex flex-col gap-1.5"
                                style={{ background: p.containerBg }}
                            >
                                <div
                                    className="self-start rounded-xl px-3 py-1.5 text-[10px] max-w-[75%]"
                                    style={{ background: p.assistantBubble, border: p.assistantBorder, color: p.textColor }}
                                >
                                    Hello! How can I help?
                                </div>
                                <div
                                    className="self-end rounded-xl px-3 py-1.5 text-[10px] max-w-[75%]"
                                    style={{ background: p.userBubble, color: userTextColor }}
                                >
                                    Fix the bug please
                                </div>
                                <div
                                    className="self-start rounded-xl px-3 py-1.5 text-[10px] max-w-[75%]"
                                    style={{ background: p.assistantBubble, border: p.assistantBorder, color: p.textColor }}
                                >
                                    On it! ✨
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                {isActive && <span className="w-2 h-2 rounded-full bg-accent shrink-0" />}
                                <div>
                                    <div className="text-sm font-bold text-text-primary">
                                        {theme.id === 'custom' ? '🎨 Custom' : theme.name}
                                    </div>
                                    <div className="text-[10px] text-text-muted">{theme.description}</div>
                                </div>
                            </div>
                        </button>
                    )
                })}
            </div>

            {/* Custom theme editor — full app + chat */}
            {activeTheme === 'custom' && (
                <CustomThemeEditor
                    dark={dark}
                    onColorsChange={(c) => setCustomColors(c)}
                />
            )}
        </div>
    )
}
