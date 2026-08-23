import { useTranslation } from 'react-i18next'
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
  const { t } = useTranslation('common')
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
        <div className="text-2xs text-text-muted">
          <span className="font-medium text-text-secondary">{t('standalone.fonts.resolvedStack')}</span>{' '}
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
  const { t } = useTranslation('common')
  const isDirty = JSON.stringify(value) !== JSON.stringify(savedValue)

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-border-subtle bg-bg-glass px-4 py-3 text-sm text-text-muted">
        {t('standalone.fonts.fontOverridesNotice')}
      </div>

      {error && <AlertBanner variant="error">{error}</AlertBanner>}
      {notice && <AlertBanner variant="success">{notice}</AlertBanner>}

      <div className="grid gap-3 lg:grid-cols-3">
        <FontControl
          surface="chat"
          title={t('standalone.fonts.chat')}
          description={t('standalone.fonts.chatDescription')}
          value={value.chat}
          options={CHAT_FONT_PRESET_OPTIONS}
          onChange={next => onChange(updateChoice(value, 'chat', next))}
        />
        <FontControl
          surface="code"
          title={t('standalone.fonts.code')}
          description={t('standalone.fonts.codeDescription')}
          value={value.code}
          options={MONO_FONT_PRESET_OPTIONS}
          onChange={next => onChange(updateChoice(value, 'code', next))}
        />
        <FontControl
          surface="terminal"
          title={t('standalone.fonts.terminal')}
          description={t('standalone.fonts.terminalDescription')}
          value={value.terminal}
          options={MONO_FONT_PRESET_OPTIONS}
          onChange={next => onChange(updateChoice(value, 'terminal', next))}
        />
      </div>

      <div className="rounded-2xl border border-border-subtle bg-bg-primary/70 p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-text-primary">{t('standalone.fonts.livePreview')}</div>
            <div className="text-xs text-text-muted mt-1">
              Chat: {getStandaloneFontPreferenceLabel('chat', value.chat.preset)} · Code: {getStandaloneFontPreferenceLabel('code', value.code.preset)} · Terminal: {getStandaloneFontPreferenceLabel('terminal', value.terminal.preset)}
            </div>
          </div>
          <div className="text-2xs text-text-muted">{t('standalone.fonts.defaults')} {getStandaloneFontPreferenceLabel('chat', DEFAULT_STANDALONE_FONT_PREFERENCES.chat.preset)} / {getStandaloneFontPreferenceLabel('code', DEFAULT_STANDALONE_FONT_PREFERENCES.code.preset)}</div>
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
          {saving ? t('standalone.fonts.saving') : t('standalone.fonts.saveFontSettings')}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onResetToSaved}
          disabled={saving || !isDirty}
        >
          {t('standalone.fonts.revertToSaved')}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onResetToDefaults}
          disabled={saving}
        >
          {t('standalone.fonts.resetToDefaults')}
        </Button>
      </div>
    </div>
  )
}
