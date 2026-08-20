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

  it('collects every checked box for a multi-select question into the answer array', () => {
    // Regression guard for the multi-select submit bug: checking 2+ boxes must
    // send ALL of them, not just one. The selection state accumulates labels,
    // and the response must carry the full array through to the daemon.
    const multi = {
      ...prompt,
      promptId: 'multi-only',
      questions: [
        {
          questionId: 'q1',
          question: 'Pick all that apply',
          multiSelect: true,
          options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
        },
      ],
    }
    const response = buildInteractivePromptResponse(multi, {
      q1: { selectedLabels: ['A', 'C'] },
    })
    expect(response.answers.q1.selectedLabels).toEqual(['A', 'C'])
    expect(response.answers.q1.selectedLabels).toHaveLength(2)
  })

  // ── Hidden coordinator-spawned worker must not surface its prompt to the owner ──
  // Live incident (2026-08-20): a mesh worker spawned with
  // spawnedSessionVisibility='hidden' (surfaceHidden+muted true) raised a choice
  // dialog on the owner's dashboard. The flags were set correctly; this selector
  // simply never read them.
  describe('surfaceHidden suppression', () => {
    const hiddenWorker = {
      id: 'daemon-1:cli:worker-1',
      daemonId: 'daemon-1',
      sessionId: 'worker-1',
      type: 'claude-cli',
      status: 'waiting_approval',
      surfaceHidden: true,
      muted: true,
      activeInteractivePrompt: prompt,
    } as DaemonData

    const visibleSession = {
      id: 'daemon-1:cli:session-2',
      daemonId: 'daemon-1',
      sessionId: 'session-2',
      type: 'claude-cli',
      status: 'waiting_approval',
      surfaceHidden: false,
      activeInteractivePrompt: prompt,
    } as DaemonData

    it('skips a surfaceHidden session on the unscoped (dashboard) scan', () => {
      expect(findInteractivePromptSession([hiddenWorker])).toBeNull()
    })

    it('does not let a hidden worker preempt a visible session ordered after it', () => {
      // Only the FIRST match is returned, so an unfiltered hidden entry earlier in
      // the list would both leak itself AND hide the owner's real prompt.
      expect(findInteractivePromptSession([hiddenWorker, visibleSession]))
        .toMatchObject({ sessionId: 'session-2' })
    })

    it('still resolves a hidden session when asked for it explicitly by id', () => {
      // The coordinator answers its worker's prompt through this path — suppressing
      // it here would strand the worker waiting forever.
      expect(findInteractivePromptSession([hiddenWorker], 'worker-1'))
        .toMatchObject({ sessionId: 'worker-1' })
    })

    it('surfaces a muted-but-visible session — mute silences alerts, not the dialog', () => {
      const mutedVisible = { ...visibleSession, muted: true, surfaceHidden: false } as DaemonData
      expect(findInteractivePromptSession([mutedVisible]))
        .toMatchObject({ sessionId: 'session-2' })
    })

    it('surfaces a session with no visibility flags at all (regression: no accidental hiding)', () => {
      const plain = { ...visibleSession } as Record<string, unknown>
      delete plain.surfaceHidden
      expect(findInteractivePromptSession([plain as DaemonData]))
        .toMatchObject({ sessionId: 'session-2' })
    })
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
