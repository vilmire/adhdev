/**
 * ProviderFixModal — Auto-implement provider scripts via AI agent.
 *
 * Features:
 * - Agent selection (Codex / Claude / Gemini)
 * - Script function selection (checkbox)
 * - User comment / instructions input
 * - Real-time log output (polling-based)
 * - Cancel running task
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProviderInfo } from './types'
import ModalPortal from '../../components/ui/ModalPortal'

const SCRIPTS = [
    'openPanel', 'sendMessage', 'readChat', 'newSession',
    'listSessions', 'switchSession', 'resolveAction',
    'listModels', 'setModel', 'listModes', 'setMode', 'focusEditor',
]

interface ProviderFixModalProps {
    machineId: string
    provider: ProviderInfo
    sendDaemonCommand: (id: string, type: string, data?: Record<string, unknown>) => Promise<any>
    onClose: () => void
}

type Phase = 'config' | 'running' | 'done' | 'error'

export default function ProviderFixModal({ machineId, provider, sendDaemonCommand, onClose }: ProviderFixModalProps) {
    const { t } = useTranslation('common')
    const AGENTS_I18N = [
        { value: 'codex-cli', label: 'Codex CLI', desc: t('machine.providerFix.descCodex'), color: '#22c55e' },
        { value: 'claude-cli', label: 'Claude Code', desc: t('machine.providerFix.descClaude'), color: '#a855f7' },
        { value: 'gemini-cli', label: 'Gemini CLI', desc: t('machine.providerFix.descGemini'), color: '#3b82f6' },
    ]
    const [phase, setPhase] = useState<Phase>('config')
    const [agent, setAgent] = useState('codex-cli')
    const [selectedScripts, setSelectedScripts] = useState<string[]>([])
    const [comment, setComment] = useState('')
    const [logs, setLogs] = useState<string[]>([])
    const [error, setError] = useState('')
    const logsEndRef = useRef<HTMLDivElement>(null)
    const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)

    const toggleScript = (s: string) => {
        setSelectedScripts(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s])
    }

    const selectAll = () => setSelectedScripts([...SCRIPTS])
    const selectNone = () => setSelectedScripts([])

    // Scroll logs to bottom
    useEffect(() => {
        logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }, [logs])

    // Cleanup polling on unmount
    useEffect(() => () => {
        if (pollingRef.current) clearInterval(pollingRef.current)
    }, [])

    const startPolling = useCallback(() => {
        if (pollingRef.current) clearInterval(pollingRef.current)
        pollingRef.current = setInterval(async () => {
            try {
                const res = await sendDaemonCommand(machineId, 'provider_auto_fix_status', {
                    providerType: provider.type,
                })
                if (res?.running === false && phase === 'running') {
                    setPhase('done')
                    setLogs(prev => [...prev, '\n✅ Auto-fix completed!'])
                    if (pollingRef.current) clearInterval(pollingRef.current)
                }
            } catch { /* ignore polling errors */ }
        }, 3000)
    }, [machineId, provider.type, sendDaemonCommand, phase])

    const handleStart = async () => {
        if (selectedScripts.length === 0) return
        setPhase('running')
        setLogs(['🚀 Starting auto-fix...', `Agent: ${agent}`, `Scripts: ${selectedScripts.join(', ')}`, comment ? `💬 Comment: ${comment}` : '', ''])
        setError('')

        try {
            const res = await sendDaemonCommand(machineId, 'provider_auto_fix', {
                providerType: provider.type,
                functions: selectedScripts,
                agent,
                ...(comment ? { comment } : {}),
            })
            if (res?.success && (res?.started || res?.running)) {
                setLogs(prev => [...prev, '✅ Agent started. Monitoring progress...'])
                startPolling()
            } else {
                setPhase('error')
                setError(res?.error || 'Failed to start auto-fix')
            }
        } catch (e: any) {
            setPhase('error')
            setError(e?.message || 'Connection failed')
        }
    }

    const handleCancel = async () => {
        try {
            await sendDaemonCommand(machineId, 'provider_auto_fix_cancel', {
                providerType: provider.type,
            })
            setLogs(prev => [...prev, '\n⚠️ Auto-fix cancelled.'])
            setPhase('done')
            if (pollingRef.current) clearInterval(pollingRef.current)
        } catch { /* ignore */ }
    }

    return (
        <ModalPortal>
        <div className="fixed inset-0 z-[var(--z-modal)] flex items-end justify-center overflow-y-auto bg-black/60 backdrop-blur-sm px-2 pt-[calc(8px+env(safe-area-inset-top,0px))] pb-[calc(8px+env(safe-area-inset-bottom,0px))] sm:items-center sm:p-4" onClick={onClose}>
            <div
                className="w-full max-w-[560px] max-h-[calc(100dvh-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px)-16px)] sm:max-h-[85vh] overflow-hidden rounded-[24px] sm:rounded-2xl bg-bg-primary border border-border-subtle shadow-2xl flex flex-col"
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="px-5 py-4 border-b border-border-subtle flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                        <span className="text-lg">{provider.icon || '🔧'}</span>
                        <div>
                            <h2 className="text-[15px] font-semibold text-text-primary">{t('machine.providerFix.titlePrefix', { name: provider.displayName })}</h2>
                            <p className="text-[11px] text-text-muted mt-0.5">{t('machine.providerFix.footerHint')}</p>
                        </div>
                    </div>
                    {/* >=44px tap target (Apple HIG); -m-2 keeps the visual
                        position of the old icon-only × unchanged. */}
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close"
                        className="-m-2 flex h-11 w-11 shrink-0 items-center justify-center text-text-muted hover:text-text-primary text-lg leading-none"
                    >×</button>
                </div>

                {/* Body */}
                <div className="flex-1 overflow-y-auto px-5 py-4">
                    {phase === 'config' && (
                        <div className="flex flex-col gap-4">
                            {/* Agent Selection */}
                            <div>
                                <label className="text-[11px] text-text-muted font-semibold uppercase tracking-wider mb-1.5 block">{t('machine.providerFix.aiAgent')}</label>
                                <div className="flex gap-2">
                                    {AGENTS_I18N.map(a => (
                                        <button
                                            key={a.value}
                                            onClick={() => setAgent(a.value)}
                                            className="flex-1 px-3 py-2 rounded-lg border text-left transition-all"
                                            style={{
                                                borderColor: agent === a.value ? a.color + '66' : 'var(--border-subtle)',
                                                background: agent === a.value ? a.color + '0d' : 'transparent',
                                            }}
                                        >
                                            <div className="text-[12px] font-semibold" style={{ color: agent === a.value ? a.color : 'var(--text-primary)' }}>
                                                {a.label}
                                            </div>
                                            <div className="text-[10px] text-text-muted">{a.desc}</div>
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Script Selection */}
                            <div>
                                <div className="flex items-center justify-between mb-1.5">
                                    <label className="text-[11px] text-text-muted font-semibold uppercase tracking-wider">{t('machine.providerFix.scriptsToFix')}</label>
                                    <div className="flex gap-1.5">
                                        <button onClick={selectAll} className="text-[10px] text-accent-primary hover:text-accent-primary-light">{t('machine.providerFix.all')}</button>
                                        <span className="text-[10px] text-text-muted">|</span>
                                        <button onClick={selectNone} className="text-[10px] text-text-muted hover:text-text-secondary">{t('machine.providerFix.none')}</button>
                                    </div>
                                </div>
                                <div className="grid grid-cols-3 gap-1.5">
                                    {SCRIPTS.map(s => (
                                        <button
                                            key={s}
                                            onClick={() => toggleScript(s)}
                                            className="px-2.5 py-1.5 rounded-md border text-[11px] font-medium text-left transition-all"
                                            style={{
                                                borderColor: selectedScripts.includes(s) ? 'color-mix(in srgb, var(--accent-primary) 40%, transparent)' : 'var(--border-subtle)',
                                                background: selectedScripts.includes(s) ? 'color-mix(in srgb, var(--accent-primary) 8%, transparent)' : 'transparent',
                                                color: selectedScripts.includes(s) ? 'var(--accent-primary)' : 'var(--text-secondary)',
                                            }}
                                        >
                                            {selectedScripts.includes(s) ? '☑ ' : '☐ '}{s}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Comment */}
                            <div>
                                <label className="text-[11px] text-text-muted font-semibold uppercase tracking-wider mb-1.5 block">
                                    {t('machine.providerFix.additionalInstructions')} <span className="text-text-muted font-normal">{t('machine.providerFix.optional')}</span>
                                </label>
                                <textarea
                                    value={comment}
                                    onChange={e => setComment(e.target.value)}
                                    placeholder="e.g. Also search buttons inside Shadow DOM, preserve code block formatting in readChat..."
                                    rows={2}
                                    className="w-full px-3 py-2 rounded-lg border border-border-subtle bg-bg-secondary text-text-primary text-[12px] resize-none placeholder:text-text-muted/50 focus:outline-none focus:border-accent-primary/40"
                                />
                            </div>
                        </div>
                    )}

                    {(phase === 'running' || phase === 'done' || phase === 'error') && (
                        <div>
                            <label className="text-[11px] text-text-muted font-semibold uppercase tracking-wider mb-1.5 block">{t('machine.providerFix.agentOutput')}</label>
                            <div
                                className="rounded-lg border border-border-subtle bg-bg-secondary p-3 font-mono text-[11px] leading-relaxed text-text-secondary overflow-y-auto"
                                style={{ maxHeight: 320, minHeight: 200 }}
                            >
                                {logs.map((line, i) => (
                                    <div key={i} className={line.startsWith('✅') ? 'text-green-400' : ''} style={(line.startsWith('❌') || line.startsWith('⚠')) ? { color: 'var(--status-warning)' } : undefined}>
                                        {line}
                                    </div>
                                ))}
                                {phase === 'running' && (
                                    <div className="text-accent-primary animate-pulse mt-1">{t('machine.providerFix.running')}</div>
                                )}
                                <div ref={logsEndRef} />
                            </div>
                            {error && (
                                <div className="mt-2 px-3 py-2 rounded-lg bg-red-500/[0.06] border border-red-500/20 text-red-400 text-[11px]">
                                    {error}
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="px-5 py-3.5 border-t border-border-subtle flex justify-between items-center">
                    <div className="text-[10px] text-text-muted">
                        {phase === 'config' && selectedScripts.length > 0 && t('machine.providerFix.scriptsSelected', { count: selectedScripts.length })}
                        {phase === 'running' && t('machine.providerFix.agentGenerating')}
                        {phase === 'done' && t('machine.providerFix.validateHint')}
                    </div>
                    <div className="flex gap-2">
                        {phase === 'config' && (
                            <>
                                <button onClick={onClose} className="machine-btn">{t('machine.providerFix.cancel')}</button>
                                <button
                                    onClick={handleStart}
                                    disabled={selectedScripts.length === 0}
                                    className="machine-btn"
                                    style={{
                                        background: selectedScripts.length > 0 ? 'color-mix(in srgb, var(--accent-primary) 15%, transparent)' : undefined,
                                        borderColor: selectedScripts.length > 0 ? 'color-mix(in srgb, var(--accent-primary) 40%, transparent)' : undefined,
                                        color: selectedScripts.length > 0 ? '#a78bfa' : undefined,
                                        opacity: selectedScripts.length === 0 ? 0.4 : 1,
                                    }}
                                >
                                    {t('machine.providerFix.startFix')}
                                </button>
                            </>
                        )}
                        {phase === 'running' && (
                            <button onClick={handleCancel} className="machine-btn text-red-400 border-red-500/30">
                                {t('machine.providerFix.cancelRunning')}
                            </button>
                        )}
                        {(phase === 'done' || phase === 'error') && (
                            <>
                                <button onClick={() => { setPhase('config'); setLogs([]); setError(''); }} className="machine-btn">
                                    {t('machine.providerFix.back')}
                                </button>
                                <button onClick={onClose} className="machine-btn">{t('machine.providerFix.close')}</button>
                            </>
                        )}
                    </div>
                </div>
            </div>
        </div>
        </ModalPortal>
    )
}
