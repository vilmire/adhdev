import { AlertBanner, Button, Input, Select } from '@adhdev/web-core'
import {
  CHAT_FONT_PRESET_OPTIONS,
  MONO_FONT_PRESET_OPTIONS,
  DEFAULT_STANDALONE_FONT_PREFERENCES,
  getStandaloneFontPreferenceLabel,
  resolveStandaloneFontFamily,
  type StandaloneFontPreferences,
  type StandaloneFontChoice,
  type StandaloneFontSurface,
} from './standalone-font-preferences'

interface StandaloneFontSettingsSectionProps {
  value: StandaloneFontPreferences
  savedValue: StandaloneFontPreferences
  saving?: boolean
  error?: string
  notice?: string
  onChange: (next: StandaloneFontPreferences) => void
  onSave: () => void
  onResetToSaved: () => void
  onResetToDefaults: () => void
}

function updateChoice(value: StandaloneFontPreferences, surface: StandaloneFontSurface, nextChoice: StandaloneFontChoice): StandaloneFontPreferences {
  return {
    ...value,
    [surface]: nextChoice,
  }
}

function FontControl({
  surface,
  title,
  description,
  value,
  options,
  onChange,
}: {
  surface: StandaloneFontSurface
  title: string
  description: string
  value: StandaloneFontChoice
  options: typeof CHAT_FONT_PRESET_OPTIONS | typeof MONO_FONT_PRESET_OPTIONS
  onChange: (next: StandaloneFontChoice) => void
}) {
  return (
    <div className="rounded-xl border border-border-subtle bg-bg-glass px-4 py-3 flex flex-col gap-3">
      <div>
        <div className="text-sm font-medium text-text-primary">{title}</div>
        <div className="text-xs text-text-muted mt-1">{description}</div>
      </div>
      <div className="flex flex-col gap-2">
        <Select
          value={value.preset}
          onChange={event => {
            const preset = event.target.value
            onChange(preset === 'custom'
              ? { preset: 'custom', customFamily: value.customFamily || '' }
              : { preset })
          }}
        >
          {options.map(option => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </Select>
        {value.preset === 'custom' && (
          <Input
            type="text"
            className="font-mono"
            placeholder="e.g. &quot;Pretendard&quot;, &quot;Noto Sans KR&quot;, sans-serif"
            value={value.customFamily || ''}
            onChange={event => onChange({ preset: 'custom', customFamily: event.target.value })}
          />
        )}
        <div className="text-[11px] text-text-muted">
          <span className="font-medium text-text-secondary">Resolved stack:</span>{' '}
          <span className="font-mono break-all">{resolveStandaloneFontFamily(surface, value)}</span>
        </div>
      </div>
    </div>
  )
}

export default function StandaloneFontSettingsSection({
  value,
  savedValue,
  saving = false,
  error,
  notice,
  onChange,
  onSave,
  onResetToSaved,
  onResetToDefaults,
}: StandaloneFontSettingsSectionProps) {
  const isDirty = JSON.stringify(value) !== JSON.stringify(savedValue)

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-border-subtle bg-bg-glass px-4 py-3 text-sm text-text-muted">
        Standalone-only font overrides. These do not affect the cloud dashboard. Chat bubbles, markdown prose, code blocks, tool rows, and terminal output all use the preferences below.
      </div>

      {error && <AlertBanner variant="error">{error}</AlertBanner>}
      {notice && <AlertBanner variant="success">{notice}</AlertBanner>}

      <div className="grid gap-3 lg:grid-cols-3">
        <FontControl
          surface="chat"
          title="Chat text"
          description="Assistant/user prose, markdown text, thought cards, and system notes."
          value={value.chat}
          options={CHAT_FONT_PRESET_OPTIONS}
          onChange={next => onChange(updateChoice(value, 'chat', next))}
        />
        <FontControl
          surface="code"
          title="Code blocks"
          description="Markdown code fences, inline code, and preformatted command output."
          value={value.code}
          options={MONO_FONT_PRESET_OPTIONS}
          onChange={next => onChange(updateChoice(value, 'code', next))}
        />
        <FontControl
          surface="terminal"
          title="Terminal"
          description="Terminal transcript cards and tool/command rows in chat mode."
          value={value.terminal}
          options={MONO_FONT_PRESET_OPTIONS}
          onChange={next => onChange(updateChoice(value, 'terminal', next))}
        />
      </div>

      <div className="rounded-2xl border border-border-subtle bg-bg-primary/70 p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-text-primary">Live preview</div>
            <div className="text-xs text-text-muted mt-1">
              Chat: {getStandaloneFontPreferenceLabel('chat', value.chat.preset)} · Code: {getStandaloneFontPreferenceLabel('code', value.code.preset)} · Terminal: {getStandaloneFontPreferenceLabel('terminal', value.terminal.preset)}
            </div>
          </div>
          <div className="text-[11px] text-text-muted">Defaults: {getStandaloneFontPreferenceLabel('chat', DEFAULT_STANDALONE_FONT_PREFERENCES.chat.preset)} / {getStandaloneFontPreferenceLabel('code', DEFAULT_STANDALONE_FONT_PREFERENCES.code.preset)}</div>
        </div>

        <div className="chat-container rounded-xl border border-border-subtle min-h-0 !p-4">
          <div className="chat-container-content">
            <div className="self-start max-w-[88%] min-w-0 flex flex-col gap-1">
              <div className="chat-bubble chat-bubble-assistant">
                <div className="chat-bubble-header mb-1.5">
                  <span className="chat-sender">Hermes</span>
                  <span className="chat-time">now</span>
                </div>
                <div className="chat-markdown">
                  <p>Readable prose, <strong>bold text</strong>, and <code>inline code</code> should all follow your standalone font choices.</p>
                  <pre><code>const message = 'standalone custom fonts'</code></pre>
                </div>
              </div>
            </div>
            <div className="chat-msg-tool">
              <span className="tool-icon">▸</span>
              <span className="tool-text">tool_call --scope standalone --font preview</span>
            </div>
            <div className="chat-msg-terminal">
              <div className="chat-msg-header">Terminal</div>
              <pre className="chat-msg-body">$ npm run dev:standalone\nready on http://localhost:3847</pre>
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={onSave}
          disabled={saving || !isDirty}
        >
          {saving ? 'Saving…' : 'Save font settings'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onResetToSaved}
          disabled={saving || !isDirty}
        >
          Revert to saved
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onResetToDefaults}
          disabled={saving}
        >
          Reset to defaults
        </Button>
      </div>
    </div>
  )
}
