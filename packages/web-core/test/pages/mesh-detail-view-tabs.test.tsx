/**
 * Mesh settings page structure (2026-09-27 UI simplification).
 *
 * The page used to open on a boxed pill segmented control with four tabs
 * (Nodes / Scheduling / Prompts / Advanced), a header Refresh on a settings
 * page, and an "Observability" section whose only job was a button to the
 * live view. Owner direction: tabs must match the account page exactly —
 * underline tabs with icons, flush against the top of one card frame — and
 * the live view is one primary header action.
 *
 * Source-level for the page wiring (MeshDetailView is page-scale with a large
 * required-props surface — same convention as the other MeshDetailView
 * guards), plus a render of the shared SettingsTabs with the exact props the
 * page passes, so the look is asserted, not just the prop spelling.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SettingsTabs } from '../../src/components/ui/SettingsTabs'

const source = fs.readFileSync(path.join(import.meta.dirname, '../../src/pages/repo-mesh/MeshDetailView.tsx'), 'utf8')

describe('MeshDetailView — tabs match the account page', () => {
    it('uses the underline SettingsTabs variant inside the same card frame as Account', () => {
        // The cloud Account page's frame (packages/web-cloud Account.tsx). Not read
        // from there: this OSS test must not depend on proprietary sources.
        const frame = 'overflow-hidden rounded-2xl border border-border-subtle bg-bg-card/30'
        expect(source).toContain(frame)
        expect(source).toMatch(/<SettingsTabs\s+variant="underline"/)
    })

    it('has exactly two tabs — General and Advanced — each with an icon', () => {
        const tabKeys = [...source.matchAll(/\{ key: '(\w+)', icon: </g)].map(m => m[1])
        expect(tabKeys).toEqual(['general', 'advanced'])
    })

    it('has no header Refresh and no Observability launcher section', () => {
        expect(source).not.toContain("t('mesh.detail.refresh')")
        expect(source).not.toContain('observabilityTitle')
        // The live view is the primary header action instead.
        expect(source).toMatch(/btn btn-primary btn-sm[\s\S]{0,200}setGraphDialogOpen\(true\)/)
    })

    it('renders underline tabs with icons and the accent underline on the active tab', () => {
        const html = renderToStaticMarkup(
            <SettingsTabs
                variant="underline"
                tabIdPrefix="mesh-settings-tab"
                tabs={[
                    { key: 'general', icon: <svg data-icon="general" />, label: 'General', content: <div>G</div> },
                    { key: 'advanced', icon: <svg data-icon="advanced" />, label: 'Advanced', content: <div>A</div> },
                ]}
            />,
        )
        expect(html).toContain('role="tablist"')
        expect(html).toContain('data-icon="general"')
        expect(html).toContain('border-accent text-accent')
        // Not the boxed pill segmented control.
        expect(html).not.toContain('rounded-xl border border-border-subtle bg-bg-secondary/60 p-1')
        expect(html).toMatch(/id="mesh-settings-tab-general"[^>]*aria-selected="true"/)
    })
})
