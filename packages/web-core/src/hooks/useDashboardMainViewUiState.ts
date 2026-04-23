import { useCallback, useEffect, useMemo, useState } from 'react'

export type DashboardMainViewGuideTabId = 'overview' | 'quickstart' | 'shortcuts'
export type DashboardMainViewShortcutSectionId = 'all' | 'workspace' | 'panes' | 'approvals'

interface UseDashboardMainViewUiStateOptions {
  isMobile: boolean
  showMobileChatMode: boolean
  visibleConversationCount: number
}

export function useDashboardMainViewUiState({
  isMobile,
  showMobileChatMode,
  visibleConversationCount,
}: UseDashboardMainViewUiStateOptions) {
  const [inboxOpen, setInboxOpen] = useState(false)
  const [hiddenOpen, setHiddenOpen] = useState(false)
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false)
  const [newSessionOpen, setNewSessionOpen] = useState(false)
  const [guideNudgeVisible, setGuideNudgeVisible] = useState(false)
  const [guideTab, setGuideTab] = useState<DashboardMainViewGuideTabId>('quickstart')
  const [shortcutSection, setShortcutSection] = useState<DashboardMainViewShortcutSectionId>('workspace')

  const isDesktopDashboard = useMemo(
    () => !showMobileChatMode && !isMobile,
    [showMobileChatMode, isMobile],
  )

  const handleInboxOpenChange = useCallback((next: boolean) => {
    setInboxOpen(next)
    if (next) setHiddenOpen(false)
  }, [])

  const handleHiddenOpenChange = useCallback((next: boolean) => {
    setHiddenOpen(next)
    if (next) setInboxOpen(false)
  }, [])

  const handleOpenShortcutHelp = useCallback(() => {
    setGuideTab(visibleConversationCount === 0 ? 'quickstart' : 'shortcuts')
    setShortcutSection('workspace')
    setShortcutHelpOpen(true)
    setInboxOpen(false)
    setHiddenOpen(false)
  }, [visibleConversationCount])

  const closeShortcutHelp = useCallback(() => {
    setShortcutHelpOpen(false)
  }, [])

  const openNewSession = useCallback(() => {
    setNewSessionOpen(true)
  }, [])

  const closeNewSession = useCallback(() => {
    setNewSessionOpen(false)
  }, [])

  useEffect(() => {
    if (!isDesktopDashboard) {
      setGuideNudgeVisible(false)
      return
    }
    setGuideNudgeVisible(true)
    const timer = window.setTimeout(() => {
      setGuideNudgeVisible(false)
    }, 10000)
    return () => window.clearTimeout(timer)
  }, [isDesktopDashboard])

  return {
    inboxOpen,
    hiddenOpen,
    shortcutHelpOpen,
    newSessionOpen,
    guideNudgeVisible,
    guideTab,
    shortcutSection,
    isDesktopDashboard,
    setGuideTab,
    setShortcutSection,
    handleInboxOpenChange,
    handleHiddenOpenChange,
    handleOpenShortcutHelp,
    closeShortcutHelp,
    openNewSession,
    closeNewSession,
  }
}
