import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import InteractivePromptModal from '../../src/components/interactive-prompt/InteractivePromptModal'

describe('InteractivePromptModal', () => {
  it('renders prompt questions, options, and freeform Other input', () => {
    const html = renderToStaticMarkup(
      React.createElement(InteractivePromptModal, {
        promptSession: {
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
            questions: [{
              questionId: 'q1',
              header: 'Plan',
              question: 'Choose a path',
              multiSelect: false,
              allowFreeform: true,
              options: [{ label: 'Proceed', description: 'Run the proposed command' }],
            }],
          },
        },
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
  })
})
