import { describe, expect, it } from 'vitest'
import { CANONICAL_MESH_TOOL_NAMES, CANONICAL_MESH_TOOL_COUNT } from '@adhdev/mesh-shared'
import { buildCoordinatorSystemPrompt, buildMagiKindPanelsSection } from '../../src/mesh/coordinator-prompt.js'

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

    // The mesh-wide cap defaults high (200) but resolveMaxParallelTasks clamps the
    // rendered value to MESH_MAX_PARALLEL_TASKS_MAX (64). The cap is de-emphasized
    // now that real limits live per capability slot (ORCHESTRATION_NODE_SLOTS.md).
    expect(prompt).toContain('Maximum **64** concurrent WRITE tasks')
    expect(prompt).toContain('Hermes → `hermes-cli`')
    expect(prompt).toContain('Never substitute the coordinator')
    expect(prompt).toContain('Coordinator runtime is not a delegation default')
  })

  it('6-2: Task Messaging Requirements carries only the generic, tool-backed convergence rule — no repo-specific prose', () => {
    // The prompt is injected into every mesh coordinator regardless of which repo
    // it runs against, so it must never hardcode conventions specific to THIS repo
    // (e.g. an oss/ AGPL submodule or a vitest-based test suite a random user's
    // repo won't have). Branch convergence stays: it restates the requiredFinalStates
    // enum a real mesh_status tool call returns (mesh-tools-internal.ts), which is
    // meaningful for any git-based mesh node. Repo-specific rules like OSS English
    // commits and scoped test runs belong in that repo's own `.adhdev/mesh.json`
    // (coordinator.systemPromptAppend) instead — see the test below.
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
    // The only rule left: branch convergence final state in the completion report.
    expect(prompt).toContain('require the completion report to classify the touched branch into exactly one final state')

    // Repo-specific rules must NOT be hardcoded into the default prompt.
    expect(prompt).not.toContain('oss/` MUST be English')
    expect(prompt).not.toContain('run only the tests covering the changed files')
  })

  it('mesh.coordinator.systemPromptAppend can carry repo-specific task-messaging rules (the .adhdev/mesh.json round-trip)', () => {
    // Confirms the migration path actually works: a repo commits its own rules
    // (e.g. this repo's OSS English commits / scoped test run conventions) into
    // `.adhdev/mesh.json`'s coordinator.systemPromptAppend, and they land in the
    // rendered prompt exactly like any other mesh-level append.
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
        coordinator: {
          systemPromptAppend: 'Commit messages in `oss/` MUST be English. Run only the tests covering the changed files.',
        },
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      } as any,
      coordinatorCliType: 'claude-cli',
    })

    expect(prompt).toContain('Commit messages in `oss/` MUST be English. Run only the tests covering the changed files.')
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

  it('draws the base-node vs worktree boundary for write tasks, and blocks the "enough nodes" misreading', () => {
    // WORKTREE-ROUTING-BOUNDARY. The prior wording — "N parallel write tasks need N
    // nodes (clone worktrees)" — reads as a NODE-COUNT condition: a coordinator with
    // four base nodes in the mesh concludes the requirement is already satisfied and
    // dispatches general code_change work straight onto the base checkouts. The real
    // requirement is BRANCH ISOLATION, which node count never satisfies. These
    // assertions pin the reframing in the rendered prompt (not just in source).
    const prompt = buildCoordinatorSystemPrompt({
      mesh: {
        id: 'mesh_1', name: 'ADHDev', repoIdentity: 'github.com/acme/adhdev',
        nodes: [{ id: 'node_1', workspace: '/repo', userOverrides: {}, policy: {} }],
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      } as any,
    })

    // 1. The node-count framing is replaced by branch isolation, in BOTH the Policy
    //    rule and the Rules "Match concurrency to task kind" entry.
    expect(prompt).toContain('N parallel write tasks need N *separate branch workspaces*')
    expect(prompt).toContain('**Having N nodes in the mesh does not satisfy this**')
    expect(prompt).toContain('a mesh with four base nodes still has zero branch isolation')
    // The exact old sentence must be gone — it is the source of the misreading.
    expect(prompt).not.toContain('N parallel write tasks need N nodes (clone worktrees)')

    // 2. The decision rule the coordinator applies per task.
    expect(prompt).toContain('Base nodes are for environment-specific testing, not for general code changes')
    expect(prompt).toContain('does this task verify the physical environment of a specific machine or OS, or does it only change code?')
    expect(prompt).toContain('**Do NOT send these to a base node.**')

    // 3. Concrete physical-node examples — without these the boundary over-corrects
    //    and genuine win32/OS verification gets pushed onto worktrees where it
    //    cannot be verified at all.
    expect(prompt).toContain('win32')
    expect(prompt).toContain('registry')
    expect(prompt).toContain('Homebrew')
    expect(prompt).toContain('OS-dependent runtime behavior')
    // ...and the mechanism for pinning them to the real machine.
    expect(prompt).toContain('required_tags` (e.g. `["os=win32"]`)')

    // 4. Clone cost / auto-launch, so 2-step friction is not a reason to fall back
    //    to a base node. mesh_clone_node returns the id and auto-launch starts the
    //    session — mesh_launch_session is NOT needed.
    expect(prompt).toContain('auto-launch starts the session on it for you')
    expect(prompt).toContain('never as a reason to fall back to a base node')

    // 5. The same boundary is restated in the durable Rules section.
    expect(prompt).toContain('**Base nodes are reserved for environment-specific testing.**')
    expect(prompt).toContain('clone a worktree and assign the task there')
    expect(prompt).toContain('mesh_clone_node')
  })

  it('keeps the pre-existing worktree affinity guidance intact alongside the new clone boundary', () => {
    // Regression guard for the two-layer design: b0 governs the CLONE decision,
    // b1 governs routing AFTER a clone exists. The earlier affinity hardening
    // (e09460cd/0862a3f1) only ever fired post-clone, which is why it never
    // prevented the base-node spray — but it is still correct and must not be
    // dropped while adding the front half.
    const prompt = buildCoordinatorSystemPrompt({
      mesh: {
        id: 'mesh_1', name: 'ADHDev', repoIdentity: 'github.com/acme/adhdev',
        nodes: [{ id: 'node_1', workspace: '/repo', userOverrides: {}, policy: {} }],
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      } as any,
    })

    expect(prompt).toContain('Keep a branch\'s work on its worktree (worktree affinity)')
    expect(prompt).toContain('durable per-branch workspace')
    expect(prompt).toContain('required_tags: ["worktree=<branch>"]')
    // The convergence exception survives: merge/push is base-only, so the new
    // "clone a worktree for write work" rule must not swallow it.
    expect(prompt).toContain('base-only')
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

  it('names mesh_refine_batch where the shared-base merge problem is stated, not only in the tool table', () => {
    // REFINE-BATCH-DISCOVERABILITY. The Rules section described the shared-base
    // hazard (merging one worktree advances a sibling's base, especially a shared
    // submodule pointer) but named no tool for it, so a coordinator landing three
    // sibling worktrees read it as "go slowly, one at a time" and called
    // mesh_refine_node 7+ times — self-inflicting base_locked and hand-rebasing each
    // laggard. mesh_refine_batch appeared ONLY as a row in the static tool table,
    // which does not carry an applicability condition. The fix is placement: the
    // solution must sit against the problem statement, and in the Workflow converge
    // step that a coordinator actually reads while landing work.
    const prompt = buildCoordinatorSystemPrompt({
      mesh: {
        id: 'mesh_1',
        name: 'ADHDev',
        repoIdentity: 'github.com/acme/adhdev',
        nodes: [{ id: 'node_1', workspace: '/repo', daemonId: 'daemon_1', userOverrides: {}, policy: {} }],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      } as any,
      coordinatorCliType: 'claude-cli',
    })

    // The applicability condition must be explicit — "2+ siblings", not just the
    // tool name floating in a table.
    expect(prompt).toContain('use `mesh_refine_batch` for two or more')
    expect(prompt).toContain('when 2+ sibling worktrees share a base, converge them with `mesh_refine_batch`')

    // Only the capabilities the implementation actually has may be claimed:
    // conflict-aware ordering, per-node re-resolve + auto-rebase, base_locked
    // avoidance. (router-refine.ts: refineSyncBaseStage rebases whenever behind>0;
    // resolve_refs re-fetches origin/<base> per node; the batch is one sequential
    // lease holder with a single retry pass for base-movement blockers.)
    expect(prompt).toContain('non-submodule first, submodule-touching serialized last')
    expect(prompt).toContain('re-resolves the base and auto-rebases')
    expect(prompt).toContain('base_locked')

    // Must NOT be sold as a conflict solver — a real conflict still blocks the node.
    // Overstating this is worse than silence, since it would send the coordinator
    // back to manual recovery with false expectations.
    expect(prompt).toContain('not a conflict solver')
    expect(prompt).toContain('blocked_review')
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
    expect(prompt).toContain('Never launch a second session onto in-flight work')

    // The anti-polling/concurrency rules must not bleed into deferring NEW
    // independent work — the proactive-parallelize rule draws that contrast.
    expect(prompt).toContain('**Proactively parallelize new work.**')
    expect(prompt).toContain('do not wait for a current task to finish or for the user to prompt you to parallelize')
    expect(prompt).toContain('a reason to defer starting a new, independent task')
  })

  it('tells the coordinator when to let an investigator apply its own fix', () => {
    // An investigator that already read the source and named file:line holds
    // context a fresh worker must rebuild, and the coordinator would have to
    // restate the findings to hand them over. Task mode is per-TASK, not
    // per-session (validateMeshTaskModeRequest reads each dispatch's own
    // readonly/taskMode and short-circuits to valid when not read-only), so the
    // handoff is a follow-up mesh_send_task without the read-only flag — no new
    // session or worktree needed. Pin both the mechanism and the split criteria.
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

    expect(prompt).toContain('Task mode is **per task, not per session**')
    expect(prompt).toContain('WITHOUT the read-only flag')
    expect(prompt).toContain('You do not need a new session or a fresh worktree for the mode to change')

    // Both directions must be stated, or the rule collapses into "always hand
    // off" — which produces unverified fixes.
    expect(prompt).toContain('**Hand off in-session when**')
    expect(prompt).toContain('**Split to a separate task when**')
    expect(prompt).toContain('OVERTURNED your hypothesis')

    // Over-handoff guard: a "do not change this" finding is a completed task.
    expect(prompt).toContain('**Never convert an investigation whose own conclusion was "do not change this"**')

    // The upfront-dispatch option must carry its tradeoff, not just the
    // shortcut — otherwise the coordinator dispatches every investigation as an
    // ordinary task and loses the guard against fixing before diagnosing.
    expect(prompt).toContain('drops the guardrail against premature fixes')
    expect(prompt).toContain('keep `live_debug_readonly` whenever the point is to find out whether anything is wrong at all')

    // Must not contradict the parallelism rule: independent work runs side by
    // side, sequential stages of ONE line of work stay in one session.
    expect(prompt).toContain('successive stages of one investigation stay in their session')
    expect(prompt).toContain('see Workflow 3f')
  })

  it('instructs recording operating notes even when NO notes exist yet', () => {
    // buildOperatingNotesSection returns '' when there are zero notes, and the
    // only imperative to CALL mesh_record_note used to live inside that section
    // — so a fresh mesh never saw the instruction to record the first note, and
    // the section stayed empty forever. The rule must therefore live in Rules,
    // which always renders. Build with NO operatingNotes to pin exactly that.
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

    // Precondition: the Operating Notes section really is absent here.
    expect(prompt).not.toContain('## Operating Notes\n')

    expect(prompt).toContain('**Promote durable lessons to operating notes — especially at mission close.**')
    expect(prompt).toContain('call `mesh_record_note` FIRST')

    // Over-recording guard: all three conditions must be present, since a bare
    // "record lessons" instruction turns the note list into a mission diary.
    expect(prompt).toContain('a coordinator on another day or another session would act differently knowing it')
    expect(prompt).toContain('it cannot be rediscovered from code, config, or `git log`')
    expect(prompt).toContain('not a one-off detail specific to this single mission')

    // Reachability: notes are injected into the coordinator prompt only (see
    // buildCoordinatorSystemPrompt callers — mesh-coordinator-launch only), so
    // worker-facing conventions must not be filed as notes.
    expect(prompt).toContain('never injected into delegated worker sessions')
  })

  it('surfaces the read-only exemption from the one-active-session-per-node invariant', () => {
    // mesh-queue-assignment.ts gates auto-launch on nodeHasActiveAssignment ONLY
    // for non-readonly tasks (`if (!isTaskReadonly(task) && ...)`), so a node can
    // hold several concurrent read-only sessions. That exemption was invisible in
    // the prompt, which led coordinators to serialize read-only investigation or
    // clone a worktree they did not need. Assert it is stated where the
    // coordinator decides whether to launch (Workflow 3b) AND in the Rules cap.
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

    expect(prompt).toContain('**A node is not limited to one live session for read-only work**')
    expect(prompt).toContain('exempt from the one-active-per-node invariant')
    expect(prompt).toContain('the SAME node can auto-launch multiple concurrent read-only sessions with no worktree needed')

    // The parallelism rule must reflect the ACTUAL scheduler semantics (per-kind
    // caps + per-node write limit), not a blanket "start small". The old "Start
    // with 1-2 tasks; scale only on success" anchored coordinators to serial
    // dispatch before the release condition was ever read.
    expect(prompt).toContain('**Match concurrency to task kind.**')
    expect(prompt).toContain('dispatch all at once up to the read-only cap')
    // The per-node write limit stays; its justification is now branch isolation
    // rather than node count (WORKTREE-ROUTING-BOUNDARY) — "need N nodes" was read
    // as already-satisfied by any multi-node mesh, which sent general code_change
    // work to base checkouts. See the base-node boundary test above.
    expect(prompt).toContain('limited to **one active task per node**')
    expect(prompt).toContain('clone a worktree per task')
    expect(prompt).not.toContain('Start with 1–2 tasks; scale only on success')

    // The duplicate-session guard must survive the rewrite.
    expect(prompt).toContain('Never launch a second session onto in-flight work for the same issue')

    // Caps are ceilings, not targets to approach cautiously from below.
    expect(prompt).toContain('ceilings, not targets')

    // Worktree affinity must not read as "avoid making new worktrees" — it is a
    // routing rule for a branch's OWN follow-ups. Stated once, at Workflow 3b1:
    // that is the dispatch-time step where the coordinator actually decides
    // whether to clone, so a misread surfaces there. The Rules entry is the
    // scannable invariant and stays terse (Rules restating a Workflow step is
    // the file's normal pattern — cf. "Converge branches" vs step 7).
    expect(prompt).toContain('it is never a reason to avoid creating a NEW worktree for independent work')
  })

  it('renders the read-only parallel cap, which is larger than the write cap', () => {
    // resolveMaxReadonlyParallelTasks (repo-mesh-types.ts) gives read-only tasks
    // their own cap = write cap x DEFAULT_MESH_READONLY_MULTIPLIER (floor 2), and
    // mesh-scheduling-runtime enforces it — but the prompt used to render only the
    // write cap, so the coordinator could not know the extra capacity existed.
    // The write number must stay the CLAMPED one (mergeAndNormalizePolicy caps at
    // MESH_MAX_PARALLEL_TASKS_MAX=64) so prompt and scheduler cannot disagree.
    const mk = (policy?: unknown) => buildCoordinatorSystemPrompt({
      mesh: {
        id: 'mesh_1',
        name: 'ADHDev',
        repoIdentity: 'github.com/acme/adhdev',
        nodes: [{ id: 'node_1', workspace: '/repo', daemonId: 'daemon_1', userOverrides: {}, policy: {} }],
        policy,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      } as any,
    })

    // Default policy declares maxParallelTasks: 200, clamped to 64 → 128 read-only.
    expect(mk()).toContain('Maximum **64** concurrent WRITE tasks; **128** concurrent READ-ONLY tasks')
    // Doubling tracks a configured cap.
    expect(mk({ maxParallelTasks: 4 })).toContain('Maximum **4** concurrent WRITE tasks; **8** concurrent READ-ONLY tasks')
    // Floor of 2 applies when doubling would drop below it.
    expect(mk({ maxParallelTasks: 1 })).toContain('Maximum **1** concurrent WRITE tasks; **2** concurrent READ-ONLY tasks')

    // The per-node write limit is what forces worktrees for parallel writes.
    expect(mk()).toContain('Write tasks are limited to **one active task per node**')
    expect(mk()).toContain('Read-only tasks are exempt and may stack on a node that is already busy')
  })

  it('exempts a genuinely new subject from idle-session reuse', () => {
    // "Reuse idle sessions" listed exceptions (a)-(d), none of which covered a
    // NEW topic — so a coordinator would append unrelated work to an idle session,
    // where it can be dropped or re-run as the previous task. The discriminator is
    // subject continuity, which is also what keeps this consistent with 3f
    // (investigation → its own fix is the SAME subject and stays in-session).
    const prompt = buildCoordinatorSystemPrompt({
      mesh: {
        id: 'mesh_1',
        name: 'ADHDev',
        repoIdentity: 'github.com/acme/adhdev',
        nodes: [{ id: 'node_1', workspace: '/repo', daemonId: 'daemon_1', userOverrides: {}, policy: {} }],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      } as any,
    })

    expect(prompt).toContain('the delta is a genuinely NEW subject rather than a continuation')
    expect(prompt).toContain('can be dropped or re-run as the previous task')
    expect(prompt).toContain('The test is subject continuity, not timing')
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

  it('carries the repo-agnostic delegated-agent operating rules migrated from CLAUDE.md into the static prompt', () => {
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

    // (1) Fresh-session 4-condition guard merged into "Reuse idle sessions".
    expect(prompt).toContain('Start a fresh session only when: (a) branch/worktree isolation is required')
    expect(prompt).toContain('(d) the user explicitly asks for a different provider/session')
    // (2) Sequential same-issue continuation is allowed; the rule only blocks concurrent unrelated interleaving.
    expect(prompt).toContain('Continuation of the same issue in an already-idle session is allowed and preferred')
    expect(prompt).toContain('not sequential same-issue follow-ups')
    // (3) No nested coordinator for simple inspection.
    expect(prompt).toContain('Do not spawn a nested coordinator-like agent for simple inspection tasks')
    // (4) Internal traffic must not surface as user-visible transcript.
    expect(prompt).toContain('must not appear as ordinary user-visible chat transcript content unless explicitly marked user-facing')
    // (5) Don't reopen already-done work after compaction/resume.
    expect(prompt).toContain('Before reopening a reported issue after context compaction or session resume')
    expect(prompt).toContain('continue from the existing diff/commit instead of starting a duplicate investigation')
    // (6) Stuck-but-verified → stop polling, verify with git, land.
    expect(prompt).toContain('If a delegated session appears stuck but has already produced a verified final summary or diff')
    // (7) Manual strict fast-forward convergence bypass when Refinery falsely blocks a clean branch.
    expect(prompt).toContain('converge by strict fast-forward')
    expect(prompt).toContain('rebase the submodule commit onto the submodule `origin/main`')
    expect(prompt).toContain('NEVER force-push or reset; abort and report on any non-fast-forward')
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

  it('6-4/Phase2-d: bounds operating notes by count cap + byte budget and truncates each to 300 chars', () => {
    // 50 notes, each far longer than 300 chars, tagged with a stable index so
    // we can assert which survived. Phase 2 (d) replaced the pure count-20 tail
    // with a byte-budget-bounded selection (still ranked newest-first), so with
    // long notes FEWER than 20 survive — the newest ride, the oldest drop.
    const operatingNotes = Array.from({ length: 50 }, (_, i) => ({
      text: `note#${i} ` + 'x'.repeat(600),
    }))

    const prompt = buildCoordinatorSystemPrompt({
      mesh: baseMesh() as any,
      operatingNotes: operatingNotes as any,
    })

    // The newest notes ride; the oldest are gone (byte-budget cuts the tail).
    expect(prompt).toContain('note#49')
    expect(prompt).toContain('note#40')
    expect(prompt).not.toContain('note#0 ')
    expect(prompt).not.toContain('note#5 ')

    // Per-note truncation: no single note line carries the full 600-char run,
    // and the truncation marker is present.
    expect(prompt).not.toContain('x'.repeat(400))
    expect(prompt).toContain('[truncated]')

    // Omitted-count line for the dropped lower-priority tail (count is now
    // byte-budget-driven, so assert the line exists rather than an exact number).
    expect(prompt).toMatch(/\d+ lower-priority notes? omitted[^(]*\(kept in ledger/)
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

  it('6-4: soft-cap sheds UNPINNED notes first — pinned notes keep riding', () => {
    // Size the append so the prompt fits once the unpinned notes are shed but
    // overflows with them included: pinned notes must survive the first stage.
    const withoutNotes = buildCoordinatorSystemPrompt({ mesh: baseMesh() as any })
    const headroom = 96 * 1024 - Buffer.byteLength(withoutNotes, 'utf8')
    const filler = 'F'.repeat(Math.max(1024, headroom - 1024))
    const operatingNotes = [
      { text: 'PINNED_LESSON_SENTINEL never rebase a pushed oss commit', pinned: true },
      ...Array.from({ length: 12 }, (_, i) => ({ text: `unpinned-note#${i} ` + 'y'.repeat(250) })),
    ]

    const prompt = buildCoordinatorSystemPrompt({
      mesh: {
        ...baseMesh(),
        coordinator: { systemPromptAppend: filler },
      } as any,
      operatingNotes: operatingNotes as any,
    })

    // The pinned note survived the shed; the unpinned tail did not.
    expect(prompt).toContain('PINNED_LESSON_SENTINEL')
    expect(prompt).not.toContain('unpinned-note#0')
    expect(prompt).toContain('omitted to fit: unpinned operating notes')
    // 'unpinned operating notes' contains the substring 'pinned operating
    // notes', so assert the LAST-RESORT entry specifically (comma-prefixed).
    expect(prompt).not.toContain(', pinned operating notes')
  })

  it('6-4: only an overflow that shedding everything cannot fix drops pinned notes', () => {
    // An append alone far past the cap: every sheddable stage fires, and the
    // notice names each stage — including the pinned last resort.
    const prompt = buildCoordinatorSystemPrompt({
      mesh: {
        ...baseMesh(),
        coordinator: { systemPromptAppend: 'B'.repeat(130 * 1024) },
      } as any,
      operatingNotes: [
        { text: 'PINNED_LESSON_SENTINEL', pinned: true },
        { text: 'unpinned lesson' },
      ] as any,
    })
    expect(prompt).not.toContain('PINNED_LESSON_SENTINEL')
    expect(prompt).toContain('omitted to fit: unpinned operating notes, recent activity, pinned operating notes')
  })

  it('6-4: soft-cap sheds daemon-generated sections but never the user append', () => {
    // A user (mesh-level) append that alone blows past the 60KB soft cap, plus
    // a large operating-notes payload. The append must survive verbatim; the
    // daemon-generated operating notes must be shed with a truncation notice.
    const bigAppend = 'USER_APPEND_SENTINEL ' + 'A'.repeat(130 * 1024)
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
    expect(prompt).toContain('A'.repeat(130 * 1024))

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

  // ── Configured MAGI panels section ──

  describe('buildMagiKindPanelsSection', () => {
    it('returns null when panels is undefined, null, or all-empty', () => {
      expect(buildMagiKindPanelsSection(undefined)).toBeNull()
      expect(buildMagiKindPanelsSection(null)).toBeNull()
      expect(buildMagiKindPanelsSection({})).toBeNull()
      // A kind bound to an empty slot list contributes nothing → still omitted.
      expect(buildMagiKindPanelsSection({ rca: [], design: undefined })).toBeNull()
    })

    it('renders a section with kind headers and slot providers when panels are present', () => {
      const section = buildMagiKindPanelsSection({
        rca: [
          { provider: 'codex-cli', nodeId: 'node_f1f8' },
          { provider: 'antigravity-cli', nodeId: 'node_8440' },
        ],
        design: [
          { provider: 'hermes-cli', model: 'opus', capabilityTags: ['reasoning'], n: 2 },
        ],
      })
      expect(section).not.toBeNull()
      const text = section as string
      expect(text).toContain('## Configured MAGI panels')
      // Per-kind headers.
      expect(text).toContain('**rca**')
      expect(text).toContain('**design**')
      // Slot providers + node pins.
      expect(text).toContain('codex-cli@node_f1f8')
      expect(text).toContain('antigravity-cli@node_8440')
      // Model / tags / replica-count rendering for the design slot.
      expect(text).toContain('hermes-cli')
      expect(text).toContain('model: opus')
      expect(text).toContain('tags: reasoning')
      expect(text).toContain('×2')
      // Guidance line — required task_kind + read-only replicas.
      expect(text).toContain('mesh_magi_review')
      expect(text).toContain('mesh_magi_kind_panel_list')
      expect(text).toContain('read-only')
    })

    it('counts replicas from per-slot n when computing the kind label', () => {
      const section = buildMagiKindPanelsSection({
        rca: [
          { provider: 'codex-cli', n: 2 },
          { provider: 'hermes-cli', n: 2 },
        ],
      }) as string
      // 2 slots but 4 total replicas → "4 replicas".
      expect(section).toContain('**rca** (4 replicas)')
    })
  })

  it('full prompt includes the Configured MAGI panels section only when panels are passed', () => {
    const withoutPanels = buildCoordinatorSystemPrompt({ mesh: baseMesh() as any })
    expect(withoutPanels).not.toContain('## Configured MAGI panels')

    const withPanels = buildCoordinatorSystemPrompt({
      mesh: baseMesh() as any,
      magiKindPanels: { rca: [{ provider: 'codex-cli', nodeId: 'node_f1f8' }] },
    })
    expect(withPanels).toContain('## Configured MAGI panels')
    expect(withPanels).toContain('codex-cli@node_f1f8')
  })

  // ─── Difficulty is a routing hint, not a model selector ───
  it('renders difficulty as a ROUTING HINT and drops the shipped brain presets', () => {
    const prompt = buildCoordinatorSystemPrompt({ mesh: baseMesh() as any })

    // The section exists and states who actually decides the model.
    expect(prompt).toContain('## Task difficulty')
    expect(prompt).toContain('ROUTING HINT')
    expect(prompt).toContain('The slot decides the model and thinking level')
    expect(prompt).toContain('mesh_node_slots_set')

    // ★ The old preset framing must be GONE from the rendered prompt. These are the
    // exact strings that taught the coordinator difficulty == a model choice, and
    // that a `difficult` task means opus regardless of which provider it lands on.
    expect(prompt).not.toContain('## Brain presets')
    expect(prompt).not.toContain('(no preset — ordinary routing)')
    expect(prompt).not.toContain('runs easy tasks on a cheaper model at low reasoning effort')
    expect(prompt).not.toContain('The current presets are shown in the "Brain presets" section below.')
    // Nothing is shipped, so an unconfigured mesh must not name a model at all.
    expect(prompt).not.toContain('model: `opus`')
    expect(prompt).not.toContain('model: `haiku`')

    // And the difficulty axis itself survives — it is still the routing key.
    expect(prompt).toContain('Classify task difficulty honestly')
    expect(prompt).toContain('Never bend difficulty to chase a model')
  })

  // ─── Node routing default: the coordinator's own machine ───
  it('makes the coordinator machine the default for code changes, with only two exceptions', () => {
    const prompt = buildCoordinatorSystemPrompt({ mesh: baseMesh() as any })

    // Nodes are machines, not interchangeable slots — the framing that produced the
    // live mistake (a fix dispatched to a win32 node, needing commit/push/pull back).
    expect(prompt).toContain('separate machines with separate checkouts')
    expect(prompt).toContain('default to this coordinator\'s own machine for code changes')
    // The cost that makes it the default: the round trip, doubled by deploy locality.
    expect(prompt).toContain('committed, pushed, and pulled back')
    // Exactly two legitimate reasons, both named.
    expect(prompt).toContain('platform-specific verification')
    expect(prompt).toContain('parallelizing read-only investigation')
    // The non-reason is called out explicitly.
    expect(prompt).toContain('"That node is idle" is not a reason')

    // Investigation and fix stay in one session when the fix lands here.
    expect(prompt).toContain('Don\'t split investigation from the fix')
    expect(prompt).toContain('code_change')
  })

  // ─── Destructive-git approval — Rules section hard statement ───
  // requireApprovalForDestructiveGit (the policy toggle that used to gate this
  // rule) has been removed: there is no code-level enforcement anywhere in the
  // mesh command path (no handler blocks force push / reset --hard / history
  // rewrite), so the prompt rule is now unconditional rather than policy-gated.
  // These tests pin that the Rules section always states it, regardless of what
  // policy object is supplied (including no policy at all), and that the wording
  // never claims a code backstop that doesn't exist.
  it('states the destructive-git approval rule unconditionally, with no policy supplied', () => {
    const prompt = buildCoordinatorSystemPrompt({ mesh: baseMesh() as any })

    expect(prompt).toContain('Never run destructive git operations without explicit user approval')
    expect(prompt).toContain('push --force')
    expect(prompt).toContain('reset --hard')
    expect(prompt).toContain('history rewrite')
    // Must not overclaim a code-level backstop that doesn't exist.
    expect(prompt).toContain('no code-level gate backing this up')
  })

  it('states the destructive-git approval rule unconditionally even with an unrelated/empty policy object', () => {
    const mesh = {
      ...baseMesh(),
      // A policy object with no git-approval-related field at all (and no
      // policy fields left that could gate this rule) must still render the
      // full unconditional rule — there is nothing left to key off of.
      policy: {},
    }
    const prompt = buildCoordinatorSystemPrompt({ mesh: mesh as any })

    expect(prompt).toContain('Never run destructive git operations without explicit user approval')
    expect(prompt).toContain('no code-level gate backing this up')
  })
})
