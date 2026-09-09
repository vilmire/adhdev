// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MeshOverviewDetailModal } from '../../src/components/MeshGraph/MeshOverviewCards'
import { getMeshGraphTheme } from '../../src/components/MeshGraph/meshGraphTheme'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
})

afterEach(() => {
    act(() => root.unmount())
    container.remove()
})

const meshTheme = getMeshGraphTheme('dark')

/**
 * ★ G5-2 THE ALWAYS-VISIBLE-RAW-JSON REGRESSION.
 *
 * LedgerDetail rendered `payloadSummary(entry.payload)` (a short friendly
 * string, only present when the payload happens to carry message/summary/
 * reason/title) AND the full raw JSON.stringify of the payload UNCONDITIONALLY
 * underneath it — no disclosure, always both. For a structured payload with
 * no summary field, raw JSON was the ONLY thing shown, permanently expanded.
 *
 * The fix wraps the raw payload in a <details>/<summary> disclosure (matching
 * the existing incomplete-evidence disclosure pattern in this same file) so
 * it defaults to collapsed, and drops the JSON.stringify-throws fallback that
 * used to print the literal string "[object Object]".
 */
describe('MeshOverviewDetailModal — G5-2 ledger raw payload is disclosure-gated', () => {
    function renderLedgerDetail(payload: Record<string, unknown>) {
        act(() => {
            root.render(
                <MeshOverviewDetailModal
                    meshTheme={meshTheme}
                    detail={{
                        kind: 'ledger',
                        entry: {
                            id: 'ledger_1',
                            kind: 'note',
                            timestamp: '2026-01-01T00:00:00Z',
                            payload,
                        } as any,
                    }}
                    onClose={() => {}}
                    resolveNodeLabel={() => 'Node'}
                />,
            )
        })
    }

    it('renders the raw payload behind a collapsed <details> disclosure, not inline', () => {
        renderLedgerDetail({ foo: 'bar', nested: { a: 1 } })
        const details = document.body.querySelector('details')
        expect(details).not.toBeNull()
        expect(details?.hasAttribute('open')).toBe(false)
        const pre = details?.querySelector('pre')
        expect(pre).not.toBeNull()
        expect(pre?.textContent).toContain('"foo": "bar"')
        // The <pre> must be INSIDE the <details>, not a sibling always-rendered block.
        expect(details?.contains(pre!)).toBe(true)
    })

    it('the disclosure summary is user-facing copy, not the bare word "Payload"', () => {
        renderLedgerDetail({ foo: 'bar' })
        const summary = document.body.querySelector('details summary')
        expect(summary).not.toBeNull()
        expect(summary?.textContent?.toLowerCase()).toContain('raw')
    })

    it('renders no payload disclosure at all when the payload is empty', () => {
        renderLedgerDetail({})
        expect(document.body.querySelector('details')).toBeNull()
    })
})
