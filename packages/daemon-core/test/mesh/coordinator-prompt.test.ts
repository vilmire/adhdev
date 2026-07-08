import { describe, expect, it } from 'vitest'
import { CANONICAL_MESH_TOOL_NAMES, CANONICAL_MESH_TOOL_COUNT } from '@adhdev/mesh-shared'
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

  it('6-2: includes Task Messaging Requirements — OSS English commits, scoped tests, convergence state', () => {
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

    expect(prompt).toContain('### Task Messaging Requirements')
    // Rule 1 — OSS English commits.
    expect(prompt).toContain('commit messages in `oss/` MUST be English')
    // Rule 2 — scoped test runs.
    expect(prompt).toContain('run only the tests covering the changed files')
    // Rule 3 — branch convergence final state in the completion report.
    expect(prompt).toContain('require the completion report to classify the touched branch into exactly one final state')
  })

  it('instructs worktree affinity — keep a branch\'s follow-up work on its worktree node', () => {
    const prompt = buildCoordinatorSystemPrompt({
      mesh: {
        id: 'mesh_1', name: 'ADHDev', repoIdentity: 'github.com/acme/adhdev',
        nodes: [{ id: 'node_1', workspace: '/repo', userOverrides: {}, policy: {} }],
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      } as any,
    })

    // Workflow step + Rules both carry the affinity guidance.
    expect(prompt).toContain('worktree affinity')
    expect(prompt).toContain('durable per-branch workspace')
    // Concrete targeting mechanism, matching the worktree=<branch> tag the nodes
    // section advertises.
    expect(prompt).toContain('required_tags: ["worktree=<branch>"]')
    // The base-only convergence exception must be stated so the coordinator does
    // not pin a merge/push task to the worktree.
    expect(prompt).toContain('base-only')
    expect(prompt).toContain('untargeted')
    // The Configured Nodes list is a launch-time snapshot; a worktree cloned
    // mid-session is NOT in it, so the guidance must point at the live sources
    // (mesh_clone_node result / mesh_status) instead of the frozen node list.
    expect(prompt).toContain('launch-time snapshot')
    expect(prompt).toContain('mesh_clone_node')
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

  it('surfaces per-node routing tags (custom + os/arch) so the coordinator can route by capability', () => {
    const prompt = buildCoordinatorSystemPrompt({
      mesh: {
        id: 'mesh_1',
        name: 'ADHDev',
        repoIdentity: 'github.com/acme/adhdev',
        nodes: [
          {
            id: 'node_win',
            machineLabel: 'Windows box',
            workspace: 'C:/repo',
            userOverrides: {},
            reportedPlatform: 'win32',
            reportedArch: 'x64',
            capabilities: ['windows-build', 'test-runner'],
            policy: { providerPriority: ['codex-cli'] },
          },
        ],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      } as any,
    })

    // Custom + auto tags appear, so the coordinator can enqueue with required_tags.
    expect(prompt).toContain('routing tags:')
    expect(prompt).toContain('`windows-build`')
    expect(prompt).toContain('`test-runner`')
    expect(prompt).toContain('`os=win32`')
    expect(prompt).toContain('`arch=x64`')
    // The internal convergence tag is never surfaced to the operator/coordinator.
    expect(prompt).not.toContain('converge=')
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

  // ── 6-4: prompt-build caps ──

  it('6-4: caps operating notes to the latest 20 and truncates each to 300 chars', () => {
    // 50 notes, each far longer than 300 chars, tagged with a stable index so
    // we can assert which survived the keep-latest-20 window.
    const operatingNotes = Array.from({ length: 50 }, (_, i) => ({
      text: `note#${i} ` + 'x'.repeat(600),
    }))

    const prompt = buildCoordinatorSystemPrompt({
      mesh: baseMesh() as any,
      operatingNotes: operatingNotes as any,
    })

    // Only the newest 20 (indices 30..49) are shown; older ones are gone.
    expect(prompt).toContain('note#49')
    expect(prompt).toContain('note#30')
    expect(prompt).not.toContain('note#29')
    expect(prompt).not.toContain('note#0 ')

    // Per-note truncation: no single note line carries the full 600-char run,
    // and the truncation marker is present.
    expect(prompt).not.toContain('x'.repeat(400))
    expect(prompt).toContain('[truncated]')

    // Omitted-count line for the 30 dropped notes.
    expect(prompt).toContain('30 older notes omitted (kept in ledger; prune with `mesh_forget_note`)')
  })

  it('6-4: windowMinutes overrides the hardcoded "last 30 min" phrasing', () => {
    const prompt = buildCoordinatorSystemPrompt({
      mesh: baseMesh() as any,
      recentActivity: {
        recentFailures: [],
        recentFailureCount: 4,
        pendingTasks: 0,
        assignedTasks: 0,
        stalledTasks: 0,
        windowMinutes: 90,
        lastActivityAt: null,
      },
    })
    expect(prompt).toContain('**4** failed in the last 90 min')
    expect(prompt).not.toContain('last 30 min')
  })

  it('6-4: defaults the recent-activity window to 30 min when unspecified', () => {
    const prompt = buildCoordinatorSystemPrompt({
      mesh: baseMesh() as any,
      recentActivity: {
        recentFailures: [],
        recentFailureCount: 1,
        pendingTasks: 0,
        assignedTasks: 0,
        stalledTasks: 0,
        lastActivityAt: null,
      },
    })
    expect(prompt).toContain('**1** failed in the last 30 min')
  })

  it('6-4: soft-cap sheds daemon-generated sections but never the user append', () => {
    // A user (mesh-level) append that alone blows past the 60KB soft cap, plus
    // a large operating-notes payload. The append must survive verbatim; the
    // daemon-generated operating notes must be shed with a truncation notice.
    const bigAppend = 'USER_APPEND_SENTINEL ' + 'A'.repeat(80 * 1024)
    const operatingNotes = Array.from({ length: 30 }, (_, i) => ({
      text: `sheddable-note#${i} ` + 'y'.repeat(250),
    }))

    const prompt = buildCoordinatorSystemPrompt({
      mesh: {
        ...baseMesh(),
        coordinator: { systemPromptAppend: bigAppend },
      } as any,
      operatingNotes: operatingNotes as any,
    })

    // User append is preserved in full — not truncated.
    expect(prompt).toContain('USER_APPEND_SENTINEL')
    expect(prompt).toContain('A'.repeat(80 * 1024))

    // Daemon-generated operating notes were shed to fit the cap.
    expect(prompt).not.toContain('sheddable-note#0')
    expect(prompt).not.toContain('## Operating Notes\n')

    // The shedding is announced, not silent.
    expect(prompt).toContain('soft cap')
    expect(prompt).toContain('omitted to fit: operating notes')

    // Invariant hardcoded sections stay intact.
    expect(prompt).toContain('## Rules')
    expect(prompt).toContain('## Available Tools')
  })

  it('6-4: an under-cap prompt is emitted unchanged with no truncation notice', () => {
    const prompt = buildCoordinatorSystemPrompt({
      mesh: baseMesh() as any,
      operatingNotes: [{ text: 'a small durable lesson', category: 'recovery_lesson' }] as any,
    })
    expect(prompt).toContain('a small durable lesson')
    expect(prompt).not.toContain('soft cap')
    expect(prompt).not.toContain('omitted to fit')
  })

  // ── 6-6: schema ↔ coordinator-prompt ↔ barrel-comment tool-exposure consistency ──
  //
  // The coordinator-prompt "## Available Tools" table once drifted 14 tools behind the
  // MCP schema (mesh_mission_list, mesh_reconcile_ledger, the refine/magi/change-impact
  // families, …), silently hiding capabilities from the coordinator — including
  // mesh_mission_list, which the "remaining work = enumerate missions" operating rule
  // depends on. This regression gate pins the table to the canonical registry so any new
  // tool added to the schema without exposing it in the prompt (or vice-versa) fails here.
  //
  // Extract the tool names the prompt actually renders from the "## Available Tools"
  // table rows (`| \`mesh_x\` | … |`) and require SET-equality with CANONICAL_MESH_TOOL_NAMES.
  const extractPromptToolTable = (prompt: string): string[] => {
    const start = prompt.indexOf('## Available Tools')
    expect(start).toBeGreaterThanOrEqual(0)
    // The table runs until the next "## " section heading.
    const rest = prompt.slice(start + '## Available Tools'.length)
    const end = rest.indexOf('\n## ')
    const table = end >= 0 ? rest.slice(0, end) : rest
    const names = new Set<string>()
    for (const m of table.matchAll(/^\|\s*`(mesh_[a-z0-9_]+)`\s*\|/gm)) {
      names.add(m[1])
    }
    return [...names]
  }

  it('6-6: the coordinator-prompt tool table exposes exactly the canonical mesh tool registry', () => {
    const prompt = buildCoordinatorSystemPrompt({ mesh: baseMesh() as any })
    const exposed = extractPromptToolTable(prompt).sort()
    const canonical = [...CANONICAL_MESH_TOOL_NAMES].sort()

    // Missing: a canonical (schema-published) tool the coordinator is never told about.
    const missing = canonical.filter(name => !exposed.includes(name))
    expect(missing, `tools published in the schema but missing from the coordinator-prompt table: ${missing.join(', ')}`).toEqual([])

    // Ghost: a tool advertised in the prompt that has no schema entry.
    const ghost = exposed.filter(name => !canonical.includes(name as any))
    expect(ghost, `tools advertised in the coordinator-prompt table with no canonical schema entry: ${ghost.join(', ')}`).toEqual([])

    // Full set-equality + count guard (== the barrel "NN tools" comment count).
    expect(exposed).toEqual(canonical)
    expect(exposed.length).toBe(CANONICAL_MESH_TOOL_COUNT)
  })

  it('6-6: mesh_mission_list and the G2 requeue tool are exposed (operating-rule + gap coverage)', () => {
    const prompt = buildCoordinatorSystemPrompt({ mesh: baseMesh() as any })
    const exposed = extractPromptToolTable(prompt)
    // mesh_mission_list underpins the "remaining work = enumerate every mission" rule.
    expect(exposed).toContain('mesh_mission_list')
    // mesh_requeue_held_events is the G2 event_held→pending recovery path.
    expect(exposed).toContain('mesh_requeue_held_events')
  })
})

