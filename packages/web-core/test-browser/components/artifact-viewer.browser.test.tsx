import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { MemoryRouter } from 'react-router-dom'
import '../../src/index.css'
import { initI18n, whenI18nReady } from '../../src/i18n/config'
import { TransportProvider } from '../../src/context/TransportContext'
import DashboardMobileChatInbox from '../../src/components/dashboard/DashboardMobileChatInbox'
import { getConversationLastMessagePreview } from '../../src/components/dashboard/conversation-selectors'
import type { MobileConversationListItem } from '../../src/components/dashboard/DashboardMobileChatShared'
import ChatMessageList from '../../src/components/ChatMessageList'
import { clearArtifactReadCache } from '../../src/hooks/useArtifactRead'
import type { ChatAttachmentMeta, ChatMessage } from '../../src/types'
import type { ActiveConversation } from '../../src/components/dashboard/types'

// 1x1 teal PNG in base64
const SAMPLE_PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const EVIDENCE_DIR = '/tmp/adhdev-rc24-artifact-evidence/task-d-delta'

function rect(element: Element) {
    const { x, y, width, height, right, bottom } = element.getBoundingClientRect()
    return { x, y, width, height, right, bottom }
}

const ARTIFACT_ATTACHMENTS: Record<string, ChatAttachmentMeta> = {
    markdown: {
        artifactId: 'art_md00000000000001',
        kind: 'markdown',
        mime: 'text/markdown',
        filename: 'architecture-plan.md',
        title: 'Architecture Plan',
        sizeBytes: 1840,
        sha256: '1'.repeat(64),
        previewText: '# Architecture Plan\n\n- Keyed transcript projection\n- Lazy on-demand artifact_fetch',
        createdAt: 1_700_000_001_000,
        updatedAt: 1_700_000_001_000,
    },
    diff: {
        artifactId: 'art_df00000000000002',
        kind: 'diff',
        mime: 'text/x-diff',
        filename: 'transport.diff',
        title: 'Transport Patch',
        sizeBytes: 620,
        sha256: '2'.repeat(64),
        previewText: '@@ -12,4 +12,5 @@\n-const legacy = true;\n+const lazyFetch = true;',
        createdAt: 1_700_000_002_000,
        updatedAt: 1_700_000_002_000,
    },
    json: {
        artifactId: 'art_js00000000000003',
        kind: 'json',
        mime: 'application/json',
        filename: 'verification.json',
        title: 'Verification Report',
        sizeBytes: 312,
        sha256: '3'.repeat(64),
        previewText: '{"status":"verified","boundaries":3}',
        createdAt: 1_700_000_003_000,
        updatedAt: 1_700_000_003_000,
    },
    text: {
        artifactId: 'art_tx00000000000004',
        kind: 'text',
        mime: 'text/plain',
        filename: 'worker-summary.txt',
        title: 'Worker Summary Log',
        sizeBytes: 410,
        sha256: '4'.repeat(64),
        previewText: '[05:30:00] Worker task D ready\n[05:30:02] Zero network fetch on initial render',
        createdAt: 1_700_000_004_000,
        updatedAt: 1_700_000_004_000,
    },
    image: {
        artifactId: 'art_im00000000000005',
        kind: 'image',
        mime: 'image/png',
        filename: 'mobile-preview.png',
        title: 'Mobile Layout Capture',
        sizeBytes: 68,
        sha256: '5'.repeat(64),
        createdAt: 1_700_000_005_000,
        updatedAt: 1_700_000_005_000,
    },
}

const FULL_BODIES: Record<string, { encoding: 'utf8' | 'base64'; content: string; sha256Changed?: boolean }> = {
    art_md00000000000001: {
        encoding: 'utf8',
        content: [
            '# Architecture Plan (Full)',
            '',
            '1. **Zero Auto-Fetch**: Chat & inbox render only `ChatAttachmentMeta`.',
            '2. **Collision-Proof Cache**: `JSON.stringify([origin, daemonId, sessionId, artifactId, sha256, updatedAt])`.',
            '3. **Safe Links & Blocked Remote Media**: [Architecture RFC](https://adhdev.io/rfc) ![beacon](https://tracker.invalid/private.png) ![svg](https://tracker.invalid/vector.svg)',
            '',
            '```ts',
            'const key = buildArtifactCacheKey(scope);',
            '```',
        ].join('\n'),
    },
    art_df00000000000002: {
        encoding: 'utf8',
        content: [
            'diff --git a/src/chat.ts b/src/chat.ts',
            '--- a/src/chat.ts',
            '+++ b/src/chat.ts',
            '@@ -12,4 +12,5 @@',
            ' const maxPreview = 600;',
            '-const autoFetch = true;',
            '+const autoFetch = false;',
            '+const lazyViewer = true;',
        ].join('\n'),
    },
    art_js00000000000003: {
        encoding: 'utf8',
        content: JSON.stringify({
            status: 'verified',
            boundariesPassed: 3,
            formats: ['markdown', 'diff', 'json', 'text', 'image'],
        }),
    },
    art_tx00000000000004: {
        encoding: 'utf8',
        sha256Changed: true,
        content: '[05:30:00] Worker task D ready\n[05:30:02] Zero network fetch on initial render\n[05:31:00] Full log loaded on demand',
    },
    art_im00000000000005: {
        encoding: 'base64',
        content: SAMPLE_PNG_BASE64,
    },
}

function toArtifactMessage(att: ChatAttachmentMeta): ChatMessage {
    return {
        role: 'system',
        kind: 'artifact',
        messageId: `artifact:${att.artifactId}`,
        content: att.title,
        attachment: att,
        receivedAt: att.updatedAt,
    }
}

it('renders mobile inbox tail (📎 <title>), collapsed previews with zero fetch, and all 5 expanded renderers at 390x844 and 1280x844', async () => {
    clearArtifactReadCache()
    localStorage.setItem('lang', 'ko')
    initI18n()
    await whenI18nReady()
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

    const sendCommand = vi.fn(async (daemonId: string, command: string, payload: any) => {
        if (command !== 'artifact_fetch') {
            throw new Error(`Unexpected command: ${command}`)
        }
        const art = Object.values(ARTIFACT_ATTACHMENTS).find((a) => a.artifactId === payload.artifactId)
        const body = FULL_BODIES[payload.artifactId]
        if (!art || !body) {
            return { success: false, error: 'artifact_not_found', message: 'Not found' }
        }
        return {
            success: true,
             daemonId,
            artifactId: art.artifactId,
            sessionId: payload.sessionId,
            kind: art.kind,
            mime: art.mime,
            filename: art.filename,
            title: art.title,
            sizeBytes: art.sizeBytes,
            sha256: body.sha256Changed ? '9'.repeat(64) : art.sha256,
            registeredSha256: art.sha256,
            sha256Changed: Boolean(body.sha256Changed),
            encoding: body.encoding,
            content: body.content,
        }
    })

    const messages: ChatMessage[] = [
        { role: 'user', content: '산출물 5종을 등록해 주세요.', receivedAt: 1_700_000_000_000 },
        toArtifactMessage(ARTIFACT_ATTACHMENTS.markdown),
        toArtifactMessage(ARTIFACT_ATTACHMENTS.diff),
        toArtifactMessage(ARTIFACT_ATTACHMENTS.json),
        toArtifactMessage(ARTIFACT_ATTACHMENTS.text),
        toArtifactMessage(ARTIFACT_ATTACHMENTS.image),
    ]

    const conversation: ActiveConversation = {
        key: 'daemon-local:sess-ui-1',
        routeId: 'daemon-local',
        daemonId: 'daemon-local',
        sessionId: 'sess-ui-1',
        tabKey: 'daemon-local:sess-ui-1',
        transport: 'pty',
        mode: 'chat',
        agentName: 'Claude',
        agentType: 'claude-code',
        status: 'active',
        title: 'Artifact Viewer Demo',
        displayPrimary: 'Artifact Viewer Demo',
        displaySecondary: 'Claude Code',
        workspaceName: 'feat-artifact-viewer-ui',
        machineName: 'MacBook-Pro',
        connectionState: 'connected',
        messages,
    } as any

    const inboxItem: MobileConversationListItem = {
        conversation,
        timestamp: 1_700_000_005_000,
        preview: getConversationLastMessagePreview(conversation),
        unread: true,
        requiresAction: false,
        isWorking: true,
        inboxBucket: 'working',
    }

    const host = document.createElement('div')
    host.style.cssText = 'height:100dvh;width:100%;display:flex;flex-direction:column;background:#0b0f17;color:#f8fafc;overflow:hidden'
    document.body.append(host)
    const root = createRoot(host)

    try {
        // 1. Mobile 390x844 Inbox tail preview (`📎 Mobile Layout Capture`) with ZERO network fetch
        await page.viewport(390, 844)
        await act(async () => {
            root.render(
                <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
                    <TransportProvider value={{ sendCommand }}>
                        <DashboardMobileChatInbox
                            section="chats"
                            attentionItems={[]}
                            unreadItems={[]}
                            workingItems={[inboxItem]}
                            completedItems={[]}
                            hiddenConversations={[]}
                            machineCards={[]}
                            getAvatarText={(text) => text[0] || 'A'}
                            actionLogs={[]}
                            sendDaemonCommand={sendCommand as any}
                            onOpenConversation={vi.fn()}
                            onShowAllHidden={vi.fn()}
                            onOpenMachine={vi.fn()}
                            onOpenSettings={vi.fn()}
                            onSectionChange={vi.fn()}
                            wsStatus="connected"
                            isStandalone={true}
                        />
                    </TransportProvider>
                </MemoryRouter>,
            )
        })

        expect(sendCommand).toHaveBeenCalledTimes(0)
        expect(host.textContent).toContain('📎 Mobile Layout Capture')
        await act(async () => {
            await page.screenshot({ path: `${EVIDENCE_DIR}/mobile-390x844-inbox-tail.png` })
        })

        // 2. Mobile 390x844 ChatMessageList with all 5 collapsed AttachmentBubbles and ZERO network fetch
        await act(async () => {
            root.render(
                <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
                    <TransportProvider value={{ sendCommand }}>
                        <div style={{ width: '390px', height: '844px', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                            <ChatMessageList
                                messages={messages}
                                contextKey="daemon-local:sess-ui-1"
                                daemonId="daemon-local"
                                sessionId="sess-ui-1"
                                agentName="Claude"
                                userName="Owner"
                            />
                        </div>
                    </TransportProvider>
                </MemoryRouter>,
            )
        })

        expect(sendCommand).toHaveBeenCalledTimes(0)
        const bubbles = [...host.querySelectorAll('[data-testid="attachment-bubble"]')]
        expect(bubbles).toHaveLength(5)
        for (const bubble of bubbles) {
            const box = rect(bubble)
            expect(box.x).toBeGreaterThanOrEqual(0)
            expect(box.right).toBeLessThanOrEqual(390)
        }
        await act(async () => {
            await page.screenshot({ path: `${EVIDENCE_DIR}/mobile-390x844-collapsed-preview.png` })
        })

        // 3. Click [전체 보기] on all 5 bubbles -> lazy fetch via TransportProvider sendCommand
        const viewButtons = [...host.querySelectorAll('[data-testid="artifact-view-full-button"]')] as HTMLButtonElement[]
        expect(viewButtons).toHaveLength(5)
        for (const btn of viewButtons) {
            await act(async () => {
                btn.click()
            })
        }

        expect(sendCommand).toHaveBeenCalledTimes(5)
        const mdRenderer = host.querySelector('[data-artifact-renderer="markdown"]')
        expect(mdRenderer).not.toBeNull()
        // D2: Verify zero remote <img> elements inside markdown renderer and safe external link rel
        expect(mdRenderer?.querySelector('img')).toBeNull()
        expect(mdRenderer?.querySelector('[data-testid="artifact-markdown-blocked-image"]')).not.toBeNull()
        const mdLink = mdRenderer?.querySelector('a')
        expect(mdLink?.getAttribute('href')).toBe('https://adhdev.io/rfc')
        expect(mdLink?.getAttribute('rel')).toBe('noopener noreferrer')
        expect(mdLink?.getAttribute('target')).toBe('_blank')
        expect(host.querySelector('[data-artifact-renderer="diff"]')).not.toBeNull()
        expect(host.querySelector('[data-artifact-renderer="json"]')).not.toBeNull()
        expect(host.querySelector('[data-artifact-renderer="text"]')).not.toBeNull()
        expect(host.querySelector('[data-artifact-renderer="image"]')).not.toBeNull()
        expect(host.querySelector('[data-testid="artifact-hash-changed-warning"]')).not.toBeNull()

        // Verify zero horizontal overflow outside 390px viewport on expanded bubbles
        for (const bubble of host.querySelectorAll('[data-testid="attachment-bubble"]')) {
            const box = rect(bubble)
            expect(box.right).toBeLessThanOrEqual(390)
        }

        // Allow ResizeObserver auto-scroll to settle, then scroll top bubble (Markdown + Diff) into view
        await new Promise((r) => setTimeout(r, 50))
        const allBubbles = [...host.querySelectorAll('[data-testid="attachment-bubble"]')] as HTMLElement[]
        const scrollEl = host.querySelector('[data-chat-scroll]') as HTMLElement
        if (scrollEl) {
            scrollEl.scrollTop = 0
        }
        allBubbles[0]?.scrollIntoView({ block: 'start' })
        await act(async () => {
            await page.screenshot({ path: `${EVIDENCE_DIR}/mobile-390x844-expanded-top.png` })
        })

        if (scrollEl) {
            scrollEl.scrollTop = scrollEl.scrollHeight
        }
        allBubbles[allBubbles.length - 1]?.scrollIntoView({ block: 'end' })
        await act(async () => {
            await page.screenshot({ path: `${EVIDENCE_DIR}/mobile-390x844-expanded-bottom.png` })
        })

        // 4. Desktop 1280x844 layout verification & screenshot
        await page.viewport(1280, 844)
        await act(async () => {
            root.render(
                <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
                    <TransportProvider value={{ sendCommand }}>
                        <div style={{ width: '1280px', height: '844px', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                            <ChatMessageList
                                messages={messages}
                                contextKey="daemon-local:sess-ui-1"
                                daemonId="daemon-local"
                                sessionId="sess-ui-1"
                                agentName="Claude"
                                userName="Owner"
                            />
                        </div>
                    </TransportProvider>
                </MemoryRouter>,
            )
        })

        // Because the 5 payloads are already cached by origin+daemonId+sessionId+artifactId+sha256,
        // re-opening or keeping them open makes ZERO additional network calls!
        expect(sendCommand).toHaveBeenCalledTimes(5)
        await act(async () => {
            await page.screenshot({ path: `${EVIDENCE_DIR}/desktop-1280x844-expanded.png` })
        })

        // 5. D5: Real browser keyboard accessibility for image lightbox modal (initial focus, Tab wrap, Escape close, focus restore)
        const openLightboxBtn = host.querySelector('[data-testid="artifact-image-lightbox-open"]') as HTMLButtonElement
        expect(openLightboxBtn).not.toBeNull()
        openLightboxBtn.focus()
        await act(async () => {
            openLightboxBtn.click()
        })

        const dialog = document.querySelector('[role="dialog"]') as HTMLElement
        expect(dialog).not.toBeNull()
        expect(dialog.contains(document.activeElement)).toBe(true)
        await act(async () => {
            await page.screenshot({ path: `${EVIDENCE_DIR}/desktop-1280x844-lightbox.png` })
        })

        const dialogButtons = Array.from(dialog.querySelectorAll('button')) as HTMLButtonElement[]
        expect(dialogButtons.length).toBeGreaterThanOrEqual(4)
        const firstDialogBtn = dialogButtons[0]!
        const lastDialogBtn = dialogButtons[dialogButtons.length - 1]!
        lastDialogBtn.focus()
        await act(async () => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
        })
        expect(document.activeElement).toBe(firstDialogBtn)

        await act(async () => {
            document.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }),
            )
        })
        expect(document.activeElement).toBe(lastDialogBtn)

        await act(async () => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        })
        expect(document.querySelector('[role="dialog"]')).toBeNull()
        expect(document.activeElement).toBe(openLightboxBtn)
    } finally {
        await act(async () => {
            root.unmount()
        })
        host.remove()
    }
})
