import { useState, type ReactNode } from 'react'
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

    const isUnderline = variant === 'underline'

    return (
        <div className={className}>
            <div
                className={cn(
                    isUnderline
                        ? 'flex shrink-0 items-center gap-1 border-b border-border-subtle px-4 md:px-6'
                        : 'mb-5 inline-flex w-full flex-wrap items-center gap-1 rounded-xl border border-border-subtle bg-bg-secondary/60 p-1 sm:w-fit',
                    tabListClassName,
                )}
                role="tablist"
                aria-label={ariaLabel}
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
                            className={cn(
                                isUnderline
                                    ? [
                                        '-mb-px flex cursor-pointer items-center gap-1.5 border-b-2 px-3 py-2.5 text-[13px] font-medium transition-colors',
                                        isActive
                                            ? 'border-accent text-accent'
                                            : 'border-transparent text-text-muted hover:text-text-secondary',
                                    ]
                                    : [
                                        'flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[13px] font-medium transition-colors sm:flex-none',
                                        isActive
                                            ? 'bg-bg-card text-text-primary shadow-sm border border-border-default'
                                            : 'text-text-muted border border-transparent hover:text-text-secondary hover:bg-white/[0.03]',
                                    ],
                            )}
                            onClick={() => selectTab(tab.key)}
                        >
                            {tab.icon}
                            {tab.label}
                        </button>
                    )
                })}
            </div>
            {tabs.map(tab => {
                const isActive = tab.key === activeKey
                if (unmountInactivePanels && !isActive) return null
                return (
                    <div
                        key={tab.key}
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
