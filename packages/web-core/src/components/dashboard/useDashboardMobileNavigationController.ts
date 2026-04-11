import { useCallback } from 'react'
import type { DashboardMobileSection } from './DashboardMobileBottomNav'
import type { ActiveConversation } from './types'
import { getConversationMachineId } from './conversation-selectors'

type MobileChatScreen = 'inbox' | 'chat' | 'machine'

interface UseDashboardMobileNavigationControllerOptions {
    conversations: ActiveConversation[]
    selectedConversation: ActiveConversation | null
    machineBackTarget: 'inbox' | 'chat'
    markConversationRead: (conversation: ActiveConversation | null) => void
    resetMachineAction: () => void
    setSelectedTabKey: (value: string | null) => void
    setScreen: (value: MobileChatScreen) => void
    setSelectedMachineId: (value: string | null) => void
    setSection: (value: DashboardMobileSection) => void
    setMachineBackTarget: (value: 'inbox' | 'chat') => void
}

export function useDashboardMobileNavigationController({
    conversations,
    selectedConversation,
    machineBackTarget,
    markConversationRead,
    resetMachineAction,
    setSelectedTabKey,
    setScreen,
    setSelectedMachineId,
    setSection,
    setMachineBackTarget,
}: UseDashboardMobileNavigationControllerOptions) {
    const openConversation = useCallback((conversation: ActiveConversation) => {
        setSelectedTabKey(conversation.tabKey)
        setScreen('chat')
        markConversationRead(conversation)
    }, [markConversationRead, setScreen, setSelectedTabKey])

    const openNativeConversation = useCallback((conversation: ActiveConversation) => {
        const nativeConversation = conversations.find(candidate => (
            candidate.routeId === conversation.routeId
            && candidate.streamSource === 'native'
        ))
        if (!nativeConversation) return
        setSelectedTabKey(nativeConversation.tabKey)
        setScreen('chat')
        markConversationRead(nativeConversation)
    }, [conversations, markConversationRead, setScreen, setSelectedTabKey])

    const backFromConversation = useCallback(() => {
        markConversationRead(selectedConversation)
        setScreen('inbox')
    }, [markConversationRead, selectedConversation, setScreen])

    const openMachine = useCallback((machineId: string, backTarget: 'inbox' | 'chat' = 'inbox') => {
        setSelectedMachineId(machineId)
        resetMachineAction()
        setSection('machines')
        setMachineBackTarget(backTarget)
        setScreen('machine')
    }, [resetMachineAction, setMachineBackTarget, setScreen, setSection, setSelectedMachineId])

    const openConversationMachine = useCallback((conversation: ActiveConversation) => {
        const machineId = getConversationMachineId(conversation)
        if (!machineId) return
        openMachine(machineId, 'chat')
    }, [openMachine])

    const backFromMachine = useCallback(() => {
        resetMachineAction()
        setScreen(machineBackTarget)
    }, [machineBackTarget, resetMachineAction, setScreen])

    const changeMachineSection = useCallback((nextSection: DashboardMobileSection) => {
        setSection(nextSection)
        setScreen('inbox')
    }, [setScreen, setSection])

    return {
        openConversation,
        openNativeConversation,
        backFromConversation,
        openMachine,
        openConversationMachine,
        backFromMachine,
        changeMachineSection,
    }
}
