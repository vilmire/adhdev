import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import InteractivePromptModal from '../../src/components/interactive-prompt/InteractivePromptModal'
import type { InteractivePromptSession } from '../../src/interactive-prompt/interactive-prompt-utils'

function session(questions: InteractivePromptSession['prompt']['questions']): InteractivePromptSession {
  return {
    daemonId: 'daemon-1',
    sessionId: 'session-1',
    routeId: 'daemon-1:cli:session-1',
    providerType: 'claude-cli',
    title: 'Claude',
    prompt: {
      promptId: 'prompt-1',
      origin: 'cli',
      providerType: 'claude-cli',
      createdAt: 123,
      questions,
    },
  }
}

describe('InteractivePromptModal', () => {
  it('renders a single prompt question, options, and freeform Other input', () => {
    const html = renderToStaticMarkup(
      React.createElement(InteractivePromptModal, {
        promptSession: session([{
          questionId: 'q1',
          header: 'Plan',
          question: 'Choose a path',
          multiSelect: false,
          allowFreeform: true,
          options: [{ label: 'Proceed', description: 'Run the proposed command' }],
        }]),
        onSubmit: vi.fn(),
        onCancel: vi.fn(),
      }),
    )

    expect(html).toContain('Action Required')
    expect(html).toContain('Choose a path')
    expect(html).toContain('Proceed')
    expect(html).toContain('Other')
    expect(html).toContain('Submit')
    expect(html).toContain('Cancel')
    // Single question: no step-counter numbering prefix.
    expect(html).not.toContain('1. Choose a path')
  })

  it('renders every question on one screen for a mixed multi/single prompt', () => {
    const html = renderToStaticMarkup(
      React.createElement(InteractivePromptModal, {
        promptSession: session([
          {
            questionId: 'q1',
            question: 'Pick features',
            multiSelect: true,
            options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
          },
          {
            questionId: 'q2',
            question: 'Pick a mode',
            multiSelect: false,
            options: [{ label: 'X' }, { label: 'Y' }],
          },
        ]),
        onSubmit: vi.fn(),
        onCancel: vi.fn(),
      }),
    )

    // Both questions present at once — no wizard step gating.
    expect(html).toContain('Pick features')
    expect(html).toContain('Pick a mode')
    // Numbered sections when there is more than one question.
    expect(html).toContain('1. ')
    expect(html).toContain('2. ')
    // All options for both questions render simultaneously.
    for (const label of ['A', 'B', 'C', 'X', 'Y']) {
      expect(html).toContain(`>${label}<`)
    }
    // Per-question type labels distinguish multi- vs single-select.
    expect(html).toContain('Multiple choice')
    expect(html).toContain('Single choice')
    // The multi-select hint appears for the multi question.
    expect(html).toContain('Select all that apply')
    // No step wizard controls.
    expect(html).not.toContain('>Next<')
    expect(html).not.toContain('>Back<')
  })
})
