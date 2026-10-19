import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useBaseDaemons } from '../../context/BaseDaemonContext'
import { useTransport } from '../../context/TransportContext'
import {
    ASSISTANT_MEMORY_LIMITS_COMMAND,
    parseStagedMemoryStatus,
    unwrapStagedAnswer,
    type AssistantMemoryStatus,
} from '../dashboard/assistant-staged'
import { AlertBanner } from '../ui/AlertBanner'
import Button from '../ui/Button'

type SendCommand = (daemonId: string, type: string, payload?: any) => Promise<any>

export interface AssistantMemoryLimitsSectionProps {
    daemonId?: string | null
    sendCommand?: SendCommand
    ownerRequired?: boolean
}

function parseLimitValue(raw: string): number {
    const trimmed = raw.trim()
    if (!trimmed) return Number.NaN
    const n = Number(trimmed)
    return Number.isFinite(n) ? Math.round(n) : Number.NaN
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
    ownerRequired: ownerRequiredProp,
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
    const [ownerRequiredState, setOwnerRequiredState] = useState(false)
    const ownerRequired = Boolean(ownerRequiredProp || ownerRequiredState)

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
            const unwrapped = unwrapStagedAnswer(raw)
            if (unwrapped?.code === 'COMMAND_SOURCE_REJECTED') {
                setOwnerRequiredState(true)
                setLoaded(true)
                return
            }
            const parsed = parseStagedMemoryStatus(raw)
            if (parsed) {
                setOwnerRequiredState(false)
                applyStatus(parsed)
            }
        } catch {
            // Keep fallback defaults when daemon is offline or uninitialized
        }
    }, [resolvedDaemonId, applyStatus])

    useEffect(() => {
        setSavedNotice(false)
        setError('')
        void refresh()
    }, [refresh])

    const memoryNum = parseLimitValue(memoryInput)
    const userNum = parseLimitValue(userInput)
    const memoryRangeError = !Number.isFinite(memoryNum) || memoryNum < status.memory.min || memoryNum > status.memory.max
        ? t('assistantMemoryLimits.outOfRange', {
            min: status.memory.min.toLocaleString(),
            max: status.memory.max.toLocaleString(),
            default: status.memory.defaultBudget.toLocaleString(),
        })
        : ''
    const userRangeError = !Number.isFinite(userNum) || userNum < status.user.min || userNum > status.user.max
        ? t('assistantMemoryLimits.outOfRange', {
            min: status.user.min.toLocaleString(),
            max: status.user.max.toLocaleString(),
            default: status.user.defaultBudget.toLocaleString(),
        })
        : ''

    const handleSave = async (nextMemory?: number, nextUser?: number) => {
        if (!resolvedDaemonId || ownerRequired) return
        const memNum = nextMemory !== undefined ? Math.round(nextMemory) : parseLimitValue(memoryInput)
        const usrNum = nextUser !== undefined ? Math.round(nextUser) : parseLimitValue(userInput)
        const clientErrors: string[] = []
        if (!Number.isFinite(memNum) || memNum < status.memory.min || memNum > status.memory.max) {
            clientErrors.push(
                `${t('assistantMemoryLimits.memoryLabel')}: ${t('assistantMemoryLimits.outOfRange', {
                    min: status.memory.min.toLocaleString(),
                    max: status.memory.max.toLocaleString(),
                    default: status.memory.defaultBudget.toLocaleString(),
                })}`,
            )
        }
        if (!Number.isFinite(usrNum) || usrNum < status.user.min || usrNum > status.user.max) {
            clientErrors.push(
                `${t('assistantMemoryLimits.userLabel')}: ${t('assistantMemoryLimits.outOfRange', {
                    min: status.user.min.toLocaleString(),
                    max: status.user.max.toLocaleString(),
                    default: status.user.defaultBudget.toLocaleString(),
                })}`,
            )
        }
        if (!Number.isFinite(memNum) || !Number.isFinite(usrNum)) {
            setSavedNotice(false)
            setError(clientErrors.join(' '))
            return
        }
        setSaving(true)
        setError('')
        setSavedNotice(false)
        try {
            const raw = await sendRef.current(resolvedDaemonId, ASSISTANT_MEMORY_LIMITS_COMMAND, {
                action: 'set',
                memory: memNum,
                user: usrNum,
            })
            const unwrapped = unwrapStagedAnswer(raw)
            if (unwrapped?.code === 'COMMAND_SOURCE_REJECTED') {
                setOwnerRequiredState(true)
                setError(t('assistantMemoryLimits.ownerRequired'))
                return
            }
            if (unwrapped?.success === false || clientErrors.length > 0) {
                const daemonError = typeof unwrapped?.error === 'string' && unwrapped.error.trim()
                    ? unwrapped.error.trim()
                    : ''
                setError(daemonError || clientErrors.join(' ') || t('assistantMemoryLimits.saveFailed'))
                return
            }
            const parsed = parseStagedMemoryStatus(raw)
            if (parsed) {
                applyStatus(parsed)
                setSavedNotice(true)
            } else {
                const daemonError = typeof unwrapped?.error === 'string' && unwrapped.error.trim()
                    ? unwrapped.error.trim()
                    : ''
                setError(daemonError || t('assistantMemoryLimits.saveFailed'))
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : t('assistantMemoryLimits.saveFailed'))
        } finally {
            setSaving(false)
        }
    }

    const handleResetDefaults = () => {
        if (ownerRequired) return
        const memDefault = Math.max(status.memory.defaultBudget, status.memory.min)
        const usrDefault = Math.max(status.user.defaultBudget, status.user.min)
        setMemoryInput(String(memDefault))
        setUserInput(String(usrDefault))
        void handleSave(memDefault, usrDefault)
    }

    const nearLimit = status.nearLimit || status.memory.percent >= status.warningThresholdPct || status.user.percent >= status.warningThresholdPct

    return (
        <div
            className="flex flex-col gap-3"
            data-assistant-memory-limits-section
            data-loaded={loaded ? 'true' : 'false'}
            data-owner-required={ownerRequired ? 'true' : 'false'}
        >
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

            {ownerRequired && (
                <AlertBanner variant="error">
                    <span data-assistant-memory-owner-required data-memory-limit-outcome="COMMAND_SOURCE_REJECTED">
                        {t('assistantMemoryLimits.ownerRequired')}
                    </span>
                </AlertBanner>
            )}

            {error && !ownerRequired && (
                <AlertBanner variant="error">
                    <span data-memory-limit-message data-memory-limit-outcome="error">{error}</span>
                </AlertBanner>
            )}
            {savedNotice && (
                <AlertBanner variant="success">
                    <span data-memory-limit-message data-memory-limit-outcome="saved">{t('assistantMemoryLimits.saved')}</span>
                </AlertBanner>
            )}

            <div className="grid gap-3 md:grid-cols-2">
                {([
                    {
                        key: 'memory' as const,
                        label: t('assistantMemoryLimits.memoryLabel'),
                        target: status.memory,
                        value: memoryInput,
                        rangeError: memoryRangeError,
                        onChange: setMemoryInput,
                    },
                    {
                        key: 'user' as const,
                        label: t('assistantMemoryLimits.userLabel'),
                        target: status.user,
                        value: userInput,
                        rangeError: userRangeError,
                        onChange: setUserInput,
                    },
                ]).map(({ key, label, target, value, rangeError, onChange }) => {
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
                                    aria-invalid={rangeError ? 'true' : 'false'}
                                    disabled={!resolvedDaemonId || saving || ownerRequired}
                                    data-memory-limit-input={key}
                                    onChange={e => {
                                        setSavedNotice(false)
                                        onChange(e.target.value)
                                    }}
                                />
                                <span className="text-2xs text-text-muted">
                                    {t('assistantMemoryLimits.boundsHint', {
                                        default: target.defaultBudget.toLocaleString(),
                                        min: target.min.toLocaleString(),
                                        max: target.max.toLocaleString(),
                                    })}
                                </span>
                            </div>

                            {rangeError && (
                                <div className="text-2xs text-status-error" data-memory-limit-error={key}>
                                    {rangeError}
                                </div>
                            )}
                        </div>
                    )
                })}
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    disabled={!resolvedDaemonId || saving || ownerRequired}
                    data-memory-limit-save
                    onClick={() => { void handleSave() }}
                >
                    {saving ? t('assistantMemoryLimits.saving') : t('assistantMemoryLimits.save')}
                </Button>
                <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={!resolvedDaemonId || saving || ownerRequired}
                    data-memory-limit-reset
                    onClick={handleResetDefaults}
                >
                    {t('assistantMemoryLimits.resetDefaults')}
                </Button>
            </div>
        </div>
    )
}
