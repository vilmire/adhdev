import * as fs from 'fs'
import * as path from 'path'

export type StandaloneBindHost = '127.0.0.1' | '0.0.0.0'
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

export interface StandalonePreferencesState {
  standaloneBindHost: StandaloneBindHost
  standaloneFontPreferences: StandaloneFontPreferences
}

export const DEFAULT_STANDALONE_FONT_PREFERENCES: StandaloneFontPreferences = {
  chat: { preset: 'default' },
  code: { preset: 'default' },
  terminal: { preset: 'default' },
}

export const DEFAULT_STANDALONE_PREFERENCES_STATE: StandalonePreferencesState = {
  standaloneBindHost: '127.0.0.1',
  standaloneFontPreferences: DEFAULT_STANDALONE_FONT_PREFERENCES,
}

const VALID_CHAT_PRESETS = new Set<StandaloneChatFontPreset>(['default', 'system-ui', 'inter', 'pretendard', 'noto-sans-kr', 'serif', 'custom'])
const VALID_MONO_PRESETS = new Set<StandaloneMonoFontPreset>(['default', 'jetbrains-mono', 'fira-code', 'cascadia-code', 'berkeley-mono', 'custom'])

export function normalizeStandaloneBindHost(value: unknown): StandaloneBindHost {
  return value === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1'
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

export function normalizeStandaloneFontPreferences(value: unknown): StandaloneFontPreferences {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  return {
    chat: normalizeStandaloneFontChoice('chat', input.chat),
    code: normalizeStandaloneFontChoice('code', input.code),
    terminal: normalizeStandaloneFontChoice('terminal', input.terminal),
  }
}

export function normalizeStandalonePreferences(value: unknown): StandalonePreferencesState {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  return {
    standaloneBindHost: normalizeStandaloneBindHost(input.standaloneBindHost),
    standaloneFontPreferences: normalizeStandaloneFontPreferences(input.standaloneFontPreferences),
  }
}

export function loadStandalonePreferences(filePath: string): StandalonePreferencesState {
  if (!fs.existsSync(filePath)) return DEFAULT_STANDALONE_PREFERENCES_STATE
  try {
    return normalizeStandalonePreferences(JSON.parse(fs.readFileSync(filePath, 'utf8')))
  } catch {
    return DEFAULT_STANDALONE_PREFERENCES_STATE
  }
}

export function saveStandalonePreferences(filePath: string, value: Partial<StandalonePreferencesState>): StandalonePreferencesState {
  const current = loadStandalonePreferences(filePath)
  const next = normalizeStandalonePreferences({
    standaloneBindHost: Object.prototype.hasOwnProperty.call(value, 'standaloneBindHost') ? value.standaloneBindHost : current.standaloneBindHost,
    standaloneFontPreferences: Object.prototype.hasOwnProperty.call(value, 'standaloneFontPreferences') ? value.standaloneFontPreferences : current.standaloneFontPreferences,
  })
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
  try { fs.chmodSync(filePath, 0o600) } catch {}
  return next
}
