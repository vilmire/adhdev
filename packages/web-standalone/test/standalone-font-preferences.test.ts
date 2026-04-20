import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_STANDALONE_FONT_PREFERENCES,
  buildStandaloneFontCssVariables,
  normalizeStandaloneFontPreferences,
  resolveStandaloneFontFamily,
} from '../src/standalone-font-preferences.ts'

test('normalizeStandaloneFontPreferences keeps supported presets and trims custom values', () => {
  const normalized = normalizeStandaloneFontPreferences({
    chat: { preset: 'pretendard' },
    code: { preset: 'custom', customFamily: '  "JetBrains Mono", monospace  ' },
    terminal: { preset: 'unknown', customFamily: '  ' },
  })

  assert.deepEqual(normalized, {
    chat: { preset: 'pretendard' },
    code: { preset: 'custom', customFamily: '"JetBrains Mono", monospace' },
    terminal: DEFAULT_STANDALONE_FONT_PREFERENCES.terminal,
  })
})

test('resolveStandaloneFontFamily returns sensible stacks for presets and custom overrides', () => {
  assert.match(resolveStandaloneFontFamily('chat', { preset: 'inter' }), /Inter/)
  assert.match(resolveStandaloneFontFamily('code', { preset: 'jetbrains-mono' }), /JetBrains Mono/)
  assert.equal(
    resolveStandaloneFontFamily('terminal', { preset: 'custom', customFamily: '"Berkeley Mono", monospace' }),
    '"Berkeley Mono", monospace',
  )
})

test('buildStandaloneFontCssVariables maps standalone preferences to scoped chat/code/terminal css variables', () => {
  const cssVars = buildStandaloneFontCssVariables({
    chat: { preset: 'noto-sans-kr' },
    code: { preset: 'fira-code' },
    terminal: { preset: 'custom', customFamily: '"CommitMono", monospace' },
  })

  assert.match(cssVars['--chat-font-family'], /Noto Sans KR/)
  assert.match(cssVars['--chat-code-font-family'], /Fira Code/)
  assert.equal(cssVars['--chat-terminal-font-family'], '"CommitMono", monospace')
  assert.equal(cssVars['--chat-tool-font-family'], '"CommitMono", monospace')
})
