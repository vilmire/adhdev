/**
 * MULTISELECT-REMOTE-DEADLOCK — `agent:waiting_choice` must hydrate the target
 * session's `activeInteractivePrompt`.
 *
 * Root cause: that field only ever arrived on the P2P rich status sync. With the
 * sync degraded (WS-only, replicaDegraded) it stayed empty, the daemon's
 * modal-park resolved to `waiting_approval`, and the dashboard fell back to the
 * raw ApprovalBanner — whose single-select `'{index}\r'` injection cannot submit a
 * multi-select checkbox picker, so the owner could not answer at all from mobile.
 *
 * The `waiting_choice` event has always carried the WHOLE InteractivePrompt (see
 * status-transition.ts); the dashboard simply threw it away. These tests pin both
 * halves of the fix: the pure merge (this file) and the EventManager wiring that
 * feeds it (event-manager-waiting-choice-hydration.test.ts).
 */
import { describe, expect, it } from 'vitest'

import { hydrateInteractivePromptIntoIdes } from '../../src/context/hydrate-interactive-prompt'
import type { DaemonData } from '../../src/types'
import type { InteractivePrompt } from '../../src/interactive-prompt/types'

function prompt(promptId: string, multiSelect = true): InteractivePrompt {
  return {
    promptId,
    origin: 'cli',
    providerType: 'claude-cli',
    createdAt: 1,
    questions: [{
      questionId: 'q1',
      question: 'Which languages do you use?',
      multiSelect,
      options: [
        { label: 'TypeScript' },
        { label: 'Python' },
      ],
    }],
  } as InteractivePrompt
}

function entry(overrides: Partial<DaemonData> = {}): DaemonData {
  return {
    id: 'daemon-1:cli:sess-1',
    sessionId: 'sess-1',
    type: 'claude-cli',
    status: 'waiting_approval',
    daemonId: 'daemon-1',
    ...overrides,
  } as DaemonData
}

describe('hydrateInteractivePromptIntoIdes', () => {
  it('fills activeInteractivePrompt on the matching session (the degraded-sync gap)', () => {
    const ides = [entry()]
    const p = prompt('p1')

    const next = hydrateInteractivePromptIntoIdes(ides, 'sess-1', p)

    expect(next[0].activeInteractivePrompt).toBe(p)
    // The structured picker keys off multiSelect — it must survive the hop.
    expect(next[0].activeInteractivePrompt?.questions[0].multiSelect).toBe(true)
  })

  it('matches on the full route id too, not just sessionId', () => {
    const next = hydrateInteractivePromptIntoIdes([entry()], 'daemon-1:cli:sess-1', prompt('p1'))
    expect(next[0].activeInteractivePrompt?.promptId).toBe('p1')
  })

  it('matches on instanceId (CLI entries carry it as their session identity)', () => {
    const ides = [entry({ sessionId: undefined, instanceId: 'inst-9' })]
    const next = hydrateInteractivePromptIntoIdes(ides, 'inst-9', prompt('p1'))
    expect(next[0].activeInteractivePrompt?.promptId).toBe('p1')
  })

  it('leaves other sessions untouched', () => {
    const other = entry({ id: 'daemon-1:cli:sess-2', sessionId: 'sess-2' })
    const next = hydrateInteractivePromptIntoIdes([entry(), other], 'sess-1', prompt('p1'))

    expect(next[0].activeInteractivePrompt?.promptId).toBe('p1')
    expect(next[1].activeInteractivePrompt).toBeUndefined()
    // Untouched entries keep their identity so React memoization still holds.
    expect(next[1]).toBe(other)
  })

  it('never CREATES a session — an unknown target is dropped, same array back', () => {
    // The status snapshot is the authority on which sessions exist; an event must
    // not conjure a phantom entry that would render an unanswerable modal.
    const ides = [entry()]
    expect(hydrateInteractivePromptIntoIdes(ides, 'sess-unknown', prompt('p1'))).toBe(ides)
  })

  it('is idempotent for the same promptId — returns the SAME array reference', () => {
    // This is what makes it safe to run on every duplicate copy of the event
    // (WS + P2P both deliver it) without re-rendering the whole dashboard.
    const p = prompt('p1')
    const hydrated = hydrateInteractivePromptIntoIdes([entry()], 'sess-1', p)
    expect(hydrateInteractivePromptIntoIdes(hydrated, 'sess-1', p)).toBe(hydrated)
  })

  it('does not overwrite the snapshot copy of the SAME prompt', () => {
    // The status snapshot may be strictly richer: the multi-question capture
    // repair upgrades `multiSelect` on a later tick (readFocusedClaudeTuiQuestion),
    // and clobbering it with the event's frozen copy would undo that repair.
    const repaired = prompt('p1', true)
    const stale = prompt('p1', false)
    const ides = [entry({ activeInteractivePrompt: repaired })]

    const next = hydrateInteractivePromptIntoIdes(ides, 'sess-1', stale)

    expect(next).toBe(ides)
    expect(next[0].activeInteractivePrompt?.questions[0].multiSelect).toBe(true)
  })

  it('DOES replace a different promptId (a genuinely new question)', () => {
    const ides = [entry({ activeInteractivePrompt: prompt('p1') })]
    const next = hydrateInteractivePromptIntoIdes(ides, 'sess-1', prompt('p2'))
    expect(next[0].activeInteractivePrompt?.promptId).toBe('p2')
  })

  it('ignores a blank session id', () => {
    const ides = [entry()]
    expect(hydrateInteractivePromptIntoIdes(ides, '   ', prompt('p1'))).toBe(ides)
  })
})
