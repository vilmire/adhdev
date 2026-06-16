import { describe, expect, it } from 'vitest'
import { buildCoordinatorSystemPrompt } from '../../src/mesh/coordinator-prompt.js'

describe('Repo Mesh coordinator prompt', () => {
  it('uses default policy for cloud inline meshes that omit policy/coordinator fields', () => {
    const prompt = buildCoordinatorSystemPrompt({
      mesh: {
        id: 'mesh_1',
        name: 'ADHDev',
        repoIdentity: 'github.com/acme/adhdev',
        nodes: [
          {
            id: 'node_1',
            workspace: '/repo',
            daemonId: 'daemon_1',
            userOverrides: {},
            policy: {},
          },
        ],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      } as any,
      coordinatorCliType: 'claude-cli',
    })

    expect(prompt).toContain('Maximum **2** tasks running in parallel')
    expect(prompt).toContain('Hermes → `hermes-cli`')
    expect(prompt).toContain('Never substitute the coordinator')
    expect(prompt).toContain('Coordinator runtime is not a delegation default')
  })

  it('requires mesh tool exposure before doing coordinator work', () => {
    const prompt = buildCoordinatorSystemPrompt({
      mesh: {
        id: 'mesh_1',
        name: 'ADHDev',
        repoIdentity: 'github.com/acme/adhdev',
        nodes: [
          {
            id: 'node_1',
            workspace: '/repo',
            daemonId: 'daemon_1',
            userOverrides: {},
            policy: {},
          },
        ],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      } as any,
    })

    expect(prompt).toContain('Before doing any coordinator work, confirm that the actual callable tool list includes `mesh_status`')
    expect(prompt).toContain('Do not substitute terminal/file/git tools')
    expect(prompt).toContain('/reload-mcp')
  })

  it('treats node labels as display context instead of shorthand aliases', () => {
    const prompt = buildCoordinatorSystemPrompt({
      mesh: {
        id: 'mesh_1',
        name: 'ADHDev',
        repoIdentity: 'github.com/acme/adhdev',
        nodes: [
          {
            id: 'node_1',
            machineLabel: 'Build host',
            workspace: '/repo',
            daemonId: 'daemon_1',
            userOverrides: {},
            policy: { providerPriority: ['codex-cli'] },
          },
        ],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      } as any,
    })

    expect(prompt).toContain('Node labels are display context, not aliases')
    expect(prompt).toContain('do not invent shorthand names such as M1/M2')
    expect(prompt).toContain('nodeId: `node_1`')
    expect(prompt).toContain('daemon: `daemon_1`')
    expect(prompt).toContain('providers: codex-cli')
  })

  it('discourages repeated read_chat polling and duplicate workers while delegated tools are active', () => {
    const prompt = buildCoordinatorSystemPrompt({
      mesh: {
        id: 'mesh_1',
        name: 'ADHDev',
        repoIdentity: 'github.com/acme/adhdev',
        nodes: [
          {
            id: 'node_1',
            workspace: '/repo',
            daemonId: 'daemon_1',
            userOverrides: {},
            policy: {},
          },
        ],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      } as any,
    })

    expect(prompt).not.toContain('Periodically call `mesh_read_chat`')
    expect(prompt).toContain('Do **not** poll `mesh_read_chat` repeatedly')
    expect(prompt).toContain('Do **not** repeatedly call `mesh_status` or `mesh_view_queue` just to wait for assigned/generating work')
    expect(prompt).toContain('After dispatching a direct or queued task, send one progress update with the task/session handle, then stop')
    expect(prompt).toContain('pendingCoordinatorEvents')
    expect(prompt).toContain('completion/approval/status signal')
    expect(prompt).toContain('Use at most one compact `mesh_read_chat` check')
    expect(prompt).toContain('Never duplicate a session because')

    // The anti-polling/concurrency rules must not bleed into deferring NEW
    // independent work — the proactive-parallelize rule draws that contrast.
    expect(prompt).toContain('**Proactively parallelize new work.**')
    expect(prompt).toContain('do not wait for a current task to finish or for the user to prompt you to parallelize')
    expect(prompt).toContain('a reason to defer starting a new, independent task')
  })

  it('prefers reusing idle sessions and concise delta instructions for same-issue continuations', () => {
    const prompt = buildCoordinatorSystemPrompt({
      mesh: {
        id: 'mesh_1',
        name: 'ADHDev',
        repoIdentity: 'github.com/acme/adhdev',
        nodes: [
          {
            id: 'node_1',
            workspace: '/repo',
            daemonId: 'daemon_1',
            userOverrides: {},
            policy: {},
          },
        ],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      } as any,
    })

    expect(prompt).toContain('Reuse an existing idle session on the correct node/provider before launching a new chat/session')
    expect(prompt).toContain('Call `mesh_launch_session` only when no suitable session exists')
    expect(prompt).toContain('send a concise **delta instruction**')
    expect(prompt).toContain('Do not resend the full original task or open a new chat solely to continue the same work')
    expect(prompt).toContain('Reuse idle sessions')
    expect(prompt).toContain('send only the delta')
  })

  it('requires a branch convergence final state before reporting completion', () => {
    const prompt = buildCoordinatorSystemPrompt({
      mesh: {
        id: 'mesh_1',
        name: 'ADHDev',
        repoIdentity: 'github.com/acme/adhdev',
        defaultBranch: 'main',
        nodes: [
          {
            id: 'node_1',
            workspace: '/repo',
            daemonId: 'daemon_1',
            userOverrides: {},
            policy: {},
          },
        ],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      } as any,
    })

    expect(prompt).toContain('Converge branches')
    expect(prompt).toContain('branchConvergenceSummary')
    expect(prompt).toContain('`mesh_refine_node`')
    expect(prompt).toContain('`merged_to_main`')
    expect(prompt).toContain('`pushed_feature_branch_needs_merge`')
    expect(prompt).toContain('`blocked_review`')
    expect(prompt).toContain('`cleanup_candidate`')
    expect(prompt).toContain('`not_mergeable`')
    expect(prompt).toContain('Converge branches')
  })

  it('treats submodule reachability failures as publish-needed blocked review', () => {
    const prompt = buildCoordinatorSystemPrompt({
      mesh: {
        id: 'mesh_1',
        name: 'ADHDev',
        repoIdentity: 'github.com/acme/adhdev',
        defaultBranch: 'main',
        nodes: [
          {
            id: 'node_1',
            workspace: '/repo',
            daemonId: 'daemon_1',
            userOverrides: {},
            policy: {},
          },
        ],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      } as any,
    })

    expect(prompt).toContain('require each submodule commit to be reachable from the configured submodule remote main branch')
    expect(prompt).toContain('`submodule_reachability_failed`')
    expect(prompt).toContain('keep the public convergence bucket as `blocked_review`')
    expect(prompt).toContain('ask the user for explicit approval to push/publish the unreachable submodule commit(s) to submodule main')
    expect(prompt).toContain('then rerun `mesh_refine_node`')
    expect(prompt).toContain('Submodule reachability = publish-needed')
  })

  it('M3-4: instructs mission upsert + mission_id enqueue for multi-task work', () => {
    const prompt = buildCoordinatorSystemPrompt({
      mesh: {
        id: 'mesh_m3',
        name: 'ADHDev',
        repoIdentity: 'github.com/acme/adhdev',
        nodes: [{ id: 'node_1', workspace: '/repo', userOverrides: {}, policy: {} }],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      } as any,
      coordinatorCliType: 'claude-cli',
    })

    expect(prompt).toContain('mesh_mission_upsert')
    expect(prompt).toContain('mission_id')
    expect(prompt).toContain('depends_on')
    expect(prompt).toContain('claims dependents automatically')
  })

  it('M3-4: restart continuation reads the injected mission and forbids duplicate enqueue', () => {
    const prompt = buildCoordinatorSystemPrompt({
      mesh: {
        id: 'mesh_m3_resume',
        name: 'ADHDev',
        repoIdentity: 'github.com/acme/adhdev',
        nodes: [{ id: 'node_1', workspace: '/repo', userOverrides: {}, policy: {} }],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      } as any,
      coordinatorCliType: 'claude-cli',
      missionSection: [
        '## Active Mission',
        '- **Nightly refactor** (id: `mission-1`)',
        '  Goal: Split the monolith',
        '  Tasks: 3 total — 2 pending (0 blocked), 0 assigned, 1 completed, 0 failed, 0 cancelled',
        'Continue this mission from its current task state. Do not re-enqueue tasks that already exist — check mesh_view_queue first. Update the mission with mesh_mission_upsert when its goal changes or it reaches a terminal state (completed/abandoned).',
      ].join('\n'),
    })

    expect(prompt).toContain('Active Mission')
    expect(prompt).toContain('Nightly refactor')
    expect(prompt).toContain('Do not re-enqueue tasks that already exist')
    // Existing anti-polling rules stay intact alongside the mission section.
    expect(prompt).toContain('Do **not** poll')
  })
})

