/**
 * StandaloneLayout — Sidebar + Main content wrapper
 *
 * Uses shared AppShell from web-core and keeps only standalone-specific nav/footer content here.
 */
import { useMemo } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { AppShell, type AppShellNavItem, IconDashboard, IconServer, IconInfo, IconSettings, IconBook, IconMesh } from '@adhdev/web-core'

interface LayoutProps {
    children: React.ReactNode
}

export default function StandaloneLayout({ children }: LayoutProps) {
    const navigate = useNavigate()
    const location = useLocation()
    const { t } = useTranslation('common')

    const navItems = useMemo<AppShellNavItem[]>(() => ([
        { id: 'dashboard', path: '/dashboard', icon: <IconDashboard />, label: t('standalone.nav.dashboard'), active: location.pathname.startsWith('/dashboard'), onSelect: () => navigate('/dashboard') },
        { id: 'machine', path: '/machines', icon: <IconServer />, label: 'Burrow', active: location.pathname.startsWith('/machines'), onSelect: () => navigate('/machines') },
        { id: 'mesh', path: '/mesh', icon: <IconMesh />, label: 'Mesh', active: location.pathname.startsWith('/mesh'), onSelect: () => navigate('/mesh') },
        { id: 'settings', path: '/settings', icon: <IconSettings />, label: t('standalone.nav.settings'), active: location.pathname.startsWith('/settings'), onSelect: () => navigate('/settings') },
    ]), [location.pathname, navigate, t])

    const footerItems = useMemo<AppShellNavItem[]>(() => ([
        {
            id: 'docs',
            label: <><span>{t('standalone.nav.docs')}</span><span className="ml-auto text-[9px] text-text-muted">↗</span></>,
            icon: <IconBook />,
            onSelect: () => window.open('https://docs.adhf.dev', '_blank'),
            title: t('standalone.nav.docs'),
        },
        {
            id: 'about',
            label: t('standalone.nav.about'),
            icon: <IconInfo />,
            active: location.pathname === '/about',
            onSelect: () => navigate('/about'),
            title: t('standalone.nav.about'),
        },
    ]), [location.pathname, navigate, t])

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
                    title={collapsed ? t('standalone.layout.expandSidebar') : t('standalone.layout.collapseSidebar')}
                >
                    <span className="nav-icon text-base">{collapsed ? '›' : '‹'}</span>
                    {!collapsed && <span className="text-xs">{t('standalone.layout.collapse')}</span>}
                </div>
            )}
        >
            {children}
        </AppShell>
    )
}
