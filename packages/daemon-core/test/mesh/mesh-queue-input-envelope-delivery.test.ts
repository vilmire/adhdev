import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// MESH-IMAGE-DISPATCH through the QUEUE (wiring-unification A5-2).
//
// Live defect: mesh_send_task's busy path routed the task through enqueueTask,
// which had no `input` field, so an image sent to a busy worker was queued as
// text only and the attachment silently vanished. Direct dispatch forwarded the
// envelope; the queue did not. This test drives the full queued path:
//
//   enqueueTask(input) → SQLite payload round-trip → claim (tryAssignQueueTask)
//   → the agent_command payload handed to cliManager.handleCliCommand
//
// and asserts the envelope arrives on the delivered payload exactly as the
// direct-dispatch path (mesh-tools-session mesh_send_task) would have sent it.

const testTmpDir = path.join(tmpdir(), `adhdev-mesh-queue-input-test-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')

vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: 'test-machine' } as any),
  getMachineId: () => 'test-machine',
  getMachineNickname: () => null,
}))

const meshConfigMocks = vi.hoisted(() => ({
  getMesh: vi.fn(),
  getMeshByRepo: vi.fn(),
  listMeshes: vi.fn(() => [] as any[]),
}))
vi.mock('../../src/config/mesh-config.js', () => ({
  getMesh: meshConfigMocks.getMesh,
  getMeshByRepo: meshConfigMocks.getMeshByRepo,
  listMeshes: meshConfigMocks.listMeshes,
}))

import { tryAssignQueueTask } from '../../src/mesh/mesh-events.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
import {
  __clearMeshQueueForTests,
  __resetMeshRuntimeStoreForTests,
  enqueueTask,
  getQueue,
  type MeshTaskInputEnvelope,
} from '../../src/mesh/mesh-work-queue.js'

const NODE = 'node_base'
const WS = '/repo/main'
const SESSION = 'sess-busy-then-idle'

const IMAGE_ENVELOPE: MeshTaskInputEnvelope = {
  parts: [
    { type: 'text', text: 'What is wrong with this screen?' },
    { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' },
  ],
}

function createComponents(meshId: string) {
  const settings: Record<string, unknown> = { meshNodeFor: meshId, providerType: 'claude-cli', meshNodeId: NODE }
  const instance = {
    getState: () => ({ settings, status: 'idle', instanceId: SESSION, type: 'claude-cli', workspace: WS }),
    updateSettings: vi.fn(),
  }
  const handleCliCommand = vi.fn(async () => ({ success: true }))
  return {
    components: {
      instanceManager: {
        getInstance: vi.fn((sid: string) => (sid === SESSION ? instance : undefined)),
        getByCategory: vi.fn((category: string) => (category === 'cli' ? [instance] : [])),
      },
      cliManager: {
        adapters: new Map<string, { workingDir: string }>(),
        handleCliCommand,
      },
      providerLoader: {
        resolveAlias: vi.fn((t: string) => t),
        isMachineProviderEnabled: vi.fn(() => true),
      },
      statusInstanceId: 'daemon-local',
      onStatusChange: vi.fn(),
    } as any,
    handleCliCommand,
  }
}

function cleanup(meshId: string) {
  __clearMeshQueueForTests(meshId)
  __resetMeshRuntimeStoreForTests()
  meshConfigMocks.getMesh.mockReset()
  try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
}

describe('MESH-IMAGE-DISPATCH: an input envelope queued for a busy target survives enqueue → store → claim → delivered payload', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('delivers the persisted envelope on the local claim dispatch exactly as direct dispatch would', () => {
    const meshId = `mesh_qinput_${randomUUID().slice(0, 8)}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId, name: 'Queue Input Mesh', policy: {},
        nodes: [{ id: NODE, workspace: WS, repoRoot: WS, policy: {} }],
      })
      const { components, handleCliCommand } = createComponents(meshId)

      // (1) enqueue — the busy path of mesh_send_task pins the task to node+session.
      const task = enqueueTask(meshId, 'What is wrong with this screen?', {
        targetNodeId: NODE,
        targetSessionId: SESSION,
        difficulty: 'medium',
        input: IMAGE_ENVELOPE,
      })
      expect(task.input).toEqual(IMAGE_ENVELOPE)

      // (2) store round-trip — the row is re-read from SQLite payload JSON.
      __resetMeshRuntimeStoreForTests()
      const stored = MeshRuntimeStore.getInstance().findQueueEntryById(meshId, task.id)
      expect(stored?.input).toEqual(IMAGE_ENVELOPE)
      expect(getQueue(meshId).find(t => t.id === task.id)?.input).toEqual(IMAGE_ENVELOPE)

      // (3) claim + deliver — the session went idle; the idle-transition funnel claims it.
      expect(tryAssignQueueTask(components, meshId, NODE, SESSION, 'claude-cli')).toBe(true)
      expect(getQueue(meshId).find(t => t.id === task.id)?.status).toBe('assigned')

      // (4) the delivered payload carries the envelope alongside the message, in the
      //     same top-level `input` slot the direct-dispatch path uses.
      expect(handleCliCommand).toHaveBeenCalledTimes(1)
      const [command, payload] = handleCliCommand.mock.calls[0] as [string, Record<string, unknown>]
      expect(command).toBe('agent_command')
      expect(payload.action).toBe('send_chat')
      expect(payload.targetSessionId).toBe(SESSION)
      expect(typeof payload.message).toBe('string')
      expect(payload.input).toEqual(IMAGE_ENVELOPE)
      expect((payload.meshContext as { taskId?: string })?.taskId).toBe(task.id)
    } finally {
      cleanup(meshId)
    }
  })

  it('a text-only task delivers a payload with no input key (byte-identical to before)', () => {
    const meshId = `mesh_qtext_${randomUUID().slice(0, 8)}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId, name: 'Queue Text Mesh', policy: {},
        nodes: [{ id: NODE, workspace: WS, repoRoot: WS, policy: {} }],
      })
      const { components, handleCliCommand } = createComponents(meshId)
      enqueueTask(meshId, 'plain text', { targetNodeId: NODE, targetSessionId: SESSION, difficulty: 'easy' })
      expect(tryAssignQueueTask(components, meshId, NODE, SESSION, 'claude-cli')).toBe(true)
      const [, payload] = handleCliCommand.mock.calls[0] as [string, Record<string, unknown>]
      expect('input' in payload).toBe(false)
    } finally {
      cleanup(meshId)
    }
  })
})
