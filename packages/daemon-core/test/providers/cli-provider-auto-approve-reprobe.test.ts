import { describe, expect, it, vi } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'

// APPROVAL Defect-C (auto-approve gap): the settle re-check timer is the ONLY thing that
// re-drives auto-approve when the PTY goes silent after the approval prompt finishes
// painting. It used getStatus({ allowParse: false }), which reads only the cached
// engine.activeModal — null/stale when the modal arrived between writes — so the re-check
// saw no modal and auto-approve never fired (forcing a manual coordinator mesh_approve).
// It must re-probe LIVE (allowParse:true) so the current screen buffer is re-parsed and the
// transient/quiet modal is recovered.
describe('recheckAutoApproveSettled live re-probe', () => {
  function makeInstance() {
    const instance = Object.create(CliProviderInstance.prototype) as any
    const getStatus = vi.fn(() => ({ status: 'waiting_approval', activeModal: { message: 'Allow?', buttons: ['Yes', 'No'] } }))
    instance.adapter = { getStatus }
    // Isolate the re-probe: assert only that the live-parse status is forwarded.
    instance.maybeAutoApproveStatus = vi.fn()
    return { instance, getStatus }
  }

  it('re-probes the adapter with allowParse:true (a live screen re-parse)', () => {
    const { instance, getStatus } = makeInstance()
    instance.recheckAutoApproveSettled()
    expect(getStatus).toHaveBeenCalledTimes(1)
    expect(getStatus).toHaveBeenCalledWith({ allowParse: true })
  })

  it('forwards the freshly parsed status to maybeAutoApproveStatus', () => {
    const { instance } = makeInstance()
    instance.recheckAutoApproveSettled()
    expect(instance.maybeAutoApproveStatus).toHaveBeenCalledTimes(1)
    const forwarded = instance.maybeAutoApproveStatus.mock.calls[0][0]
    expect(forwarded.status).toBe('waiting_approval')
    expect(forwarded.activeModal.buttons).toEqual(['Yes', 'No'])
  })

  it('swallows adapter errors (transient — next frame retries)', () => {
    const instance = Object.create(CliProviderInstance.prototype) as any
    instance.adapter = { getStatus: () => { throw new Error('adapter gone') } }
    instance.maybeAutoApproveStatus = vi.fn()
    expect(() => instance.recheckAutoApproveSettled()).not.toThrow()
    expect(instance.maybeAutoApproveStatus).not.toHaveBeenCalled()
  })
})
