import * as assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'
import {
  DEFAULT_STANDALONE_FONT_PREFERENCES,
  loadStandalonePreferences,
  normalizeStandaloneFontPreferences,
  saveStandalonePreferences,
} from '../src/standalone-preferences'

test('normalizeStandaloneFontPreferences trims custom families and falls back invalid presets', () => {
  const normalized = normalizeStandaloneFontPreferences({
    chat: { preset: 'custom', customFamily: '  "Pretendard", sans-serif  ' },
    code: { preset: 'jetbrains-mono' },
    terminal: { preset: 'nope', customFamily: '   ' },
  })

  assert.deepEqual(normalized, {
    chat: { preset: 'custom', customFamily: '"Pretendard", sans-serif' },
    code: { preset: 'jetbrains-mono' },
    terminal: DEFAULT_STANDALONE_FONT_PREFERENCES.terminal,
  })
})

test('loadStandalonePreferences returns defaults when the file is missing or invalid', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-standalone-prefs-'))
  const filePath = path.join(tempDir, 'standalone-preferences.json')

  try {
    assert.deepEqual(loadStandalonePreferences(filePath), {
      standaloneBindHost: '127.0.0.1',
      standaloneFontPreferences: DEFAULT_STANDALONE_FONT_PREFERENCES,
    })

    fs.writeFileSync(filePath, '{bad json', 'utf8')
    assert.deepEqual(loadStandalonePreferences(filePath), {
      standaloneBindHost: '127.0.0.1',
      standaloneFontPreferences: DEFAULT_STANDALONE_FONT_PREFERENCES,
    })
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('saveStandalonePreferences preserves bind host while storing normalized standalone font preferences', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-standalone-prefs-'))
  const filePath = path.join(tempDir, 'standalone-preferences.json')

  try {
    saveStandalonePreferences(filePath, {
      standaloneBindHost: '0.0.0.0',
      standaloneFontPreferences: {
        chat: { preset: 'pretendard' },
        code: { preset: 'custom', customFamily: '  "Berkeley Mono", monospace ' },
        terminal: { preset: 'fira-code' },
      },
    })

    assert.deepEqual(loadStandalonePreferences(filePath), {
      standaloneBindHost: '0.0.0.0',
      standaloneFontPreferences: {
        chat: { preset: 'pretendard' },
        code: { preset: 'custom', customFamily: '"Berkeley Mono", monospace' },
        terminal: { preset: 'fira-code' },
      },
    })
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})
