/**
 * StartAssistantButton — the dashboard header's "Start assistant" split button
 * (design 2026-10-07-assistant-layer.md §4.7).
 *
 * The main part launches the default target (remembered choice, else
 * claude-cli, else the first eligible CLI). The chevron opens a menu listing
 * the CLIs of every machine that can host the assistant: eligible ones are
 * selectable, a CLI whose tool limit is only the system prompt carries a
 * "no tool lock" note, and ineligible ones are listed disabled with the
 * daemon's reason. Machine headings appear only when more than one machine is
 * online. Eligibility is the daemon's own (`availableProviders[].assistant`).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import { IconAssistant, IconCheck, IconChevronLeft } from '../Icons'
import type { AssistantLaunchTarget, AssistantMachineOption } from './assistant-session'

export interface StartAssistantButtonProps {
    /** Main click: launch the default target. */
    onStart: () => void
    /** Dropdown choice: launch this CLI on this machine. */
    onStartWith?: (target: AssistantLaunchTarget) => void
    machines?: AssistantMachineOption[]
    defaultTarget?: AssistantLaunchTarget | null
    pending?: boolean
    error?: string | null
}

const MENU_WIDTH = 280

export default function StartAssistantButton({
    onStart,
    onStartWith,
    machines = [],
    defaultTarget = null,
    pending = false,
    error = null,
}: StartAssistantButtonProps) {
    const { t } = useTranslation('common')
    const [open, setOpen] = useState(false)
    const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
    const toggleRef = useRef<HTMLButtonElement | null>(null)
    const menuRef = useRef<HTMLDivElement | null>(null)
    const showMachines = machines.length > 1
    const hasMenu = !!onStartWith && machines.some(m => m.clis.length > 0)
    const defaultLabel = defaultTarget
        ? machines.find(m => m.machineId === defaultTarget.machineId)?.clis.find(c => c.cliType === defaultTarget.cliType)?.label || defaultTarget.cliType
        : ''

    const close = useCallback((focusToggle = false) => {
        setOpen(false)
        if (focusToggle) toggleRef.current?.focus()
    }, [])

    useLayoutEffect(() => {
        if (!open || typeof window === 'undefined') { setPosition(null); return }
        const rect = toggleRef.current?.getBoundingClientRect()
        if (!rect) return
        const left = Math.min(Math.max(8, rect.left), window.innerWidth - MENU_WIDTH - 8)
        setPosition({ top: rect.bottom + 6, left: Math.max(8, left) })
    }, [open])

    useEffect(() => {
        if (!open || typeof window === 'undefined') return
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return
            event.stopPropagation()
            close(true)
        }
        const onPointerDown = (event: MouseEvent | PointerEvent) => {
            const target = event.target as Node | null
            if (!target) return
            if (toggleRef.current?.contains(target) || menuRef.current?.contains(target)) return
            close()
        }
        const onResize = () => close()
        window.addEventListener('keydown', onKeyDown, true)
        document.addEventListener('mousedown', onPointerDown, true)
        window.addEventListener('resize', onResize)
        return () => {
            window.removeEventListener('keydown', onKeyDown, true)
            document.removeEventListener('mousedown', onPointerDown, true)
            window.removeEventListener('resize', onResize)
        }
    }, [close, open])

    useEffect(() => {
        if (!open) return
        menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]:not([disabled])')?.focus()
    }, [open, position])

    const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        event.preventDefault()
        const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]:not([disabled])') ?? [])
        if (buttons.length === 0) return
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]
        next?.focus()
    }

    const mainTitle = error
        ? t('dashboard.assistant.startFailed', { error })
        : defaultLabel
            ? `${t('dashboard.assistant.startHint')} · ${t('dashboard.assistantLaunch.startWith', { cli: defaultLabel })}`
            : t('dashboard.assistant.startHint')

    return (
        <span className="ml-2 inline-flex items-stretch" data-testid="dashboard-start-assistant-group">
            <button
                type="button"
                onClick={onStart}
                disabled={pending}
                className={cn('btn btn-secondary btn-sm inline-flex items-center gap-1.5', hasMenu && 'rounded-r-none')}
                title={mainTitle}
                aria-label={t('dashboard.assistant.start')}
                data-testid="dashboard-start-assistant"
            >
                <IconAssistant size={14} />
                <span>{pending ? t('dashboard.assistant.starting') : t('dashboard.assistant.start')}</span>
            </button>
            {hasMenu && (
                <button
                    ref={toggleRef}
                    type="button"
                    onClick={() => setOpen(value => !value)}
                    disabled={pending}
                    className="btn btn-secondary btn-sm rounded-l-none border-l border-border-default px-1.5 inline-flex items-center"
                    title={t('dashboard.assistantLaunch.chooseCli')}
                    aria-label={t('dashboard.assistantLaunch.chooseCli')}
                    aria-haspopup="menu"
                    aria-expanded={open}
                    data-testid="dashboard-start-assistant-menu"
                >
                    <IconChevronLeft size={12} className="-rotate-90" />
                </button>
            )}
            {open && hasMenu && typeof document !== 'undefined' && createPortal(
                <div
                    ref={menuRef}
                    role="menu"
                    aria-label={t('dashboard.assistantLaunch.chooseCli')}
                    onKeyDown={onMenuKeyDown}
                    data-testid="dashboard-start-assistant-options"
                    className="fixed z-[var(--z-popover)] flex max-h-[70vh] flex-col overflow-y-auto rounded-xl border border-border-default bg-bg-card p-1 shadow-xl backdrop-blur-xl"
                    style={position ? { top: position.top, left: position.left, width: MENU_WIDTH } : { top: -9999, left: -9999, width: MENU_WIDTH, visibility: 'hidden' }}
                >
                    {machines.map(machine => (
                        <div key={machine.machineId} role="group" aria-label={machine.label} className="flex flex-col">
                            {showMachines && (
                                <div className="px-2.5 pb-1 pt-2 text-2xs font-semibold uppercase tracking-wide text-text-muted">{machine.label}</div>
                            )}
                            {machine.clis.map(cli => {
                                const isDefault = !!defaultTarget && defaultTarget.machineId === machine.machineId && defaultTarget.cliType === cli.cliType
                                return (
                                    <button
                                        key={cli.cliType}
                                        type="button"
                                        role="menuitemradio"
                                        aria-checked={isDefault}
                                        disabled={!cli.supported}
                                        data-assistant-cli={cli.cliType}
                                        data-assistant-machine={machine.machineId}
                                        title={!cli.supported
                                            ? t('dashboard.assistantLaunch.unavailable', { reason: cli.reason || t('dashboard.assistantLaunch.unsupported') })
                                            : cli.promptOnly ? t('dashboard.assistantLaunch.noToolLockHint') : undefined}
                                        onClick={() => {
                                            if (!cli.supported) return
                                            close()
                                            onStartWith?.({ machineId: machine.machineId, cliType: cli.cliType })
                                        }}
                                        className={cn(
                                            'flex w-full items-start gap-2.5 rounded-lg border-none bg-transparent px-2.5 py-2 text-left text-xs font-medium text-text-secondary transition-colors',
                                            cli.supported
                                                ? 'hover:bg-bg-secondary hover:text-text-primary focus-visible:bg-bg-secondary focus-visible:text-text-primary focus-visible:outline-none'
                                                : 'cursor-not-allowed opacity-50',
                                        )}
                                    >
                                        <span className="mt-0.5 flex w-4 shrink-0 justify-center" aria-hidden>{isDefault ? <IconCheck size={13} /> : null}</span>
                                        <span className="flex min-w-0 flex-col">
                                            <span className="flex min-w-0 items-center gap-1.5">
                                                <span className="truncate">{cli.label}</span>
                                                {cli.supported && cli.promptOnly && (
                                                    <span className="shrink-0 rounded border border-border-default px-1 text-2xs text-text-muted" data-testid="assistant-cli-no-tool-lock">
                                                        {t('dashboard.assistantLaunch.noToolLock')}
                                                    </span>
                                                )}
                                            </span>
                                            {!cli.supported && (
                                                <span className="line-clamp-2 text-2xs font-normal text-text-muted" data-testid="assistant-cli-unavailable-reason">
                                                    {cli.reason || t('dashboard.assistantLaunch.unsupported')}
                                                </span>
                                            )}
                                        </span>
                                    </button>
                                )
                            })}
                        </div>
                    ))}
                </div>,
                document.body,
            )}
        </span>
    )
}
