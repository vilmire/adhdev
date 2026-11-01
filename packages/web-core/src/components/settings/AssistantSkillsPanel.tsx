import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useBaseDaemons } from '../../context/BaseDaemonContext'
import { useTransport } from '../../context/TransportContext'
import { unwrapStagedAnswer } from '../dashboard/assistant-staged'
import {
    ASSISTANT_SKILLS_LIST_COMMAND,
    ASSISTANT_STORE_ADMIN_COMMAND,
    parseSkillsList,
    type AssistantSkillRow,
    type AssistantSkillsList,
} from '../dashboard/assistant-skills'
import { RelativeTime } from '../ui/RelativeTime'

type SendCommand = (daemonId: string, type: string, payload?: any) => Promise<any>

export interface AssistantSkillsPanelProps {
    daemonId?: string | null
    sendCommand?: SendCommand
}

type SkillAction = 'pin' | 'unpin' | 'restore' | 'archive'

/**
 * The assistant's skills with how often each was attached to a project request
 * (design 2026-11-01-procedure-skills.md §9). Reading the list never counts a
 * view. "Attached" is the number of times the skill's text was handed to a
 * coordinator; whether it was followed is not observable, so it is not called "applied".
 */
export function AssistantSkillsPanel({ daemonId: daemonIdProp, sendCommand: sendCommandProp }: AssistantSkillsPanelProps = {}) {
    const { t } = useTranslation('common')
    const baseDaemons = useBaseDaemons()
    const transport = useTransport()
    const daemonId = useMemo(() => {
        if (daemonIdProp !== undefined) return daemonIdProp
        const ides = baseDaemons?.ides ?? []
        const withAssistant = ides.find(
            (d: any) => d?.type === 'adhdev-daemon' && Array.isArray(d?.sessions) && d.sessions.some((s: any) => s?.isAssistant || s?.sessionRole === 'assistant'),
        )
        return withAssistant?.id ?? ides.find((d: any) => d?.type === 'adhdev-daemon' && d?.status === 'online')?.id ?? null
    }, [daemonIdProp, baseDaemons?.ides])
    const sendRef = useRef<SendCommand>(sendCommandProp ?? transport.sendCommand)
    sendRef.current = sendCommandProp ?? transport.sendCommand

    const [list, setList] = useState<AssistantSkillsList | null>(null)
    const [busy, setBusy] = useState<string | null>(null)
    const [error, setError] = useState('')

    const refresh = useCallback(async () => {
        if (!daemonId) return
        try {
            setList(parseSkillsList(await sendRef.current(daemonId, ASSISTANT_SKILLS_LIST_COMMAND, {})))
        } catch {
            setList(null)
        }
    }, [daemonId])

    useEffect(() => {
        setList(null)
        void refresh()
    }, [refresh])

    const act = async (name: string, action: SkillAction) => {
        if (!daemonId) return
        setBusy(name)
        setError('')
        try {
            const out = unwrapStagedAnswer(await sendRef.current(daemonId, ASSISTANT_STORE_ADMIN_COMMAND, { target: 'skill', action, name }))
            if (out?.success === false) setError(t('assistantSkills.actionFailed', { code: String(out.code || out.result || 'failed') }))
        } catch (e) {
            setError(t('assistantSkills.actionFailed', { code: e instanceof Error ? e.message : String(e) }))
        }
        setBusy(null)
        await refresh()
    }

    // A daemon without the verb (older build) or no daemon: show nothing rather than an empty promise.
    if (!daemonId || !list) return null
    const s = list.summary
    return (
        <div className="flex flex-col gap-2 border-t border-border-subtle pt-4" data-assistant-skills-panel>
            <div className="text-xs text-text-muted font-medium">{t('assistantSkills.title')}</div>
            <div className="text-xs text-text-muted">{t('assistantSkills.hint')}</div>
            {s && s.sends > 0 && (
                <div className="text-xs text-text-muted" data-assistant-skills-summary>
                    {t('assistantSkills.summary', { days: s.days, sends: s.sends, attaches: s.attaches })}
                </div>
            )}
            {error && <div className="text-xs text-status-error" data-assistant-skills-error>{error}</div>}
            {list.skills.length === 0 && <div className="text-xs italic text-text-muted">{t('assistantSkills.empty')}</div>}
            <ul className="flex flex-col divide-y divide-border-subtle rounded-md border border-border-subtle">
                {list.skills.map(skill => (
                    <SkillRow key={skill.name} skill={skill} busy={busy === skill.name} onAction={a => void act(skill.name, a)} />
                ))}
            </ul>
        </div>
    )
}

function SkillRow({ skill, busy, onAction }: { skill: AssistantSkillRow; busy: boolean; onAction: (a: SkillAction) => void }) {
    const { t } = useTranslation('common')
    const originKey = ['starter', 'owner', 'agent', 'imported'].includes(skill.origin) ? skill.origin : 'owner'
    return (
        <li className="flex flex-col gap-1 px-2.5 py-2 text-xs" data-assistant-skill={skill.name} data-skill-status={skill.status}>
            <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono font-medium text-text-primary">{skill.name}</span>
                <span className="rounded bg-bg-secondary px-1.5 py-px text-[10px] leading-none text-text-muted" data-skill-origin={skill.origin}>
                    {t(`assistantSkills.origin.${originKey}`)}
                </span>
                {skill.status !== 'active' && (
                    <span className="rounded bg-status-warning/15 px-1.5 py-px text-[10px] leading-none text-status-warning">{t(`assistantSkills.status.${skill.status}`)}</span>
                )}
                {skill.pinned && <span className="text-[10px] leading-3 text-text-muted">{t('assistantSkills.pinned')}</span>}
            </div>
            {skill.description && <div className="text-text-secondary">{skill.description}</div>}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-text-muted">
                <span data-skill-attach-count={skill.attachCount} title={t('assistantSkills.attachedTooltip')}>
                    {t('assistantSkills.attached', { count: skill.attachCount })}
                </span>
                <span data-skill-view-count={skill.viewCount}>{t('assistantSkills.viewed', { count: skill.viewCount })}</span>
                <span>
                    {skill.lastUsedAt
                        ? <>{t('assistantSkills.lastUsed')} <RelativeTime value={skill.lastUsedAt} live={false} /></>
                        : t('assistantSkills.neverUsed')}
                </span>
                <span className="ml-auto flex gap-1">
                    <button type="button" className="btn btn-sm btn-secondary" disabled={busy} data-skill-action={skill.pinned ? 'unpin' : 'pin'}
                        onClick={() => onAction(skill.pinned ? 'unpin' : 'pin')}>
                        {skill.pinned ? t('assistantSkills.unpin') : t('assistantSkills.pin')}
                    </button>
                    {skill.status === 'active'
                        ? <button type="button" className="btn btn-sm btn-secondary" disabled={busy} data-skill-action="archive" onClick={() => onAction('archive')}>{t('assistantSkills.archive')}</button>
                        : <button type="button" className="btn btn-sm btn-secondary" disabled={busy} data-skill-action="restore" onClick={() => onAction('restore')}>{t('assistantSkills.restore')}</button>}
                </span>
            </div>
        </li>
    )
}
