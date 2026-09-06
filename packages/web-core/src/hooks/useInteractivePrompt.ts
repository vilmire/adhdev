import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useTranslation } from 'react-i18next'
import {
  CLAUDE_TUI_REVIEW_PAGE_NOT_FOCUSED_PREFIX,
  CLAUDE_TUI_REVIEW_UNCONFIRMED_PREFIX,
} from '@adhdev/mesh-shared'

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

export interface UseInteractivePromptOptions {
  /** See `findInteractivePromptSession` — opt-in, for the coordinator answer path only. */
  includeHidden?: boolean
}

/**
 * Hold the interactive prompt a dashboard surface should render.
 *
 * Pass the SELECTED session's id. An unscoped call scans every session and
 * returns the first match in `ides` order — a status-report merge artifact — so
 * it can render a question belonging to a session the user is not looking at,
 * and which tab wins may change between refreshes.
 *
 * Hidden (`surfaceHidden`) sessions stay suppressed regardless of scope; see
 * the selector's contract for why that is a separate axis.
 */
export function useInteractivePrompt(
  sessionId?: string | null,
  options?: UseInteractivePromptOptions,
): UseInteractivePromptResult {
  const { t } = useTranslation('common')
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

  const includeHidden = options?.includeHidden === true
  const foundSession = useMemo(
    () => findInteractivePromptSession(ides, { sessionId, includeHidden }),
    [ides, sessionId, includeHidden],
  )

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
      // DELIVERED-BUT-UNCONFIRMED (live defect 2026-09-06). The daemon reaches
      // this class only AFTER writing every answer keystroke to the terminal,
      // with our own bound question still on screen — so the answer did land.
      // The old copy called that "verification failed" and told the user to
      // "try again", which resends an answer the agent has already acted on.
      // Report it as unconfirmed, and dismiss the modal: leaving it open is
      // itself a resubmit invitation.
      if (msg.includes(CLAUDE_TUI_REVIEW_UNCONFIRMED_PREFIX)) {
        setDismissedPromptId(promptSession.prompt.promptId)
        setResponseError(t('interactivePrompt.errorReviewUnconfirmed', {
          defaultValue: 'Your answer was sent, but the terminal did not confirm it in time. Check the terminal screen before answering again — resending may submit it twice.'
        }))
        throw error
      }
      if (msg.includes(CLAUDE_TUI_REVIEW_PAGE_NOT_FOCUSED_PREFIX)) {
        // Genuinely wrong screen: nothing was submitted into our question, so
        // retrying is both safe and the correct next step.
        msg = t('interactivePrompt.errorReviewPageNotFocused', {
          defaultValue: 'The terminal is showing a different screen, so the answer was not submitted — check the terminal screen or close this and try again.'
        })
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
