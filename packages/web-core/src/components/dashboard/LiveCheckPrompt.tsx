import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import type { DaemonData } from '../../types'
import { useNeedsYou } from '../../context/NeedsYouContext'
import { useLiveCheckVersionPrompt } from '../../hooks/useLiveCheckVersionPrompt'
import { withTodoDrawer } from '../needs-you/needs-you-model'
import { IconX } from '../Icons'

/** "N live checks waiting on <machine>" after a daemon's version changed; opens Needs You filtered to the machine. */
export default function LiveCheckPrompt({ daemons }: { daemons: readonly DaemonData[] }) {
    const { t } = useTranslation('common')
    const navigate = useNavigate()
    const { snapshot } = useNeedsYou()
    const { prompts, dismiss } = useLiveCheckVersionPrompt(daemons, snapshot.liveChecks)
    if (prompts.length === 0) return null
    return (
        <>
            {prompts.map(p => (
                <div key={`${p.daemonId}@${p.version}`} data-testid="live-check-prompt" role="status" className="flex items-center gap-2.5 px-4 py-2 border-b text-xs text-text-secondary shrink-0 flex-wrap"
                    style={{ background: 'color-mix(in srgb, var(--status-info, var(--accent-primary)) 8%, transparent)', borderColor: 'color-mix(in srgb, var(--status-info, var(--accent-primary)) 20%, transparent)' }}>
                    <span className="flex-1 min-w-0">{t('needsYou.liveChecksPrompt', { count: p.count, machine: p.machine, version: p.version })}</span>
                    <button type="button" className="btn btn-sm btn-primary min-h-[44px] md:min-h-0" data-testid="live-check-prompt-open"
                        onClick={() => {
                            const q = new URLSearchParams(withTodoDrawer(''))
                            q.set('machine', p.machine)
                            navigate({ pathname: '/dashboard', search: `?${q.toString()}` })
                            dismiss(p)
                        }}>{t('needsYou.liveChecksPromptOpen')}</button>
                    <button type="button" className="btn btn-sm btn-ghost min-h-[44px] md:min-h-0" aria-label={t('needsYou.liveChecksPromptDismiss')} onClick={() => dismiss(p)}><IconX size={14} /></button>
                </div>
            ))}
        </>
    )
}
