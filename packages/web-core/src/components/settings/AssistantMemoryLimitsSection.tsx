import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useBaseDaemons } from '../../context/BaseDaemonContext'
import { useTransport } from '../../context/TransportContext'
import {
    ASSISTANT_MEMORY_LIMITS_COMMAND,
    parseStagedMemoryStatus,
    type AssistantMemoryStatus,
} from '../dashboard/assistant-staged'
import { AlertBanner } from '../ui/AlertBanner'
import Button from '../ui/Button'

type SendCommand = (daemonId: string, type: string, payload?: any) => Promise<any>

export interface AssistantMemoryLimitsSectionProps {
    daemonId?: string | null
    sendCommand?: SendCommand
}

const FALLBACK_STATUS: AssistantMemoryStatus = {
    budgets: { memory: 2200, user: 1375 },
    defaults: { memory: 2200, user: 1375 },
    min: { memory: 2200, user: 1375 },
    max: { memory: 8800, user: 5500 },
    warningThresholdPct: 90,
    nearLimit: false,
    usage: { memory: '0%', user: '0%' },
    memory: {
        used: 0,
        budget: 2200,
        percent: 0,
        usage: '0%',
        nearLimit: false,
        defaultBudget: 2200,
        min: 2200,
        max: 8800,
    },
    user: {
        used: 0,
        budget: 1375,
        percent: 0,
        usage: '0%',
        nearLimit: false,
        defaultBudget: 1375,
        min: 1375,
        max: 5500,
    },
}

export function AssistantMemoryLimitsSection({
    daemonId: daemonIdProp,
    sendCommand: sendCommandProp,
}: AssistantMemoryLimitsSectionProps = {}) {
    const { t } = useTranslation('common')
    const baseDaemons = useBaseDaemons()
    const transport = useTransport()

    const resolvedDaemonId = useMemo(() => {
        if (daemonIdProp !== undefined) return daemonIdProp
        const ides = baseDaemons?.ides ?? []
        const withAssistant = ides.find(
            (d: any) => d?.type === 'adhdev-daemon' && Array.isArray(d?.sessions) && d.sessions.some((s: any) => s?.isAssistant || s?.sessionRole === 'assistant'),
        )
        if (withAssistant?.id) return withAssistant.id
        const onlineDaemon = ides.find((d: any) => d?.type === 'adhdev-daemon' && d?.status === 'online')
        if (onlineDaemon?.id) return onlineDaemon.id
        const anyDaemon = ides.find((d: any) => d?.type === 'adhdev-daemon')
        return anyDaemon?.id ?? null
    }, [daemonIdProp, baseDaemons?.ides])

    const sendRef = useRef<SendCommand>(sendCommandProp ?? transport.sendCommand)
    sendRef.current = sendCommandProp ?? transport.sendCommand

    const [status, setStatus] = useState<AssistantMemoryStatus>(FALLBACK_STATUS)
    const [loaded, setLoaded] = useState(false)
    const [memoryInput, setMemoryInput] = useState<string>('2200')
    const [userInput, setUserInput] = useState<string>('1375')
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState('')
    const [savedNotice, setSavedNotice] = useState(false)

    const applyStatus = useCallback((next: AssistantMemoryStatus) => {
        setStatus(next)
        setMemoryInput(String(next.memory.budget))
        setUserInput(String(next.user.budget))
        setLoaded(true)
    }, [])

    const refresh = useCallback(async () => {
        if (!resolvedDaemonId) return
        try {
            const raw = await sendRef.current(resolvedDaemonId, ASSISTANT_MEMORY_LIMITS_COMMAND, { action: 'get' })
            const parsed = parseStagedMemoryStatus(raw)
            if (parsed) applyStatus(parsed)
        } catch {
            // Keep fallback defaults when daemon is offline or uninitialized
        }
    }, [resolvedDaemonId, applyStatus])

    useEffect(() => {
        setSavedNotice(false)
        setError('')
        void refresh()
    }, [refresh])

    const handleSave = async (nextMemory?: number, nextUser?: number) => {
        if (!resolvedDaemonId) return
        setSaving(true)
        setError('')
        setSavedNotice(false)
        try {
            const memNum = nextMemory ?? Number(memoryInput)
            const usrNum = nextUser ?? Number(userInput)
            const raw = await sendRef.current(resolvedDaemonId, ASSISTANT_MEMORY_LIMITS_COMMAND, {
                action: 'set',
                memory: Number.isFinite(memNum) ? Math.round(memNum) : status.memory.budget,
                user: Number.isFinite(usrNum) ? Math.round(usrNum) : status.user.budget,
            })
            const parsed = parseStagedMemoryStatus(raw)
            if (parsed) {
                applyStatus(parsed)
                setSavedNotice(true)
            } else {
                setError(t('assistantMemoryLimits.saveFailed'))
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : t('assistantMemoryLimits.saveFailed'))
        } finally {
            setSaving(false)
        }
    }

    const handleResetDefaults = () => {
        const memDefault = Math.max(status.memory.defaultBudget, status.memory.min)
        const usrDefault = Math.max(status.user.defaultBudget, status.user.min)
        setMemoryInput(String(memDefault))
        setUserInput(String(usrDefault))
        void handleSave(memDefault, usrDefault)
    }

    const nearLimit = status.nearLimit || status.memory.percent >= status.warningThresholdPct || status.user.percent >= status.warningThresholdPct

    return (
        <div className="flex flex-col gap-3" data-assistant-memory-limits-section data-loaded={loaded ? 'true' : 'false'}>
            <p className="text-xs text-text-muted m-0">
                {t('assistantMemoryLimits.promptNote')}
            </p>

            {nearLimit && (
                <AlertBanner variant="warning">
                    <div className="flex flex-col gap-0.5" data-assistant-memory-settings-warning>
                        <div className="font-semibold">{t('assistantMemoryLimits.warningTitle')}</div>
                        <div>{t('assistantMemoryLimits.warningBody')}</div>
                    </div>
                </AlertBanner>
            )}

            {error && <AlertBanner variant="error">{error}</AlertBanner>}
            {savedNotice && <AlertBanner variant="success">{t('assistantMemoryLimits.saved')}</AlertBanner>}

            <div className="grid gap-3 md:grid-cols-2">
                {([
                    {
                        key: 'memory' as const,
                        label: t('assistantMemoryLimits.memoryLabel'),
                        target: status.memory,
                        value: memoryInput,
                        onChange: setMemoryInput,
                    },
                    {
                        key: 'user' as const,
                        label: t('assistantMemoryLimits.userLabel'),
                        target: status.user,
                        value: userInput,
                        onChange: setUserInput,
                    },
                ]).map(({ key, label, target, value, onChange }) => {
                    const isNear = target.nearLimit || target.percent >= status.warningThresholdPct
                    return (
                        <div
                            key={key}
                            className="flex flex-col gap-2 rounded-xl border border-border-subtle bg-bg-glass p-3.5"
                            data-memory-limit-card={key}
                            data-near-limit={isNear ? 'true' : 'false'}
                        >
                            <div className="flex items-center justify-between gap-2">
                                <label
                                    htmlFor={`assistant-memory-limit-${key}`}
                                    className="text-xs font-semibold text-text-primary"
                                >
                                    {label}
                                </label>
                                <span
                                    className={`font-mono text-xs font-medium ${isNear ? 'text-status-warning' : 'text-text-secondary'}`}
                                    data-memory-usage={key}
                                >
                                    {t('assistantMemoryLimits.usageSummary', {
                                        used: target.used.toLocaleString(),
                                        budget: target.budget.toLocaleString(),
                                        percent: target.percent,
                                    })}
                                </span>
                            </div>

                            <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-secondary">
                                <div
                                    className={`h-full transition-all ${isNear ? 'bg-status-warning' : 'bg-accent-primary'}`}
                                    style={{ width: `${Math.min(100, Math.max(0, target.percent))}%` }}
                                />
                            </div>

                            <div className="flex items-center gap-2 pt-1">
                                <input
                                    id={`assistant-memory-limit-${key}`}
                                    type="number"
                                    className="input input-sm w-32 font-mono text-xs"
                                    min={target.min}
                                    max={target.max}
                                    step={25}
                                    value={value}
                                    disabled={!resolvedDaemonId || saving}
                                    data-memory-limit-input={key}
                                    onChange={e => {
                                        setSavedNotice(false)
                                        onChange(e.target.value)
                                    }}
                                />
                                <span className="text-[11px] text-text-muted">
                                    {t('assistantMemoryLimits.boundsHint', {
                                        default: target.defaultBudget.toLocaleString(),
                                        min: target.min.toLocaleString(),
                                        max: target.max.toLocaleString(),
                                    })}
                                </span>
                            </div>
                        </div>
                    )
                })}
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    disabled={!resolvedDaemonId || saving}
                    data-memory-limit-save
                    onClick={() => { void handleSave() }}
                >
                    {saving ? t('assistantMemoryLimits.saving') : t('assistantMemoryLimits.save')}
                </Button>
                <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={!resolvedDaemonId || saving}
                    data-memory-limit-reset
                    onClick={handleResetDefaults}
                >
                    {t('assistantMemoryLimits.resetDefaults')}
                </Button>
            </div>
        </div>
    )
}
