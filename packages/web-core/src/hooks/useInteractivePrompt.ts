import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

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
  hasActivePrompt: boolean
  responseError: string | null
  isSubmitting: boolean
  submit: (selection: InteractivePromptSelection) => Promise<void>
  cancel: () => void
  reopen: () => void
}

export function useInteractivePrompt(sessionId?: string | null): UseInteractivePromptResult {
  const { ides, isP2PActive, p2pStates } = useBaseDaemons()
  const { sendCommand } = useTransport()
  const [dismissedPromptId, setDismissedPromptId] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [responseError, setResponseError] = useState<string | null>(null)
  // Synchronous in-flight guard: `isSubmitting` is React state and only reaches the
  // modal on the next render, so two rapid clicks can both pass the state check before
  // it flips. This ref rejects re-entrant submits in the same tick — the most common
  // cause of an answered question staying "unresolved". See fix/interactive-question-submit-delay.
  const submitInFlightRef = useRef(false)

  const foundSession = useMemo(() => findInteractivePromptSession(ides, sessionId), [ides, sessionId])

  // hasActivePrompt is true even when dismissed — so callers can show a "reopen" button
  const hasActivePrompt = !!foundSession

  const promptSession = useMemo(() => {
    if (!foundSession) return null
    return foundSession.prompt.promptId === dismissedPromptId ? null : foundSession
  }, [dismissedPromptId, foundSession])

  // STALE-BANNER GUARD (live defect 2026-08-29): responseError previously
  // stayed set until the next submit() call or an explicit reopen(). A failed
  // submit on one AskUserQuestion — including a false-negative focus-guard
  // rejection that a near-immediate retry then resolved — could leave its
  // error banner showing over a LATER, unrelated question once the picker
  // moved on, since nothing cleared it in between. Clear it whenever the
  // held prompt's identity changes (a new question, or none) so an error can
  // only ever be attributed to the question currently on screen.
  const activePromptId = foundSession?.prompt.promptId ?? null
  useEffect(() => {
    setResponseError(null)
  }, [activePromptId])

  const submit = useCallback(async (selection: InteractivePromptSelection) => {
    if (!promptSession) return
    // Reject re-entrant submits synchronously (before any await / state settle).
    if (submitInFlightRef.current) return
    submitInFlightRef.current = true
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
      let msg = error instanceof Error ? error.message : String(error)
      if (msg.includes('Claude TUI review page is not focused')) {
        msg = '입력은 전달됐으나 확인에 실패했습니다 — 화면을 확인하거나 닫고 다시 시도하세요'
      }
      setResponseError(msg)
      throw error
    } finally {
      setIsSubmitting(false)
      submitInFlightRef.current = false
    }
  }, [isP2PActive, p2pStates, promptSession, sendCommand])

  const cancel = useCallback(() => {
    if (promptSession) setDismissedPromptId(promptSession.prompt.promptId)
  }, [promptSession])

  const reopen = useCallback(() => {
    setDismissedPromptId(null)
    setResponseError(null)
  }, [])

  return {
    promptSession,
    hasActivePrompt,
    responseError,
    isSubmitting,
    submit,
    cancel,
    reopen,
  }
}
