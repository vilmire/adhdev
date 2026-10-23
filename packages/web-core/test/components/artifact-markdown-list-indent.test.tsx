// @vitest-environment jsdom
/**
 * Live finding (2026-10-23, standalone + headless Chromium): the markdown
 * artifact view rendered list bullets hanging outside its box, clipped at the
 * left border — Tailwind preflight zeroes `ul` padding and the viewer's
 * container did not carry `.chat-markdown`, the class that gives chat markdown
 * its list indent, heading and paragraph spacing. The container must share it.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactContentRenderer } from '../../src/components/attachments/ArtifactContentRenderers'
import type { ArtifactResolvedPayload } from '../../src/hooks/useArtifactRead'

const roots: Root[] = []
afterEach(() => {
    for (const root of roots.splice(0)) act(() => root.unmount())
    document.body.innerHTML = ''
})

describe('artifact markdown renderer container', () => {
    it('carries the chat-markdown class so lists are indented', async () => {
        const text = '# Report\n\n- item one\n- item two\n'
        const payload: ArtifactResolvedPayload = {
            artifactId: 'art_0123456789abcdef',
            sessionId: 's1',
            daemonId: 'd1',
            kind: 'markdown',
            mime: 'text/markdown',
            filename: 'report.md',
            title: 'report.md',
            sizeBytes: text.length,
            sha256: 'a'.repeat(64),
            registeredSha256: 'a'.repeat(64),
            sha256Changed: false,
            hashChanged: false,
            encoding: 'utf8',
            content: text,
            textContent: text,
            bytes: new TextEncoder().encode(text),
        }
        const host = document.createElement('div')
        document.body.appendChild(host)
        const root = createRoot(host)
        roots.push(root)
        await act(async () => {
            root.render(<ArtifactContentRenderer payload={payload} objectUrl={null} />)
        })
        const markdown = host.querySelector('[data-artifact-renderer="markdown"]')
        expect(markdown).not.toBeNull()
        const list = markdown!.querySelector('ul')
        expect(list).not.toBeNull()
        expect(list!.closest('.chat-markdown')).not.toBeNull()
    })
})
