import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  buildInteractivePromptResponse,
  type InteractivePromptSelection,
  type InteractivePromptSession,
} from '../../interactive-prompt/interactive-prompt-utils'
import type { InteractiveQuestion } from '../../interactive-prompt/types'
import { IconCheckCircle, IconWarning, IconX } from '../Icons'

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
        {/* Multi-select renders a square checkbox indicator; single-select a round radio. */}
        <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border ${
          multiSelect ? 'rounded-sm' : 'rounded-full'
        } ${
          selected ? 'border-accent-primary bg-accent-primary text-accent-on-primary' : 'border-border-subtle'
        }`}>
          {selected ? <IconCheckCircle size={12} /> : null}
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
  const [currentStep, setCurrentStep] = useState(0)
  // Gate that blocks Submit for a short window right after a new prompt renders.
  const [submitReady, setSubmitReady] = useState(false)
  const submitReadyRef = useRef(false)

  useEffect(() => {
    setSelection(defaultSelection(promptSession))
    setCurrentStep(0)
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
  const totalSteps = questions.length
  const isLastStep = currentStep === totalSteps - 1
  const isSingleQuestion = totalSteps === 1

  const currentQuestion = questions[currentStep]
  const currentAnswer = currentQuestion ? selection[currentQuestion.questionId] : undefined
  const currentAnswered = currentQuestion ? hasAnswer(currentQuestion, currentAnswer) : false

  const canSubmit = useMemo(() => {
    if (!promptSession) return false
    return promptSession.prompt.questions.every(question => hasAnswer(question, selection[question.questionId]))
  }, [promptSession, selection])

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

  const handleNext = () => {
    if (currentStep < totalSteps - 1) setCurrentStep(s => s + 1)
  }

  const handleBack = () => {
    if (currentStep > 0) setCurrentStep(s => s - 1)
  }

  const handleSubmit = () => {
    // submitReadyRef guards the just-rendered window; isSubmitting guards in-flight.
    if (!canSubmit || isSubmitting || !submitReadyRef.current) return
    void onSubmit(selection)
  }

  const answerPreview = buildInteractivePromptResponse(promptSession.prompt, selection)

  return (
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
            {!isSingleQuestion && (
              <span className="text-xs text-text-muted">
                {currentStep + 1} / {totalSteps}
              </span>
            )}
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

        {/* Step indicator dots for multi-question */}
        {!isSingleQuestion && (
          <div className="flex shrink-0 gap-1.5 px-5 pt-3">
            {questions.map((q, i) => (
              <div
                key={q.questionId}
                className={`h-1.5 flex-1 rounded-full transition-colors ${
                  i < currentStep
                    ? 'bg-accent-primary'
                    : i === currentStep
                    ? 'bg-accent-primary/60'
                    : 'bg-border-default'
                }`}
              />
            ))}
          </div>
        )}

        {/* Question body — scrolls independently so the header and footer stay pinned. */}
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {currentQuestion && (
            <section className="space-y-3">
              <div>
                {currentQuestion.header && (
                  <div className="mb-1 text-xs font-semibold uppercase tracking-normal text-text-muted">
                    {currentQuestion.header}
                  </div>
                )}
                <div className="text-sm font-semibold text-text-primary">
                  {!isSingleQuestion ? `${currentStep + 1}. ` : ''}{currentQuestion.question}
                </div>
                {currentQuestion.multiSelect && currentQuestion.options.length > 0 && (
                  <div className="mt-0.5 text-xs text-text-muted">{t('interactivePrompt.selectAllThatApply')}</div>
                )}
              </div>

              <div
                className="grid gap-2"
                role={currentQuestion.multiSelect ? 'group' : 'radiogroup'}
                aria-label={currentQuestion.question}
              >
                {currentQuestion.options.map(option => (
                  <OptionButton
                    key={option.label}
                    label={option.label}
                    description={option.description || option.preview}
                    selected={(answerPreview.answers[currentQuestion.questionId]?.selectedLabels || []).includes(option.label)}
                    multiSelect={currentQuestion.multiSelect}
                    disabled={isSubmitting}
                    onClick={() => toggleOption(currentQuestion, option.label)}
                  />
                ))}
              </div>

              {currentQuestion.allowFreeform && (
                <label className="block">
                  <span className="mb-1 block text-xs font-semibold text-text-muted">{t('interactivePrompt.other')}</span>
                  <textarea
                    value={selection[currentQuestion.questionId]?.freeformText || ''}
                    disabled={isSubmitting}
                    onChange={(event) => setFreeformText(currentQuestion.questionId, event.currentTarget.value)}
                    className="w-full min-h-20 rounded-md border border-border-default bg-surface-secondary px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-primary"
                  />
                </label>
              )}
            </section>
          )}

          {error && (
            <div className="rounded-md border border-status-error/30 bg-status-error/10 px-3 py-2 text-sm text-status-error">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border-default px-5 pt-4 pb-[calc(16px+env(safe-area-inset-bottom,0px))]">
          <div>
            {!isSingleQuestion && currentStep > 0 && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={handleBack} disabled={isSubmitting}>
                Back
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} disabled={isSubmitting}>
              Cancel
            </button>
            {isSingleQuestion || isLastStep ? (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={handleSubmit}
                disabled={!canSubmit || isSubmitting || !submitReady}
              >
                {isSubmitting ? 'Submitting...' : 'Submit'}
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={handleNext}
                disabled={!currentAnswered || isSubmitting}
              >
                Next
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
