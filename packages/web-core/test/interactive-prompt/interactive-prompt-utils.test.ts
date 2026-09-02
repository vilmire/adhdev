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

    it('still resolves a hidden session for the legacy positional-id form', () => {
      // The coordinator answers its worker's prompt through this path — suppressing
      // it here would strand the worker waiting forever.
      expect(findInteractivePromptSession([hiddenWorker], 'worker-1'))
        .toMatchObject({ sessionId: 'worker-1' })
    })

    it('resolves a hidden session when includeHidden is opted into explicitly', () => {
      expect(findInteractivePromptSession([hiddenWorker], { sessionId: 'worker-1', includeHidden: true }))
        .toMatchObject({ sessionId: 'worker-1' })
    })

    // ★ The core guard for the scoping fix: adding a scope must NOT re-open the
    // hidden leak. Under the old single-parameter contract, any explicit
    // sessionId implicitly enabled hidden entries, so scoping the dashboard
    // modal to the selected tab would have surfaced a hidden worker again.
    it('keeps a hidden session suppressed even when scoped to it by id', () => {
      expect(findInteractivePromptSession([hiddenWorker], { sessionId: 'worker-1' }))
        .toBeNull()
    })

    it('keeps hidden suppression when a scoped scan would otherwise match it first', () => {
      expect(findInteractivePromptSession(
        [hiddenWorker, visibleSession],
        { sessionId: 'worker-1' },
      )).toBeNull()
    })
  })

  // ── The modal must follow the SELECTED tab, not `ides` order ──
  // Live defect: with the `ws` tab selected, the modal rendered `e2e-ws`'s
  // question. Dashboard.tsx called the hook unscoped, so the winner was
  // whichever prompt-bearing session came first in the status-report merge —
  // unstable enough to change across a refresh.
  describe('selected-session scoping', () => {
    const otherPrompt = { ...prompt, promptId: 'prompt-other' }

    const unselectedFirst = {
      id: 'daemon-1:cli:e2e-ws',
      daemonId: 'daemon-1',
      sessionId: 'e2e-ws',
      type: 'claude-cli',
      status: 'waiting_choice',
      activeInteractivePrompt: otherPrompt,
    } as DaemonData

    const selectedSecond = {
      id: 'daemon-1:cli:ws',
      daemonId: 'daemon-1',
      sessionId: 'ws',
      type: 'claude-cli',
      status: 'waiting_choice',
      activeInteractivePrompt: prompt,
    } as DaemonData

    it('returns the selected session\'s prompt even when another is ordered first', () => {
      expect(findInteractivePromptSession([unselectedFirst, selectedSecond], { sessionId: 'ws' }))
        .toMatchObject({ sessionId: 'ws', prompt })
    })

    it('returns nothing when the selected session has no prompt of its own', () => {
      // Must NOT fall back to some other session's question — silence is correct.
      const selectedNoPrompt = { ...selectedSecond, activeInteractivePrompt: undefined } as DaemonData
      expect(findInteractivePromptSession([unselectedFirst, selectedNoPrompt], { sessionId: 'ws' }))
        .toBeNull()
    })

    it('scopes by routeId too, since that is what a tab may carry', () => {
      expect(findInteractivePromptSession(
        [unselectedFirst, selectedSecond],
        { sessionId: 'daemon-1:cli:ws' },
      )).toMatchObject({ sessionId: 'ws' })
    })
  })

  describe('visibility flags other than surfaceHidden', () => {
    const visibleSession = {
      id: 'daemon-1:cli:session-2',
      daemonId: 'daemon-1',
      sessionId: 'session-2',
      type: 'claude-cli',
      status: 'waiting_approval',
      surfaceHidden: false,
      activeInteractivePrompt: prompt,
    } as DaemonData

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
