import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SettingsTabs } from '../../src/components/ui/SettingsTabs'

const TABS = [
    { key: 'a', label: 'A', content: <div>PANEL_A</div> },
    { key: 'b', label: 'B', content: <div>PANEL_B</div> },
]

describe('SettingsTabs', () => {
    it('composes tab ids from tabIdPrefix', () => {
        const html = renderToStaticMarkup(<SettingsTabs tabIdPrefix="account-tab" tabs={TABS} />)
        expect(html).toContain('id="account-tab-a"')
        expect(html).toContain('id="account-tab-b"')
    })

    it('unmountInactivePanels renders only the active panel', () => {
        const html = renderToStaticMarkup(<SettingsTabs unmountInactivePanels tabs={TABS} />)
        expect(html).toContain('PANEL_A')
        expect(html).not.toContain('PANEL_B')
    })

    it('keeps all panels mounted by default', () => {
        const html = renderToStaticMarkup(<SettingsTabs tabs={TABS} />)
        expect(html).toContain('PANEL_A')
        expect(html).toContain('PANEL_B')
    })

    it('controlled activeKey selects the given tab', () => {
        const html = renderToStaticMarkup(<SettingsTabs activeKey="b" unmountInactivePanels tabs={TABS} />)
        expect(html).toContain('PANEL_B')
        expect(html).not.toContain('PANEL_A')
    })

    it('underline variant uses the accent border on the active tab', () => {
        const html = renderToStaticMarkup(<SettingsTabs variant="underline" tabs={TABS} />)
        expect(html).toContain('border-accent')
        expect(html).toContain('role="tablist"')
    })
})
