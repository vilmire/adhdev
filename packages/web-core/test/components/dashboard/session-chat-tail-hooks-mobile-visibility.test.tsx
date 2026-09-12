// @vitest-environment jsdom
//
// ★ Replica visibility grace must cover mobile `pagehide`/`pageshow`, not
// just desktop `visibilitychange`.
//
// `session-chat-tail-hooks.ts` feeds `document.hidden`/`visible` edges into
// the controller's replica lease via `noteVisibilityChange` (see
// `replica-health-lease.test.ts` ★A③), but historically only listened to
// `visibilitychange`. Mobile Safari/PWA backgrounding (home button, app
// switcher, BFCache suspension) does not reliably fire `visibilitychange` —
// it fires `pagehide` on suspend and `pageshow` on resume instead. Without a
// listener for those events, minimizing the app on mobile banks zero hidden
// time, so the very next liveness tick on resume sees the full wall-clock gap
// as elapsed time and trips a false "replica degraded" fallback — even though
// nothing actually stalled.
//
// This test renders the real hook in jsdom and dispatches genuine
// `pagehide`/`pageshow` window events (no `visibilitychange` at all), proving
// the hook's OWN event wiring — not just the controller primitive it calls —
// covers the mobile path.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TransportProvider } from '../../../src/context/TransportContext'
import { useSessionChatTailController } from '../../../src/components/dashboard/session-chat-tail-hooks'
import {
  getOrCreateSessionChatTailController,
  resetSessionChatTailControllersForTest,
} from '../../../src/components/dashboard/session-chat-tail-controller'
import type { ActiveConversation } from '../../../src/components/dashboard/types'

const DAEMON = 'daemon-mobile-1'
const SESSION = 'session-mobile-1'
const SUBSCRIPTION_KEY = `daemon:${DAEMON}:session:${SESSION}`
const LEASE_MS = 20_000

const conversation: ActiveConversation = {
  routeId: DAEMON,
  daemonId: DAEMON,
  sessionId: SESSION,
  agentName: 'agent',
  agentType: 'claude-cli',
  status: 'generating',
  title: 'Session',
  messages: [],
  workspaceName: 'ws',
  displayPrimary: 'p',
  displaySecondary: 's',
  streamSource: 'native',
}

function Harness() {
  useSessionChatTailController(conversation, { tailLimit: 60 })
  return null
}

function renderHarness(sendData: ReturnType<typeof vi.fn>): Root {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <TransportProvider value={{ sendCommand: async () => ({}), sendData }}>
        <Harness />
      </TransportProvider>,
    )
  })
  return root
}

describe('★ useSessionChatTailController mobile pagehide/pageshow visibility grace', () => {
  let clock = 1_000_000
  let root: Root | null = null

  beforeEach(() => {
    clock = 1_000_000
    resetSessionChatTailControllersForTest()
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
  })

  afterEach(() => {
    if (root) {
      act(() => root!.unmount())
      root = null
    }
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  function advance(ms: number) {
    clock += ms
  }

  it('★ does NOT expire the replica lease when the hidden span is signaled ONLY via pagehide/pageshow (mobile minimize/resume)', () => {
    const sendData = vi.fn().mockReturnValue(true)
    root = renderHarness(sendData)

    const controller = getOrCreateSessionChatTailController({
      sendData,
      daemonId: DAEMON,
      sessionId: SESSION,
      subscriptionKey: SUBSCRIPTION_KEY,
      tailLimit: 60,
    })

    act(() => {
      controller.applyTranscriptReplicaSnapshot(
        {
          schemaVersion: 1,
          sessionId: SESSION,
          historySessionId: null,
          providerType: 'claude-cli',
          providerSessionId: null,
          producerDaemonId: DAEMON,
          producerWriterId: 'writer-1',
          producerEpoch: 'epoch-1',
          revision: 2,
          observedAt: new Date(clock).toISOString(),
          status: 'generating',
          providerObservedStatus: null,
          title: null,
          activeModal: null,
          activeInteractivePrompt: null,
          turn: null,
          provenance: { messageSource: null, transcriptProvenance: null },
          messages: [
            { role: 'user', kind: 'standard', content: 'q', receivedAt: 10, timestamp: 10, turnKey: 'user-10', bubbleState: 'final', senderName: null, toolName: null, streaming: null },
            { role: 'assistant', kind: 'standard', content: 'a', receivedAt: 11, timestamp: 11, turnKey: 'assistant-11', bubbleState: 'final', senderName: null, toolName: null, streaming: null },
          ],
          terminalMarkers: [],
          coverage: { mode: 'tail', totalMessageCount: 2, returnedMessageCount: 2, omittedBefore: false },
        } as never,
        { omittedBefore: false },
      )
    })

    // Mobile app minimized via home button/app switcher: `pagehide` fires,
    // `visibilitychange` does NOT (the historical gap this fix closes).
    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })
    // Exactly the lease window. `expireStaleReplicaLease` trips `laneStalled`
    // at `elapsed >= LEASE_MS` but bails out as "busy stamp too old to be
    // meaningful" once `elapsed > LEASE_MS` — so this is the one gap size
    // that is simultaneously "armed" and "stalled" with ZERO hidden discount,
    // which is exactly the reading a mobile minimize must NOT produce. With
    // the fix, the hidden discount brings the effective elapsed time under
    // the stall threshold entirely.
    advance(LEASE_MS)
    // App resumed from the app switcher / BFCache: `pageshow` fires.
    act(() => {
      window.dispatchEvent(new Event('pageshow'))
    })

    act(() => {
      controller.shouldRefreshForLiveness()
    })

    expect(controller.getSnapshot().transcriptReadSource).toBe('replica')
    expect(controller.getSnapshot().transcriptReplicaDegraded).not.toBe(true)
    expect(controller.getSnapshot().transcriptFallbackReason).not.toBe('replica_lease_expired')
    expect(controller.getSnapshot().transcriptFallbackReason).not.toBe('replica_screen_stalled')
  })
})
