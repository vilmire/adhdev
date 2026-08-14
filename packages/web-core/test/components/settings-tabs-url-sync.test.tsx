import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SettingsTabs } from '../../src/components/ui/SettingsTabs'

// Mirrors Account.tsx: parent owns state from ?tab=, SettingsTabs is controlled.
const TABS = [
    { id: 'account', label: 'Account' },
    { id: 'billing', label: 'Billing' },
    { id: 'activity', label: 'Activity' },
] as const

function renderAt(search: string, onChange?: (k: string) => void) {
    const raw = new URLSearchParams(search).get('tab')
    const active = raw && TABS.some(t => t.id === raw) ? raw : 'account'
    return renderToStaticMarkup(
        <SettingsTabs
            variant="underline"
            activeKey={active}
            onTabChange={onChange}
            tabIdPrefix="account-tab"
            unmountInactivePanels
            tabs={TABS.map(t => ({ key: t.id, label: t.label, content: <div>{`PANEL_${t.id}`}</div> }))}
        />,
    )
}

describe('Account ?tab= URL sync via controlled SettingsTabs', () => {
    it('?tab=billing deep-links to the billing panel (refresh/bookmark)', () => {
        const html = renderAt('?tab=billing')
        expect(html).toContain('PANEL_billing')
        expect(html).not.toContain('PANEL_account')
    })

    it('?tab=activity deep-links to the activity panel', () => {
        expect(renderAt('?tab=activity')).toContain('PANEL_activity')
    })

    it('no ?tab= falls back to the account tab', () => {
        expect(renderAt('')).toContain('PANEL_account')
    })

    it('an unknown ?tab= value falls back to account rather than blanking', () => {
        const html = renderAt('?tab=bogus')
        expect(html).toContain('PANEL_account')
        expect(html).not.toContain('PANEL_bogus')
    })

    it('marks the URL-selected tab as aria-selected for a11y/back-button state', () => {
        expect(renderAt('?tab=billing')).toContain('id="account-tab-billing"')
        const m = renderAt('?tab=billing').match(/id="account-tab-billing"[^>]*aria-selected="true"|aria-selected="true"[^>]*id="account-tab-billing"/)
        expect(m).toBeTruthy()
    })
})
