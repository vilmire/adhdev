/**
 * StandaloneLayout — Sidebar + Main content wrapper
 *
 * Uses shared AppShell from web-core and keeps only standalone-specific nav/footer content here.
 */
import { useMemo } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { AppShell, type AppShellNavItem, IconDashboard, IconServer, IconInfo, IconSettings, IconBook, IconMesh, IconWarning, IconBell } from '@adhdev/web-core'

interface LayoutProps {
    children: React.ReactNode
}

export default function StandaloneLayout({ children }: LayoutProps) {
    const navigate = useNavigate()
    const location = useLocation()
    const { t } = useTranslation('common')

    const navItems = useMemo<AppShellNavItem[]>(() => ([
        { id: 'dashboard', path: '/dashboard', icon: <IconDashboard />, label: t('nav.dashboard'), active: location.pathname.startsWith('/dashboard'), onSelect: () => navigate('/dashboard') },
        { id: 'machine', path: '/machines', icon: <IconServer />, label: t('nav.machines'), active: location.pathname.startsWith('/machines'), onSelect: () => navigate('/machines') },
        // Setup has no nav entry: it is first-run onboarding that ends by handing off
        // to Mesh, which owns every mesh setting from then on. The /setup route stays
        // reachable for deep links and docs.
        { id: 'mesh', path: '/mesh', icon: <IconMesh />, label: t('nav.mesh'), active: location.pathname.startsWith('/mesh') || location.pathname.startsWith('/setup'), onSelect: () => navigate('/mesh') },
        { id: 'approvals', path: '/approvals', icon: <IconWarning />, label: t('approvals.pageTitle'), active: location.pathname.startsWith('/approvals'), onSelect: () => navigate('/approvals') },
        { id: 'notifications', path: '/notifications', icon: <IconBell />, label: t('nav.notifications'), active: location.pathname.startsWith('/notifications'), onSelect: () => navigate('/notifications') },
        { id: 'settings', path: '/settings', icon: <IconSettings />, label: t('nav.settings'), active: location.pathname.startsWith('/settings'), onSelect: () => navigate('/settings') },
    ]), [location.pathname, navigate, t])

    const footerItems = useMemo<AppShellNavItem[]>(() => ([
        {
            id: 'docs',
            label: <><span>{t('nav.docs')}</span><span className="ml-auto text-4xs text-text-muted">↗</span></>,
            icon: <IconBook />,
            onSelect: () => window.open('https://docs.adhf.dev', '_blank'),
            title: t('nav.docs'),
        },
        {
            id: 'about',
            label: t('nav.about'),
            icon: <IconInfo />,
            active: location.pathname === '/about',
            onSelect: () => navigate('/about'),
            title: t('nav.about'),
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
