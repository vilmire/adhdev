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

    expect(source).toContain("'Reconnecting'")
    expect(source).toContain("'Restoring the server connection…'")
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
    expect(inboxSource).toContain('title="Open live repo mesh graph"')
    expect(inboxSource).toContain('onOpenMeshGraph?: (conversation: ActiveConversation) => void')
    expect(roomSource).toContain('const meshGraphAvailable = !!selectedConversation.daemonId')
    expect(roomSource).toContain('title="Open live repo mesh graph"')
    expect(modeSource).toContain('onOpenMeshGraph={onOpenMeshGraph}')
    expect(mainViewSource).toContain('onOpenMeshGraph={handleOpenMeshGraph}')
  })

  it('keeps mobile hidden chats collapsed and makes row hide an explicit confirmed action under the left chat icon', () => {
    const inboxSource = readSource('components/dashboard/DashboardMobileChatInbox.tsx')
    const modeSource = readSource('components/dashboard/DashboardMobileChatMode.tsx')
    const mainViewSource = readSource('components/dashboard/DashboardMainView.tsx')

    expect(inboxSource).toContain('onHideConversation?: (conversation: ActiveConversation) => void')
    expect(inboxSource).toContain('mobile-inbox-leading-rail')
    expect(inboxSource).toContain('mobile-inbox-hide-button')
    expect(inboxSource).toContain('setHideConfirmConversation(item.conversation)')
    expect(inboxSource).toContain('HideConversationConfirmDialog')
    // Hide confirm dialog now matches the CliStopDialog style (title "Hide {name}?",
    // card fade-in mobile-compact-dialog, no top-right X, stacked full-width buttons).
    expect(inboxSource).toContain('Hide {title}?')
    expect(inboxSource).toContain('card fade-in mobile-compact-dialog')
    expect(inboxSource).toContain('max-h-[calc(100dvh-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px)-16px)] flex flex-col')
    expect(inboxSource).toContain('onHideConversation?.(hideConfirmConversation)')
    expect(inboxSource).not.toContain('onHideConversation(item.conversation)')
    expect(inboxSource).not.toContain('className="flex justify-end px-4 pb-3 -mt-1"')
    expect(inboxSource).toContain('Hidden tabs')
    expect(inboxSource).toContain('collapsed')
    expect(inboxSource).not.toContain('hiddenConversations.map((conversation')
    expect(inboxSource).not.toContain('Tap to restore and open')
    expect(modeSource).toContain('onHideConversation={onHideConversation}')
    expect(mainViewSource).toContain('onHideConversation={onHideConversation}')
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
