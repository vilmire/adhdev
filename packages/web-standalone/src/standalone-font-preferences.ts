export type StandaloneFontSurface = 'chat' | 'code' | 'terminal'
export type StandaloneChatFontPreset = 'default' | 'system-ui' | 'inter' | 'pretendard' | 'noto-sans-kr' | 'serif' | 'custom'
export type StandaloneMonoFontPreset = 'default' | 'jetbrains-mono' | 'fira-code' | 'cascadia-code' | 'berkeley-mono' | 'custom'

export interface StandaloneFontChoice {
  preset: string
  customFamily?: string
}

export interface StandaloneFontPreferences {
  chat: StandaloneFontChoice
  code: StandaloneFontChoice
  terminal: StandaloneFontChoice
}

export interface StandaloneFontPresetOption {
  id: string
  label: string
  family: string
  description: string
}

export const STANDALONE_FONT_PREFERENCES_STORAGE_KEY = 'adhdev_standalone_font_preferences'

export const DEFAULT_STANDALONE_FONT_PREFERENCES: StandaloneFontPreferences = {
  chat: { preset: 'default' },
  code: { preset: 'default' },
  terminal: { preset: 'default' },
}

export const CHAT_FONT_PRESET_OPTIONS: StandaloneFontPresetOption[] = [
  { id: 'default', label: 'Default', family: 'var(--font-sans)', description: 'Current dashboard sans stack' },
  { id: 'system-ui', label: 'System UI', family: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', description: 'Use the browser/OS default UI font' },
  { id: 'inter', label: 'Inter', family: '"Inter", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', description: 'Match the current product default explicitly' },
  { id: 'pretendard', label: 'Pretendard', family: '"Pretendard", "Noto Sans KR", system-ui, sans-serif', description: 'Crisp Korean-first sans fallback stack' },
  { id: 'noto-sans-kr', label: 'Noto Sans KR', family: '"Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", "Segoe UI", sans-serif', description: 'Wide CJK coverage with neutral metrics' },
  { id: 'serif', label: 'Serif', family: '"Iowan Old Style", "Apple Garamond", "Times New Roman", serif', description: 'Reading-focused serif stack for long replies' },
  { id: 'custom', label: 'Custom…', family: '', description: 'Enter any CSS font-family stack' },
]

export const MONO_FONT_PRESET_OPTIONS: StandaloneFontPresetOption[] = [
  { id: 'default', label: 'Default mono', family: 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace', description: 'Current monospace stack' },
  { id: 'jetbrains-mono', label: 'JetBrains Mono', family: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace', description: 'Readable coding font with strong punctuation' },
  { id: 'fira-code', label: 'Fira Code', family: '"Fira Code", ui-monospace, "SF Mono", Menlo, Consolas, monospace', description: 'Popular ligature-friendly code font' },
  { id: 'cascadia-code', label: 'Cascadia Code', family: '"Cascadia Code", "Cascadia Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace', description: 'Windows-friendly modern coding font' },
  { id: 'berkeley-mono', label: 'Berkeley Mono', family: '"Berkeley Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace', description: 'Editorial-feeling mono stack if installed' },
  { id: 'custom', label: 'Custom…', family: '', description: 'Enter any CSS monospace stack' },
]

const VALID_CHAT_PRESETS = new Set<StandaloneChatFontPreset>(CHAT_FONT_PRESET_OPTIONS.map(option => option.id as StandaloneChatFontPreset))
const VALID_MONO_PRESETS = new Set<StandaloneMonoFontPreset>(MONO_FONT_PRESET_OPTIONS.map(option => option.id as StandaloneMonoFontPreset))

export function normalizeStandaloneFontPreferences(value: unknown): StandaloneFontPreferences {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  return {
    chat: normalizeStandaloneFontChoice('chat', input.chat),
    code: normalizeStandaloneFontChoice('code', input.code),
    terminal: normalizeStandaloneFontChoice('terminal', input.terminal),
  }
}

function normalizeStandaloneFontChoice(surface: StandaloneFontSurface, value: unknown): StandaloneFontChoice {
  const fallback = DEFAULT_STANDALONE_FONT_PREFERENCES[surface]
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const preset = typeof input.preset === 'string' ? input.preset.trim() : ''
  const customFamily = typeof input.customFamily === 'string' ? input.customFamily.trim() : ''
  const validPresets = surface === 'chat' ? VALID_CHAT_PRESETS : VALID_MONO_PRESETS

  if (!validPresets.has(preset as never)) {
    return fallback
  }
  if (preset === 'custom') {
    if (!customFamily) return fallback
    return { preset: 'custom', customFamily }
  }
  return { preset }
}

export function resolveStandaloneFontFamily(surface: StandaloneFontSurface, choice: StandaloneFontChoice): string {
  const normalized = normalizeStandaloneFontChoice(surface, choice)
  if (normalized.preset === 'custom' && normalized.customFamily) {
    return normalized.customFamily
  }
  const options = surface === 'chat' ? CHAT_FONT_PRESET_OPTIONS : MONO_FONT_PRESET_OPTIONS
  return options.find(option => option.id === normalized.preset)?.family || options[0].family
}

export function buildStandaloneFontCssVariables(value: StandaloneFontPreferences): Record<string, string> {
  const normalized = normalizeStandaloneFontPreferences(value)
  const chatFamily = resolveStandaloneFontFamily('chat', normalized.chat)
  const codeFamily = resolveStandaloneFontFamily('code', normalized.code)
  const terminalFamily = resolveStandaloneFontFamily('terminal', normalized.terminal)
  return {
    '--chat-font-family': chatFamily,
    '--chat-code-font-family': codeFamily,
    '--chat-terminal-font-family': terminalFamily,
    '--chat-tool-font-family': terminalFamily,
  }
}

export function applyStandaloneFontPreferences(value: StandaloneFontPreferences, root: HTMLElement = document.documentElement): StandaloneFontPreferences {
  const normalized = normalizeStandaloneFontPreferences(value)
  const cssVars = buildStandaloneFontCssVariables(normalized)
  root.setAttribute('data-standalone-fonts', 'custom')
  for (const [key, cssValue] of Object.entries(cssVars)) {
    root.style.setProperty(key, cssValue)
  }
  return normalized
}

export function cacheStandaloneFontPreferences(value: StandaloneFontPreferences): StandaloneFontPreferences {
  const normalized = normalizeStandaloneFontPreferences(value)
  try {
    localStorage.setItem(STANDALONE_FONT_PREFERENCES_STORAGE_KEY, JSON.stringify(normalized))
  } catch {
    // noop
  }
  return normalized
}

export function getCachedStandaloneFontPreferences(): StandaloneFontPreferences {
  try {
    const raw = localStorage.getItem(STANDALONE_FONT_PREFERENCES_STORAGE_KEY)
    if (raw) {
      return normalizeStandaloneFontPreferences(JSON.parse(raw))
    }
  } catch {
    // noop
  }
  return DEFAULT_STANDALONE_FONT_PREFERENCES
}

export function initStandaloneFontPreferences(): StandaloneFontPreferences {
  return applyStandaloneFontPreferences(getCachedStandaloneFontPreferences())
}

export function getStandaloneFontPreferenceLabel(surface: StandaloneFontSurface, preset: string): string {
  const options = surface === 'chat' ? CHAT_FONT_PRESET_OPTIONS : MONO_FONT_PRESET_OPTIONS
  return options.find(option => option.id === preset)?.label || options[0].label
}
