import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

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

// PICKER-DISMISS-SHARED-STORE (live defect, 2026-09-15): the dismissal used to be
// per-hook-instance `useState`, but the dashboard mounts this hook more than once —
// the modal surface (Dashboard → DashboardOverlays) and each ApprovalBanner
// "Answer the question" CTA are SEPARATE instances. Closing the modal set the
// dismissal only on the modal's instance; the banner's reopen() reset only its own
// (already-null) instance, so the CTA was a dead button and a dismissed picker was
// gone for good while the banner kept showing "Question waiting". The dismissal is
// now module-level, shared by every hook instance, and keyed by promptId so a NEW
// question (a different promptId) is never born pre-dismissed.
let sharedDismissedPromptId: string | null = null
const dismissedPromptListeners = new Set<() => void>()

function subscribeDismissedPrompt(listener: () => void): () => void {
  dismissedPromptListeners.add(listener)
  return () => { dismissedPromptListeners.delete(listener) }
}

function getSharedDismissedPromptId(): string | null {
  return sharedDismissedPromptId
}

function setSharedDismissedPromptId(next: string | null): void {
  if (sharedDismissedPromptId === next) return
  sharedDismissedPromptId = next
  for (const listener of dismissedPromptListeners) listener()
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
  // Shared across every hook instance (see PICKER-DISMISS-SHARED-STORE above), so a
  // dismiss from the modal and a reopen from the banner act on the same state.
  const dismissedPromptId = useSyncExternalStore(
    subscribeDismissedPrompt,
    getSharedDismissedPromptId,
    getSharedDismissedPromptId,
  )
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
      setSharedDismissedPromptId(promptSession.prompt.promptId)
    } catch (error) {
      let msg = error instanceof Error ? error.message : String(error)
      // KEYS-WRITTEN-BUT-UNCONFIRMED (live defect 2026-09-06, corrected
      // 2026-09-11). The daemon reaches this class only AFTER writing every
      // answer keystroke to the terminal, with our own bound question still on
      // screen. That does NOT prove the answer was submitted: the preview
      // (side-by-side) layout reached exactly this state with nothing
      // submitted (09-10 incident). So the copy must not claim delivery —
      // only that the keys reached the terminal and the outcome is unknown.
      // Still no "try again" invitation: if the answer DID land, resending
      // would submit it twice. Dismiss the modal for the same reason.
      if (msg.includes(CLAUDE_TUI_REVIEW_UNCONFIRMED_PREFIX)) {
        setSharedDismissedPromptId(promptSession.prompt.promptId)
        setResponseError(t('interactivePrompt.errorReviewUnconfirmed', {
          defaultValue: 'The answer keys reached the terminal, but the question is still on screen — the answer may not have been submitted. Check the terminal: if it was not submitted, answer there; resending from here could submit it twice.'
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
    if (promptSession) setSharedDismissedPromptId(promptSession.prompt.promptId)
  }, [promptSession])

  const reopen = useCallback(() => {
    setSharedDismissedPromptId(null)
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
