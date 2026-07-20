import { memo, useCallback, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { IconX } from '../Icons'
import ThemeToggle from '../ThemeToggle'
import LanguageSelector from '../LanguageSelector'

export interface AppShellNavItem {
    id: string
    icon: ReactNode
    label: ReactNode
    onSelect: () => void
    active?: boolean
    title?: string
    className?: string
}

export interface AppShellNavSection {
    key: string
    title?: ReactNode
    items: AppShellNavItem[]
    className?: string
}

interface AppShellRenderState {
    collapsed: boolean
    mobileMenuOpen: boolean
    openMobileMenu: () => void
    closeMobileMenu: () => void
    toggleCollapsed: () => void
}

interface AppShellProps {
    children: ReactNode
    brand: ReactNode | ((state: AppShellRenderState) => ReactNode)
    navItems: AppShellNavItem[]
    sidebarSections?: AppShellNavSection[]
    footerItems?: AppShellNavItem[]
    footerInfo?: ReactNode | ((state: AppShellRenderState) => ReactNode)
    footerActions?: ReactNode | ((state: AppShellRenderState) => ReactNode)
    preMainContent?: ReactNode
    collapsedStorageKey?: string
}

// Stable empty defaults so an omitted sidebarSections/footerItems does not hand the
// memoized sidebar a fresh [] identity on every render (which would defeat the memo).
const EMPTY_SECTIONS: AppShellNavSection[] = []
const EMPTY_ITEMS: AppShellNavItem[] = []

function renderMaybeNode(value: ReactNode | ((state: AppShellRenderState) => ReactNode) | undefined, state: AppShellRenderState) {
    if (!value) return null
    return typeof value === 'function' ? value(state) : value
}

interface AppShellSidebarProps {
    renderState: AppShellRenderState
    brand: AppShellProps['brand']
    navItems: AppShellNavItem[]
    sidebarSections: AppShellNavSection[]
    footerItems: AppShellNavItem[]
    footerInfo: AppShellProps['footerInfo']
    footerActions: AppShellProps['footerActions']
    closeMobileMenu: () => void
}

/**
 * The `<aside class="sidebar">` whose width transitions on collapse. Split out and
 * wrapped in React.memo so a parent re-render that only changes `children` (the main
 * dashboard tree re-rendering on a ~2s daemon-status flush) does NOT re-render the
 * sidebar. Combined with the CSS paint-isolation (index.css .sidebar will-change/
 * contain) and stable render-fn props from the consumer, this stops the status-flush
 * reflow that made the cloud sidebar collapse stutter — the standalone dashboard was
 * always smooth only because its layout never subscribed to status.
 *
 * Correctness: all inputs that legitimately change the sidebar's rendered content
 * (collapsed state via renderState, nav items, footer info) are props here, so memo
 * only skips a re-render when EVERY prop is referentially unchanged. The consumer
 * memoizes those props, so a footer daemon-count update still re-renders the sidebar —
 * it just no longer thrashes on every unrelated status tick mid-transition.
 */
const AppShellSidebar = memo(function AppShellSidebar({
    renderState,
    brand,
    navItems,
    sidebarSections,
    footerItems,
    footerInfo,
    footerActions,
    closeMobileMenu,
}: AppShellSidebarProps) {
    const { t } = useTranslation('common')
    const { collapsed, mobileMenuOpen } = renderState

    const navItemClass = (item: AppShellNavItem) =>
        `nav-item${item.active ? ' active' : ''} cursor-pointer ${collapsed ? 'justify-center py-2.5 px-0' : ''}${item.className ? ` ${item.className}` : ''}`

    const renderNavItem = (item: AppShellNavItem) => (
        <div
            key={item.id}
            className={navItemClass(item)}
            id={`nav-${item.id}`}
            onClick={() => {
                item.onSelect()
                closeMobileMenu()
            }}
            title={collapsed ? (item.title ?? (typeof item.label === 'string' ? item.label : undefined)) : item.title}
        >
            <span className="nav-icon">{item.icon}</span>
            {!collapsed && item.label}
        </div>
    )

    return (
        <aside className={`sidebar ${mobileMenuOpen ? 'sidebar-open' : ''}`}>
            <div className="sidebar-header">
                <div className={`sidebar-logo ${collapsed ? 'justify-center gap-0' : ''}`}>
                    {renderMaybeNode(brand, renderState)}
                </div>
                <button
                    type="button"
                    className="sidebar-close-btn"
                    aria-label={t('app.closeMenu')}
                    onClick={closeMobileMenu}
                >
                    <IconX size={16} />
                </button>
            </div>

            <nav className="sidebar-nav">
                {navItems.map(renderNavItem)}
            </nav>

            {sidebarSections.map(section => (
                <div key={section.key} className={section.className ?? 'border-t border-border-subtle pt-2 mt-2'}>
                    {!collapsed && section.title ? <div className="px-3 py-1 text-[10px] text-text-muted uppercase tracking-widest">{section.title}</div> : null}
                    {section.items.map(renderNavItem)}
                </div>
            ))}

            <div className="border-t border-border-subtle pt-4 mt-2">
                {footerItems.map(renderNavItem)}
                {renderMaybeNode(footerInfo, renderState)}
                <ThemeToggle collapsed={collapsed} />
                <LanguageSelector collapsed={collapsed} />
                {renderMaybeNode(footerActions, renderState)}
            </div>
        </aside>
    )
})

export default function AppShell({
    children,
    brand,
    navItems,
    sidebarSections = EMPTY_SECTIONS,
    footerItems = EMPTY_ITEMS,
    footerInfo,
    footerActions,
    preMainContent,
    collapsedStorageKey = 'sidebar-collapsed',
}: AppShellProps) {
    const { t } = useTranslation('common')
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
    const [collapsed, setCollapsed] = useState(() => {
        try { return localStorage.getItem(collapsedStorageKey) === '1' } catch { return false }
    })

    // Stable identities so the memoized sidebar isn't invalidated by these on every
    // parent re-render (they never actually change — setState updaters are used).
    const openMobileMenu = useCallback(() => setMobileMenuOpen(true), [])
    const closeMobileMenu = useCallback(() => setMobileMenuOpen(false), [])
    const toggleCollapsed = useCallback(() => {
        setCollapsed(prev => {
            const next = !prev
            try { localStorage.setItem(collapsedStorageKey, next ? '1' : '0') } catch {}
            return next
        })
    }, [collapsedStorageKey])

    const renderState = useMemo<AppShellRenderState>(() => ({
        collapsed,
        mobileMenuOpen,
        openMobileMenu,
        closeMobileMenu,
        toggleCollapsed,
    }), [collapsed, mobileMenuOpen, openMobileMenu, closeMobileMenu, toggleCollapsed])

    return (
        <div className={`app-layout${mobileMenuOpen ? ' mobile-menu-open' : ''}${collapsed ? ' sidebar-collapsed' : ''}`}>
            <button
                type="button"
                className="mobile-menu-btn"
                aria-label={t('app.openMenu')}
                onClick={openMobileMenu}
            >
                <span className="mobile-menu-icon" />
                <span className="mobile-menu-icon" />
                <span className="mobile-menu-icon" />
            </button>

            {mobileMenuOpen && (
                <div
                    className="sidebar-overlay"
                    role="button"
                    tabIndex={0}
                    aria-label={t('app.closeMenu')}
                    onClick={closeMobileMenu}
                    onKeyDown={(e) => e.key === 'Escape' && closeMobileMenu()}
                />
            )}

            <AppShellSidebar
                renderState={renderState}
                brand={brand}
                navItems={navItems}
                sidebarSections={sidebarSections}
                footerItems={footerItems}
                footerInfo={footerInfo}
                footerActions={footerActions}
                closeMobileMenu={closeMobileMenu}
            />

            <main className="main-content relative">
                <div className="main-content-inner">
                    {preMainContent}
                    {children}
                </div>
            </main>
        </div>
    )
}
