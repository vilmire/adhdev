// Owner-attention park — hop 1: adapter status -> CLI provider instance state.
//
// adapter-status-projection turns an FsmState.owner_attention state (grok's
// "Help improve Grok" consent banner, a persistent workspace-trust prompt) into
// status `waiting_choice` + `ownerAttention: { stateId, message }` with no
// activeModal / activeInteractivePrompt. buildProviderState must carry that
// marker onto the instance state, or it dies at the adapter and the dashboard
// shows a buttonless waiting_choice with no explanation.
import { describe, expect, it } from 'vitest'
import { buildProviderState, resolveCliOwnerAttention, type ProviderStateHost } from '../../src/providers/cli-provider-state-projection.js'

const MARKER = { stateId: 'consent_banner', message: 'Owner attention: Grok data-retention consent' }

function makeHost(adapterStatus: Record<string, unknown>): ProviderStateHost {
  return {
    type: 'grok-cli',
    workingDir: '/tmp/ws/project',
    instanceId: 'inst-1',
    provider: { type: 'grok-cli', name: 'Grok', category: 'cli' } as any,
    presentationMode: 'terminal',
    settings: {},
    lastStatus: String(adapterStatus.status ?? 'idle'),
    errorMessage: undefined,
    errorReason: undefined,
    activeInteractivePrompt: null,
    controlValues: {},
    summaryMetadata: undefined,
    suppressIdleHistoryReplay: false,
    autoApproveBusy: false,
    historyWriter: { appendNewMessages: () => {} } as any,
    runtimeMessages: [],
    parsedIngestTimestamps: { stamp: (m: unknown[]) => m } as any,
    lastPersistedHistoryMessages: [],
    lastCompletionSummary: null,
    adapter: {
      getStatus: () => adapterStatus,
      getRuntimeMetadata: () => null,
    },
    stabilizeFlappingApprovalStatus: (s: any) => s,
    maybeAutoApproveStatus: () => false,
    autoApproveMaskStalled: () => false,
    maybeAppendRuntimeRecoveryMessage: () => {},
    shouldSuppressFreshLaunchStartupReplay: () => false,
    promoteProviderSessionId: () => {},
    shouldHydrateExistingProviderHistory: () => false,
    syncCanonicalSavedHistoryIfNeeded: () => false,
    shouldSuppressStaleParsedBusyStatus: () => false,
    applyProviderResponse: () => {},
  }
}

describe('resolveCliOwnerAttention', () => {
  it('carries the marker while the surfaced status is waiting_choice', () => {
    expect(resolveCliOwnerAttention(MARKER, 'waiting_choice')).toEqual(MARKER)
  })

  it('drops it for any other surfaced status (error overlay, auto-approve mask, reconcile)', () => {
    for (const status of ['idle', 'generating', 'waiting_approval', 'error', 'starting']) {
      expect(resolveCliOwnerAttention(MARKER, status)).toBeNull()
    }
  })

  it('rejects malformed markers', () => {
    expect(resolveCliOwnerAttention(undefined, 'waiting_choice')).toBeNull()
    expect(resolveCliOwnerAttention({ message: 'x' }, 'waiting_choice')).toBeNull()
    expect(resolveCliOwnerAttention({ stateId: '' }, 'waiting_choice')).toBeNull()
    expect(resolveCliOwnerAttention({ stateId: 's' }, 'waiting_choice')).toEqual({ stateId: 's', message: '' })
  })
})

describe('buildProviderState — owner attention', () => {
  it('threads the adapter park onto the instance state with no modal and no prompt', () => {
    const state = buildProviderState(makeHost({
      status: 'waiting_choice',
      activeModal: null,
      activeInteractivePrompt: null,
      ownerAttention: MARKER,
      messages: [],
    }))
    expect(state.status).toBe('waiting_choice')
    expect(state.ownerAttention).toEqual(MARKER)
    expect(state.activeChat?.activeModal).toBeNull()
    expect(state.activeInteractivePrompt).toBeNull()
  })

  it('is null (explicit) once the park clears', () => {
    const state = buildProviderState(makeHost({ status: 'idle', activeModal: null, messages: [] }))
    expect(state.status).toBe('idle')
    expect(state).toHaveProperty('ownerAttention', null)
  })
})
