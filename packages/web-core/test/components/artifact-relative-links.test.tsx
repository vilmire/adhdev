// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { ArtifactContentRenderer } from '../../src/components/attachments/ArtifactContentRenderers'
import { ArtifactLinkContext, findArtifactByLink } from '../../src/components/attachments/artifact-link-context'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const payload = (md: string): any => ({
    artifactId: 'a', sessionId: 's', daemonId: 'd', kind: 'markdown', mime: 'text/markdown', filename: 'a.md', title: 'A', sizeBytes: md.length,
    sha256: '', registeredSha256: '', sha256Changed: false, hashChanged: false, encoding: 'utf8', content: md, textContent: md, bytes: new Uint8Array(0),
})

function render(md: string, resolver: ((h: string) => (() => void) | null) | null) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => {
        root.render(<ArtifactLinkContext.Provider value={resolver}><ArtifactContentRenderer payload={payload(md)} objectUrl={null} variant="fullscreen" /></ArtifactLinkContext.Provider>)
    })
    return host
}

describe('artifact markdown links', () => {
  it('relative links never become anchors; unmatched render as titled text', () => {
    const host = render('[spec](docs/receipt-spec-2.md) and [ext](https://adhdev.io/x)', null)
    const anchors = Array.from(host.querySelectorAll('a'))
    expect(anchors).toHaveLength(1)
    expect(anchors[0].getAttribute('href')).toBe('https://adhdev.io/x')
    expect(anchors[0].getAttribute('rel')).toBe('noopener noreferrer')
    expect(anchors[0].getAttribute('target')).toBe('_blank')
    const rel = host.querySelector('[data-testid="artifact-markdown-relative-link"]')!
    expect(rel.textContent).toBe('spec')
    expect(rel.getAttribute('title')).toBe('docs/receipt-spec-2.md')
  })

  it('a relative link matching another artifact opens it in the viewer without navigating', () => {
    const open = vi.fn()
    const host = render('[spec](docs/receipt-spec-2.md)', href => (href === 'docs/receipt-spec-2.md' ? open : null))
    expect(host.querySelector('a')).toBeNull()
    const btn = host.querySelector('[data-testid="artifact-markdown-internal-link"]') as HTMLButtonElement
    act(() => { btn.click() })
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('findArtifactByLink matches relPath, then a unique filename', () => {
    const items = [{ filename: 'receipt-spec-2.md' }, { filename: 'other.md' }, { filename: 'dup.md' }, { filename: 'dup.md' }]
    expect(findArtifactByLink('docs/receipt-spec-2.md', items)).toBe(0)
    expect(findArtifactByLink('./other.md#top', items)).toBe(1)
    expect(findArtifactByLink('dup.md', items)).toBe(-1)
    expect(findArtifactByLink('docs/a.md', [{ filename: 'a.md', relPath: 'docs/a.md' }, { filename: 'a.md', relPath: 'src/a.md' }])).toBe(0)
    expect(findArtifactByLink('nope.md', items)).toBe(-1)
  })
})
