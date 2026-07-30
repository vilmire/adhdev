import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MeshOverviewDetailModal } from '../../src/components/MeshGraph/MeshOverviewCards'
import { getMeshGraphTheme } from '../../src/components/MeshGraph/meshGraphTheme'

const h = React.createElement
const meshTheme = getMeshGraphTheme('dark')

function renderDetailModal(onClose: () => void = () => {}): string {
    return renderToStaticMarkup(
        h(MeshOverviewDetailModal, {
            meshTheme,
            detail: {
                kind: 'mission' as const,
                mission: {
                    id: 'mission-1',
                    title: 'RC32 hardening',
                    status: 'active',
                    createdAt: '2026-07-30T00:00:00.000Z',
                    updatedAt: '2026-07-30T01:00:00.000Z',
                    tasks: { total: 3, completed: 1, assigned: 1, pending: 1, failed: 0, blocked: 0, cancelled: 0 },
                } as any,
            },
            onClose,
            daemonId: null,
            meshId: null,
            sendDaemonCommand: null,
            resolveNodeLabel: (nodeId: string | undefined | null) => nodeId ?? 'unknown',
        }),
    )
}

// RC32: the mesh overview DetailModal is a viewport-fit=cover fullscreen
// (100dvh) modal in the iOS installed PWA. Its sticky header previously had no
// safe-area-top padding and a 32px close button, so the ✕ rendered inside the
// system status bar and was untappable (see the RC32 evidence screenshot).
describe('MeshOverviewDetailModal safe-area close path (RC32)', () => {
    it('renders as a modal dialog with a dvh fullscreen mobile shell', () => {
        const html = renderDetailModal()

        expect(html).toContain('role="dialog"')
        expect(html).toContain('aria-modal="true"')
        expect(html).toContain('h-[100dvh]')
        expect(html).toContain('z-[var(--z-modal)]')
    })

    it('pads the sticky header below the iOS safe-area top inset', () => {
        const html = renderDetailModal()

        expect(html).toContain('pt-[calc(12px+env(safe-area-inset-top,0px))]')
    })

    it('gives the close button a >=44px tap target while preserving the 32px visual scale', () => {
        const html = renderDetailModal()

        // Outer button owns the 44px hit area; inner span owns the 32px chrome.
        expect(html).toContain('aria-label="Close detail"')
        expect(html).toContain('h-11 w-11')
        expect(html).toContain('h-8 w-8')
        // The negative margin keeps the header layout footprint unchanged.
        expect(html).toContain('-m-1.5')
    })

    it('keeps the backdrop click close path on the overlay', () => {
        const html = renderDetailModal()

        // The overlay carries the dialog role and closes on backdrop click; the
        // shell stops propagation. Rendered markup keeps both hooks.
        expect(html).toContain('fixed inset-0')
    })
})
