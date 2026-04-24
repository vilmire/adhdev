/**
 * StandaloneLayout — Sidebar + Main content wrapper
 *
 * Uses shared AppShell from web-core and keeps only standalone-specific nav/footer content here.
 */
import { useMemo } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { AppShell, type AppShellNavItem, IconDashboard, IconServer, IconInfo, IconSettings, IconBook } from '@adhdev/web-core'

interface LayoutProps {
    children: React.ReactNode
}

const NAV_ITEMS = [
    { id: 'dashboard', path: '/dashboard', icon: <IconDashboard />, label: 'Dashboard' },
    { id: 'machine', path: '/machines', icon: <IconServer />, label: 'Burrow' },
    { id: 'settings', path: '/settings', icon: <IconSettings />, label: 'Settings' },
]

export default function StandaloneLayout({ children }: LayoutProps) {
    const navigate = useNavigate()
    const location = useLocation()

    const navItems = useMemo<AppShellNavItem[]>(() => (
        NAV_ITEMS.map(item => ({
            ...item,
            active: location.pathname.startsWith(item.path),
            onSelect: () => navigate(item.path),
        }))
    ), [location.pathname, navigate])

    const footerItems = useMemo<AppShellNavItem[]>(() => ([
        {
            id: 'docs',
            label: <><span>Docs</span><span className="ml-auto text-[9px] text-text-muted">↗</span></>,
            icon: <IconBook />,
            onSelect: () => window.open('https://docs.adhf.dev', '_blank'),
            title: 'Docs',
        },
        {
            id: 'about',
            label: 'About',
            icon: <IconInfo />,
            active: location.pathname === '/about',
            onSelect: () => navigate('/about'),
            title: 'About',
        },
    ]), [location.pathname, navigate])

    return (
        <AppShell
            brand={({ collapsed }) => (
                <>
                    <img src="/otter-logo.png" alt="ADHDev" className="w-7 h-7" />
                    {!collapsed && <span>ADHDev</span>}
                </>
            )}
            navItems={navItems}
            footerItems={footerItems}
            footerInfo={({ collapsed }) => !collapsed ? (
                <div className="px-3 py-2 text-xs text-text-muted">
                    Selfhost v{__APP_VERSION__}
                </div>
            ) : null}
            footerActions={({ collapsed, toggleCollapsed }) => (
                <div
                    className={`nav-item cursor-pointer ${collapsed ? 'justify-center py-2.5 px-0' : 'mt-1'}`}
                    onClick={toggleCollapsed}
                    title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                >
                    <span className="nav-icon text-base">{collapsed ? '›' : '‹'}</span>
                    {!collapsed && <span className="text-xs">Collapse</span>}
                </div>
            )}
        >
            {children}
        </AppShell>
    )
}
