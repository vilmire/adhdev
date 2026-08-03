import test from 'node:test'
import assert from 'node:assert/strict'
import { isSessionHostLiveRuntime } from '../src/runtime-labels.js'

test('a stopping record without a termination stamp is still live', () => {
  assert.equal(isSessionHostLiveRuntime({ lifecycle: 'stopping' }), true)
})

test('a running record is live', () => {
  assert.equal(isSessionHostLiveRuntime({ lifecycle: 'running' }), true)
})

test('a stopping record stamped with a termination is not live', () => {
  // A resurrected/stale file can carry lifecycle:'stopping' alongside a
  // termination stamp (self-contradictory: it already terminated). Such a
  // record must not surface as a live attach target for a PID that exited.
  assert.equal(
    isSessionHostLiveRuntime({ lifecycle: 'stopping', termination: { reason: 'exit' } }),
    false,
  )
})

test('a stopped record is never live regardless of termination', () => {
  assert.equal(isSessionHostLiveRuntime({ lifecycle: 'stopped' }), false)
  assert.equal(
    isSessionHostLiveRuntime({ lifecycle: 'stopped', termination: { reason: 'exit' } }),
    false,
  )
})

test('an explicit live_runtime surfaceKind wins regardless of termination', () => {
  assert.equal(
    isSessionHostLiveRuntime({ lifecycle: 'stopping', surfaceKind: 'live_runtime', termination: { reason: 'exit' } }),
    true,
  )
})

test('null/undefined records are not live', () => {
  assert.equal(isSessionHostLiveRuntime(null), false)
  assert.equal(isSessionHostLiveRuntime(undefined), false)
})
