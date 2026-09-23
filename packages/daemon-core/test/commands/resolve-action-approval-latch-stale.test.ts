import { describe, expect, it, vi } from 'vitest'
import { handleResolveAction } from '../../src/commands/chat-commands.js'

/**
 * APPROVE-LATCH-STALE (live defect, 2026-09-23 — win32 + antigravity, 3/3 repro).
 *
 * The daemon log showed the shape this suite pins:
 *
 *   rawStatus=waiting_approval effectiveStatus=waiting_approval
 *   statusModal=no surfacedModal=no parsedModal=no instance=yes
 *   → error="Not in approval state"
 *
 * That is NOT a contradiction. The adapter's modal is refreshed only when the FSM
 * driver emits; the driver emits only on a PTY frame or an armed wake timer; and an
 * approval state whose exits are pure content guards arms no timer. A focus-event
 * TUI (agy) then draws the modal once and goes quiet, so the latch freezes at
 * whatever the ENTRY frame parsed — and a priority-90 `busy→approval-timeout` entry
 * has no modal anchor at all, so it legitimately latches null.
 *
 * Fix ① makes the approve path force one live re-parse before refusing.
 * Fix ③ stops the two distinct failures sharing one misleading message.
 */

/** The live shape: status is authoritatively waiting_approval, every modal source
 *  is empty, and a forced re-parse is what makes the real modal visible. */
function makeLatchStaleAdapter(opts: { modalAfterRefresh: boolean }) {
  const resolveModal = vi.fn()
  let latched: { message: string; buttons: string[] } | null = null
  const refreshModalNow = vi.fn(() => {
    if (opts.modalAfterRefresh) {
      latched = { message: 'Do you want to proceed?', buttons: ['Yes', 'No'] }
    }
    return !!latched
  })
  return {
    resolveModal,
    refreshModalNow,
    adapter: {
      // status never changes — only the modal latch does. This is the whole point:
      // status is FSM-derived and stays authoritative across the refresh.
      getStatus: () => ({ status: 'waiting_approval', messages: [], activeModal: latched }),
      resolveModal,
      refreshModalNow,
      isApprovalRecentlyResolved: () => false,
      writeRaw: vi.fn(),
    },
  }
}

function helpersFor(adapter: unknown, instanceState?: unknown) {
  return {
    getProvider: () => ({ type: 'antigravity-cli', category: 'cli', approvalPositiveHints: ['yes'] }),
    getCliAdapter: () => adapter as any,
    getCdp: () => null,
    getProviderScript: () => null,
    evaluateProviderScript: async () => null,
    currentSession: { transport: 'pty', providerType: 'antigravity-cli', sessionId: 'sess-latch' },
    currentProviderType: 'antigravity-cli',
    currentManagerKey: undefined,
    agentStream: null,
    ctx: {
      instanceManager: {
        getInstance: () => (instanceState === undefined ? null : { getState: () => instanceState }),
      },
    },
  } as any
}

const APPROVE_ARGS = { targetSessionId: 'sess-latch', agentType: 'antigravity-cli', action: 'approve' }

describe('handleResolveAction — stale approval-modal latch (APPROVE-LATCH-STALE)', () => {
  it('① approves after forcing a live re-parse when waiting_approval had no latched modal', async () => {
    const { adapter, resolveModal, refreshModalNow } = makeLatchStaleAdapter({ modalAfterRefresh: true })

    const result = await handleResolveAction(helpersFor(adapter), APPROVE_ARGS)

    expect(refreshModalNow).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ success: true, buttonIndex: 0, button: 'Yes' })
    expect(resolveModal).toHaveBeenCalledWith(0)
  })

  it('② returns the separated approvalModalUnavailable error when the re-parse still finds nothing', async () => {
    // Hypothesis (a) from the investigation: a `busy→approval-timeout` entry means
    // there may never have been a modal on screen at all, so re-reading returns null
    // too. The caller must get a message that says exactly that — not a claim the
    // session is "not in approval state", which flatly contradicts mesh_status.
    const { adapter, resolveModal, refreshModalNow } = makeLatchStaleAdapter({ modalAfterRefresh: false })

    const result = await handleResolveAction(helpersFor(adapter), APPROVE_ARGS)

    expect(refreshModalNow).toHaveBeenCalledTimes(1)
    expect(result.success).toBe(false)
    expect((result as any).approvalModalUnavailable).toBe(true)
    expect((result as any).refreshAttempted).toBe(true)
    expect((result as any).error).toContain('waiting_approval')
    expect((result as any).error).toContain('live re-parse')
    // The old, actively misleading wording must be gone from this branch.
    expect((result as any).error).not.toBe('Not in approval state')
    expect(resolveModal).not.toHaveBeenCalled()
  })

  it('③ does not re-parse when the modal is already latched (healthy path is untouched)', async () => {
    const refreshModalNow = vi.fn(() => true)
    const resolveModal = vi.fn()
    const adapter = {
      getStatus: () => ({
        status: 'waiting_approval',
        messages: [],
        activeModal: { message: 'Do you want to proceed?', buttons: ['Yes', 'No'] },
      }),
      resolveModal,
      refreshModalNow,
      isApprovalRecentlyResolved: () => false,
      writeRaw: vi.fn(),
    }

    const result = await handleResolveAction(helpersFor(adapter), APPROVE_ARGS)

    expect(refreshModalNow).not.toHaveBeenCalled()
    expect(result).toEqual({ success: true, buttonIndex: 0, button: 'Yes' })
    expect(resolveModal).toHaveBeenCalledWith(0)
  })

  it('④ keeps the isApprovalRecentlyResolved soft path ahead of the new error', async () => {
    // A benign race (the worker's own auto-approve already answered this modal)
    // must still report already_resolved, not the new hard error — even though the
    // status is waiting_approval and the re-parse comes up empty.
    const refreshModalNow = vi.fn(() => false)
    const resolveModal = vi.fn()
    const adapter = {
      getStatus: () => ({ status: 'waiting_approval', messages: [], activeModal: null }),
      resolveModal,
      refreshModalNow,
      isApprovalRecentlyResolved: () => true,
      writeRaw: vi.fn(),
    }

    const result = await handleResolveAction(helpersFor(adapter), APPROVE_ARGS)

    expect(result).toEqual({ success: true, alreadyResolved: true, status: 'already_resolved' })
    expect(resolveModal).not.toHaveBeenCalled()
  })

  it('⑤ still reports the plain "Not in approval state" when the status is genuinely not approval', async () => {
    // The separated message must not swallow the original case: an idle session with
    // no modal and nothing recently resolved is a real caller error, and no re-parse
    // should be attempted for it.
    const refreshModalNow = vi.fn(() => false)
    const resolveModal = vi.fn()
    const adapter = {
      getStatus: () => ({ status: 'idle', messages: [], activeModal: null }),
      resolveModal,
      refreshModalNow,
      isApprovalRecentlyResolved: () => false,
      writeRaw: vi.fn(),
    }

    const result = await handleResolveAction(helpersFor(adapter), APPROVE_ARGS)

    expect(result).toEqual({ success: false, error: 'Not in approval state' })
    expect(refreshModalNow).not.toHaveBeenCalled()
    expect(resolveModal).not.toHaveBeenCalled()
  })

  it('⑥ recovers when the instance projection masks activeModal but the adapter latch is refreshable', async () => {
    // Second, independent branch the investigation flagged: cli-provider-state-projection
    // nulls activeChat.activeModal whenever autoApproveActive — which is true for a
    // delegated worker with delegatedWorkerAutoApprove:true, whether or not a modal was
    // ever parsed. So surfacedModal is no help here by construction, and the adapter's
    // own refreshed latch has to carry the approve.
    const { adapter, resolveModal, refreshModalNow } = makeLatchStaleAdapter({ modalAfterRefresh: true })
    const maskedState = { activeChat: { status: 'generating', activeModal: null } }

    const result = await handleResolveAction(helpersFor(adapter, maskedState), APPROVE_ARGS)

    expect(refreshModalNow).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ success: true, buttonIndex: 0, button: 'Yes' })
    expect(resolveModal).toHaveBeenCalledWith(0)
  })

  it('⑦ legacy adapters with no refreshModalNow fall through without throwing', async () => {
    const resolveModal = vi.fn()
    const adapter = {
      getStatus: () => ({ status: 'waiting_approval', messages: [], activeModal: null }),
      resolveModal,
      isApprovalRecentlyResolved: () => false,
      writeRaw: vi.fn(),
    }

    const result = await handleResolveAction(helpersFor(adapter), APPROVE_ARGS)

    expect(result.success).toBe(false)
    expect((result as any).approvalModalUnavailable).toBe(true)
    expect((result as any).refreshAttempted).toBe(false)
    // Wording must reflect that no re-parse was possible, not claim one happened.
    expect((result as any).error).not.toContain('live re-parse')
    expect(resolveModal).not.toHaveBeenCalled()
  })
})
