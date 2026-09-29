/**
 * rc.61 live regression: after mesh_restart_daemon upgraded remote members, the
 * coordinator kept reporting their PREVIOUS daemonBuild for 7+ minutes. A
 * restarted member lost its in-memory push subscription and stayed silent, and
 * the coordinator only re-handshakes a member-pushed node once its held state is
 * older than MESH_NODE_STATE_STALE_MS (600 s).
 *
 * Fixed on three edges, all event-driven (no polling):
 *   - member: the push subscription set survives a restart and is pushed as soon
 *     as the mesh transport / the link to the coordinator is up;
 *   - coordinator: a member's link (re)opening handshakes its held nodes now
 *     (a nudge — which also re-subscribes a member that lost its subscription;
 *     the coordinator never probes);
 *   - coordinator: restart_daemon_node forwarded to a member marks its held build
 *     pending, so the new process's first report is taken even with an older
 *     timestamp, and the replaced build is not served as live meanwhile.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const buildState = vi.hoisted(() => ({
  current: { commit: 'c60c60c60', commitShort: 'c60c60c', version: '1.0.60-rc.60' } as Record<string, string>,
}))
vi.mock('../../src/build-info', async (importOriginal) => {
  const original = await importOriginal<any>()
  return { ...original, getDaemonBuildInfo: () => ({ ...buildState.current }) }
})

import { DaemonCommandRouter } from '../../src/commands/router'
import { cleanupTempDir } from '../helpers/temp-cleanup.js'
import { MeshNodeGitStateStore } from '../../src/mesh/mesh-node-git-state'
import { MeshNodeGitRefresher, isHeldRuntimeLive } from '../../src/mesh/mesh-node-git-refresher'
import { MeshNodeStatePusher } from '../../src/mesh/mesh-node-state-pusher'
import { MESH_SENDER_DAEMON_ID_ARG } from '../../src/commands/mesh-sender'
import { createDefaultGitCommandServices } from '../../src/git/git-commands'
import { kickMeshNodeGitRefreshes } from '../../src/commands/high-family/mesh-status-node-state'

const execFileAsync = promisify(execFile)

const MESH_ID = 'mesh_restart_handshake'
const COORD_DAEMON = 'daemon_local'
const MEMBER_DAEMON = 'daemon_member'
const MEMBER_NODE = 'node_member'
const REMOTE_WORKSPACE = '/Users/remote/work/restart-handshake'

const RC60 = { commit: 'c60c60c60', commitShort: 'c60c60c', version: '1.0.60-rc.60' }
const RC61 = { commit: 'c61c61c61', commitShort: 'c61c61c', version: '1.0.61-rc.61' }

async function createTempGitRepo(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  const repoRoot = join(dir, 'repo')
  await execFileAsync('git', ['init', repoRoot])
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot })
  await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repoRoot })
  await writeFile(join(repoRoot, 'README.md'), '# test\n')
  await execFileAsync('git', ['add', 'README.md'], { cwd: repoRoot })
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repoRoot })
  return { dir, repoRoot }
}

function remoteGit(overrides: Record<string, unknown> = {}) {
  return {
    isGitRepo: true, workspace: REMOTE_WORKSPACE, repoRoot: REMOTE_WORKSPACE, branch: 'main', headCommit: 'abc12345',
    upstream: 'origin/main', upstreamStatus: 'fresh', ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0,
    deleted: 0, renamed: 0, hasConflicts: false, stashCount: 0, submodules: [],
    ...overrides,
  }
}

function runtimeOf(build: Record<string, string>, bootId: string) {
  return { schemaVersion: 1, daemonId: MEMBER_DAEMON, daemonBootId: bootId, daemonBuild: { ...build, track: 'preview' }, sessions: [] }
}

function meshWith(memberWorkspace: string, coordWorkspace: string) {
  return {
    id: MESH_ID,
    name: 'restart handshake',
    repoIdentity: 'github.com/acme/restart-handshake',
    defaultBranch: 'main',
    coordinator: { preferredNodeId: 'node_coord' },
    policy: {},
    nodes: [
      { id: 'node_coord', daemonId: COORD_DAEMON, workspace: coordWorkspace, repoRoot: coordWorkspace, providers: [], policy: {} },
      { id: MEMBER_NODE, daemonId: MEMBER_DAEMON, workspace: memberWorkspace, repoRoot: memberWorkspace, providers: [], policy: {} },
    ],
  }
}

function createRouter(opts: {
  dispatchMeshCommand?: (daemonId: string, cmd: string, args: Record<string, unknown>) => Promise<unknown>
  onMeshStateChange?: (meshId: string) => void
  store?: MeshNodeGitStateStore
  statusInstanceId?: string
}) {
  return new DaemonCommandRouter({
    commandHandler: {
      handle: vi.fn(async () => ({ success: false })),
      handleSpec: vi.fn(async (spec: any, args: any) => spec.run(createDefaultGitCommandServices(), args)),
    } as any,
    cliManager: { restoreHostedSessions: vi.fn(async () => {}) } as any,
    cdpManagers: new Map(),
    providerLoader: {} as any,
    instanceManager: { collectAllStates: () => [], listInstanceIds: () => [], getInstance: () => null, getByCategory: () => [] } as any,
    detectedIdes: { value: [] },
    sessionRegistry: {} as any,
    sessionHostControl: { listSessions: vi.fn(async () => []) } as any,
    dispatchMeshCommand: opts.dispatchMeshCommand,
    onMeshStateChange: opts.onMeshStateChange,
    statusInstanceId: opts.statusInstanceId ?? COORD_DAEMON,
    meshNodeGitStateStore: opts.store,
  })
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return check()
}

/** The host's lifecycle hooks (absent on a daemon without the fix — then nothing happens). */
function bootMember(router: DaemonCommandRouter, coordinatorDaemonId: string) {
  const r = router as any
  void r.resumeMeshNodeStatePushOnStartup?.()
  r.noteMeshTransportReady?.()
  r.noteMeshPeerOpened?.(coordinatorDaemonId)
}

let configDir = ''
let previousConfigDir: string | undefined
beforeEach(async () => {
  // A fresh config dir per test: the persisted push subscriptions live there.
  previousConfigDir = process.env.ADHDEV_CONFIG_DIR
  configDir = await mkdtemp(join(tmpdir(), 'restart-handshake-config-'))
  process.env.ADHDEV_CONFIG_DIR = configDir
  buildState.current = { ...RC60 }
})
afterEach(async () => {
  process.env.ADHDEV_CONFIG_DIR = previousConfigDir
  await cleanupTempDir(configDir)
})

describe('member restart → coordinator reflects the new daemonBuild promptly', () => {
  it('a restarted member (subscription lost with its process) pushes its new build at boot, without the coordinator asking', async () => {
    const coordRepo = await createTempGitRepo('restart-coord-')
    const memberRepo = await createTempGitRepo('restart-member-')
    const routers: DaemonCommandRouter[] = []
    try {
      let coordinator!: DaemonCommandRouter
      const memberDispatch = vi.fn(async (_daemonId: string, cmd: string, args: Record<string, unknown>) =>
        coordinator.execute(cmd, { ...args, [MESH_SENDER_DAEMON_ID_ARG]: MEMBER_DAEMON }, 'mesh'))
      // The coordinator never reaches the member itself in this test: whatever it
      // learns after the restart, the member told it.
      const coordDispatch = vi.fn(() => new Promise<unknown>(() => {}))
      const store = new MeshNodeGitStateStore()
      coordinator = createRouter({ dispatchMeshCommand: coordDispatch, store })
      routers.push(coordinator)
      await coordinator.execute('mesh_status', { meshId: MESH_ID, inlineMesh: meshWith(memberRepo.repoRoot, coordRepo.repoRoot) })

      // rc.60 member process: the coordinator's first-contact nudge subscribed it.
      const member60 = createRouter({ dispatchMeshCommand: memberDispatch, statusInstanceId: MEMBER_DAEMON })
      routers.push(member60)
      await member60.execute('mesh_node_state_nudge', {
        meshId: MESH_ID, nodeId: MEMBER_NODE, workspace: memberRepo.repoRoot,
        [MESH_SENDER_DAEMON_ID_ARG]: COORD_DAEMON,
      }, 'mesh')
      await waitFor(() => store.get(MESH_ID, MEMBER_NODE)?.runtime?.daemonBuild?.version === RC60.version, 5_000)
      expect(store.get(MESH_ID, MEMBER_NODE)?.runtime?.daemonBuild?.version).toBe(RC60.version)
      const heldBefore = store.get(MESH_ID, MEMBER_NODE)!.runtimeObservedAt!

      // mesh_restart_daemon upgrades the member: the rc.60 process exits (its
      // in-memory subscription with it) and an rc.61 process boots.
      member60.meshNodeStatePusher.stop()
      buildState.current = { ...RC61 }
      const member61 = createRouter({ dispatchMeshCommand: memberDispatch, statusInstanceId: MEMBER_DAEMON })
      routers.push(member61)
      bootMember(member61, COORD_DAEMON)

      const startedAt = Date.now()
      const reflected = await waitFor(() => store.get(MESH_ID, MEMBER_NODE)?.runtime?.daemonBuild?.version === RC61.version, 8_000)
      expect(reflected).toBe(true)
      expect(Date.now() - startedAt).toBeLessThan(8_000)
      expect(store.get(MESH_ID, MEMBER_NODE)!.runtimeObservedAt!).toBeGreaterThanOrEqual(heldBefore)
      // The coordinator's mesh_status serves the new build from held state.
      const status: any = await coordinator.execute('mesh_status', { meshId: MESH_ID }, 'p2p')
      const node = status.nodes.find((n: any) => n.nodeId === MEMBER_NODE)
      expect(node.heldRuntime.daemonBuild).toMatchObject({ version: RC61.version, commit: RC61.commit })
      // The coordinator never read the member.
      expect(coordDispatch.mock.calls.some((call: any) => call[1] === 'git_status' || call[1] === 'get_status_metadata')).toBe(false)
    } finally {
      for (const r of routers) r.meshNodeStatePusher.stop()
      await cleanupTempDir(coordRepo.dir)
      await cleanupTempDir(memberRepo.dir)
    }
  })
})

describe('coordinator — reconnect-triggered handshake', () => {
  async function setup(memberTakesNudge: boolean) {
    const store = new MeshNodeGitStateStore()
    const now = Date.now()
    // Held: a live member push from the rc.60 process, observed just now.
    store.recordObservation({ meshId: MESH_ID, nodeId: MEMBER_NODE, workspace: REMOTE_WORKSPACE, git: remoteGit(), source: 'member_push', observedAt: now })
    store.recordRuntimeObservation({ meshId: MESH_ID, nodeId: MEMBER_NODE, workspace: REMOTE_WORKSPACE, runtime: runtimeOf(RC60, 'boot-60'), source: 'member_push', observedAt: now, daemonId: MEMBER_DAEMON })
    let coordinator!: DaemonCommandRouter
    const calls: string[] = []
    // A restarted member: the nudge (re)subscribes it and it pushes its rc.61 state right away.
    const dispatch = vi.fn(async (daemonId: string, cmd: string) => {
      calls.push(cmd)
      if (daemonId !== MEMBER_DAEMON) throw new Error('unexpected daemon')
      if (cmd === 'mesh_node_state_nudge') {
        if (!memberTakesNudge) return { success: true, subscribed: false }
        setTimeout(() => {
          void coordinator.execute('mesh_node_git_report', {
            meshId: MESH_ID, nodeId: MEMBER_NODE, workspace: REMOTE_WORKSPACE,
            git: remoteGit(), observedAt: Date.now(),
            runtime: runtimeOf(RC61, 'boot-61'), runtimeObservedAt: Date.now(),
            [MESH_SENDER_DAEMON_ID_ARG]: MEMBER_DAEMON,
          }, 'mesh')
        }, 0)
        return { success: true, subscribed: true }
      }
      return { success: false, error: `Unknown command: ${cmd}` }
    })
    const onMeshStateChange = vi.fn()
    coordinator = createRouter({ dispatchMeshCommand: dispatch, store, onMeshStateChange })
    await coordinator.execute('mesh_status', { meshId: MESH_ID, inlineMesh: meshWith(REMOTE_WORKSPACE, '/nonexistent/coord') })
    await coordinator.meshNodeGitRefresher.whenIdle()
    calls.length = 0
    return { store, coordinator, calls, onMeshStateChange }
  }

  it('a member link opening handshakes its held nodes now — the nudge re-subscribes it and its push lands the new build', async () => {
    const { store, coordinator, calls, onMeshStateChange } = await setup(true)
    try {
      ;(coordinator as any).noteMeshPeerOpened?.(MEMBER_DAEMON)
      const reflected = await waitFor(() => store.get(MESH_ID, MEMBER_NODE)?.runtime?.daemonBuild?.version === RC61.version, 5_000)
      expect(reflected).toBe(true)
      await coordinator.meshNodeGitRefresher.whenIdle()
      // The nudge is the ONLY thing the coordinator sent — no probe, no runtime read.
      expect(calls).toEqual(['mesh_node_state_nudge'])
      // The new build is news for every viewer.
      expect(onMeshStateChange).toHaveBeenCalledWith(MESH_ID)
      expect(store.get(MESH_ID, MEMBER_NODE)?.handshakePendingSince ?? null).toBeNull()
    } finally {
      coordinator.meshNodeStatePusher.stop()
    }
  })

  it('a member that refuses the nudge is recorded unreachable and its held build is not live — never probed', async () => {
    const { store, coordinator, calls } = await setup(false)
    try {
      ;(coordinator as any).noteMeshPeerOpened?.(MEMBER_DAEMON)
      await waitFor(() => calls.includes('mesh_node_state_nudge'), 5_000)
      await coordinator.meshNodeGitRefresher.whenIdle()
      expect(calls).toEqual(['mesh_node_state_nudge'])
      expect(typeof store.get(MESH_ID, MEMBER_NODE)?.unreachableSince).toBe('number')
      expect(isHeldRuntimeLive(store.get(MESH_ID, MEMBER_NODE))).toBe(false)
    } finally {
      coordinator.meshNodeStatePusher.stop()
    }
  })
})

describe('coordinator — mesh_restart_daemon marks the held build pending', () => {
  it('the new process is taken at once (even with an older stamp); a late report of the replaced process is not', async () => {
    const store = new MeshNodeGitStateStore()
    const now = Date.now()
    store.recordObservation({ meshId: MESH_ID, nodeId: MEMBER_NODE, workspace: REMOTE_WORKSPACE, git: remoteGit(), source: 'member_push', observedAt: now })
    store.recordRuntimeObservation({ meshId: MESH_ID, nodeId: MEMBER_NODE, workspace: REMOTE_WORKSPACE, runtime: runtimeOf(RC60, 'boot-60'), source: 'member_push', observedAt: now, daemonId: MEMBER_DAEMON })
    const dispatch = vi.fn(async (_daemonId: string, cmd: string) => {
      if (cmd === 'restart_daemon_node') return { success: true, mode: 'upgrade', restarted: true, outcome: 'scheduled' }
      if (cmd === 'git_status') return { success: true, status: remoteGit({ lastCheckedAt: Date.now() }) }
      return { success: true, subscribed: true }
    })
    const onMeshStateChange = vi.fn()
    const coordinator = createRouter({ dispatchMeshCommand: dispatch, store, onMeshStateChange })
    try {
      await coordinator.execute('mesh_status', { meshId: MESH_ID, inlineMesh: meshWith(REMOTE_WORKSPACE, '/nonexistent/coord') })
      await coordinator.meshNodeGitRefresher.whenIdle()
      expect(isHeldRuntimeLive(store.get(MESH_ID, MEMBER_NODE))).toBe(true)

      const restarted: any = await coordinator.execute('restart_daemon_node', { meshId: MESH_ID, nodeId: MEMBER_NODE, mode: 'upgrade' })
      expect(restarted.success).toBe(true)
      // The held rc.60 build is no longer served as live truth.
      expect(isHeldRuntimeLive(store.get(MESH_ID, MEMBER_NODE))).toBe(false)

      const report = (runtime: Record<string, unknown>, runtimeObservedAt: number) => coordinator.execute('mesh_node_git_report', {
        meshId: MESH_ID, nodeId: MEMBER_NODE, workspace: REMOTE_WORKSPACE, runtime, runtimeObservedAt,
        [MESH_SENDER_DAEMON_ID_ARG]: MEMBER_DAEMON,
      }, 'mesh')
      // A late report from the process being replaced does not end the wait.
      await report(runtimeOf(RC60, 'boot-60'), now + 1)
      expect(isHeldRuntimeLive(store.get(MESH_ID, MEMBER_NODE))).toBe(false)

      // The new process's clock / first report predates the held stamp: still taken.
      onMeshStateChange.mockClear()
      const accepted: any = await report(runtimeOf(RC61, 'boot-61'), now - 30_000)
      expect(accepted.accepted).toBe(true)
      expect(store.get(MESH_ID, MEMBER_NODE)?.runtime?.daemonBuild?.version).toBe(RC61.version)
      expect(isHeldRuntimeLive(store.get(MESH_ID, MEMBER_NODE), now)).toBe(true)
      expect(onMeshStateChange).toHaveBeenCalledWith(MESH_ID)
    } finally {
      coordinator.meshNodeStatePusher.stop()
    }
  })

  it('a different build than held is accepted as a change even without a pending mark', () => {
    const store = new MeshNodeGitStateStore()
    const base = { meshId: MESH_ID, nodeId: MEMBER_NODE, workspace: REMOTE_WORKSPACE, source: 'member_push' as const, daemonId: MEMBER_DAEMON }
    store.recordRuntimeObservation({ ...base, runtime: runtimeOf(RC60, 'boot-60'), observedAt: 2_000_000 })
    const next = store.recordRuntimeObservation({ ...base, runtime: runtimeOf(RC61, 'boot-61'), observedAt: 1_990_000 })
    expect(next.changed).toBe(true)
    expect(store.get(MESH_ID, MEMBER_NODE)?.runtime?.daemonBuild?.version).toBe(RC61.version)
    // Same process, older stamp: still never rolled back.
    const stale = store.recordRuntimeObservation({ ...base, runtime: runtimeOf(RC61, 'boot-61'), observedAt: 1_000_000 })
    expect(stale.changed).toBe(false)
  })
})

describe('member push — restart survival', () => {
  it('persists the subscription set, restores it after a restart, and pushes only the reconnected coordinator on a peer open', async () => {
    const saved: any[][] = []
    const persistence = { load: () => (saved.length ? saved[saved.length - 1] : []), save: (targets: any[]) => { saved.push(targets) } }
    const dispatch = vi.fn(async () => ({ success: true, accepted: true }))
    const readGit = async () => remoteGit({ lastCheckedAt: Date.now() })
    const before = new MeshNodeStatePusher({ dispatch, readGit, persistence, startTimer: () => ({ stop() {} }) })
    before.selfRegister({ coordinatorDaemonId: 'coord_a', meshId: MESH_ID, nodeId: MEMBER_NODE, workspace: REMOTE_WORKSPACE })
    before.selfRegister({ coordinatorDaemonId: 'coord_b', meshId: 'mesh_b', nodeId: 'node_b', workspace: REMOTE_WORKSPACE })
    expect(saved[saved.length - 1]).toHaveLength(2)
    before.stop()

    const after = new MeshNodeStatePusher({ dispatch, readGit, persistence, startTimer: () => ({ stop() {} }) })
    expect(after.restore()).toBe(2)
    dispatch.mockClear()
    expect(after.pushNow('coord_b')).toBe(1)
    await waitFor(() => dispatch.mock.calls.length >= 1, 2_000)
    expect(dispatch.mock.calls.map((c: any) => c[0])).toEqual(['coord_b'])
    // A second forced push inside the minimum interval is skipped (no storm on a flapping link).
    expect(after.pushNow('coord_b')).toBe(0)

    // A coordinator too old to hold pushed state refuses the report: the restored subscription is dropped.
    dispatch.mockResolvedValue({ success: false, error: 'Unknown command: mesh_node_git_report' } as any)
    expect(after.pushNow('coord_a')).toBe(1)
    await waitFor(() => after.list().length === 1, 2_000)
    expect(after.list().map((s) => s.coordinatorDaemonId)).toEqual(['coord_b'])
    expect(saved[saved.length - 1]).toHaveLength(1)
    after.stop()
  })

  it('the router persists subscriptions to the config dir (ids + workspace only)', async () => {
    const repo = await createTempGitRepo('restart-persist-')
    const router = createRouter({ dispatchMeshCommand: vi.fn(async () => ({ success: true, accepted: true })), statusInstanceId: MEMBER_DAEMON })
    try {
      await router.execute('mesh_node_state_nudge', {
        meshId: MESH_ID, nodeId: MEMBER_NODE, workspace: repo.repoRoot,
        [MESH_SENDER_DAEMON_ID_ARG]: COORD_DAEMON,
      }, 'mesh')
      const file = join(configDir, 'mesh-node-push-subscriptions.json')
      expect(existsSync(file)).toBe(true)
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      expect(parsed.subscriptions).toEqual([{ coordinatorDaemonId: COORD_DAEMON, meshId: MESH_ID, nodeId: MEMBER_NODE, workspace: repo.repoRoot }])
    } finally {
      router.meshNodeStatePusher.stop()
      await cleanupTempDir(repo.dir)
    }
  })
})

describe('no periodic probing', () => {
  it('after a reconnect handshake lands, mesh_status reads never contact a pushing member again, and no timer is started', async () => {
    let now = 5_000_000
    const store = new MeshNodeGitStateStore(null, () => now)
    const nudge = vi.fn(async () => true)
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const refresher = new MeshNodeGitRefresher({ store, nudge, onSettled: () => {}, now: () => now })
    const target = { meshId: MESH_ID, nodeId: MEMBER_NODE, daemonId: MEMBER_DAEMON, workspace: REMOTE_WORKSPACE }
    store.recordObservation({ ...target, git: remoteGit(), source: 'member_push', observedAt: now })
    store.markHandshakePending(MESH_ID, MEMBER_NODE, 'reconnect')
    expect(refresher.handshakeDaemon(MESH_ID, MEMBER_DAEMON, [target])).toBe(1)
    await refresher.whenIdle()
    expect(nudge).toHaveBeenCalledTimes(1)
    // The member pushes; the handshake is over.
    store.recordObservation({ ...target, git: remoteGit(), source: 'member_push', observedAt: now })
    const mesh = meshWith(REMOTE_WORKSPACE, '/nonexistent/coord')
    for (let i = 0; i < 20; i += 1) {
      now += 15_000 // 5 minutes of dashboard reads
      kickMeshNodeGitRefreshes({ meshId: MESH_ID, mesh, store, refresher, locality: { localDaemonId: COORD_DAEMON }, refresh: false, now })
      await refresher.whenIdle()
    }
    expect(nudge).toHaveBeenCalledTimes(1)
    expect(setIntervalSpy).not.toHaveBeenCalled()
    setIntervalSpy.mockRestore()
  })
})
