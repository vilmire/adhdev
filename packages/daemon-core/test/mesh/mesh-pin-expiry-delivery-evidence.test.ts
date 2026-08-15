import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// DISPATCH-ACK-EVIDENCE. The `target_session_pin_expired` coordinator notification used to
// assert, unconditionally:
//
//   "Assume the addressed session never received this delta and is still acting on its
//    previous instructions. Re-send it to that session once it is idle."
//
// That is an inference from the absence of a coordinator-side CLAIM, and a claim proves
// nothing about the worker's inbox — "unclaimed" here means only that the queue row never
// left 'pending' within the pin TTL. Observed live 2026-08-11, four times in one session:
// the worker HAD received the delta and was already acting on it (mesh_read_terminal showed
// the work under way), so following the advice would have injected the same instruction
// twice. A duplicate injection is the more expensive error, so the notification must not
// recommend a re-send it cannot justify.
//
// The fix branches the guidance on what the durable delivery records actually witness:
//   consumed ('acked'/'completed')  → the worker started a turn for it → never re-send
//   delivered ('delivered')         → handed to the transport, no turn echo → verify first
//   no delivery row at all          → certainly not received → re-send (the original advice)

const testTmpDir = path.join(tmpdir(), `adhdev-pin-evidence-test-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')

vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: 'mach_evidence_test' } as any),
}))

vi.mock('../../src/config/mesh-config.js', () => ({
  getMesh: vi.fn(),
  getMeshByRepo: vi.fn(),
  listMeshes: vi.fn(() => [] as any[]),
}))

import { notifyCoordinatorOfActionableSkip } from '../../src/mesh/mesh-skip-notify.js'
import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, enqueueTask } from '../../src/mesh/mesh-work-queue.js'
import { createSessionDelivery, updateSessionDeliveryStatus } from '../../src/mesh/mesh-delivery-policy.js'
import { drainPendingMeshCoordinatorEvents } from '../../src/mesh/mesh-events-pending.js'

const NODE_ID = 'node_pin_evidence'
const SESSION_ID = 'sess-pinned-worker'
// notifyCoordinatorOfActionableSkip scopes the pending event to loadConfig().machineId,
// so the drain must ask for that same coordinator id.
const COORDINATOR_DAEMON_ID = 'mach_evidence_test'

function cleanup(meshId: string) {
  __clearMeshQueueForTests(meshId)
  __resetMeshRuntimeStoreForTests()
  try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
}

/** The coordinatorMessage the pin-expiry skip would surface for `taskId`. */
function notifiedMessage(meshId: string, taskId: string): string {
  notifyCoordinatorOfActionableSkip(meshId, taskId, 'target_session_pin_expired', NODE_ID)
  const events = drainPendingMeshCoordinatorEvents(meshId, COORDINATOR_DAEMON_ID) as any[]
  const hit = (events || []).find(e => (e?.metadataEvent?.taskId ?? e?.taskId) === taskId)
  return String(hit?.coordinatorMessage ?? '')
}

/** Create a delivery row for the task and drive it to `status`. */
function seedDelivery(meshId: string, taskId: string, status: 'delivered' | 'acked') {
  const d = createSessionDelivery({
    meshId, nodeId: NODE_ID, sessionId: SESSION_ID,
    providerType: 'claude-cli', taskId, kind: 'task',
    message: 'delta', status: 'delivering',
  } as any)
  updateSessionDeliveryStatus(d.id, status)
}

describe('DISPATCH-ACK-EVIDENCE — pin-expiry guidance must not claim a delta was lost when it was delivered', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('does NOT recommend re-sending when the worker demonstrably consumed the message', () => {
    const meshId = `mesh_pin_consumed_${randomUUID().slice(0, 8)}`
    try {
      const task = enqueueTask(meshId, 'DELTA-CONSUMED', { targetNodeId: NODE_ID, taskMode: 'code_change',
    difficulty: 'medium',
})
      // 'acked' == the worker emitted agent:generating_started — it HAS the message.
      seedDelivery(meshId, task.id, 'acked')

      const msg = notifiedMessage(meshId, task.id)

      // THE ASSERTION: the false "never received it, re-send" advice is gone, and the
      // duplicate-injection hazard is called out explicitly.
      expect(msg).not.toMatch(/never received this delta/i)
      expect(msg).toMatch(/Do NOT re-send/i)
      expect(msg).toMatch(/twice/i)
    } finally {
      cleanup(meshId)
    }
  })

  it('asks the coordinator to VERIFY (not assume) when the message was delivered but unconfirmed', () => {
    const meshId = `mesh_pin_delivered_${randomUUID().slice(0, 8)}`
    try {
      const task = enqueueTask(meshId, 'DELTA-DELIVERED', { targetNodeId: NODE_ID, taskMode: 'code_change',
    difficulty: 'medium',
})
      // Handed to the transport, but the worker never echoed a turn start.
      seedDelivery(meshId, task.id, 'delivered')

      const msg = notifiedMessage(meshId, task.id)

      expect(msg).not.toMatch(/never received this delta/i)
      expect(msg).toMatch(/Verify before re-sending/i)
      expect(msg).toMatch(/unconfirmed/i)
    } finally {
      cleanup(meshId)
    }
  })

  it('STILL recommends a re-send when no delivery was ever recorded (the genuine lost-delta case)', () => {
    const meshId = `mesh_pin_never_${randomUUID().slice(0, 8)}`
    try {
      const task = enqueueTask(meshId, 'DELTA-NEVER', { targetNodeId: NODE_ID, taskMode: 'code_change',
    difficulty: 'medium',
})
      // No delivery row at all — nothing was ever handed to a transport.

      const msg = notifiedMessage(meshId, task.id)

      // The original, CORRECT advice must survive for the case it was written for —
      // the fix narrows the claim, it does not remove it.
      expect(msg).toMatch(/never received this delta/i)
      expect(msg).toMatch(/Re-send it to that session/i)
    } finally {
      cleanup(meshId)
    }
  })

  it('drops the false "stays pending until you resolve it" clause (the pin is already cleared)', () => {
    const meshId = `mesh_pin_closing_${randomUUID().slice(0, 8)}`
    try {
      const task = enqueueTask(meshId, 'DELTA-CLOSING', { targetNodeId: NODE_ID, taskMode: 'code_change',
    difficulty: 'medium',
})

      const msg = notifiedMessage(meshId, task.id)

      // expireTaskTargetPin has already cleared the pin by the time this fires, so the row
      // is claimable by any compatible session — the old closing clause contradicted the
      // summary in the same sentence.
      expect(msg).not.toMatch(/the task stays pending until you resolve it/i)
      expect(msg).toMatch(/already been cleared/i)
    } finally {
      cleanup(meshId)
    }
  })

  it('leaves an unrelated actionable reason untouched (guidance change is scoped to pin expiry)', () => {
    const meshId = `mesh_pin_other_${randomUUID().slice(0, 8)}`
    try {
      const task = enqueueTask(meshId, 'DELTA-OTHER', { targetNodeId: NODE_ID, taskMode: 'code_change',
    difficulty: 'medium',
})
      notifyCoordinatorOfActionableSkip(meshId, task.id, 'no_node_satisfies_required_tags', NODE_ID)
      const events = drainPendingMeshCoordinatorEvents(meshId, COORDINATOR_DAEMON_ID) as any[]
      const msg = String((events || []).find(e => (e?.metadataEvent?.taskId ?? e?.taskId) === task.id)?.coordinatorMessage ?? '')

      // A genuine standing blocker keeps the original closing clause.
      expect(msg).toMatch(/required capability tags/i)
      expect(msg).toMatch(/it will NOT clear on its own/i)
    } finally {
      cleanup(meshId)
    }
  })

  it('does not call a provider scan result permanently blocked while keeping missing-provider action explicit', () => {
    const meshId = `mesh_provider_scan_wording_${randomUUID().slice(0, 8)}`
    try {
      const task = enqueueTask(meshId, 'PROVIDER-SCAN', { targetNodeId: NODE_ID, taskMode: 'code_change', difficulty: 'medium' })
      notifyCoordinatorOfActionableSkip(meshId, task.id, 'provider_priority_unusable: claude-cli: not detected; codex-cli: detect failed', NODE_ID)
      const events = drainPendingMeshCoordinatorEvents(meshId, COORDINATOR_DAEMON_ID) as any[]
      const msg = String((events || []).find(e => (e?.metadataEvent?.taskId ?? e?.taskId) === task.id)?.coordinatorMessage ?? '')

      expect(msg).toMatch(/current provider scan/i)
      expect(msg).toMatch(/needs action if it persists/i)
      expect(msg).toMatch(/missing, disabled, or misconfigured provider/i)
      expect(msg).toMatch(/later provider-status refresh.*can clear it/i)
      expect(msg).not.toMatch(/will NOT clear on its own/i)
      expect(msg).toMatch(/quota-gated candidates use a separate, self-resolving reason/i)
    } finally {
      cleanup(meshId)
    }
  })
})
