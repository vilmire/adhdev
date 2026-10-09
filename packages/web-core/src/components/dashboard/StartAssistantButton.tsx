/**
 * StartAssistantButton — the dashboard header's "Start assistant" split button
 * (design 2026-10-07-assistant-layer.md §4.7).
 *
 * The main part launches the default target (remembered choice, else
 * claude-cli, else the first eligible CLI, on the machine hosting the most projects). The chevron opens a menu listing
 * the CLIs of every machine that can host the assistant: eligible ones are
 * selectable, a CLI whose tool limit is only the system prompt carries a
 * "no tool lock" note, and ineligible ones are listed disabled with the
 * daemon's reason. Machine headings appear only when more than one machine is
 * online; machines are listed host-first (most hosted projects first — an
 * assistant can only route work to projects on its own daemon) and a heading
 * says "hosts N projects". Eligibility is the daemon's own (`availableProviders[].assistant`).
 *
 * Picking a CLI selects it; the footer then offers compact Model / Thinking
 * selects for that CLI (only the lists its manifest advertises — a CLI with
 * no thinking levels gets no thinking select) and a Start button that launches
 * the selection.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import { IconAssistant, IconCheck, IconChevronLeft } from '../Icons'
import { assistantLaunchTargetFor, type AssistantLaunchTarget, type AssistantMachineOption } from './assistant-session'

export interface StartAssistantButtonProps {
    /** Main click: launch the default target. */
    onStart: () => void
    /** Dropdown choice: launch this CLI on this machine (with its model / thinking level). */
    onStartWith?: (target: AssistantLaunchTarget) => void
    machines?: AssistantMachineOption[]
    defaultTarget?: AssistantLaunchTarget | null
    pending?: boolean
    error?: string | null
    /** Wrapper classes (default: the header's left gap). */
    className?: string
}

const MENU_WIDTH = 280

export default function StartAssistantButton({
    onStart,
    onStartWith,
    machines = [],
    defaultTarget = null,
    pending = false,
    error = null,
    className = 'ml-2',
}: StartAssistantButtonProps) {
    const { t } = useTranslation('common')
    const [open, setOpen] = useState(false)
    const [selected, setSelected] = useState<AssistantLaunchTarget | null>(null)
    const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
    const toggleRef = useRef<HTMLButtonElement | null>(null)
    const menuRef = useRef<HTMLDivElement | null>(null)
    const showMachines = machines.length > 1
    const hasMenu = !!onStartWith && machines.some(m => m.clis.length > 0)
    const cliLabel = defaultTarget
        ? machines.find(m => m.machineId === defaultTarget.machineId)?.clis.find(c => c.cliType === defaultTarget.cliType)?.label || defaultTarget.cliType
        : ''
    const defaultLabel = cliLabel && defaultTarget?.model ? `${cliLabel} · ${defaultTarget.model}` : cliLabel
    const selectedCli = selected
        ? machines.find(m => m.machineId === selected.machineId)?.clis.find(c => c.cliType === selected.cliType && c.supported)
        : undefined

    const toggle = () => {
        // The selection starts from the default target each time the menu opens.
        if (!open) setSelected(defaultTarget)
        setOpen(!open)
    }
    const pickOption = (field: 'model' | 'thinkingLevel', value: string) => {
        if (!selected || !selectedCli) return
        setSelected(assistantLaunchTargetFor(selected.machineId, selectedCli, { ...selected, [field]: value || undefined }))
    }

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
        const menu = menuRef.current
        ;(menu?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]:not([disabled])')
            ?? menu?.querySelector<HTMLButtonElement>('[role="menuitemradio"]:not([disabled])'))?.focus()
    }, [open, position])

    const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        // Arrow keys inside the model / thinking selects belong to the select.
        if ((event.target as HTMLElement | null)?.getAttribute?.('role') !== 'menuitemradio') return
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
        <span className={cn(className, 'inline-flex items-stretch')} data-testid="dashboard-start-assistant-group">
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
                    onClick={toggle}
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
                    className="fixed z-[var(--z-popover)] flex max-h-[70vh] flex-col rounded-xl border border-border-default bg-bg-card p-1 shadow-xl backdrop-blur-xl"
                    style={position ? { top: position.top, left: position.left, width: MENU_WIDTH } : { top: -9999, left: -9999, width: MENU_WIDTH, visibility: 'hidden' }}
                >
                    <div className="flex min-h-0 flex-col overflow-y-auto">
                    {machines.map(machine => (
                        <div key={machine.machineId} role="group" aria-label={machine.label} className="flex flex-col">
                            {showMachines && (
                                <div className="flex min-w-0 items-baseline gap-1.5 px-2.5 pb-1 pt-2 text-2xs text-text-muted">
                                    <span className="truncate font-semibold uppercase tracking-wide">{machine.label}</span>
                                    {machine.hostedProjects > 0 && (
                                        <span
                                            className="shrink-0 font-normal"
                                            title={t('dashboard.assistantLaunch.hostsProjectsHint')}
                                            data-testid="assistant-machine-hosts-projects"
                                        >
                                            {t('dashboard.assistantLaunch.hostsProjects', { count: machine.hostedProjects })}
                                        </span>
                                    )}
                                </div>
                            )}
                            {machine.clis.map(cli => {
                                const isSelected = !!selected && selected.machineId === machine.machineId && selected.cliType === cli.cliType
                                return (
                                    <button
                                        key={cli.cliType}
                                        type="button"
                                        role="menuitemradio"
                                        aria-checked={isSelected}
                                        disabled={!cli.supported}
                                        data-assistant-cli={cli.cliType}
                                        data-assistant-machine={machine.machineId}
                                        title={!cli.supported
                                            ? t('dashboard.assistantLaunch.unavailable', { reason: cli.reason || t('dashboard.assistantLaunch.unsupported') })
                                            : cli.promptOnly ? t('dashboard.assistantLaunch.noToolLockHint') : undefined}
                                        onClick={() => {
                                            if (!cli.supported) return
                                            const keep = defaultTarget && defaultTarget.machineId === machine.machineId && defaultTarget.cliType === cli.cliType
                                            setSelected(assistantLaunchTargetFor(machine.machineId, cli, keep ? defaultTarget : null))
                                        }}
                                        className={cn(
                                            'flex w-full items-start gap-2.5 rounded-lg border-none bg-transparent px-2.5 py-2 text-left text-xs font-medium text-text-secondary transition-colors',
                                            cli.supported
                                                ? 'hover:bg-bg-secondary hover:text-text-primary focus-visible:bg-bg-secondary focus-visible:text-text-primary focus-visible:outline-none'
                                                : 'cursor-not-allowed opacity-50',
                                        )}
                                    >
                                        <span className="mt-0.5 flex w-4 shrink-0 justify-center" aria-hidden>{isSelected ? <IconCheck size={13} /> : null}</span>
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
                    </div>
                    {selected && selectedCli && (
                        <div className="mt-1 flex flex-col gap-1.5 border-t border-border-default px-1.5 pb-1 pt-2" data-testid="assistant-launch-options">
                            {(selectedCli.modelOptions.length > 0 || selectedCli.thinkingLevelOptions.length > 0) && (
                                <div className="flex gap-1.5">
                                    {selectedCli.modelOptions.length > 0 && (
                                        <label className="flex min-w-0 flex-1 flex-col gap-0.5 text-2xs text-text-muted">
                                            {t('dashboard.assistantLaunch.model')}
                                            <select
                                                value={selected.model ?? ''}
                                                onChange={event => pickOption('model', event.target.value)}
                                                className="min-w-0 rounded-md border border-border-default bg-bg-secondary px-1.5 py-1 text-xs text-text-primary"
                                                data-testid="assistant-launch-model"
                                            >
                                                <option value="">{t('dashboard.assistantLaunch.defaultOption')}</option>
                                                {selectedCli.modelOptions.map(model => <option key={model} value={model}>{model}</option>)}
                                            </select>
                                        </label>
                                    )}
                                    {selectedCli.thinkingLevelOptions.length > 0 && (
                                        <label className="flex w-[88px] shrink-0 flex-col gap-0.5 text-2xs text-text-muted">
                                            {t('dashboard.assistantLaunch.thinking')}
                                            <select
                                                value={selected.thinkingLevel ?? ''}
                                                onChange={event => pickOption('thinkingLevel', event.target.value)}
                                                className="min-w-0 rounded-md border border-border-default bg-bg-secondary px-1.5 py-1 text-xs text-text-primary"
                                                data-testid="assistant-launch-thinking"
                                            >
                                                <option value="">{t('dashboard.assistantLaunch.defaultOption')}</option>
                                                {selectedCli.thinkingLevelOptions.map(level => <option key={level} value={level}>{level}</option>)}
                                            </select>
                                        </label>
                                    )}
                                </div>
                            )}
                            <button
                                type="button"
                                onClick={() => {
                                    close()
                                    onStartWith?.(selected)
                                }}
                                className="btn btn-primary btn-sm inline-flex items-center justify-center gap-1.5"
                                data-testid="assistant-launch-start"
                            >
                                <IconAssistant size={13} />
                                <span>{t('dashboard.assistantLaunch.start')}</span>
                            </button>
                        </div>
                    )}
                </div>,
                document.body,
            )}
        </span>
    )
}
