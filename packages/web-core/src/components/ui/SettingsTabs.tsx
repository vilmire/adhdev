import { useState, type ReactNode } from 'react'
import type React from 'react'
import { cn } from '../../lib/utils'

export interface SettingsTab {
    key: string
    label: ReactNode
    /** Optional leading icon, rendered before the label. */
    icon?: ReactNode
    content: ReactNode
}

/**
 * `pill`  — boxed segmented control, for tabs sitting inside a card/section.
 * `underline` — full-width bar with an accent underline on the active tab, for
 * page-level tabs flush against the top edge of a card.
 */
export type SettingsTabsVariant = 'pill' | 'underline'

interface SettingsTabsProps {
    tabs: SettingsTab[]
    /** Uncontrolled initial tab key. Defaults to the first tab. Ignored when `activeKey` is set. */
    defaultTabKey?: string
    /** Controlled active key. Pass with `onTabChange` to own the state (e.g. sync to a URL query param). */
    activeKey?: string
    onTabChange?: (key: string) => void
    variant?: SettingsTabsVariant
    ariaLabel?: string
    className?: string
    /** Extra classes for the tab-list row. */
    tabListClassName?: string
    /** Extra classes for each active panel wrapper. */
    panelClassName?: string
    /** id applied to each tab button, as `${tabIdPrefix}-${tab.key}`. */
    tabIdPrefix?: string
    /**
     * Mount only the active panel instead of keeping all panels mounted.
     * Default `false` — inactive panels stay mounted so background form state
     * survives a tab switch. Set `true` when panels fetch on mount and mounting
     * them all would fire every tab's requests on first render.
     */
    unmountInactivePanels?: boolean
}

export interface SettingsTabBarItem {
    key: string
    label: ReactNode
    icon?: ReactNode
    /** Optional trailing element (e.g. a count or status dot). */
    trailing?: ReactNode
}

interface SettingsTabBarProps {
    tabs: SettingsTabBarItem[]
    activeKey: string | undefined
    onSelect: (key: string) => void
    variant?: SettingsTabsVariant
    ariaLabel?: string
    className?: string
    tabIdPrefix?: string
    /** id of the panel each tab controls, as `${panelIdPrefix}-${tab.key}`. */
    panelIdPrefix?: string
}

/**
 * The tab row on its own — for surfaces that own their panels (e.g. the mesh
 * graph dialog, which lazy-mounts heavy panels) but must look exactly like
 * every other tab bar. Arrow keys move between tabs (WAI-ARIA tabs pattern).
 */
export function SettingsTabBar({
    tabs,
    activeKey,
    onSelect,
    variant = 'pill',
    ariaLabel,
    className,
    tabIdPrefix,
    panelIdPrefix,
}: SettingsTabBarProps) {
    const isUnderline = variant === 'underline'
    const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft' && event.key !== 'Home' && event.key !== 'End') return
        const index = Math.max(0, tabs.findIndex(tab => tab.key === activeKey))
        const nextIndex = event.key === 'Home' ? 0
            : event.key === 'End' ? tabs.length - 1
                : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
        const next = tabs[nextIndex]
        if (!next) return
        event.preventDefault()
        onSelect(next.key)
        const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')
        buttons[nextIndex]?.focus()
    }
    return (
        <div
            className={cn(
                isUnderline
                    ? 'flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border-subtle px-4 md:px-6 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
                    : 'mb-5 inline-flex w-full flex-wrap items-center gap-1 rounded-xl border border-border-subtle bg-bg-secondary/60 p-1 sm:w-fit',
                className,
            )}
            role="tablist"
            aria-label={ariaLabel}
            onKeyDown={onKeyDown}
        >
            {tabs.map(tab => {
                const isActive = tab.key === activeKey
                return (
                    <button
                        key={tab.key}
                        id={tabIdPrefix ? `${tabIdPrefix}-${tab.key}` : undefined}
                        type="button"
                        role="tab"
                        aria-selected={isActive}
                        aria-controls={panelIdPrefix ? `${panelIdPrefix}-${tab.key}` : undefined}
                        tabIndex={isActive ? 0 : -1}
                        className={cn(
                            isUnderline
                                ? [
                                    '-mb-px flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap border-b-2 bg-transparent px-3 py-2.5 text-xxs font-medium transition-colors',
                                    isActive
                                        ? 'border-accent text-accent'
                                        : 'border-transparent text-text-muted hover:text-text-secondary',
                                ]
                                : [
                                    'flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xxs font-medium transition-colors sm:flex-none',
                                    isActive
                                        ? 'bg-bg-card text-text-primary shadow-sm border border-border-default'
                                        : 'text-text-muted border border-transparent hover:text-text-secondary hover:bg-white/[0.03]',
                                ],
                        )}
                        onClick={() => onSelect(tab.key)}
                    >
                        {tab.icon}
                        {tab.label}
                        {tab.trailing}
                    </button>
                )
            })}
        </div>
    )
}

/**
 * Generic settings-page tab bar. Inactive panels stay mounted (display:none) rather
 * than unmounting, so form state / in-flight saves in a background tab survive a
 * tab switch — same pattern as MeshObservabilitySurface's internal tabs.
 *
 * Works controlled (`activeKey` + `onTabChange`) or uncontrolled (`defaultTabKey`).
 */
export function SettingsTabs({
    tabs,
    defaultTabKey,
    activeKey: controlledKey,
    onTabChange,
    variant = 'pill',
    ariaLabel,
    className,
    tabListClassName,
    panelClassName,
    tabIdPrefix,
    unmountInactivePanels = false,
}: SettingsTabsProps) {
    const [uncontrolledKey, setUncontrolledKey] = useState(defaultTabKey ?? tabs[0]?.key)
    const isControlled = controlledKey !== undefined
    const activeKey = isControlled ? controlledKey : uncontrolledKey

    const selectTab = (key: string) => {
        if (!isControlled) setUncontrolledKey(key)
        onTabChange?.(key)
    }

    return (
        <div className={className}>
            <SettingsTabBar
                tabs={tabs}
                activeKey={activeKey}
                onSelect={selectTab}
                variant={variant}
                ariaLabel={ariaLabel}
                className={tabListClassName}
                tabIdPrefix={tabIdPrefix}
            />
            {tabs.map(tab => {
                const isActive = tab.key === activeKey
                if (unmountInactivePanels && !isActive) return null
                return (
                    <div
                        key={tab.key}
                        role="tabpanel"
                        aria-labelledby={tabIdPrefix ? `${tabIdPrefix}-${tab.key}` : undefined}
                        className={isActive ? cn('flex flex-col gap-4', panelClassName) : 'hidden'}
                    >
                        {tab.content}
                    </div>
                )
            })}
        </div>
    )
}

export default SettingsTabs
