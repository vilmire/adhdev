import { useState, type ReactNode } from 'react'
import { cn } from '../../lib/utils'

export interface SettingsTab {
    key: string
    label: ReactNode
    content: ReactNode
}

interface SettingsTabsProps {
    tabs: SettingsTab[]
    /** Uncontrolled initial tab key. Defaults to the first tab. */
    defaultTabKey?: string
    ariaLabel?: string
    className?: string
}

/**
 * Generic settings-page tab bar. Inactive panels stay mounted (display:none) rather
 * than unmounting, so form state / in-flight saves in a background tab survive a
 * tab switch — same pattern as MeshObservabilitySurface's internal tabs.
 */
export function SettingsTabs({ tabs, defaultTabKey, ariaLabel, className }: SettingsTabsProps) {
    const [activeKey, setActiveKey] = useState(defaultTabKey ?? tabs[0]?.key)

    return (
        <div className={className}>
            <div
                className="mb-5 inline-flex w-full flex-wrap items-center gap-1 rounded-xl border border-border-subtle bg-bg-secondary/60 p-1 sm:w-fit"
                role="tablist"
                aria-label={ariaLabel}
            >
                {tabs.map(tab => {
                    const isActive = tab.key === activeKey
                    return (
                        <button
                            key={tab.key}
                            type="button"
                            role="tab"
                            aria-selected={isActive}
                            className={cn(
                                'flex-1 rounded-lg px-3.5 py-1.5 text-[13px] font-medium transition-colors sm:flex-none',
                                isActive
                                    ? 'bg-bg-card text-text-primary shadow-sm border border-border-default'
                                    : 'text-text-muted border border-transparent hover:text-text-secondary hover:bg-white/[0.03]',
                            )}
                            onClick={() => setActiveKey(tab.key)}
                        >
                            {tab.label}
                        </button>
                    )
                })}
            </div>
            {tabs.map(tab => (
                <div key={tab.key} className={tab.key === activeKey ? 'flex flex-col gap-4' : 'hidden'}>
                    {tab.content}
                </div>
            ))}
        </div>
    )
}

export default SettingsTabs
