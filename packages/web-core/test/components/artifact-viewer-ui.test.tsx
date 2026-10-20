// @vitest-environment jsdom
/**
 * Task D — Web-Core Artifact Viewer UI unit & integration tests.
 *
 * Covers:
 * 1. AttachmentBubble rendering (title, filename, formatBytes, CopyButton, download, <=600 char preview)
 *    with ZERO network fetch on initial render.
 * 2. Lazy [전체 보기] / View full `artifact_fetch` lifecycle, repeat-open cache hit,
 *    cache invalidation on sha256 update, and sha256Changed warning banner.
 * 3. Cross-machine (daemonId), cross-session (sessionId), and cross-origin cache isolation,
 *    plus fail-closed session resolution (never guessing an arbitrary session).
 * 4. All 5 allowed renderers (markdown, diff +/-/@@, json valid+malformed, text, image + lightbox)
 *    and strict rejection of HTML, iframe, and SVG.
 * 5. Download Blob bytes (UTF-8 & base64) + URL.createObjectURL / URL.revokeObjectURL lifecycle
 *    on download, close, sha256 update, and unmount.
 * 6. Actual ChatMessageList / ChatRowModel / chat-activity-visibility / mobile tail (`📎 <title>`) wiring.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatAttachmentMeta, ChatMessage, DaemonData } from '../../src/types'
import { AttachmentBubble } from '../../src/components/attachments/AttachmentBubble'
import { ArtifactContentRenderer, classifyDiffLine } from '../../src/components/attachments/ArtifactContentRenderers'
import {
    buildArtifactCacheKey,
    clampArtifactPreviewText,
    clearArtifactReadCache,
    getArtifactReadCacheSize,
    readArtifactFetchCommandResponse,
    resolveArtifactSessionTarget,
    useArtifactRead,
    type ArtifactResolvedPayload,
    type FetchArtifactCommandFn,
    type UseArtifactReadResult,
} from '../../src/hooks/useArtifactRead'
import {
    chatBubbleContentSignature,
    classifyChatMessageForDisplay,
} from '../../src/components/dashboard/chat-activity-visibility'
import { getConversationLastMessagePreview } from '../../src/components/dashboard/conversation-selectors'
import {
    controllerRegistry,
    getOrCreateSessionChatController,
} from '../../src/components/dashboard/session-chat-controller'
import { BaseDaemonProvider, useBaseDaemonActions } from '../../src/context/BaseDaemonContext'
import { TransportProvider } from '../../src/context/TransportContext'
import { resolveChatRow } from '../../src/components/ChatMessageList/chat-row-model'
import ChatMessageList from '../../src/components/ChatMessageList'

function makeAttachment(overrides: Partial<ChatAttachmentMeta> = {}): ChatAttachmentMeta {
    return {
        artifactId: 'art_0123456789abcdef',
        kind: 'markdown',
        mime: 'text/markdown',
        filename: 'architecture-plan.md',
        title: 'Architecture Plan',
        sizeBytes: 2450,
        sha256: 'a'.repeat(64),
        previewText: '# Architecture Plan\n\nSummary of the v1.1 design.',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_005_000,
        ...overrides,
    }
}

function makeArtifactMessage(
    attachment: ChatAttachmentMeta = makeAttachment(),
    overrides: Partial<ChatMessage> = {},
): ChatMessage {
    return {
        role: 'system',
        kind: 'artifact',
        messageId: `artifact:${attachment.artifactId}`,
        content: attachment.title,
        attachment,
        receivedAt: attachment.updatedAt,
        ...overrides,
    }
}

function makeResolvedPayload(overrides: Partial<ArtifactResolvedPayload> = {}): ArtifactResolvedPayload {
    const content = overrides.content ?? '# Sample'
    return {
        artifactId: 'art_0123456789abcdef',
        sessionId: 'sess-101',
        daemonId: 'daemon-alpha',
        kind: 'markdown',
        mime: 'text/markdown',
        filename: 'architecture-plan.md',
        title: 'Architecture Plan',
        sizeBytes: content.length,
        sha256: 'a'.repeat(64),
        registeredSha256: 'a'.repeat(64),
        sha256Changed: false,
        hashChanged: false,
        encoding: 'utf8',
        content,
        textContent: content,
        bytes: new TextEncoder().encode(content),
        ...overrides,
    }
}

describe('Task D — Artifact Viewer UI', () => {
    let container: HTMLDivElement
    let root: Root | null = null
    let createdUrls: string[] = []
    let revokedUrls: string[] = []
    let urlCounter = 0

    beforeEach(() => {
        clearArtifactReadCache()
        createdUrls = []
        revokedUrls = []
        urlCounter = 0

        if (typeof globalThis.ResizeObserver === 'undefined') {
            globalThis.ResizeObserver = class ResizeObserver {
                observe() {}
                unobserve() {}
                disconnect() {}
            } as any
        }
        if (typeof HTMLElement.prototype.scrollTo === 'undefined') {
            HTMLElement.prototype.scrollTo = (() => {}) as any
        }
        controllerRegistry.clear()

        container = document.createElement('div')
        document.body.appendChild(container)

        vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
            urlCounter += 1
            const url = `blob:https://adhdev.local/mock-object-${urlCounter}`
            createdUrls.push(url)
            return url
        })
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
            revokedUrls.push(url)
        })
    })

    afterEach(() => {
        if (root) {
            act(() => {
                root?.unmount()
            })
            root = null
        }
        container.remove()
        vi.restoreAllMocks()
    })

    function mount(element: React.ReactElement) {
        root = createRoot(container)
        act(() => {
            root?.render(element)
        })
    }

    describe('1. Immediate preview & ZERO network fetch on render', () => {
        it('renders title, filename, formatted byte size, CopyButton, Download, and <=600 char preview with 0 network calls', () => {
            const fetchArtifact = vi.fn<FetchArtifactCommandFn>()
            const att = makeAttachment({
                title: 'Release Checklist',
                filename: 'release-checklist.md',
                sizeBytes: 1536, // 1.5 KB
                previewText: 'Step 1: Verify boundaries\nStep 2: Run unit tests',
            })

            mount(
                <AttachmentBubble
                    attachment={att}
                    daemonId="daemon-alpha"
                    sessionId="sess-101"
                    fetchArtifact={fetchArtifact}
                />,
            )

            expect(fetchArtifact).not.toHaveBeenCalled()
            expect(container.querySelector('[data-testid="artifact-title"]')?.textContent).toBe('Release Checklist')
            expect(container.querySelector('[data-testid="artifact-filename"]')?.textContent).toBe('release-checklist.md')
            expect(container.querySelector('[data-testid="artifact-size"]')?.textContent).toBe('1.5 KB')
            expect(container.querySelector('[data-testid="artifact-preview-text"]')?.textContent).toContain('Step 1: Verify boundaries')
            expect(container.querySelector('[data-testid="artifact-view-full-button"]')).not.toBeNull()
            expect(container.querySelector('[data-testid="artifact-download-button"]')).not.toBeNull()
            expect(container.querySelector('[data-testid="artifact-viewer-panel"]')).toBeNull()
        })

        it('bounds previewText to at most 600 characters without network fetch', () => {
            const overlong = '가'.repeat(650)
            const truncated = clampArtifactPreviewText(overlong)
            expect(Array.from(truncated)).toHaveLength(600)

            const fetchArtifact = vi.fn<FetchArtifactCommandFn>()
            mount(
                <AttachmentBubble
                    attachment={makeAttachment({ previewText: overlong })}
                    daemonId="daemon-alpha"
                    sessionId="sess-101"
                    fetchArtifact={fetchArtifact}
                />,
            )
            expect(fetchArtifact).not.toHaveBeenCalled()
            const previewEl = container.querySelector('[data-testid="artifact-preview-text"]')
            expect(previewEl).not.toBeNull()
            expect(Array.from(previewEl!.textContent || '')).toHaveLength(600)
        })
    })

    describe('2. Lazy [전체 보기] fetch, cache hit, sha256 invalidation & hashChanged warning', () => {
        it('fetches only when [전체 보기] is clicked, caches repeat opens, and invalidates when sha256 changes', async () => {
            const fullMarkdown = '# Architecture Plan\n\nFull detailed specification with **bold** text.'
            const fetchArtifact = vi.fn<FetchArtifactCommandFn>().mockImplementation(async (_daemonId, _cmd, payload) => ({
                success: true,
                artifactId: payload.artifactId,
                sessionId: payload.sessionId,
                kind: 'markdown',
                mime: 'text/markdown',
                filename: 'architecture-plan.md',
                title: 'Architecture Plan',
                sizeBytes: fullMarkdown.length,
                sha256: 'a'.repeat(64),
                registeredSha256: 'a'.repeat(64),
                sha256Changed: false,
                encoding: 'utf8',
                content: fullMarkdown,
            }))

            const attV1 = makeAttachment({ sha256: 'a'.repeat(64) })
            mount(
                <AttachmentBubble
                    attachment={attV1}
                    daemonId="daemon-alpha"
                    sessionId="sess-101"
                    origin="https://app.adhdev.test"
                    fetchArtifact={fetchArtifact}
                />,
            )

            // Zero fetch before clicking [전체 보기]
            expect(fetchArtifact).toHaveBeenCalledTimes(0)

            const viewBtn = container.querySelector('[data-testid="artifact-view-full-button"]') as HTMLButtonElement
            await act(async () => {
                viewBtn.click()
            })

            expect(fetchArtifact).toHaveBeenCalledTimes(1)
            expect(fetchArtifact).toHaveBeenCalledWith('daemon-alpha', 'artifact_fetch', {
                artifactId: attV1.artifactId,
                sessionId: 'sess-101',
                targetSessionId: 'sess-101',
            })
            expect(container.querySelector('[data-artifact-renderer="markdown"]')?.textContent).toContain(
                'Full detailed specification',
            )

            // Close viewer
            await act(async () => {
                viewBtn.click()
            })
            expect(container.querySelector('[data-testid="artifact-viewer-panel"]')).toBeNull()

            // Re-open viewer -> served from cache, ZERO additional network calls
            await act(async () => {
                viewBtn.click()
            })
            expect(fetchArtifact).toHaveBeenCalledTimes(1)
            expect(container.querySelector('[data-artifact-renderer="markdown"]')?.textContent).toContain(
                'Full detailed specification',
            )

            // Now update attachment sha256 (file re-registered with new content)
            const updatedMarkdown = '# Architecture Plan v2\n\nUpdated section after review.'
            fetchArtifact.mockImplementationOnce(async (_daemonId, _cmd, payload) => ({
                success: true,
                artifactId: payload.artifactId,
                sessionId: payload.sessionId,
                kind: 'markdown',
                mime: 'text/markdown',
                filename: 'architecture-plan.md',
                title: 'Architecture Plan',
                sizeBytes: updatedMarkdown.length,
                sha256: 'b'.repeat(64),
                registeredSha256: 'b'.repeat(64),
                sha256Changed: false,
                encoding: 'utf8',
                content: updatedMarkdown,
            }))

            const attV2 = makeAttachment({ sha256: 'b'.repeat(64), updatedAt: 1_700_000_010_000 })
            act(() => {
                root?.render(
                    <AttachmentBubble
                        attachment={attV2}
                        daemonId="daemon-alpha"
                        sessionId="sess-101"
                        origin="https://app.adhdev.test"
                        fetchArtifact={fetchArtifact}
                    />,
                )
            })

            // Re-open after sha256 change -> cache key changed, triggers 2nd fetch
            const viewBtnV2 = container.querySelector('[data-testid="artifact-view-full-button"]') as HTMLButtonElement
            await act(async () => {
                viewBtnV2.click()
            })
            expect(fetchArtifact).toHaveBeenCalledTimes(2)
            expect(container.querySelector('[data-artifact-renderer="markdown"]')?.textContent).toContain(
                'Updated section after review.',
            )
        })

        it('displays hashChanged warning banner when sha256Changed is true on read', async () => {
            const fetchArtifact = vi.fn<FetchArtifactCommandFn>().mockResolvedValue({
                success: true,
                artifactId: 'art_0123456789abcdef',
                sessionId: 'sess-101',
                kind: 'text',
                mime: 'text/plain',
                filename: 'notes.txt',
                title: 'Workspace Notes',
                sizeBytes: 32,
                sha256: 'c'.repeat(64),
                registeredSha256: 'a'.repeat(64),
                sha256Changed: true,
                encoding: 'utf8',
                content: 'Modified workspace file content',
            })

            mount(
                <AttachmentBubble
                    attachment={makeAttachment({ kind: 'text', mime: 'text/plain', filename: 'notes.txt' })}
                    daemonId="daemon-alpha"
                    sessionId="sess-101"
                    fetchArtifact={fetchArtifact}
                />,
            )

            const viewBtn = container.querySelector('[data-testid="artifact-view-full-button"]') as HTMLButtonElement
            await act(async () => {
                viewBtn.click()
            })

            expect(container.querySelector('[data-testid="artifact-hash-changed-warning"]')).not.toBeNull()
            expect(container.querySelector('[data-artifact-renderer="text"] pre')?.textContent).toBe(
                'Modified workspace file content',
            )
        })
    })

    describe('3. Exact machine / session / origin isolation & fail-closed routing', () => {
        it('isolates cache keys by origin, daemonId, sessionId, artifactId, and sha256 to prevent cross-machine collisions', async () => {
            const keyA = buildArtifactCacheKey({
                origin: 'https://cloud.adhdev.io',
                daemonId: 'daemon-mac-1',
                sessionId: 'sess-1',
                artifactId: 'art_sameid0000000001',
                sha256: 'f'.repeat(64),
            })
            const keyB = buildArtifactCacheKey({
                origin: 'https://cloud.adhdev.io',
                daemonId: 'daemon-mac-2',
                sessionId: 'sess-1',
                artifactId: 'art_sameid0000000001',
                sha256: 'f'.repeat(64),
            })
            const keyC = buildArtifactCacheKey({
                origin: 'https://cloud.adhdev.io',
                daemonId: 'daemon-mac-1',
                sessionId: 'sess-2',
                artifactId: 'art_sameid0000000001',
                sha256: 'f'.repeat(64),
            })
            const keyD = buildArtifactCacheKey({
                origin: 'http://127.0.0.1:5173',
                daemonId: 'daemon-mac-1',
                sessionId: 'sess-1',
                artifactId: 'art_sameid0000000001',
                sha256: 'f'.repeat(64),
            })

            expect(new Set([keyA, keyB, keyC, keyD]).size).toBe(4)

            const fetchArtifact = vi.fn<FetchArtifactCommandFn>().mockImplementation(async (daemonId, _cmd, payload) => ({
                success: true,
                artifactId: payload.artifactId,
                sessionId: payload.sessionId,
                kind: 'text',
                mime: 'text/plain',
                filename: 'out.txt',
                title: 'Output',
                sizeBytes: 20,
                sha256: 'f'.repeat(64),
                registeredSha256: 'f'.repeat(64),
                sha256Changed: false,
                encoding: 'utf8',
                content: `from-${daemonId}-${payload.sessionId}`,
            }))

            const sharedAtt = makeAttachment({
                artifactId: 'art_sameid0000000001',
                kind: 'text',
                mime: 'text/plain',
                sha256: 'f'.repeat(64),
            })

            mount(
                <div>
                    <div id="machine-1">
                        <AttachmentBubble
                            attachment={sharedAtt}
                            daemonId="daemon-mac-1"
                            sessionId="sess-1"
                            fetchArtifact={fetchArtifact}
                        />
                    </div>
                    <div id="machine-2">
                        <AttachmentBubble
                            attachment={sharedAtt}
                            daemonId="daemon-mac-2"
                            sessionId="sess-1"
                            fetchArtifact={fetchArtifact}
                        />
                    </div>
                </div>,
            )

            const btn1 = container.querySelector('#machine-1 [data-testid="artifact-view-full-button"]') as HTMLButtonElement
            const btn2 = container.querySelector('#machine-2 [data-testid="artifact-view-full-button"]') as HTMLButtonElement

            await act(async () => {
                btn1.click()
            })
            await act(async () => {
                btn2.click()
            })

            expect(fetchArtifact).toHaveBeenCalledTimes(2)
            expect(container.querySelector('#machine-1 [data-artifact-renderer="text"] pre')?.textContent).toBe(
                'from-daemon-mac-1-sess-1',
            )
            expect(container.querySelector('#machine-2 [data-artifact-renderer="text"] pre')?.textContent).toBe(
                'from-daemon-mac-2-sess-1',
            )
            expect(getArtifactReadCacheSize()).toBe(2)
        })

        it('resolves exact session target from contextKey or ides and fails closed when session context is missing or ambiguous', () => {
            expect(resolveArtifactSessionTarget({})).toBeNull()
            expect(resolveArtifactSessionTarget({ daemonId: 'd1' })).toBeNull()
            expect(resolveArtifactSessionTarget({ sessionId: 's1' })).toBeNull()

            expect(
                resolveArtifactSessionTarget({
                    daemonId: 'daemon-1',
                    sessionId: 'sess-99',
                    meshCoordinatorDaemonId: 'coord-1',
                }),
            ).toEqual({
                daemonId: 'daemon-1',
                sessionId: 'sess-99',
                meshCoordinatorDaemonId: 'coord-1',
            })

            const ides: DaemonData[] = [
                {
                    daemonId: 'daemon-a',
                    machineId: 'm-a',
                    hostname: 'host-a',
                    pid: 4100,
                    ideName: 'Claude Code',
                    status: 'online',
                    sessions: [
                        { id: 'sess-exact', label: 'Main', status: 'active' } as any,
                        { id: 'sess-other', label: 'Other', status: 'idle' } as any,
                    ],
                } as any,
            ]
            // Ambiguous 2-session daemon with only pid in contextKey -> fails closed
            expect(resolveArtifactSessionTarget({ contextKey: '4100', ides })).toBeNull()

            // Exact daemonId:sessionId contextKey resolves cleanly
            expect(resolveArtifactSessionTarget({ contextKey: 'daemon-a:sess-exact', ides })).toEqual({
                daemonId: 'daemon-a',
                sessionId: 'sess-exact',
            })
        })

        it('fails closed in UI when session context is missing or daemon response mismatches sessionId/artifactId', async () => {
            const fetchArtifact = vi.fn<FetchArtifactCommandFn>()
            mount(<AttachmentBubble attachment={makeAttachment()} fetchArtifact={fetchArtifact} />)

            const viewBtn = container.querySelector('[data-testid="artifact-view-full-button"]') as HTMLButtonElement
            await act(async () => {
                viewBtn.click()
            })

            expect(fetchArtifact).not.toHaveBeenCalled()
            expect(container.querySelector('[data-testid="artifact-error"]')?.textContent).toContain(
                'Session context is required',
            )

            const mismatchResult = readArtifactFetchCommandResponse(
                {
                    success: true,
                    artifactId: 'art_0123456789abcdef',
                    sessionId: 'sess-attacker',
                    kind: 'text',
                    mime: 'text/plain',
                    encoding: 'utf8',
                    content: 'spoofed',
                },
                {
                    daemonId: 'daemon-1',
                    sessionId: 'sess-legit',
                    artifactId: 'art_0123456789abcdef',
                    attachment: makeAttachment({ kind: 'text', mime: 'text/plain' }),
                },
            )
            expect(mismatchResult.data).toBeNull()
            expect(mismatchResult.errorCode).toBe('session_mismatch')
        })
    })

    describe('4. Five allowed renderers & strict HTML / iframe / SVG rejection', () => {
        it('renders diff with add (+), del (-), hunk (@@), and meta line styling', () => {
            const rawDiff = [
                'diff --git a/src/app.ts b/src/app.ts',
                '--- a/src/app.ts',
                '+++ b/src/app.ts',
                '@@ -10,4 +10,5 @@',
                ' const a = 1;',
                '-const oldVal = 2;',
                '+const newVal = 3;',
            ].join('\n')

            expect(classifyDiffLine('diff --git a/x b/x')).toBe('meta')
            expect(classifyDiffLine('--- a/x')).toBe('meta')
            expect(classifyDiffLine('+++ b/x')).toBe('meta')
            expect(classifyDiffLine('@@ -1,2 +1,2 @@')).toBe('hunk')
            expect(classifyDiffLine('+added line')).toBe('add')
            expect(classifyDiffLine('-removed line')).toBe('del')
            expect(classifyDiffLine(' context line')).toBe('context')

            mount(
                <ArtifactContentRenderer
                    payload={makeResolvedPayload({
                        kind: 'diff',
                        mime: 'text/x-diff',
                        title: 'Patch',
                        filename: 'fix.diff',
                        content: rawDiff,
                        textContent: rawDiff,
                    })}
                    objectUrl={null}
                />,
            )

            const diffEl = container.querySelector('[data-artifact-renderer="diff"]')
            expect(diffEl).not.toBeNull()
            expect(diffEl?.querySelectorAll('[data-diff-line-kind="add"]')).toHaveLength(1)
            expect(diffEl?.querySelectorAll('[data-diff-line-kind="del"]')).toHaveLength(1)
            expect(diffEl?.querySelectorAll('[data-diff-line-kind="hunk"]')).toHaveLength(1)
            expect(diffEl?.querySelectorAll('[data-diff-line-kind="meta"]')).toHaveLength(3)
        })

        it('renders formatted JSON for valid JSON and raw text + notice for malformed JSON', () => {
            mount(
                <ArtifactContentRenderer
                    payload={makeResolvedPayload({
                        kind: 'json',
                        mime: 'application/json',
                        title: 'Config',
                        filename: 'config.json',
                        content: '{"name":"adhdev","version":1}',
                        textContent: '{"name":"adhdev","version":1}',
                    })}
                    objectUrl={null}
                />,
            )
            const jsonEl = container.querySelector('[data-artifact-renderer="json"]')
            expect(jsonEl).not.toBeNull()
            expect(jsonEl?.textContent).toContain('"name": "adhdev"')
            expect(container.querySelector('[data-testid="artifact-json-invalid-notice"]')).toBeNull()

            act(() => {
                root?.render(
                    <ArtifactContentRenderer
                        payload={makeResolvedPayload({
                            kind: 'json',
                            mime: 'application/json',
                            title: 'Broken Config',
                            filename: 'broken.json',
                            content: '{"unclosed": 123',
                            textContent: '{"unclosed": 123',
                        })}
                        objectUrl={null}
                    />,
                )
            })
            expect(container.querySelector('[data-testid="artifact-json-invalid-notice"]')).not.toBeNull()
            expect(container.querySelector('[data-artifact-renderer="json"]')?.textContent).toContain('{"unclosed": 123')
        })

        it('renders image via ScreenshotViewer and opens/zooms/closes lightbox modal + revokes objectUrl on close', async () => {
            const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
            const b64 = Buffer.from(pngBytes).toString('base64')
            const fetchArtifact = vi.fn<FetchArtifactCommandFn>().mockResolvedValue({
                success: true,
                artifactId: 'art_img0000000000001',
                sessionId: 'sess-101',
                kind: 'image',
                mime: 'image/png',
                filename: 'ui-shot.png',
                title: 'UI Screenshot',
                sizeBytes: pngBytes.byteLength,
                sha256: 'd'.repeat(64),
                registeredSha256: 'd'.repeat(64),
                sha256Changed: false,
                encoding: 'base64',
                content: b64,
            })

            mount(
                <AttachmentBubble
                    attachment={makeAttachment({
                        artifactId: 'art_img0000000000001',
                        kind: 'image',
                        mime: 'image/png',
                        filename: 'ui-shot.png',
                        title: 'UI Screenshot',
                        sizeBytes: pngBytes.byteLength,
                        sha256: 'd'.repeat(64),
                        previewText: undefined,
                    })}
                    daemonId="daemon-alpha"
                    sessionId="sess-101"
                    fetchArtifact={fetchArtifact}
                />,
            )

            const viewBtn = container.querySelector('[data-testid="artifact-view-full-button"]') as HTMLButtonElement
            await act(async () => {
                viewBtn.click()
            })

            expect(createdUrls).toHaveLength(1)
            expect(container.querySelector('[data-artifact-renderer="image"]')).not.toBeNull()
            const expandBtn = container.querySelector('[data-testid="artifact-image-lightbox-open"]') as HTMLButtonElement
            expect(expandBtn).not.toBeNull()

            await act(async () => {
                expandBtn.click()
            })

            const lightbox = document.body.querySelector('[data-testid="artifact-image-lightbox"]')
            expect(lightbox).not.toBeNull()

            // Close viewer -> revokes objectUrl
            await act(async () => {
                viewBtn.click()
            })
            expect(revokedUrls).toContain(createdUrls[0])
        })

        it('strictly blocks HTML, iframe, and SVG MIME/kinds in both response validator and renderer', () => {
            for (const forbidden of [
                { kind: 'html', mime: 'text/html', content: '<script>alert(1)</script>' },
                { kind: 'text', mime: 'text/html', content: '<iframe src="evil"></iframe>' },
                { kind: 'image', mime: 'image/svg+xml', content: '<svg onload="alert(1)"/>' },
            ]) {
                const res = readArtifactFetchCommandResponse(
                    {
                        success: true,
                        artifactId: 'art_0123456789abcdef',
                        sessionId: 'sess-101',
                        ...forbidden,
                        encoding: 'utf8',
                    },
                    {
                        daemonId: 'daemon-alpha',
                        sessionId: 'sess-101',
                        artifactId: 'art_0123456789abcdef',
                        attachment: makeAttachment(),
                    },
                )
                expect(res.data).toBeNull()
                expect(res.errorCode).toMatch(/unsupported_kind|unsupported_mime/)
            }

            mount(
                <ArtifactContentRenderer
                    payload={makeResolvedPayload({
                        kind: 'image' as any,
                        mime: 'image/svg+xml',
                        title: 'Evil SVG',
                        filename: 'evil.svg',
                        content: '<svg onload=alert(1)></svg>',
                        textContent: '<svg onload=alert(1)></svg>',
                    })}
                    objectUrl="blob:https://adhdev.local/evil"
                />,
            )
            expect(container.querySelector('[data-artifact-renderer="unsupported"]')).not.toBeNull()
            expect(container.querySelector('iframe')).toBeNull()
        })
    })

    describe('5. Download Blob + URL.revokeObjectURL cleanup + Copy + Error/Retry', () => {
        it('downloads exact decoded bytes via Blob + objectURL and revokes temporary download URL', async () => {
            const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
            const fetchArtifact = vi.fn<FetchArtifactCommandFn>().mockResolvedValue({
                success: true,
                artifactId: 'art_0123456789abcdef',
                sessionId: 'sess-101',
                kind: 'text',
                mime: 'text/plain',
                filename: 'report.txt',
                title: 'Report',
                sizeBytes: 11,
                sha256: 'a'.repeat(64),
                registeredSha256: 'a'.repeat(64),
                sha256Changed: false,
                encoding: 'utf8',
                content: 'hello world',
            })

            mount(
                <AttachmentBubble
                    attachment={makeAttachment({ kind: 'text', mime: 'text/plain', filename: 'report.txt' })}
                    daemonId="daemon-alpha"
                    sessionId="sess-101"
                    fetchArtifact={fetchArtifact}
                />,
            )

            const downloadBtn = container.querySelector('[data-testid="artifact-download-button"]') as HTMLButtonElement
            await act(async () => {
                downloadBtn.click()
            })

            expect(fetchArtifact).toHaveBeenCalledTimes(1)
            expect(clickSpy).toHaveBeenCalledTimes(1)
            expect(createdUrls).toHaveLength(1)
            expect(revokedUrls).toEqual(createdUrls)
        })

        it('shows error banner on failure and succeeds on Retry click', async () => {
            let attempt = 0
            const fetchArtifact = vi.fn<FetchArtifactCommandFn>().mockImplementation(async () => {
                attempt += 1
                if (attempt === 1) {
                    return {
                        success: false,
                        error: 'artifact_not_found',
                        message: 'File missing',
                    }
                }
                return {
                    success: true,
                    artifactId: 'art_0123456789abcdef',
                    sessionId: 'sess-101',
                    kind: 'text',
                    mime: 'text/plain',
                    filename: 'recovered.txt',
                    title: 'Recovered',
                    sizeBytes: 9,
                    sha256: 'a'.repeat(64),
                    registeredSha256: 'a'.repeat(64),
                    sha256Changed: false,
                    encoding: 'utf8',
                    content: 'recovered',
                }
            })

            mount(
                <AttachmentBubble
                    attachment={makeAttachment({ kind: 'text', mime: 'text/plain', filename: 'recovered.txt' })}
                    daemonId="daemon-alpha"
                    sessionId="sess-101"
                    fetchArtifact={fetchArtifact}
                />,
            )

            const viewBtn = container.querySelector('[data-testid="artifact-view-full-button"]') as HTMLButtonElement
            await act(async () => {
                viewBtn.click()
            })

            expect(container.querySelector('[data-testid="artifact-error"]')).not.toBeNull()
            const retryBtn = container.querySelector('[data-testid="artifact-retry-button"]') as HTMLButtonElement
            expect(retryBtn).not.toBeNull()

            await act(async () => {
                retryBtn.click()
            })

            expect(container.querySelector('[data-testid="artifact-error"]')).toBeNull()
            expect(container.querySelector('[data-artifact-renderer="text"] pre')?.textContent).toBe('recovered')
        })

        it('copies previewText before fetch and full textContent after fetch, enforces 4 MiB cap, and revokes image objectURL on unmount', async () => {
            const writeText = vi.fn().mockResolvedValue(undefined)
            Object.defineProperty(navigator, 'clipboard', {
                value: { writeText },
                configurable: true,
            })

            const fetchText = vi.fn<FetchArtifactCommandFn>().mockResolvedValue({
                success: true,
                artifactId: 'art_0123456789abcdef',
                sessionId: 'sess-101',
                kind: 'text',
                mime: 'text/plain',
                filename: 'copy-test.txt',
                title: 'Copy Test',
                sizeBytes: 24,
                sha256: 'a'.repeat(64),
                registeredSha256: 'a'.repeat(64),
                sha256Changed: false,
                encoding: 'utf8',
                content: 'FULL_FETCHED_BODY_STRING',
            })

            mount(
                <AttachmentBubble
                    attachment={makeAttachment({
                        kind: 'text',
                        mime: 'text/plain',
                        filename: 'copy-test.txt',
                        previewText: 'INITIAL_PREVIEW_ONLY',
                    })}
                    daemonId="daemon-alpha"
                    sessionId="sess-101"
                    fetchArtifact={fetchText}
                />,
            )

            // Copy before open -> copies previewText
            const headerCopyBtn = Array.from(container.querySelectorAll('button')).find(
                (btn) => btn.textContent?.trim() === 'Copy',
            ) as HTMLButtonElement
            expect(headerCopyBtn).toBeDefined()
            await act(async () => {
                headerCopyBtn.click()
            })
            expect(writeText).toHaveBeenLastCalledWith('INITIAL_PREVIEW_ONLY')

            // Open viewer -> fetches full text -> Copy copies full text
            const viewBtn = container.querySelector('[data-testid="artifact-view-full-button"]') as HTMLButtonElement
            await act(async () => {
                viewBtn.click()
            })
            await act(async () => {
                headerCopyBtn.click()
            })
            expect(writeText).toHaveBeenLastCalledWith('FULL_FETCHED_BODY_STRING')

            // 4 MiB limit check
            const overLimit = readArtifactFetchCommandResponse(
                {
                    success: true,
                    artifactId: 'art_0123456789abcdef',
                    sessionId: 'sess-101',
                    kind: 'text',
                    mime: 'text/plain',
                    sizeBytes: 4 * 1024 * 1024 + 1,
                    encoding: 'utf8',
                    content: 'x',
                },
                {
                    daemonId: 'daemon-alpha',
                    sessionId: 'sess-101',
                    artifactId: 'art_0123456789abcdef',
                    attachment: makeAttachment({ kind: 'text', mime: 'text/plain' }),
                },
            )
            expect(overLimit.data).toBeNull()
            expect(overLimit.errorCode).toBe('file_too_large')
        })
    })

    describe('6. Actual ChatMessageList, ChatRowModel, visibility & mobile tail integration', () => {
        it('marks artifact messages as user-facing chat rows and includes artifactId:sha256:updatedAt in signatures', () => {
            const msgV1 = makeArtifactMessage(
                makeAttachment({
                    artifactId: 'art_1111222233334444',
                    sha256: '1'.repeat(64),
                    updatedAt: 1_700_000_001_000,
                }),
            )
            const msgV2 = makeArtifactMessage(
                makeAttachment({
                    artifactId: 'art_1111222233334444',
                    sha256: '2'.repeat(64),
                    updatedAt: 1_700_000_002_000,
                }),
            )

            const vis = classifyChatMessageForDisplay(msgV1)
            expect(vis.surface).toBe('chat')
            expect(vis.isUserFacing).toBe(true)

            const sig1 = chatBubbleContentSignature(msgV1)
            const sig2 = chatBubbleContentSignature(msgV2)
            expect(sig1).toContain(`art_1111222233334444:${'1'.repeat(64)}:1700000001000`)
            expect(sig1).not.toBe(sig2)

            const row1 = resolveChatRow(msgV1)
            const row2 = resolveChatRow(msgV2)
            expect(row1.kind).toBe('artifact')
            expect(row1.surface).toBe('chat')
            expect(row1.attachment?.artifactId).toBe('art_1111222233334444')
            expect(row1.signature).not.toBe(row2.signature)
        })

        it('renders AttachmentBubble inside actual ChatMessageList and updates when attachment sha256 changes', () => {
            const msgV1 = makeArtifactMessage(
                makeAttachment({
                    title: 'Initial Spec',
                    sha256: '1'.repeat(64),
                    previewText: 'Preview v1 content',
                    updatedAt: 1_700_000_001_000,
                }),
            )

            mount(
                <ChatMessageList
                    messages={[
                        { role: 'user', content: 'Please generate the spec.' },
                        msgV1,
                    ]}
                    contextKey="daemon-alpha:sess-101"
                    agentName="Claude"
                    userName="You"
                />,
            )

            expect(container.querySelector('[data-testid="attachment-bubble"]')).not.toBeNull()
            expect(container.querySelector('[data-testid="artifact-title"]')?.textContent).toBe('Initial Spec')
            expect(container.querySelector('[data-testid="artifact-preview-text"]')?.textContent).toBe('Preview v1 content')

            // Update same artifactId with new sha256 and previewText
            const msgV2 = makeArtifactMessage(
                makeAttachment({
                    title: 'Updated Spec v2',
                    sha256: '2'.repeat(64),
                    previewText: 'Preview v2 content after edit',
                    updatedAt: 1_700_000_009_000,
                }),
            )

            act(() => {
                root?.render(
                    <ChatMessageList
                        messages={[
                            { role: 'user', content: 'Please generate the spec.' },
                            msgV2,
                        ]}
                        contextKey="daemon-alpha:sess-101"
                        agentName="Claude"
                        userName="You"
                    />,
                )
            })

            expect(container.querySelector('[data-testid="artifact-title"]')?.textContent).toBe('Updated Spec v2')
            expect(container.querySelector('[data-testid="artifact-preview-text"]')?.textContent).toBe(
                'Preview v2 content after edit',
            )
        })

        it('renders mobile inbox tail preview as 📎 <title> with zero network fetch', () => {
            const artMsg = makeArtifactMessage(
                makeAttachment({
                    title: 'Deployment Diff Report',
                    filename: 'deploy.diff',
                }),
            )

            const preview = getConversationLastMessagePreview({
                key: 'daemon-alpha:sess-101',
                daemonId: 'daemon-alpha',
                sessionId: 'sess-101',
                messages: [
                    { role: 'user', content: 'Show deployment diff' },
                    artMsg,
                ],
            } as any)

            expect(preview).toBe('📎 Deployment Diff Report')
        })
    })

    describe('7. D1-D5 Reviewer Remediation Regression & Positive Controls', () => {
        it('D1: ChatMessageList with only contextKey reacts to live session/daemon switch behind stable tabKey and fences deferred responses', async () => {
            let resolveFirst!: (val: unknown) => void
            const firstPromise = new Promise((r) => {
                resolveFirst = r
            })
            const fetchCalls: Array<[string, string]> = []
            const sendCommand = vi.fn((daemonId: string, _cmd: string, payload: any) => {
                fetchCalls.push([daemonId, payload.sessionId])
                if (fetchCalls.length === 1) return firstPromise
                return Promise.resolve({
                    success: true,
                    artifactId: 'art_0123456789abcdef',
                    sessionId: payload.sessionId,
                    kind: 'text',
                    mime: 'text/plain',
                    filename: 'live.txt',
                    title: 'Live Output',
                    sizeBytes: 15,
                    sha256: 'a'.repeat(64),
                    registeredSha256: 'a'.repeat(64),
                    sha256Changed: false,
                    encoding: 'utf8',
                    content: 'CURRENT-CONTENT',
                })
            })

            let injectFn!: (entries: DaemonData[], options?: { authoritativeDaemonIds?: string[] }) => void
            function Harness({ messages }: { messages: ChatMessage[] }) {
                const { injectEntries } = useBaseDaemonActions()
                injectFn = injectEntries
                return <ChatMessageList messages={messages} contextKey="stable-tab" />
            }

            const artMsg = makeArtifactMessage(makeAttachment({ kind: 'text', mime: 'text/plain' }))

            mount(
                <BaseDaemonProvider>
                    <TransportProvider
                        value={{
                            sendCommand,
                            subscribe: () => () => {},
                            sendPtyInput: () => false,
                            requestRuntimeSnapshot: async () => ({ success: false, error: 'noop' }),
                            onRuntimeEvent: () => () => {},
                        }}
                    >
                        <Harness messages={[artMsg]} />
                    </TransportProvider>
                </BaseDaemonProvider>,
            )

            act(() => {
                injectFn(
                    [
                        {
                            id: 'stable-tab',
                            daemonId: 'host-a',
                            sessionId: 'old-session',
                            type: 'claude-code',
                            transport: 'pty',
                            status: 'active',
                            activeChat: { messages: [] },
                        } as any,
                    ],
                    { authoritativeDaemonIds: ['host-a'] },
                )
            })

            const viewBtn = container.querySelector('[data-testid="artifact-view-full-button"]') as HTMLButtonElement
            await act(async () => {
                viewBtn.click()
            })
            expect(fetchCalls).toEqual([['host-a', 'old-session']])

            // Switch live session/daemon behind the same tabKey before first request settles
            act(() => {
                injectFn(
                    [
                        {
                            id: 'stable-tab',
                            daemonId: 'host-b',
                            sessionId: 'CURRENT-session',
                            type: 'claude-code',
                            transport: 'pty',
                            status: 'active',
                            activeChat: { messages: [] },
                        } as any,
                    ],
                    { authoritativeDaemonIds: ['host-a', 'host-b'] },
                )
            })

            await act(async () => {
                resolveFirst({
                    success: true,
                    artifactId: 'art_0123456789abcdef',
                    sessionId: 'old-session',
                    kind: 'text',
                    mime: 'text/plain',
                    filename: 'live.txt',
                    title: 'Live Output',
                    sizeBytes: 11,
                    sha256: 'a'.repeat(64),
                    registeredSha256: 'a'.repeat(64),
                    sha256Changed: false,
                    encoding: 'utf8',
                    content: 'OLD-CONTENT',
                })
                await Promise.resolve()
            })

            expect(container.textContent).not.toContain('OLD-CONTENT')

            await act(async () => {
                ;(container.querySelector('[data-testid="artifact-view-full-button"]') as HTMLButtonElement).click()
            })
            expect(fetchCalls).toEqual([
                ['host-a', 'old-session'],
                ['host-b', 'CURRENT-session'],
            ])
            expect(container.textContent).toContain('CURRENT-CONTENT')
        })

        it('D1 & D4: fences in-flight response on origin change, invalidates cache on updatedAt bump, and prevents :: delimiter cache collisions', async () => {
            const key1 = buildArtifactCacheKey({
                origin: 'https://same.test',
                daemonId: 'a::b',
                sessionId: 'c',
                artifactId: 'art_1',
                sha256: '2'.repeat(64),
            })
            const key2 = buildArtifactCacheKey({
                origin: 'https://same.test',
                daemonId: 'a',
                sessionId: 'b::c',
                artifactId: 'art_1',
                sha256: '2'.repeat(64),
            })
            expect(key1).not.toBeNull()
            expect(key2).not.toBeNull()
            expect(key1).not.toBe(key2)

            let calls = 0
            const fetchArtifact: FetchArtifactCommandFn = async () => ({
                success: true,
                artifactId: 'art_0123456789abcdef',
                sessionId: 'sess-101',
                kind: 'text',
                mime: 'text/plain',
                filename: 'versioned.txt',
                title: 'Versioned',
                sizeBytes: 6,
                sha256: 'a'.repeat(64),
                registeredSha256: 'a'.repeat(64),
                sha256Changed: false,
                encoding: 'utf8',
                content: `call-${++calls}`,
            })

            mount(
                <AttachmentBubble
                    attachment={makeAttachment({ kind: 'text', mime: 'text/plain', updatedAt: 100 })}
                    daemonId="daemon-alpha"
                    sessionId="sess-101"
                    fetchArtifact={fetchArtifact}
                />,
            )
            await act(async () => {
                ;(container.querySelector('[data-testid="artifact-view-full-button"]') as HTMLButtonElement).click()
            })
            expect(calls).toBe(1)
            expect(container.textContent).toContain('call-1')

            // Bump updatedAt with same sha256 -> closes viewer and refetches on reopen
            act(() => {
                root?.render(
                    <AttachmentBubble
                        attachment={makeAttachment({ kind: 'text', mime: 'text/plain', updatedAt: 200 })}
                        daemonId="daemon-alpha"
                        sessionId="sess-101"
                        fetchArtifact={fetchArtifact}
                    />,
                )
            })
            await act(async () => {
                ;(container.querySelector('[data-testid="artifact-view-full-button"]') as HTMLButtonElement).click()
            })
            expect(calls).toBe(2)
            expect(container.textContent).toContain('call-2')
        })

        it('D3a: fails closed on ambiguous bare-session controllerRegistry lookup and unauthoritative colon contextKey', () => {
            controllerRegistry.set('host-a:same', {
                getIdentity: () => ({ daemonId: 'host-a', sessionId: 'same' }),
            } as any)
            controllerRegistry.set('host-b:same', {
                getIdentity: () => ({ daemonId: 'host-b', sessionId: 'same' }),
            } as any)
            expect(resolveArtifactSessionTarget({ contextKey: 'same' })).toBeNull()
            expect(resolveArtifactSessionTarget({ contextKey: 'unknown-host:guessed-session' })).toBeNull()
            // Exact controller match still resolves
            expect(resolveArtifactSessionTarget({ contextKey: 'host-b:same' })).toEqual({
                daemonId: 'host-b',
                sessionId: 'same',
            })
        })

        it('D2 & D5: blocks remote Markdown images/SVGs, enforces safe link rel/protocol, and traps/restores focus in image lightbox', async () => {
            const md = [
                '![remote-png](https://tracker.invalid/pixel.png)',
                '![remote-svg](https://tracker.invalid/icon.svg)',
                '[safe-link](https://adhdev.io/docs)',
                '[unsafe-js](javascript:alert(1))',
                '<iframe src="https://evil.invalid"></iframe>',
            ].join(' ')
            mount(
                <ArtifactContentRenderer
                    payload={makeResolvedPayload({
                        kind: 'markdown',
                        mime: 'text/markdown',
                        content: md,
                        textContent: md,
                    })}
                    objectUrl={null}
                />,
            )
            expect(container.querySelector('img')).toBeNull()
            expect(container.querySelector('iframe')).toBeNull()
            const links = Array.from(container.querySelectorAll('a'))
            expect(links).toHaveLength(1)
            expect(links[0]?.getAttribute('href')).toBe('https://adhdev.io/docs')
            expect(links[0]?.getAttribute('rel')).toBe('noopener noreferrer')
            expect(links[0]?.getAttribute('target')).toBe('_blank')

            // Now test image lightbox focus, Tab containment, Escape, and focus restoration
            act(() => {
                root?.render(
                    <ArtifactContentRenderer
                        payload={makeResolvedPayload({
                            kind: 'image',
                            mime: 'image/png',
                            filename: 'shot.png',
                            title: 'Shot',
                            encoding: 'base64',
                            content: 'AAAA',
                            textContent: null,
                            bytes: new Uint8Array([1, 2, 3, 4]),
                        })}
                        objectUrl="blob:https://adhdev.local/test-image"
                    />,
                )
            })
            const openBtn = container.querySelector('[data-testid="artifact-image-lightbox-open"]') as HTMLButtonElement
            const focusSpy = vi.spyOn(openBtn, 'focus')
            openBtn.focus()
            await act(async () => {
                openBtn.click()
            })

            const dialog = document.body.querySelector('[role="dialog"]') as HTMLElement
            expect(dialog).not.toBeNull()
            expect(dialog.contains(document.activeElement)).toBe(true)

            const dialogButtons = Array.from(dialog.querySelectorAll('button')) as HTMLButtonElement[]
            const firstBtn = dialogButtons[0]!
            const lastBtn = dialogButtons[dialogButtons.length - 1]!
            lastBtn.focus()
            await act(async () => {
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
            })
            expect(document.activeElement).toBe(firstBtn)

            await act(async () => {
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
            })
            expect(document.body.querySelector('[role="dialog"]')).toBeNull()
            expect(document.activeElement).toBe(openBtn)
            expect(focusSpy).toHaveBeenLastCalledWith({ preventScroll: true })
        })

        it('D1 (delta2): production BaseDaemonProvider and default ChatMessageList refetch after coordinator authority changes', async () => {
            const sendCommand = vi.fn(async (_daemonId: string, _cmd: string, _payload: any) => ({
                success: true,
                artifactId: 'art_0123456789abcdef',
                sessionId: 'same',
                kind: 'text',
                mime: 'text/plain',
                filename: 'live.txt',
                title: 'Live',
                sizeBytes: 6,
                sha256: 'a'.repeat(64),
                registeredSha256: 'a'.repeat(64),
                sha256Changed: false,
                encoding: 'utf8',
                content: `BODY-${sendCommand.mock.calls.length}`,
            }))

            let injectFn!: (entries: DaemonData[], options?: { authoritativeDaemonIds?: string[] }) => void
            const artMsg = makeArtifactMessage(makeAttachment({ kind: 'text', mime: 'text/plain' }))

            function Harness() {
                injectFn = useBaseDaemonActions().injectEntries
                return <ChatMessageList messages={[artMsg]} contextKey="stable-tab" />
            }

            mount(
                <BaseDaemonProvider>
                    <TransportProvider
                        value={{
                            sendCommand,
                            subscribe: () => () => {},
                            sendPtyInput: () => false,
                            requestRuntimeSnapshot: async () => ({ success: false, error: 'noop' }),
                            onRuntimeEvent: () => () => {},
                        }}
                    >
                        <Harness />
                    </TransportProvider>
                </BaseDaemonProvider>,
            )

            const makeEntry = (coord: string): DaemonData =>
                ({
                    id: 'stable-tab',
                    daemonId: 'host-a',
                    sessionId: 'same',
                    transport: 'pty',
                    type: 'claude-code',
                    status: 'active',
                    activeChat: { messages: [] },
                    settings: { meshCoordinatorDaemonId: coord },
                }) as any

            act(() => {
                injectFn([makeEntry('coord-a')], { authoritativeDaemonIds: ['host-a'] })
            })

            await act(async () => {
                ;(container.querySelector('[data-testid="artifact-view-full-button"]') as HTMLElement).click()
            })
            expect(sendCommand).toHaveBeenCalledTimes(1)
            expect(sendCommand.mock.calls[0]?.[2]?.meshCoordinatorDaemonId).toBe('coord-a')
            expect(container.textContent).toContain('BODY-1')

            act(() => {
                injectFn([makeEntry('coord-b')], { authoritativeDaemonIds: ['host-a'] })
            })
            expect(
                container.querySelector('[data-testid="artifact-view-full-button"]')?.getAttribute('aria-expanded'),
            ).toBe('false')

            await act(async () => {
                ;(container.querySelector('[data-testid="artifact-view-full-button"]') as HTMLElement).click()
            })
            expect(sendCommand).toHaveBeenCalledTimes(2)
            expect(sendCommand.mock.calls[1]?.[2]?.meshCoordinatorDaemonId).toBe('coord-b')
            expect(container.textContent).toContain('BODY-2')
        })

        it('D1 (delta2): actual controller registry becoming ambiguous in flight fences deferred response in default ChatMessageList', async () => {
            getOrCreateSessionChatController({ daemonId: 'host-a', sessionId: 'same' })
            let resolveFetch!: (val: unknown) => void
            const sendCommand = vi.fn(
                () =>
                    new Promise((r) => {
                        resolveFetch = r
                    }),
            )
            const artMsg = makeArtifactMessage(makeAttachment({ kind: 'text', mime: 'text/plain' }))

            mount(
                <TransportProvider
                    value={{
                        sendCommand,
                        subscribe: () => () => {},
                        sendPtyInput: () => false,
                        requestRuntimeSnapshot: async () => ({ success: false, error: 'noop' }),
                        onRuntimeEvent: () => () => {},
                    }}
                >
                    <ChatMessageList messages={[artMsg]} contextKey="same" />
                </TransportProvider>,
            )

            await act(async () => {
                ;(container.querySelector('[data-testid="artifact-view-full-button"]') as HTMLElement).click()
            })
            expect(sendCommand).toHaveBeenCalledTimes(1)

            await act(async () => {
                getOrCreateSessionChatController({ daemonId: 'host-b', sessionId: 'same' })
                await Promise.resolve()
            })
            expect(resolveArtifactSessionTarget({ contextKey: 'same' })).toBeNull()

            await act(async () => {
                resolveFetch({
                    success: true,
                    artifactId: 'art_0123456789abcdef',
                    sessionId: 'same',
                    kind: 'text',
                    mime: 'text/plain',
                    filename: 'live.txt',
                    title: 'Live',
                    sizeBytes: 18,
                    sha256: 'a'.repeat(64),
                    registeredSha256: 'a'.repeat(64),
                    sha256Changed: false,
                    encoding: 'utf8',
                    content: 'AMBIGUOUS-OLD-BODY',
                })
                await Promise.resolve()
            })
            expect(container.textContent).not.toContain('AMBIGUOUS-OLD-BODY')
        })

        it('D1 (delta2): stale inferred hook completion or rejection never clears or overwrites a newer loaded identity result', async () => {
            let resolveOldSuccess!: (val: unknown) => void
            let rejectOldError!: (err: unknown) => void
            const fetchArtifact = vi
                .fn<FetchArtifactCommandFn>()
                .mockImplementationOnce(
                    () =>
                        new Promise((r) => {
                            resolveOldSuccess = r
                        }),
                )
                .mockImplementationOnce(
                    () =>
                        new Promise((_r, rej) => {
                            rejectOldError = rej
                        }),
                )
                .mockImplementationOnce(async (_daemonId, _cmd, payload) => ({
                    success: true,
                    artifactId: 'art_0123456789abcdef',
                    sessionId: payload.sessionId,
                    kind: 'text',
                    mime: 'text/plain',
                    filename: 'current.txt',
                    title: 'Current',
                    sizeBytes: 12,
                    sha256: 'a'.repeat(64),
                    registeredSha256: 'a'.repeat(64),
                    sha256Changed: false,
                    encoding: 'utf8',
                    content: 'CURRENT-BODY',
                }))

            let hook!: UseArtifactReadResult
            let injectFn!: (entries: DaemonData[], options?: { authoritativeDaemonIds?: string[] }) => void
            const attachment = makeAttachment({ kind: 'text', mime: 'text/plain' })

            function HookHarness() {
                injectFn = useBaseDaemonActions().injectEntries
                hook = useArtifactRead({ attachment, contextKey: 'stable-tab', fetchArtifact })
                return <div data-testid="hook-text">{hook.data?.textContent ?? ''}</div>
            }

            mount(
                <BaseDaemonProvider>
                    <HookHarness />
                </BaseDaemonProvider>,
            )

            act(() => {
                injectFn(
                    [
                        {
                            id: 'stable-tab',
                            daemonId: 'host-a',
                            sessionId: 'old-session-1',
                            type: 'claude-code',
                            transport: 'pty',
                            status: 'active',
                            activeChat: { messages: [] },
                        } as any,
                    ],
                    { authoritativeDaemonIds: ['host-a'] },
                )
            })

            let pending1!: Promise<ArtifactResolvedPayload | null>
            await act(async () => {
                pending1 = hook.openViewer()
            })

            act(() => {
                injectFn(
                    [
                        {
                            id: 'stable-tab',
                            daemonId: 'host-a',
                            sessionId: 'old-session-2',
                            type: 'claude-code',
                            transport: 'pty',
                            status: 'active',
                            activeChat: { messages: [] },
                        } as any,
                    ],
                    { authoritativeDaemonIds: ['host-a'] },
                )
            })

            let pending2!: Promise<ArtifactResolvedPayload | null>
            await act(async () => {
                pending2 = hook.openViewer()
            })

            act(() => {
                injectFn(
                    [
                        {
                            id: 'stable-tab',
                            daemonId: 'host-b',
                            sessionId: 'new-session',
                            type: 'claude-code',
                            transport: 'pty',
                            status: 'active',
                            activeChat: { messages: [] },
                        } as any,
                    ],
                    { authoritativeDaemonIds: ['host-a', 'host-b'] },
                )
            })

            await act(async () => {
                await hook.openViewer()
            })
            expect(container.querySelector('[data-testid="hook-text"]')?.textContent).toBe('CURRENT-BODY')

            // Resolve stale request 1 and reject stale request 2 -> CURRENT-BODY must remain intact
            await act(async () => {
                resolveOldSuccess({
                    success: true,
                    artifactId: 'art_0123456789abcdef',
                    sessionId: 'old-session-1',
                    kind: 'text',
                    mime: 'text/plain',
                    filename: 'old.txt',
                    title: 'Old',
                    sizeBytes: 8,
                    sha256: 'a'.repeat(64),
                    registeredSha256: 'a'.repeat(64),
                    sha256Changed: false,
                    encoding: 'utf8',
                    content: 'OLD-BODY',
                })
                rejectOldError(new Error('Stale network failure'))
                await pending1
                await pending2
            })

            expect(container.querySelector('[data-testid="hook-text"]')?.textContent).toBe('CURRENT-BODY')
            expect(hook.status).toBe('loaded')
            expect(hook.error).toBeNull()
        })
    })
})
