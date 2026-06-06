import { useCallback, useMemo, useState } from 'react'

import { useBaseDaemons } from '../context/BaseDaemonContext'
import { useTransport } from '../context/TransportContext'
import {
  buildInteractivePromptResponse,
  findInteractivePromptSession,
  type InteractivePromptSelection,
} from '../interactive-prompt/interactive-prompt-utils'
import { submitInteractivePromptResponse } from '../interactive-prompt/interactive-prompt-transport'

export interface UseInteractivePromptResult {
  promptSession: ReturnType<typeof findInteractivePromptSession>
  responseError: string | null
  isSubmitting: boolean
  submit: (selection: InteractivePromptSelection) => Promise<void>
  cancel: () => void
}

export function useInteractivePrompt(sessionId?: string | null): UseInteractivePromptResult {
  const { ides, isP2PActive, p2pStates } = useBaseDaemons()
  const { sendCommand } = useTransport()
  const [dismissedPromptId, setDismissedPromptId] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [responseError, setResponseError] = useState<string | null>(null)

  const promptSession = useMemo(() => {
    const found = findInteractivePromptSession(ides, sessionId)
    if (!found) return null
    return found.prompt.promptId === dismissedPromptId ? null : found
  }, [dismissedPromptId, ides, sessionId])

  const submit = useCallback(async (selection: InteractivePromptSelection) => {
    if (!promptSession) return
      const response = buildInteractivePromptResponse(promptSession.prompt, selection)
    setIsSubmitting(true)
    setResponseError(null)
    try {
      const useP2PCommand = p2pStates?.[promptSession.daemonId] === 'connected' || isP2PActive === true
      await submitInteractivePromptResponse({
        promptSession,
        response,
        useP2PCommand,
        sendCommand,
      })
      setDismissedPromptId(promptSession.prompt.promptId)
    } catch (error) {
      setResponseError(error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      setIsSubmitting(false)
    }
  }, [isP2PActive, p2pStates, promptSession, sendCommand])

  const cancel = useCallback(() => {
    if (promptSession) setDismissedPromptId(promptSession.prompt.promptId)
  }, [promptSession])

  return {
    promptSession,
    responseError,
    isSubmitting,
    submit,
    cancel,
  }
}
