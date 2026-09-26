/**
 * Coordinator-held node RUNTIME (sessions / build / upgrade marker / facts incl.
 * quota): the member pushes a content-free summary beside its git state, the
 * coordinator holds it (mesh-runtime.db) and mesh_status answers from it — no
 * per-daemon get_status_metadata on the request path (owner principle 2026-09-26).
 */
import { describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import {
  buildMeshNodeRuntimeSummary,
  computeMeshNodeRuntimeSignature,
  sanitizeMeshNodeRuntimeSummary,
  MESH_NODE_RUNTIME_MAX_SESSIONS,
} from '../../src/mesh/mesh-node-runtime-summary'
import {
  MeshNodeGitStateStore,
  createDbMeshNodeGitStatePersistence,
  ensureMeshNodeGitStateSchema,
} from '../../src/mesh/mesh-node-git-state'
import { MeshNodeStatePusher } from '../../src/mesh/mesh-node-state-pusher'
import { MeshNodeGitRefresher } from '../../src/mesh/mesh-node-git-refresher'
import {
  kickMeshNodeGitRefreshes,
  overlayMeshNodeGitObservations,
} from '../../src/commands/high-family/mesh-status-node-state'

const MESH = 'mesh_runtime'
const NODE = 'node_remote'
const WS = '/Users/remote/work/repo'

function statusMetadata(overrides: { sessions?: any[]; upgradeFailure?: any } = {}) {
  return {
    success: true,
    status: {
      instanceId: 'daemon_remote',
      sessions: overrides.sessions ?? [{
        id: 'sess-1',
        instanceId: 'sess-1',
        providerType: 'claude-cli',
        transport: 'pty',
        status: 'generating',
        title: 'Refactor the payment module for ACME',
        lastMessagePreview: 'I changed the secret key rotation in billing.ts',
        lastMessageRole: 'assistant',
        lastMessageAt: 1_700_000_000_000,
        activeChat: { status: 'generating', title: 'chat title', messages: [{ role: 'user', content: 'private prompt' }] },
        turn: { attemptId: 'att-1', stage: 'delivered', summary: 'free text' },
        coordinator: { meshId: MESH, prompt: 'coordinator prompt text' },
        settings: { userHidden: false, meshNodeFor: MESH, notes: 'free text', systemPrompt: 'secret' },
        model: 'claude-opus',
      }],
    },
    daemonBuild: { commit: 'abcdef0123456789', commitShort: 'abcdef0', version: '1.0.60-rc.2', track: 'preview' },
    upgradeFailure: overrides.upgradeFailure ?? null,
  }
}

const FACTS = { schemaVersion: 1, reportedAt: 5_000, quota: { 'claude-cli': { status: 'ok', windows: [{ usedPercent: 12, updatedAt: 4_000 }] } } }

describe('runtime summary — content-free allow-list', () => {
  it('keeps ids / enums / booleans / timestamps and drops every free-text field', () => {
    const summary = buildMeshNodeRuntimeSummary(statusMetadata({
      upgradeFailure: { notice: '[2026-09-27T00:00:00Z]\nnpm ERR! EACCES /Users/alice/secret', noticePath: '/p/notice.txt', logPath: '/p/log', recordedAt: '2026-09-27T00:00:00Z', targetVersion: '1.0.60-rc.3' },
    }), FACTS)!
    expect(summary.daemonId).toBe('daemon_remote')
    expect(summary.daemonBuild).toEqual({ commit: 'abcdef0123456789', commitShort: 'abcdef0', version: '1.0.60-rc.2', track: 'preview' })
    expect(summary.upgradeFailure).toEqual({ recordedAt: '2026-09-27T00:00:00Z', targetVersion: '1.0.60-rc.3', noticePath: '/p/notice.txt', logPath: '/p/log' })
    expect(summary.sessions).toEqual([{
      id: 'sess-1',
      instanceId: 'sess-1',
      providerType: 'claude-cli',
      transport: 'pty',
      status: 'generating',
      model: 'claude-opus',
      lastMessageRole: 'assistant',
      lastMessageAt: 1_700_000_000_000,
      activeChat: { status: 'generating' },
      turn: { attemptId: 'att-1', stage: 'delivered' },
      coordinator: { meshId: MESH },
      settings: { userHidden: false, meshNodeFor: MESH },
    }])
    expect(summary.nodeFacts?.quota).toEqual(FACTS.quota)
    const wire = JSON.stringify(summary)
    for (const text of ['ACME', 'secret key rotation', 'private prompt', 'free text', 'coordinator prompt', 'EACCES', 'chat title']) {
      expect(wire).not.toContain(text)
    }
    // Idempotent: the coordinator re-sanitizes at ingest.
    expect(sanitizeMeshNodeRuntimeSummary(summary)).toEqual(summary)
  })

  it('drops multi-line / oversized "ids" and non-enum roles, and caps the session list', () => {
    const sessions = Array.from({ length: MESH_NODE_RUNTIME_MAX_SESSIONS + 5 }, (_, i) => ({ id: `s-${i}`, status: 'idle', lastMessageRole: i === 0 ? 'Assistant said: hi' : 'user', model: i === 1 ? 'x'.repeat(500) : undefined, providerType: i === 2 ? 'a\nb' : 'claude-cli' }))
    const summary = sanitizeMeshNodeRuntimeSummary({ sessions })!
    expect(summary.sessions).toHaveLength(MESH_NODE_RUNTIME_MAX_SESSIONS)
    expect(summary.sessionsTruncated).toBe(true)
    expect(summary.sessions[0].lastMessageRole).toBeUndefined()
    expect(summary.sessions[1].model).toBeUndefined()
    expect(summary.sessions[2].providerType).toBeUndefined()
  })

  it('signature ignores timestamps (lastMessageAt, facts/quota stamps) but not status', () => {
    const a = buildMeshNodeRuntimeSummary(statusMetadata(), FACTS)!
    const b = buildMeshNodeRuntimeSummary(statusMetadata({ sessions: [{ ...statusMetadata().status.sessions[0], lastMessageAt: 1_800_000_000_000 }] }), { ...FACTS, reportedAt: 9_000, quota: { 'claude-cli': { status: 'ok', windows: [{ usedPercent: 12, updatedAt: 8_000 }] } } })!
    expect(computeMeshNodeRuntimeSignature(a)).toBe(computeMeshNodeRuntimeSignature(b))
    const c = buildMeshNodeRuntimeSummary(statusMetadata({ sessions: [{ ...statusMetadata().status.sessions[0], status: 'idle' }] }), FACTS)!
    expect(computeMeshNodeRuntimeSignature(c)).not.toBe(computeMeshNodeRuntimeSignature(a))
    const d = buildMeshNodeRuntimeSummary(statusMetadata(), { ...FACTS, quota: { 'claude-cli': { status: 'ok', windows: [{ usedPercent: 80, updatedAt: 4_000 }] } } })!
    expect(computeMeshNodeRuntimeSignature(d)).not.toBe(computeMeshNodeRuntimeSignature(a))
  })
})

describe('member push — runtime half', () => {
  function gitStatus(head = 'h1') {
    return { isGitRepo: true, branch: 'main', headCommit: head, upstream: 'origin/main', upstreamStatus: 'fresh', upstreamFetchedAt: 1, ahead: 0, behind: 0 }
  }

  it('carries the runtime on the check tick, stays quiet while unchanged, and pushes a debounced runtime-only report on a lifecycle change', async () => {
    let now = 1_000_000
    let runtime: any = buildMeshNodeRuntimeSummary(statusMetadata(), FACTS)
    const dispatch = vi.fn(async () => ({ success: true, accepted: true }))
    const debounced: Array<() => void> = []
    const pusher = new MeshNodeStatePusher({
      dispatch,
      readGit: async () => gitStatus(),
      readRuntime: async () => runtime,
      now: () => now,
      startTimer: () => ({ stop() {} }),
      startDebounce: (fn) => { debounced.push(fn); return { stop() {} } },
    })
    pusher.register({ coordinatorDaemonId: 'coord', meshId: MESH, nodeId: NODE, workspace: WS, git: gitStatus() })
    // A new subscription schedules the runtime push right away (not on the next tick).
    expect(debounced).toHaveLength(1)
    debounced.shift()!()
    await pusher.pushRuntimeChanges()
    expect(dispatch).toHaveBeenCalledTimes(1)
    const first = (dispatch.mock.calls[0] as any)[2]
    expect(first.git).toBeUndefined()
    expect(first.runtime.sessions[0]).toMatchObject({ id: 'sess-1', status: 'generating' })
    expect(JSON.stringify(first)).not.toContain('secret key rotation')

    // The first tick after a (re-)registration pushes once — the coordinator's
    // held state becomes member-pushed, so it stops probing this node.
    now += 60_000
    await pusher.tick()
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect((dispatch.mock.calls[1] as any)[2].git).toMatchObject({ headCommit: 'h1' })
    now += 60_000
    await pusher.tick()
    expect(dispatch).toHaveBeenCalledTimes(2) // git and runtime unchanged since the last push

    // A lifecycle change: one debounced runtime-only push.
    runtime = buildMeshNodeRuntimeSummary(statusMetadata({ sessions: [{ id: 'sess-1', providerType: 'claude-cli', status: 'idle' }] }), FACTS)
    pusher.noteRuntimeChanged()
    pusher.noteRuntimeChanged() // coalesced
    expect(debounced).toHaveLength(1)
    debounced.shift()!()
    await pusher.pushRuntimeChanges()
    expect(dispatch).toHaveBeenCalledTimes(3)
    expect((dispatch.mock.calls[2] as any)[2].runtime.sessions[0].status).toBe('idle')

    // Quota moved (picked up by the next check tick, alongside git).
    runtime = buildMeshNodeRuntimeSummary(statusMetadata({ sessions: [{ id: 'sess-1', providerType: 'claude-cli', status: 'idle' }] }), { ...FACTS, quota: { 'claude-cli': { status: 'ok', windows: [{ usedPercent: 90 }] } } })
    now += 60_000
    await pusher.tick()
    expect(dispatch).toHaveBeenCalledTimes(4)
    const third = (dispatch.mock.calls[3] as any)[2]
    expect(third.git).toMatchObject({ headCommit: 'h1' })
    expect(third.runtime.nodeFacts.quota['claude-cli'].windows[0].usedPercent).toBe(90)
    pusher.stop()
  })
})

describe('coordinator store + overlay', () => {
  it('holds the runtime, stamps heldRuntime on foreign-daemon nodes only, and serves the newer facts bundle (quota)', () => {
    const store = new MeshNodeGitStateStore()
    const refresher = new MeshNodeGitRefresher({ store, probe: async () => null, onSettled: () => {} })
    const runtime = buildMeshNodeRuntimeSummary(statusMetadata(), FACTS)
    const first = store.recordRuntimeObservation({ meshId: MESH, nodeId: NODE, workspace: WS, runtime, source: 'member_push', observedAt: 7_000 })
    expect(first).toMatchObject({ changed: true, factsChanged: true })
    const again = store.recordRuntimeObservation({ meshId: MESH, nodeId: NODE, workspace: WS, runtime, source: 'member_push', observedAt: 8_000 })
    expect(again).toMatchObject({ changed: false, factsChanged: false })
    // An older (delayed) report never rolls the held runtime back.
    const stale = store.recordRuntimeObservation({ meshId: MESH, nodeId: NODE, workspace: WS, runtime: { sessions: [] }, source: 'coordinator_probe', observedAt: 6_000 })
    expect(stale.changed).toBe(false)
    expect(store.get(MESH, NODE)!.runtime!.sessions).toHaveLength(1)

    const snapshot: any = {
      nodes: [
        { nodeId: 'node_self', daemonId: 'daemon_local', connection: { state: 'self' }, workspace: '/nope' },
        { nodeId: NODE, daemonId: 'daemon_remote', connection: { state: 'unknown' }, workspace: WS, nodeFacts: { schemaVersion: 1, reportedAt: 1_000, quota: { 'claude-cli': { status: 'ok', windows: [{ usedPercent: 1 }] } } } },
        { nodeId: 'node_other', daemonId: 'daemon_other', connection: { state: 'unknown' }, workspace: '/x' },
      ],
    }
    overlayMeshNodeGitObservations(snapshot, { meshId: MESH, store, refresher, locality: { localDaemonId: 'daemon_local' } })
    expect(snapshot.nodeRuntimeHeld).toBe(true)
    expect(snapshot.nodes[0].heldRuntime).toBeUndefined()
    expect(snapshot.nodes[1].heldRuntime).toMatchObject({ source: 'member_push', observedAt: 8_000, refreshing: false, daemonId: 'daemon_remote' })
    expect(snapshot.nodes[1].heldRuntime.sessions[0]).toMatchObject({ id: 'sess-1', status: 'generating' })
    expect(snapshot.nodes[1].nodeFacts.reportedAt).toBe(5_000)
    expect(snapshot.nodes[1].nodeFacts.quota['claude-cli'].windows[0].usedPercent).toBe(12)
    expect(snapshot.nodes[2].heldRuntime).toEqual({ source: 'none', observedAt: null, refreshing: false, sessions: [] })
  })

  it('an older member that never pushes runtime gets ONE background get_status_metadata per daemon, never awaited', async () => {
    const store = new MeshNodeGitStateStore()
    let release!: (value: unknown) => void
    const probeRuntime = vi.fn(() => new Promise<Record<string, unknown> | null>((resolve) => { release = resolve as any }))
    const onSettled = vi.fn()
    const refresher = new MeshNodeGitRefresher({ store, probe: async () => null, onSettled, probeRuntime })
    const mesh = {
      nodes: [
        { id: 'n1', daemonId: 'daemon_old', workspace: '/remote/a' },
        { id: 'n2', daemonId: 'daemon_old', workspace: '/remote/b' },
        { id: 'n3', daemonId: 'daemon_local', workspace: '/remote/c' },
      ],
    }
    kickMeshNodeGitRefreshes({ meshId: MESH, mesh, store, refresher, locality: { localDaemonId: 'daemon_local' }, refresh: false })
    expect(probeRuntime).toHaveBeenCalledTimes(1)
    expect(probeRuntime).toHaveBeenCalledWith('daemon_old')
    expect(refresher.isRuntimeRefreshing(MESH, 'daemon_old')).toBe(true)
    // A second call while in flight starts nothing.
    kickMeshNodeGitRefreshes({ meshId: MESH, mesh, store, refresher, locality: { localDaemonId: 'daemon_local' }, refresh: true })
    expect(probeRuntime).toHaveBeenCalledTimes(1)

    release(buildMeshNodeRuntimeSummary(statusMetadata()))
    await refresher.whenIdle()
    expect(store.get(MESH, 'n1')!.runtimeSource).toBe('coordinator_probe')
    expect(store.get(MESH, 'n2')!.runtime!.sessions[0].id).toBe('sess-1')
    expect(store.get(MESH, 'n3')?.runtime ?? null).toBeNull()
  })
})

describe('runtime persistence', () => {
  it('survives a coordinator restart, and migrates a git-only table from the earlier build in place', () => {
    const db = new Database(':memory:')
    // The table as the previous build created it (no runtime columns), with a row.
    db.exec(`CREATE TABLE mesh_node_git_state (
      mesh_id TEXT NOT NULL, node_id TEXT NOT NULL, workspace TEXT NOT NULL DEFAULT '', git_json TEXT, observed_at INTEGER,
      source TEXT, signature TEXT, unreachable_since INTEGER, last_failure_at INTEGER, last_failure_reason TEXT,
      PRIMARY KEY (mesh_id, node_id))`)
    db.prepare('INSERT INTO mesh_node_git_state (mesh_id, node_id, workspace, git_json, observed_at, source) VALUES (?, ?, ?, ?, ?, ?)')
      .run(MESH, 'node_old', '/w', JSON.stringify({ isGitRepo: true, branch: 'main' }), 100, 'member_push')
    ensureMeshNodeGitStateSchema(db as any)
    ensureMeshNodeGitStateSchema(db as any) // idempotent
    const persistence = createDbMeshNodeGitStatePersistence(() => db as any)
    const before = new MeshNodeGitStateStore(persistence)
    expect(before.get(MESH, 'node_old')).toMatchObject({ observedAt: 100, runtime: null })
    before.recordRuntimeObservation({ meshId: MESH, nodeId: NODE, workspace: WS, runtime: buildMeshNodeRuntimeSummary(statusMetadata(), FACTS), source: 'member_push', observedAt: 123 })

    const after = new MeshNodeGitStateStore(persistence)
    const entry = after.get(MESH, NODE)!
    expect(entry).toMatchObject({ runtimeSource: 'member_push', runtimeObservedAt: 123 })
    expect(entry.runtime!.sessions[0].id).toBe('sess-1')
    expect(entry.runtime!.nodeFacts?.quota).toEqual(FACTS.quota)
    expect(entry.git).toBeNull()
    db.close()
  })
})
