// @vitest-environment jsdom
//
// Display-only grace for the replica-degraded banner. The controller flag
// (`transcriptReplicaDegraded`) still flips immediately; ChatPane waits this
// window before rendering the notice so a replica that re-attaches after a
// short transport bounce never flashes it.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReplicatedTranscriptSnapshotV1 } from '@adhdev/daemon-core'
import { SubscriptionManager } from '../../../src/managers/SubscriptionManager'
import {
  getOrCreateSessionChatTailController,
  resetSessionChatTailControllersForTest,
} from '../../../src/components/dashboard/session-chat-tail-controller'
import { buildTranscriptReadSourceAttributes } from '../../../src/components/dashboard/transcript-chat-pane-adapter'
import {
  REPLICA_DEGRADED_BANNER_GRACE_MS,
  shouldShowReplicaDegradedBanner,
  useReplicaDegradedBannerVisible,
} from '../../../src/components/dashboard/replica-degraded-banner'

// jsdom overrides the URL global, so build the path with node:path instead
// of fileURLToPath(new URL(...)) like the node-env source-slice tests do.
const CHAT_PANE_SOURCE = readFileSync(
  join(import.meta.dirname, '../../../src/components/dashboard/ChatPane.tsx'),
  'utf8',
)

const DAEMON = 'daemon-1'
const SESSION = 'session-1'
const SUBSCRIPTION_KEY = `daemon:${DAEMON}:session:${SESSION}`

function snapshot(overrides: Partial<ReplicatedTranscriptSnapshotV1> = {}): ReplicatedTranscriptSnapshotV1 {
  return {
    schemaVersion: 1,
    sessionId: SESSION,
    historySessionId: null,
    providerType: 'claude-cli',
    providerSessionId: null,
    producerDaemonId: DAEMON,
    producerWriterId: 'writer-1',
    producerEpoch: 'epoch-1',
    revision: 1,
    observedAt: '2026-09-05T00:00:00.000Z',
    status: 'idle',
    providerObservedStatus: null,
    title: null,
    activeModal: null,
    activeInteractivePrompt: null,
    turn: null,
    provenance: { messageSource: null, transcriptProvenance: null },
    messages: [],
    terminalMarkers: [],
    coverage: { mode: 'tail', totalMessageCount: 0, returnedMessageCount: 0, omittedBefore: false },
    ...overrides,
  }
}

function message(
  role: 'user' | 'assistant',
  content: string,
  receivedAt: number,
): ReplicatedTranscriptSnapshotV1['messages'][number] {
  return {
    role,
    kind: 'standard',
    content,
    receivedAt,
    timestamp: receivedAt,
    turnKey: `${role}-${receivedAt}`,
    bubbleState: 'final',
    senderName: null,
    toolName: null,
    streaming: null,
  } as ReplicatedTranscriptSnapshotV1['messages'][number]
}

function healthySnapshot(revision: number, ...contents: string[]) {
  return snapshot({
    revision,
    messages: contents.map((c, i) => message(i % 2 === 0 ? 'user' : 'assistant', c, 10 + i)),
  })
}

function setupController() {
  resetSessionChatTailControllersForTest()
  const manager = new SubscriptionManager()
  const sendData = vi.fn().mockReturnValue(true)
  const controller = getOrCreateSessionChatTailController({
    manager,
    sendData,
    daemonId: DAEMON,
    sessionId: SESSION,
    subscriptionKey: SUBSCRIPTION_KEY,
    tailLimit: 60,
  })
  return { manager, sendData, controller }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  resetSessionChatTailControllersForTest()
})

function BannerProbe({ degraded, resetKey }: { degraded: boolean; resetKey?: string }) {
  const visible = useReplicaDegradedBannerVisible(degraded, resetKey)
  return visible
    ? <div data-testid="transcript-replica-degraded-notice">shown</div>
    : <div data-testid="transcript-replica-degraded-hidden">hidden</div>
}

function renderBanner(degraded: boolean, resetKey?: string) {
  act(() => {
    root.render(<BannerProbe degraded={degraded} resetKey={resetKey} />)
  })
}

function bannerShown(): boolean {
  return container.querySelector('[data-testid="transcript-replica-degraded-notice"]') != null
}

describe('shouldShowReplicaDegradedBanner (pure display rule)', () => {
  it('hides while the replica is healthy, regardless of elapsed time', () => {
    expect(shouldShowReplicaDegradedBanner(false, 0)).toBe(false)
    expect(shouldShowReplicaDegradedBanner(false, REPLICA_DEGRADED_BANNER_GRACE_MS)).toBe(false)
    expect(shouldShowReplicaDegradedBanner(false, REPLICA_DEGRADED_BANNER_GRACE_MS * 4)).toBe(false)
  })

  it('hides a degraded replica until grace elapses', () => {
    expect(shouldShowReplicaDegradedBanner(true, 0)).toBe(false)
    expect(shouldShowReplicaDegradedBanner(true, REPLICA_DEGRADED_BANNER_GRACE_MS - 1)).toBe(false)
  })

  it('shows a degraded replica once grace has elapsed', () => {
    expect(shouldShowReplicaDegradedBanner(true, REPLICA_DEGRADED_BANNER_GRACE_MS)).toBe(true)
    expect(shouldShowReplicaDegradedBanner(true, REPLICA_DEGRADED_BANNER_GRACE_MS + 1_000)).toBe(true)
  })

  it('pins the grace in the 3–10s window the owner accepted for a display delay', () => {
    expect(REPLICA_DEGRADED_BANNER_GRACE_MS).toBeGreaterThanOrEqual(3_000)
    expect(REPLICA_DEGRADED_BANNER_GRACE_MS).toBeLessThanOrEqual(10_000)
  })
})

describe('useReplicaDegradedBannerVisible — banner render grace', () => {
  it('★ stays hidden for the whole grace when degraded recovers to false', () => {
    renderBanner(true)
    expect(bannerShown()).toBe(false)

    act(() => {
      vi.advanceTimersByTime(REPLICA_DEGRADED_BANNER_GRACE_MS - 1)
    })
    expect(bannerShown()).toBe(false)

    renderBanner(false)
    act(() => {
      vi.advanceTimersByTime(REPLICA_DEGRADED_BANNER_GRACE_MS + 1_000)
    })
    expect(bannerShown()).toBe(false)
  })

  it('★ renders once degraded stays true past grace', () => {
    renderBanner(true)
    expect(bannerShown()).toBe(false)

    act(() => {
      vi.advanceTimersByTime(REPLICA_DEGRADED_BANNER_GRACE_MS - 1)
    })
    expect(bannerShown()).toBe(false)

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(bannerShown()).toBe(true)
  })

  it('restarts grace on a fresh true after a recovery', () => {
    renderBanner(true)
    act(() => {
      vi.advanceTimersByTime(REPLICA_DEGRADED_BANNER_GRACE_MS)
    })
    expect(bannerShown()).toBe(true)

    renderBanner(false)
    expect(bannerShown()).toBe(false)

    renderBanner(true)
    expect(bannerShown()).toBe(false)
    act(() => {
      vi.advanceTimersByTime(REPLICA_DEGRADED_BANNER_GRACE_MS - 1)
    })
    expect(bannerShown()).toBe(false)
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(bannerShown()).toBe(true)
  })

  it('restarts grace when the pane identity changes while still degraded', () => {
    renderBanner(true, 'tab-a')
    act(() => {
      vi.advanceTimersByTime(REPLICA_DEGRADED_BANNER_GRACE_MS)
    })
    expect(bannerShown()).toBe(true)

    renderBanner(true, 'tab-b')
    expect(bannerShown()).toBe(false)
    act(() => {
      vi.advanceTimersByTime(REPLICA_DEGRADED_BANNER_GRACE_MS - 1)
    })
    expect(bannerShown()).toBe(false)
  })
})

describe('★ controller state is independent of banner grace', () => {
  it('sets and clears transcriptReplicaDegraded immediately while the banner waits', () => {
    const { controller } = setupController()
    controller.retain()
    controller.applyTranscriptReplicaSnapshot(healthySnapshot(2, 'replica answer'), { omittedBefore: false })
    expect(controller.getSnapshot().transcriptReplicaDegraded).toBe(false)

    controller.reportTranscriptReplicaFallback('no_node')
    expect(controller.getSnapshot().transcriptReplicaDegraded).toBe(true)
    expect(buildTranscriptReadSourceAttributes(controller.getSnapshot()))
      .toHaveProperty('data-transcript-replica-degraded', 'true')

    renderBanner(controller.getSnapshot().transcriptReplicaDegraded)
    expect(bannerShown()).toBe(false)

    act(() => {
      vi.advanceTimersByTime(REPLICA_DEGRADED_BANNER_GRACE_MS - 1)
    })
    expect(controller.getSnapshot().transcriptReplicaDegraded).toBe(true)
    expect(bannerShown()).toBe(false)

    controller.applyTranscriptReplicaSnapshot(healthySnapshot(5, 'replica answer', 'replica is back'), {
      omittedBefore: false,
    })
    expect(controller.getSnapshot().transcriptReplicaDegraded).toBe(false)
    expect(buildTranscriptReadSourceAttributes(controller.getSnapshot()))
      .not.toHaveProperty('data-transcript-replica-degraded')

    renderBanner(controller.getSnapshot().transcriptReplicaDegraded)
    act(() => {
      vi.advanceTimersByTime(REPLICA_DEGRADED_BANNER_GRACE_MS + 1_000)
    })
    expect(bannerShown()).toBe(false)
    expect(controller.getSnapshot().transcriptReplicaDegraded).toBe(false)
  })
})

describe('ChatPane wires the banner to the grace hook, not the raw flag', () => {
  it('imports and uses useReplicaDegradedBannerVisible', () => {
    expect(CHAT_PANE_SOURCE).toContain("import { useReplicaDegradedBannerVisible } from './replica-degraded-banner'")
    expect(CHAT_PANE_SOURCE).toContain('useReplicaDegradedBannerVisible(')
    expect(CHAT_PANE_SOURCE).toContain('showReplicaDegradedBanner')
  })

  it('does not render the notice from the raw controller flag', () => {
    expect(CHAT_PANE_SOURCE).not.toMatch(/\{\s*chatTailState\.transcriptReplicaDegraded\s*&&/)
    expect(CHAT_PANE_SOURCE).toMatch(/\{\s*showReplicaDegradedBanner\s*&&/)
    expect(CHAT_PANE_SOURCE).toContain('data-testid="transcript-replica-degraded-notice"')
  })
})
