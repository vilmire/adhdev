import { useMemo, useState, type ReactNode } from 'react'
import { IconX } from '../Icons'
import ThemeToggle from '../ThemeToggle'

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

function renderMaybeNode(value: ReactNode | ((state: AppShellRenderState) => ReactNode) | undefined, state: AppShellRenderState) {
    if (!value) return null
    return typeof value === 'function' ? value(state) : value
}

export default function AppShell({
    children,
    brand,
    navItems,
    sidebarSections = [],
    footerItems = [],
    footerInfo,
    footerActions,
    preMainContent,
    collapsedStorageKey = 'sidebar-collapsed',
}: AppShellProps) {
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
    const [collapsed, setCollapsed] = useState(() => {
        try { return localStorage.getItem(collapsedStorageKey) === '1' } catch { return false }
    })

    const openMobileMenu = () => setMobileMenuOpen(true)
    const closeMobileMenu = () => setMobileMenuOpen(false)
    const toggleCollapsed = () => {
        setCollapsed(prev => {
            const next = !prev
            try { localStorage.setItem(collapsedStorageKey, next ? '1' : '0') } catch {}
            return next
        })
    }

    const renderState = useMemo<AppShellRenderState>(() => ({
        collapsed,
        mobileMenuOpen,
        openMobileMenu,
        closeMobileMenu,
        toggleCollapsed,
    }), [collapsed, mobileMenuOpen])

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
        <div className={`app-layout${mobileMenuOpen ? ' mobile-menu-open' : ''}${collapsed ? ' sidebar-collapsed' : ''}`}>
            <button
                type="button"
                className="mobile-menu-btn"
                aria-label="Open menu"
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
                    aria-label="Close menu"
                    onClick={closeMobileMenu}
                    onKeyDown={(e) => e.key === 'Escape' && closeMobileMenu()}
                />
            )}

            <aside className={`sidebar ${mobileMenuOpen ? 'sidebar-open' : ''}`}>
                <div className="sidebar-header">
                    <div className={`sidebar-logo ${collapsed ? 'justify-center gap-0' : ''}`}>
                        {renderMaybeNode(brand, renderState)}
                    </div>
                    <button
                        type="button"
                        className="sidebar-close-btn"
                        aria-label="Close menu"
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
                    {renderMaybeNode(footerActions, renderState)}
                </div>
            </aside>

            <main className="main-content relative">
                <div className="main-content-inner">
                    {preMainContent}
                    {children}
                </div>
            </main>
        </div>
    )
}
