import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  buildInteractivePromptResponse,
  type InteractivePromptSelection,
  type InteractivePromptSession,
} from '../../interactive-prompt/interactive-prompt-utils'
import type { InteractiveQuestion } from '../../interactive-prompt/types'
import { IconCheckCircle, IconWarning, IconX } from '../Icons'
import ModalPortal from '../ui/ModalPortal'

// Ignore Submit clicks fired in this window right after a prompt renders. Without it, a
// stray click/keypress left over from the previous view (or a just-dismissed prompt) can
// land on the freshly-rendered question and submit it before the user has actually chosen
// — one cause of a question being answered with garbage or resolving unexpectedly early.
const SUBMIT_READY_DELAY_MS = 200

interface InteractivePromptModalProps {
  promptSession: InteractivePromptSession | null
  isSubmitting?: boolean
  error?: string | null
  onSubmit: (selection: InteractivePromptSelection) => void | Promise<void>
  onCancel: () => void
}

function defaultSelection(promptSession: InteractivePromptSession | null): InteractivePromptSelection {
  const selection: InteractivePromptSelection = {}
  for (const question of promptSession?.prompt.questions || []) {
    selection[question.questionId] = { selectedLabels: [], freeformText: '' }
  }
  return selection
}

function hasAnswer(question: InteractiveQuestion, answer: InteractivePromptSelection[string] | undefined): boolean {
  return !!answer?.freeformText?.trim() || (answer?.selectedLabels?.length || 0) > 0 || (question.options.length === 0 && !!question.allowFreeform)
}

function OptionButton({
  label,
  description,
  selected,
  multiSelect,
  disabled,
  onClick,
}: {
  label: string
  description?: string
  selected: boolean
  multiSelect?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      role={multiSelect ? 'checkbox' : 'radio'}
      aria-checked={selected}
      onClick={onClick}
      className={`w-full text-left rounded-md border px-3 py-2 transition ${
        selected
          ? 'border-accent-primary bg-accent-primary/15 text-text-primary'
          : 'border-border-default bg-surface-secondary text-text-secondary hover:bg-surface-secondary hover:text-text-primary'
      } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
    >
      <span className="flex items-start gap-2">
        {/* Multi-select renders a square checkbox indicator; single-select a round radio dot. */}
        <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border ${
          multiSelect ? 'rounded-sm' : 'rounded-full'
        } ${
          selected ? 'border-accent-primary bg-accent-primary text-accent-on-primary' : 'border-border-subtle'
        }`}>
          {selected
            ? multiSelect
              ? <IconCheckCircle size={12} />
              : <span className="h-1.5 w-1.5 rounded-full bg-accent-on-primary" />
            : null}
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold leading-5">{label}</span>
          {description && <span className="mt-0.5 line-clamp-3 block text-xs leading-5 text-text-muted">{description}</span>}
        </span>
      </span>
    </button>
  )
}

export default function InteractivePromptModal({
  promptSession,
  isSubmitting = false,
  error,
  onSubmit,
  onCancel,
}: InteractivePromptModalProps) {
  const { t } = useTranslation('common')
  const [selection, setSelection] = useState<InteractivePromptSelection>(() => defaultSelection(promptSession))
  // Gate that blocks Submit for a short window right after a new prompt renders.
  const [submitReady, setSubmitReady] = useState(false)
  const submitReadyRef = useRef(false)

  useEffect(() => {
    setSelection(defaultSelection(promptSession))
    setSubmitReady(false)
    submitReadyRef.current = false
    const promptId = promptSession?.prompt.promptId
    if (!promptId) return
    const timer = setTimeout(() => {
      submitReadyRef.current = true
      setSubmitReady(true)
    }, SUBMIT_READY_DELAY_MS)
    return () => clearTimeout(timer)
  }, [promptSession?.prompt.promptId])

  const questions = promptSession?.prompt.questions || []
  // A single question needs no section header/numbering; multiple questions are listed
  // top-to-bottom, each as its own titled section on one screen (no step wizard).
  const isSingleQuestion = questions.length === 1

  const canSubmit = useMemo(() => {
    if (!promptSession) return false
    return promptSession.prompt.questions.every(question => hasAnswer(question, selection[question.questionId]))
  }, [promptSession, selection])

  const unansweredQuestionCount = useMemo(
    () => questions.filter(question => !hasAnswer(question, selection[question.questionId])).length,
    [questions, selection],
  )

  if (!promptSession) return null

  const toggleOption = (question: InteractiveQuestion, label: string) => {
    setSelection(prev => {
      const current = prev[question.questionId] || { selectedLabels: [] }
      const labels = current.selectedLabels || []
      const nextLabels = question.multiSelect
        ? labels.includes(label)
          ? labels.filter(item => item !== label)
          : [...labels, label]
        : [label]
      return {
        ...prev,
        [question.questionId]: {
          ...current,
          selectedLabels: nextLabels,
        },
      }
    })
  }

  const setFreeformText = (questionId: string, freeformText: string) => {
    setSelection(prev => ({
      ...prev,
      [questionId]: {
        ...(prev[questionId] || { selectedLabels: [] }),
        freeformText,
      },
    }))
  }

  const handleSubmit = () => {
    // submitReadyRef guards the just-rendered window; isSubmitting guards in-flight.
    if (!canSubmit || isSubmitting || !submitReadyRef.current) return
    void onSubmit(selection)
  }

  const answerPreview = buildInteractivePromptResponse(promptSession.prompt, selection)

  return (
    <ModalPortal>
    <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/50 px-4 pt-[calc(24px+env(safe-area-inset-top,0px))] pb-[calc(24px+env(safe-area-inset-bottom,0px))]">
      <div className="flex max-h-[calc(100dvh-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px)-48px)] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border-default bg-surface-primary shadow-2xl">
        {/* Header */}
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border-default px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-normal text-status-warning">
              <IconWarning size={15} /> Action Required
            </div>
            <h2 className="mt-1 text-lg font-bold text-text-primary">
              {promptSession.title || promptSession.providerType}
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="btn btn-ghost btn-sm h-8 w-8 p-0"
              aria-label="Cancel interactive prompt"
            >
              <IconX size={16} />
            </button>
          </div>
        </div>

        {/* Body — every question is listed here on one screen and scrolls independently
            so the header and footer stay pinned. */}
        <div className="interactive-prompt-question-list min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {questions.map((question, index) => {
            const selectedLabels = answerPreview.answers[question.questionId]?.selectedLabels || []
            const typeLabel = question.multiSelect
              ? t('interactivePrompt.multipleChoice')
              : t('interactivePrompt.singleChoice')
            return (
              <section
                key={question.questionId}
                className={index > 0 ? 'space-y-3 border-t border-border-default pt-5' : 'space-y-3'}
              >
                <div>
                  <div className="flex items-center gap-2">
                    {question.header && (
                      <span className="text-xs font-semibold uppercase tracking-normal text-text-muted">
                        {question.header}
                      </span>
                    )}
                    {/* Type label makes the checkbox-vs-radio distinction explicit per question. */}
                    <span className="rounded-full border border-border-subtle px-2 py-0.5 text-[10px] font-semibold uppercase tracking-normal text-text-muted">
                      {typeLabel}
                    </span>
                  </div>
                  <div className="mt-1 text-sm font-semibold text-text-primary">
                    {!isSingleQuestion ? `${index + 1}. ` : ''}{question.question}
                  </div>
                  {question.multiSelect && question.options.length > 0 && (
                    <div className="mt-0.5 text-xs text-text-muted">{t('interactivePrompt.selectAllThatApply')}</div>
                  )}
                </div>

                <div
                  className="grid gap-2"
                  role={question.multiSelect ? 'group' : 'radiogroup'}
                  aria-label={question.question}
                >
                  {question.options.map(option => (
                    <OptionButton
                      key={option.label}
                      label={option.label}
                      description={option.description || option.preview}
                      selected={selectedLabels.includes(option.label)}
                      multiSelect={question.multiSelect}
                      disabled={isSubmitting}
                      onClick={() => toggleOption(question, option.label)}
                    />
                  ))}
                </div>

                {question.allowFreeform && (
                  <label className="block">
                    <span className="mb-1 block text-xs font-semibold text-text-muted">{t('interactivePrompt.other')}</span>
                    <textarea
                      value={selection[question.questionId]?.freeformText || ''}
                      disabled={isSubmitting}
                      onChange={(event) => setFreeformText(question.questionId, event.currentTarget.value)}
                      className="w-full min-h-20 rounded-md border border-border-default bg-surface-secondary px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-primary"
                    />
                  </label>
                )}
              </section>
            )
          })}

          {error && (
            <div className="rounded-md border border-status-error/30 bg-status-error/10 px-3 py-2 text-sm text-status-error">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border-default px-5 pt-4 pb-[calc(16px+env(safe-area-inset-bottom,0px))]">
          {!canSubmit && unansweredQuestionCount > 0 && (
            <span className="mr-auto text-xs text-text-muted">
              {t('interactivePrompt.answersRequired', { count: unansweredQuestionCount })}
            </span>
          )}
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} disabled={isSubmitting}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={handleSubmit}
            disabled={!canSubmit || isSubmitting || !submitReady}
          >
            {isSubmitting ? 'Submitting...' : 'Submit'}
          </button>
        </div>
      </div>
    </div>
    </ModalPortal>
  )
}
