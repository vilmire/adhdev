/**
 * StandaloneLayout — Sidebar + Main content wrapper
 *
 * Mirrors cloud Layout structure but simplified for standalone.
 * Uses shared Icons and ThemeToggle from web-core.
 */
import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { IconDashboard, IconServer, IconInfo, IconSettings, IconBook } from '@adhdev/web-core'

interface LayoutProps {
    children: React.ReactNode
}

const NAV_ITEMS = [
    { id: 'dashboard', path: '/dashboard', icon: <IconDashboard />, label: 'Dashboard' },
    { id: 'capabilities', path: '/capabilities', icon: <IconBook />, label: 'Capabilities' },
    { id: 'machine', path: '/machines', icon: <IconServer />, label: 'Burrow' },
    { id: 'settings', path: '/settings', icon: <IconSettings />, label: 'Settings' },
]

export default function StandaloneLayout({ children }: LayoutProps) {
    const navigate = useNavigate()
    const location = useLocation()
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
    const [collapsed, setCollapsed] = useState(() => {
        try { return localStorage.getItem('sidebar-collapsed') === '1'; } catch { return false; }
    })

    const handleNav = (path: string) => {
        navigate(path)
        setMobileMenuOpen(false)
    }

    const toggleCollapsed = () => {
        setCollapsed(prev => {
            const next = !prev
            try { localStorage.setItem('sidebar-collapsed', next ? '1' : '0'); } catch {}
            return next
        })
    }

    const navItemClass = (path: string) =>
        `nav-item${location.pathname.startsWith(path) ? ' active' : ''} cursor-pointer ${collapsed ? 'justify-center py-2.5 px-0' : ''}`

    return (
        <div className={`app-layout${mobileMenuOpen ? ' mobile-menu-open' : ''}${collapsed ? ' sidebar-collapsed' : ''}`}>
            {/* Mobile menu button */}
            <button
                type="button"
                className="mobile-menu-btn"
                aria-label="Open menu"
                onClick={() => setMobileMenuOpen(true)}
            >
                <span className="mobile-menu-icon" />
                <span className="mobile-menu-icon" />
                <span className="mobile-menu-icon" />
            </button>

            {/* Overlay */}
            {mobileMenuOpen && (
                <div
                    className="sidebar-overlay"
                    role="button"
                    tabIndex={0}
                    aria-label="Close menu"
                    onClick={() => setMobileMenuOpen(false)}
                    onKeyDown={(e) => e.key === 'Escape' && setMobileMenuOpen(false)}
                />
            )}

            <aside className={`sidebar ${mobileMenuOpen ? 'sidebar-open' : ''}`}>
                <div className="sidebar-header">
                    <div className={`sidebar-logo ${collapsed ? 'justify-center gap-0' : ''}`}>
                        <img src="/otter-logo.png" alt="ADHDev" className="w-7 h-7" />
                        {!collapsed && <span>ADHDev</span>}
                    </div>
                    <button
                        type="button"
                        className="sidebar-close-btn"
                        aria-label="Close menu"
                        onClick={() => setMobileMenuOpen(false)}
                    >
                        ✕
                    </button>
                </div>

                <nav className="sidebar-nav">
                    {NAV_ITEMS.map((item) => (
                        <div
                            key={item.id}
                            className={navItemClass(item.path)}
                            id={`nav-${item.id}`}
                            onClick={() => handleNav(item.path)}
                            title={collapsed ? item.label : undefined}
                        >
                            <span className="nav-icon">{item.icon}</span>
                            {!collapsed && item.label}
                        </div>
                    ))}
                </nav>

                <div className="border-t border-border-subtle pt-4 mt-2">
                    <div
                        className={`nav-item cursor-pointer${location.pathname === '/about' ? ' active' : ''} ${collapsed ? 'justify-center py-2.5 px-0' : ''}`}
                        id="nav-about"
                        onClick={() => navigate('/about')}
                        title={collapsed ? 'About' : undefined}
                    >
                        <span className="nav-icon"><IconInfo /></span>
                        {!collapsed && 'About'}
                    </div>
                    {!collapsed && (
                        <div className="px-3 py-2 text-xs text-text-muted">
                            Selfhost v{__APP_VERSION__}
                        </div>
                    )}
                    {/* Theme toggle */}
                    {/* <ThemeToggle collapsed={collapsed} /> */}
                    {/* Collapse toggle */}
                    <div
                        className={`nav-item cursor-pointer ${collapsed ? 'justify-center py-2.5 px-0' : 'mt-1'}`}
                        onClick={toggleCollapsed}
                        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                    >
                        <span className="nav-icon text-base">{collapsed ? '›' : '‹'}</span>
                        {!collapsed && <span className="text-xs">Collapse</span>}
                    </div>
                </div>
            </aside>

            <main className="main-content relative">
                <div className="main-content-inner">
                    {children}
                </div>
            </main>
        </div>
    )
}
