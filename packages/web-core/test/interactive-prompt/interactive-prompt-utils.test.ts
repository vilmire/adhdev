import { describe, expect, it } from 'vitest'
import {
  buildInteractivePromptResponse,
  findInteractivePromptSession,
} from '../../src/interactive-prompt/interactive-prompt-utils'
import type { DaemonData } from '../../src/types'

const prompt = {
  promptId: 'prompt-1',
  origin: 'cli' as const,
  providerType: 'claude-cli',
  createdAt: 123,
  questions: [
    {
      questionId: 'q1',
      question: 'Pick one',
      multiSelect: false,
      options: [{ label: 'Approve' }, { label: 'Reject' }],
    },
    {
      questionId: 'q2',
      question: 'Anything else?',
      multiSelect: true,
      allowFreeform: true,
      options: [{ label: 'A' }, { label: 'B' }],
    },
  ],
}

describe('interactive prompt utilities', () => {
  it('finds active prompts on top-level session entries', () => {
    const entries: DaemonData[] = [
      { id: 'daemon-1', type: 'adhdev-daemon', status: 'online' },
      {
        id: 'daemon-1:cli:session-1',
        daemonId: 'daemon-1',
        sessionId: 'session-1',
        type: 'claude-cli',
        status: 'waiting_approval',
        activeInteractivePrompt: prompt,
      } as DaemonData,
    ]

    expect(findInteractivePromptSession(entries, 'session-1')).toMatchObject({
      daemonId: 'daemon-1',
      sessionId: 'session-1',
      routeId: 'daemon-1:cli:session-1',
      prompt,
    })
  })

  it('keeps scoped prompt lookup isolated to the requested session', () => {
    const otherPrompt = {
      ...prompt,
      promptId: 'prompt-2',
      questions: [{ questionId: 'q-other', question: 'Other session?', options: [{ label: 'Yes' }] }],
    }
    const entries: DaemonData[] = [
      {
        id: 'daemon-1:cli:session-a',
        daemonId: 'daemon-1',
        sessionId: 'session-a',
        type: 'claude-cli',
        status: 'waiting_approval',
        activeInteractivePrompt: prompt,
      } as DaemonData,
      {
        id: 'daemon-1:cli:session-b',
        daemonId: 'daemon-1',
        sessionId: 'session-b',
        type: 'claude-cli',
        status: 'waiting_approval',
        activeInteractivePrompt: otherPrompt,
      } as DaemonData,
    ]

    expect(findInteractivePromptSession(entries, 'session-a')).toMatchObject({
      sessionId: 'session-a',
      prompt,
    })
    expect(findInteractivePromptSession(entries, 'missing-session')).toBeNull()
  })

  it('builds daemon-compatible responses from selected labels and freeform text', () => {
    expect(buildInteractivePromptResponse(prompt, {
      q1: { selectedLabels: ['Approve'] },
      q2: { selectedLabels: ['A', 'A', 'B'], freeformText: '  extra context  ' },
    })).toEqual({
      promptId: 'prompt-1',
      answers: {
        q1: { selectedLabels: ['Approve'] },
        q2: { selectedLabels: ['A', 'B'], freeformText: 'extra context' },
      },
    })
  })
})
