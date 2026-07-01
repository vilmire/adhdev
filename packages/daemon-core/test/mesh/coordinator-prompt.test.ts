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

  const baseMesh = () => ({
    id: 'mesh_activity',
    name: 'ADHDev',
    repoIdentity: 'github.com/acme/adhdev',
    nodes: [{ id: 'node_1', workspace: '/repo', userOverrides: {}, policy: {} }],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  })

  // ── Gap1: Recent Activity section ──

  it('renders a Recent Activity section from the supplied ledger/queue snapshot', () => {
    const prompt = buildCoordinatorSystemPrompt({
      mesh: baseMesh() as any,
      coordinatorCliType: 'claude-cli',
      recentActivity: {
        recentFailures: [
          { timestamp: '2026-06-25T01:00:00Z', nodeId: 'node_1', summary: 'typecheck failed' },
          { timestamp: '2026-06-25T01:05:00Z', nodeId: 'node_2', summary: 'merge conflict' },
        ],
        recentFailureCount: 2,
        pendingTasks: 3,
        assignedTasks: 1,
        stalledTasks: 0,
        lastActivityAt: '2026-06-25T01:05:00Z',
      },
    })

    expect(prompt).toContain('## Recent Activity')
    expect(prompt).toContain('**3** pending')
    expect(prompt).toContain('**1** assigned')
    expect(prompt).toContain('**2** failed in the last 30 min')
    expect(prompt).toContain('Recent failures (newest first):')
    // Newest first — the 01:05 failure should precede the 01:00 one.
    expect(prompt.indexOf('merge conflict')).toBeLessThan(prompt.indexOf('typecheck failed'))
    expect(prompt).toContain('node `node_1`')
  })

  it('omits the Recent Activity section when there is nothing to surface', () => {
    const quiet = buildCoordinatorSystemPrompt({
      mesh: baseMesh() as any,
      recentActivity: { recentFailures: [], recentFailureCount: 0, pendingTasks: 0, assignedTasks: 0, stalledTasks: 0, lastActivityAt: null },
    })
    expect(quiet).not.toContain('## Recent Activity')

    const absent = buildCoordinatorSystemPrompt({ mesh: baseMesh() as any })
    expect(absent).not.toContain('## Recent Activity')
  })

  // ── Gap2-A: Operating Notes section ──

  it('renders an Operating Notes section from accumulated notes', () => {
    const prompt = buildCoordinatorSystemPrompt({
      mesh: baseMesh() as any,
      operatingNotes: [
        { text: 'codex-cli swallows bare CR on win32', category: 'provider_quirk', createdAt: '2026-06-25T00:00:00Z' },
        { text: 'do not merge a sibling worktree while another is in flight', category: 'pattern_to_avoid' },
        { text: '   ' as any }, // whitespace-only is dropped
      ],
    })

    expect(prompt).toContain('## Operating Notes')
    expect(prompt).toContain('mesh_record_note')
    expect(prompt).toContain('[provider quirk] codex-cli swallows bare CR on win32')
    expect(prompt).toContain('[pattern to avoid] do not merge a sibling worktree')
  })

  it('omits the Operating Notes section when there are no usable notes', () => {
    // The tool table mentions "## Operating Notes" as descriptive text, so assert
    // on the rendered section heading (heading line followed by a blank line).
    const HEADING = '## Operating Notes\n'
    expect(buildCoordinatorSystemPrompt({ mesh: baseMesh() as any })).not.toContain(HEADING)
    expect(buildCoordinatorSystemPrompt({ mesh: baseMesh() as any, operatingNotes: [] })).not.toContain(HEADING)
    expect(buildCoordinatorSystemPrompt({ mesh: baseMesh() as any, operatingNotes: [{ text: '  ' }] })).not.toContain(HEADING)
  })

  it('expands {{recentActivity}} and {{operatingNotes}} placeholders in a mesh-level override', () => {
    const prompt = buildCoordinatorSystemPrompt({
      mesh: {
        ...baseMesh(),
        coordinator: { systemPromptOverride: 'CUSTOM\n{{recentActivity}}\n{{operatingNotes}}' },
      } as any,
      recentActivity: { pendingTasks: 5, recentFailures: [], recentFailureCount: 0, assignedTasks: 0, stalledTasks: 0, lastActivityAt: null },
      operatingNotes: [{ text: 'a durable lesson', category: 'recovery_lesson' }],
    })

    expect(prompt).toContain('CUSTOM')
    expect(prompt).toContain('## Recent Activity')
    expect(prompt).toContain('**5** pending')
    expect(prompt).toContain('## Operating Notes')
    expect(prompt).toContain('[recovery lesson] a durable lesson')
  })

  it('includes the guided Onboarding / Reinit section with save-scope labels and init-vs-reinit guidance', () => {
    const prompt = buildCoordinatorSystemPrompt({
      mesh: baseMesh() as any,
      coordinatorCliType: 'claude-cli',
    })

    expect(prompt).toContain('## Onboarding / Reinit')
    expect(prompt).toContain('mesh_init')
    expect(prompt).toContain('mesh_reinit')
    // Save-scope labels — repo-file (commit) vs machine-local.
    expect(prompt).toContain('repo-file (commit target)')
    expect(prompt).toContain('machine-local')
    // Machine-local + repo write tools called out.
    expect(prompt).toContain('mesh_magi_kind_panel_set')
    expect(prompt).toContain('mesh_write_mesh_json_config')
    // reinit must diff-then-approve before overwriting hand-edits.
    expect(prompt).toContain('current-vs-suggested diff')
  })

  it('expands the {{onboarding}} placeholder in a mesh-level override', () => {
    const prompt = buildCoordinatorSystemPrompt({
      mesh: {
        ...baseMesh(),
        coordinator: { systemPromptOverride: 'HEAD\n{{onboarding}}' },
      } as any,
    })
    expect(prompt).toContain('HEAD')
    expect(prompt).toContain('## Onboarding / Reinit')
  })
})

