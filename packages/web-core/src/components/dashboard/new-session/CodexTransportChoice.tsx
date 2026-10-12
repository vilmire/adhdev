import { useTranslation } from 'react-i18next'

export default function CodexTransportChoice({ checked, disabled, onChange }: {
  checked: boolean; disabled: boolean; onChange: (checked: boolean) => void
}) {
  const { t } = useTranslation('common')
  return <label className="block rounded-lg border border-border-subtle px-4 py-3">
    <span className="flex items-center gap-2 text-sm text-text-primary">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.currentTarget.checked)} />
      {t('newSession.codexManagedQuestions')}
    </span>
    <span className="mt-1 block text-xs text-text-muted">{t('newSession.codexManagedQuestionsDescription')}</span>
  </label>
}
