/**
 * Phase 3 unit 4c — deriving transcript session interest from what is being read.
 *
 * The cloud assembly declares transcript interest to the daemon by reading
 * this derivation. Two properties are load-bearing and both fail silently:
 *
 *  1. RETAINED-ONLY. The controller registry is append-only — a controller is
 *     never deleted once created — so registry membership accumulates every
 *     session opened this page load. Deriving from membership would keep
 *     widening the daemon's grant map for the whole session and never narrow
 *     it, defeating least privilege (design §9 item 4) while looking correct
 *     in every "does the pane render" test.
 *  2. EDGE NOTIFICATION. The 0↔1 retain edges are what tell the cloud binder
 *     to re-declare. If they stop firing, interest freezes at whatever it was
 *     when the last unrelated controller was created — the pane renders on
 *     legacy and nothing reports an error.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SubscriptionManager } from '../../../src/managers/SubscriptionManager'
import {
  collectRetainedTranscriptSessionInterest,
  getOrCreateSessionChatTailController,
  resetSessionChatTailControllersForTest,
  subscribeTranscriptSessionInterest,
} from '../../../src/components/dashboard/session-chat-tail-controller'

function createController(options: {
  daemonId: string
  sessionId: string
  historySessionId?: string
}) {
  return getOrCreateSessionChatTailController({
    manager: new SubscriptionManager(),
    sendData: vi.fn(() => true),
    subscriptionKey: `daemon:${options.daemonId}:session:${options.sessionId}`,
    ...options,
  })
}

afterEach(() => {
  resetSessionChatTailControllersForTest()
})

describe('collectRetainedTranscriptSessionInterest (unit 4c)', () => {
  it('★ reports only RETAINED controllers — a registered but unread session is not granted', () => {
    // The registry never evicts, so this is the only thing separating "the
    // user is looking at this" from "the user once opened this".
    createController({ daemonId: 'daemon-a', sessionId: 'sess-registered-only' })

    expect(collectRetainedTranscriptSessionInterest().size).toBe(0)
  })

  it('reports a session once it is retained', () => {
    createController({ daemonId: 'daemon-a', sessionId: 'sess-1' }).retain()

    expect(collectRetainedTranscriptSessionInterest()).toEqual(
      new Map([['daemon-a', ['sess-1']]]),
    )
  })

  it('★ releasing NARROWS the set back — this is what revokes the grant', () => {
    const controller = createController({ daemonId: 'daemon-a', sessionId: 'sess-1' })
    controller.retain()
    controller.release()

    expect(collectRetainedTranscriptSessionInterest().size).toBe(0)
  })

  it('groups by daemon so one daemon never sees another daemon\'s session ids', () => {
    createController({ daemonId: 'daemon-a', sessionId: 'sess-a' }).retain()
    createController({ daemonId: 'daemon-b', sessionId: 'sess-b' }).retain()

    expect(collectRetainedTranscriptSessionInterest()).toEqual(
      new Map([
        ['daemon-a', ['sess-a']],
        ['daemon-b', ['sess-b']],
      ]),
    )
  })

  it('★ dedups the pane and warm-inbox controllers of ONE session into one id', () => {
    // Controllers are keyed `daemonId::sessionId::historySessionId`, so the
    // chat pane (keyed by the provider conv id) and the mobile inbox's warm
    // controller (keyed by the sessionId) are two entries for one session.
    // The wire contract is a set of SESSION ids — emitting the id twice would
    // put a duplicate in the declared frame.
    createController({ daemonId: 'daemon-a', sessionId: 'sess-1', historySessionId: 'prov-1' }).retain()
    createController({ daemonId: 'daemon-a', sessionId: 'sess-1' }).retain()

    expect(collectRetainedTranscriptSessionInterest()).toEqual(
      new Map([['daemon-a', ['sess-1']]]),
    )
  })

  it('one session still granted while a SECOND consumer of it remains retained', () => {
    const pane = createController({ daemonId: 'daemon-a', sessionId: 'sess-1', historySessionId: 'prov-1' })
    const warm = createController({ daemonId: 'daemon-a', sessionId: 'sess-1' })
    pane.retain()
    warm.retain()

    pane.release()

    // The warm mobile preview is still reading it (roster id 2), so the
    // transcript must keep being replicated.
    expect(collectRetainedTranscriptSessionInterest()).toEqual(
      new Map([['daemon-a', ['sess-1']]]),
    )
  })

  it('sorts ids so two equal interest sets compare equal without normalizing', () => {
    createController({ daemonId: 'daemon-a', sessionId: 'sess-z' }).retain()
    createController({ daemonId: 'daemon-a', sessionId: 'sess-a' }).retain()

    expect(collectRetainedTranscriptSessionInterest().get('daemon-a')).toEqual(['sess-a', 'sess-z'])
  })
})

describe('subscribeTranscriptSessionInterest (unit 4c)', () => {
  it('★ fires on the retain edge — without this the binder never widens interest', () => {
    const controller = createController({ daemonId: 'daemon-a', sessionId: 'sess-1' })
    const listener = vi.fn()
    subscribeTranscriptSessionInterest(listener)

    controller.retain()

    expect(listener).toHaveBeenCalled()
  })

  it('★ fires on the release edge — without this a closed pane keeps its grant', () => {
    const controller = createController({ daemonId: 'daemon-a', sessionId: 'sess-1' })
    controller.retain()
    const listener = vi.fn()
    subscribeTranscriptSessionInterest(listener)

    controller.release()

    expect(listener).toHaveBeenCalled()
  })

  it('does not fire for a retain that changes nothing (no grant churn)', () => {
    const controller = createController({ daemonId: 'daemon-a', sessionId: 'sess-1' })
    controller.retain()
    const listener = vi.fn()
    subscribeTranscriptSessionInterest(listener)

    // A second consumer of an already-read controller: the interest set is
    // unchanged, so re-declaring would be pure churn.
    controller.retain()

    expect(listener).not.toHaveBeenCalled()
  })

  it('unsubscribing stops delivery', () => {
    const controller = createController({ daemonId: 'daemon-a', sessionId: 'sess-1' })
    const listener = vi.fn()
    subscribeTranscriptSessionInterest(listener)()

    controller.retain()

    expect(listener).not.toHaveBeenCalled()
  })
})
