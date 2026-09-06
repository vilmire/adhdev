// @vitest-environment jsdom
//
// DELIVERED-BUT-UNCONFIRMED: what the USER sees (live defect, 2026-09-06).
//
// Owner report, rc.87, mobile: after answering a coordinator AskUserQuestion the
// modal showed "The input was delivered but verification failed — check the
// terminal screen or close this and try again." — while the coordinator had
// received the answer and already dispatched work from it.
//
// Two things were wrong with that, and this file asserts both are fixed:
//   1. It called a delivered answer a FAILURE.
//   2. It told the user to "try again", which resends an answer the agent has
//      already acted on. Double submission is the real damage here.
//
// The complementary daemon-side contract (which error class is raised, and that
// a genuinely wrong screen still fails closed) lives in
// daemon-core/test/providers/spec/cli-adapter-tui-review-unconfirmed.test.ts.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_TUI_REVIEW_PAGE_NOT_FOCUSED_PREFIX,
  CLAUDE_TUI_REVIEW_UNCONFIRMED_PREFIX,
} from '@adhdev/mesh-shared'

import { useInteractivePrompt } from '../../src/hooks/useInteractivePrompt'

const DAEMON_ID = 'daemon_alpha'
const SESSION_ID = 'sess_1'
const PROMPT_ID = 'toolu_owner_repro'

let sendCommandImpl: (daemonId: string, type: string, payload?: unknown) => Promise<unknown>

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Mirror i18next: return the shipped English copy for the requested key.
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
  }),
}))

vi.mock('../../src/context/BaseDaemonContext', () => ({
  useBaseDaemons: () => ({
    ides: [{
      id: `${DAEMON_ID}:${SESSION_ID}`,
      daemonId: DAEMON_ID,
      sessionId: SESSION_ID,
      type: 'claude-cli',
      activeInteractivePrompt: {
        promptId: PROMPT_ID,
        providerType: 'claude-cli',
        questions: [{
          questionId: 'q1',
          question: 'Which approach?',
          header: 'Approach',
          multiSelect: false,
          options: [{ label: 'Rebase the feature branch only' }, { label: 'Rebase everything' }],
        }],
      },
    }],
    isP2PActive: true,
    p2pStates: { [DAEMON_ID]: 'connected' },
  }),
}))

vi.mock('../../src/context/TransportContext', () => ({
  useTransport: () => ({
    sendCommand: (daemonId: string, type: string, payload?: unknown) =>
      sendCommandImpl(daemonId, type, payload),
  }),
}))

let container: HTMLDivElement
let root: Root
let latest: ReturnType<typeof useInteractivePrompt>

function Probe() {
  latest = useInteractivePrompt(SESSION_ID)
  return null
}

async function answer() {
  await act(async () => {
    try {
      await latest.submit({ q1: { selectedLabels: ['Rebase the feature branch only'] } })
    } catch {
      // submit() re-throws for callers that want it; the banner state is what
      // this file asserts on.
    }
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('interactive prompt — delivered but unconfirmed', () => {
  it('does not tell the user the answer failed, and does not invite a retry', async () => {
    sendCommandImpl = async () => ({
      success: false,
      error: `${CLAUDE_TUI_REVIEW_UNCONFIRMED_PREFIX} — the answer keys reached the terminal but the review page did not settle in time`,
    })
    await act(async () => { root.render(<Probe />) })

    await answer()

    const banner = latest.responseError ?? ''
    expect(banner).not.toBe('')

    // (1) Never framed as a failure...
    expect(banner).not.toMatch(/verification failed|\bfailed\b/i)
    // ...but as delivered-yet-unconfirmed.
    expect(banner).toMatch(/sent|delivered/i)
    expect(banner).toMatch(/did not confirm|not confirm/i)

    // (2) No "try again" instruction, and an explicit double-submit warning.
    expect(banner).not.toMatch(/try again/i)
    expect(banner).toMatch(/twice|double/i)

    // The modal itself closes — leaving it open with the choice still selected
    // is a resubmit invitation regardless of the copy.
    expect(latest.promptSession).toBeNull()
  })

  it('a genuinely wrong screen is still reported, and retrying is still offered', async () => {
    // Guard against over-correcting: suppressing the false negative must not
    // swallow a true one. Nothing was submitted into our question here.
    sendCommandImpl = async () => ({
      success: false,
      error: `${CLAUDE_TUI_REVIEW_PAGE_NOT_FOCUSED_PREFIX} for the active interactive prompt; focused question is "Which environment?"`,
    })
    await act(async () => { root.render(<Probe />) })

    await answer()

    const banner = latest.responseError ?? ''
    expect(banner).toMatch(/not submitted/i)
    expect(banner).toMatch(/try again/i)
    // Still answerable — the user must be able to retry a real failure.
    expect(latest.promptSession).not.toBeNull()
  })

  it('a successful answer produces no error banner at all', async () => {
    sendCommandImpl = async () => ({ success: true })
    await act(async () => { root.render(<Probe />) })

    await answer()

    expect(latest.responseError).toBeNull()
    expect(latest.promptSession).toBeNull()
  })
})
