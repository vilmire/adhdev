import { useEffect, useMemo, useState } from 'react'

import {
  buildInteractivePromptResponse,
  type InteractivePromptSelection,
  type InteractivePromptSession,
} from '../../interactive-prompt/interactive-prompt-utils'
import type { InteractiveQuestion } from '../../interactive-prompt/types'
import { IconCheckCircle, IconWarning, IconX } from '../Icons'

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
  return !!answer?.freeformText?.trim() || (answer?.selectedLabels?.length || 0) > 0 || (question.options.length === 0 && question.allowFreeform)
}

function OptionButton({
  label,
  description,
  selected,
  disabled,
  onClick,
}: {
  label: string
  description?: string
  selected: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`w-full text-left rounded-md border px-3 py-2 transition ${
        selected
          ? 'border-accent-primary bg-accent-primary/15 text-text-primary'
          : 'border-border-primary bg-surface-secondary text-text-secondary hover:bg-surface-tertiary hover:text-text-primary'
      } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
    >
      <span className="flex items-start gap-2">
        <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
          selected ? 'border-accent-primary bg-accent-primary text-white' : 'border-border-secondary'
        }`}>
          {selected ? <IconCheckCircle size={12} /> : null}
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold leading-5">{label}</span>
          {description && <span className="mt-0.5 block text-xs leading-5 text-text-muted">{description}</span>}
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
  const [selection, setSelection] = useState<InteractivePromptSelection>(() => defaultSelection(promptSession))

  useEffect(() => {
    setSelection(defaultSelection(promptSession))
  }, [promptSession?.prompt.promptId])

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

  const handleSubmit = () => {
    if (!canSubmit || isSubmitting) return
    void onSubmit(selection)
  }

  const answerPreview = buildInteractivePromptResponse(promptSession.prompt, selection)

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 px-4 py-6">
      <div className="w-full max-w-2xl overflow-hidden rounded-lg border border-border-primary bg-surface-primary shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-border-primary px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-normal text-status-warning">
              <IconWarning size={15} /> Action Required
            </div>
            <h2 className="mt-1 text-lg font-bold text-text-primary">
              {promptSession.title || promptSession.providerType}
            </h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="btn btn-ghost btn-sm h-8 w-8 p-0"
            aria-label="Cancel interactive prompt"
          >
            <IconX size={16} />
          </button>
        </div>

        <div className="max-h-[70vh] space-y-5 overflow-auto px-5 py-4">
          {promptSession.prompt.questions.map((question, index) => {
            const answer = answerPreview.answers[question.questionId]
            return (
              <section key={question.questionId} className="space-y-3">
                <div>
                  {question.header && (
                    <div className="mb-1 text-xs font-semibold uppercase tracking-normal text-text-muted">
                      {question.header}
                    </div>
                  )}
                  <div className="text-sm font-semibold text-text-primary">
                    {promptSession.prompt.questions.length > 1 ? `${index + 1}. ` : ''}{question.question}
                  </div>
                </div>

                <div className="grid gap-2">
                  {question.options.map(option => (
                    <OptionButton
                      key={option.label}
                      label={option.label}
                      description={option.description || option.preview}
                      selected={answer.selectedLabels.includes(option.label)}
                      disabled={isSubmitting}
                      onClick={() => toggleOption(question, option.label)}
                    />
                  ))}
                </div>

                {question.allowFreeform && (
                  <label className="block">
                    <span className="mb-1 block text-xs font-semibold text-text-muted">Other</span>
                    <textarea
                      value={selection[question.questionId]?.freeformText || ''}
                      disabled={isSubmitting}
                      onChange={(event) => setFreeformText(question.questionId, event.currentTarget.value)}
                      className="w-full min-h-20 rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-primary"
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

        <div className="flex items-center justify-end gap-2 border-t border-border-primary px-5 py-4">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} disabled={isSubmitting}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={handleSubmit} disabled={!canSubmit || isSubmitting}>
            {isSubmitting ? 'Submitting...' : 'Submit'}
          </button>
        </div>
      </div>
    </div>
  )
}
