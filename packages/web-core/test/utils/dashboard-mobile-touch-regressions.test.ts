import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const readSource = (relativePath: string) => fs.readFileSync(path.join(import.meta.dirname, '../../src', relativePath), 'utf8')

describe('dashboard mobile/touch regressions', () => {
  it('does not force the document back to the top when the chat input blurs', () => {
    const source = readSource('components/dashboard/ChatInputBar.tsx')

    expect(source).not.toContain('document.documentElement.scrollTop = 0')
    expect(source).not.toContain('window.scrollTo(0, 0)')
  })

  it('keeps mobile chat header metadata on one non-truncated scroll row', () => {
    const css = readSource('index.css')
    const roomSource = readSource('components/dashboard/DashboardMobileChatRoom.tsx')

    expect(roomSource).toContain('className="min-w-0 flex-1 flex flex-col gap-0.5"')
    expect(roomSource).toContain('className="min-w-0 max-w-full text-xs text-text-secondary"')
    expect(css).toContain('.conversation-meta-chips.is-mobile-header {')
    expect(css).toContain('overflow-x: auto;')
    expect(css).toContain('-webkit-overflow-scrolling: touch;')
    expect(css).toContain('.conversation-meta-chips.is-mobile-header::-webkit-scrollbar')
    expect(css).toContain('.conversation-meta-chips.is-mobile-header .conversation-meta-chip span {')
    expect(css).toContain('overflow: visible;')
    expect(css).toContain('text-overflow: clip;')
  })

  it('keeps mobile inbox reconnect empty-state copy compact and single-owned', () => {
    const source = readSource('components/dashboard/DashboardMobileChatInbox.tsx')

    expect(source).toContain("t('mobileInbox.reconnecting')")
    expect(source).toContain("t('mobileInbox.restoringConnection')")
    expect(source).not.toContain('Connecting to server')
    expect(source).not.toContain('Establishing connection to the server')
    expect(source).not.toContain('MobileSpinner label=')
  })

  it('does not render the top-right timestamp when the Done chip owns that corner', () => {
    const source = readSource('components/dashboard/DashboardMobileChatInbox.tsx')

    expect(source).toContain('const shouldShowTimestamp = !isWorking && !isTaskComplete')
    // Timestamp now lives in the top-right corner-actions cluster (left of the
    // Mute/Hide/Stop icons) so it never sits under them.
    expect(source).toContain('{shouldShowTimestamp && (')
    expect(source).toContain('mobile-inbox-corner-actions')
  })

  it('supports copying a chat debug bundle directly from mobile inbox rows', () => {
    const inboxSource = readSource('components/dashboard/DashboardMobileChatInbox.tsx')
    const modeSource = readSource('components/dashboard/DashboardMobileChatMode.tsx')

    expect(inboxSource).toContain('handleConversationContextMenu')
    expect(inboxSource).toContain('onCollectChatDebugBundle?.(item.conversation)')
    expect(inboxSource).toContain("type MobileInboxDebugBundleCollector = (conversation: ActiveConversation) => void | Promise<void>")
    expect(inboxSource).toContain('buildChatFrontendDebugSnapshot')
    expect(inboxSource).toContain("sendDaemonCommand(routeTarget, 'get_chat_debug_bundle'")
    expect(inboxSource).toContain('const result = unwrapCommandResult(raw)')
    expect(inboxSource).toContain('buildChatDebugBundleClipboardText(result)')
    expect(inboxSource).toContain('buildChatDebugBundleToastMessage(result')
    expect(modeSource).toContain('actionLogs={actionLogs}')
    expect(modeSource).toContain('sendDaemonCommand={sendDaemonCommand}')
  })

  it('does not expose a redundant hide/close action in the mobile chat room header', () => {
    const roomSource = readSource('components/dashboard/DashboardMobileChatRoom.tsx')

    expect(roomSource).not.toContain('onHideConversation')
    expect(roomSource).not.toContain('title="Close chat"')
  })

  it('keeps mesh graph access available from both the mobile chat header and inbox rows', () => {
    const inboxSource = readSource('components/dashboard/DashboardMobileChatInbox.tsx')
    const roomSource = readSource('components/dashboard/DashboardMobileChatRoom.tsx')
    const modeSource = readSource('components/dashboard/DashboardMobileChatMode.tsx')
    const mainViewSource = readSource('components/dashboard/DashboardMainView.tsx')

    expect(inboxSource).toContain('mobile-inbox-mesh-button')
    expect(inboxSource).toContain("title={t('mobileInbox.openLiveMeshGraph')}")
    expect(inboxSource).toContain('onOpenMeshGraph?: (conversation: ActiveConversation) => void')
    // The room header shows the coordinator's dedicated Mesh graph button
    // (owner decision 2026-09-27) next to the shared "…" menu, which holds the
    // remaining secondary actions (history, remote, mute, info).
    expect(roomSource).toContain('<ConversationActionsMenu')
    expect(roomSource).toContain('<ConversationMeshGraphButton')
    expect(roomSource).toContain('<MeshRoleIcon conversation={selectedConversation}')
    expect(roomSource).toContain('onOpenMeshGraph={onOpenMeshGraph}')
    expect(modeSource).toContain('onOpenMeshGraph={onOpenMeshGraph}')
    expect(mainViewSource).toContain('onOpenMeshGraph={handleOpenMeshGraph}')
  })

  it('keeps mobile hidden chats collapsed and makes row hide immediate with an Undo toast (no confirm dialog)', () => {
    const inboxSource = readSource('components/dashboard/DashboardMobileChatInbox.tsx')
    const modeSource = readSource('components/dashboard/DashboardMobileChatMode.tsx')
    const mainViewSource = readSource('components/dashboard/DashboardMainView.tsx')

    expect(inboxSource).toContain('onHideConversation?: (conversation: ActiveConversation) => void')
    expect(inboxSource).toContain('mobile-inbox-leading-rail')
    expect(inboxSource).toContain('mobile-inbox-hide-button')
    expect(inboxSource).toContain('hideConversationWithUndo(item.conversation)')
    expect(inboxSource).not.toContain('HideConversationConfirmDialog')
    expect(inboxSource).toContain("t('mobileInbox.undo')")
    expect(inboxSource).toContain("t('mobileInbox.collapsedCount', { count: hiddenConversations.length })")
    expect(inboxSource).not.toContain('hiddenConversations.map((conversation')
    expect(inboxSource).not.toContain('Tap to restore and open')
    expect(modeSource).toContain('onHideConversation={onHideConversation}')
    expect(modeSource).toContain('onShowHiddenConversation={onShowHiddenConversation}')
    expect(mainViewSource).toContain('onHideConversation={onHideConversation}')
    expect(mainViewSource).toContain('onShowHiddenConversation={handleShowHiddenConversationWithRestore}')
  })

  it('makes dashboard tab drag handles non-text-selectable on touch devices', () => {
    const css = readSource('index.css')

    expect(css).toContain('.adhdev-dockview .dv-tab,')
    expect(css).toContain('.adhdev-dockview-tab {')
    expect(css).toContain('-webkit-user-select: none;')
    expect(css).toContain('user-select: none;')
    expect(css).toContain('-webkit-touch-callout: none;')
    expect(css).toContain('touch-action: manipulation;')
  })
})
