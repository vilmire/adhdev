/**
 * Built-in starter skills (design 2026-11-01-procedure-skills.md §8, owner
 * decision D2): three product-generic procedures only. Repository-specific or
 * personal operating procedures are NOT shipped here — the owner installs
 * those locally from a project's `docs/skills/` directory (`dir-import.ts`).
 *
 * The definitions are code constants; `ensureStarterSkills` writes the
 * missing ones (origin `starter`) once the assistant layer activates. A
 * starter skill the owner archived stays gone (tombstone in `.state.json`).
 */

import type { AssistantSkillStore } from './skill-store.js';

export interface StarterSkillDef {
    name: string;
    description: string;
    body: string;
    triggers?: string[];
}

export const STARTER_SKILLS: readonly StarterSkillDef[] = [
    {
        name: 'mesh-dispatch-hygiene',
        description: 'Checks to run before handing work to a project coordinator, so work is not duplicated or interrupted.',
        triggers: ['send a task to a project', 'dispatch work to the coordinator', 'delegate a task', 'hand over a request to a project'],
        body: `# Dispatch hygiene

Run these checks before every project_send, in order.

1. **No duplicate.** Call project_status for the project. If an equivalent task is already in flight, do not send it again; tell the user it is already running and wait for its report.
2. **Reuse the idle session.** If the coordinator already has an idle session for the same workstream, send the follow-up there (review to fix, then the next step the user asked for). Send only what changed since the last verified state; do not start a new session just because the previous step finished.
3. **Do not poll a busy session.** While the coordinator is generating, do not call project_read or project_status again to check progress. Completion, progress and blocked reports arrive on their own as relays. Wait for them, or for an explicit request from the user.
4. **One progress line.** After sending, tell the user the project and what was sent in one short line, then stop.
5. **Verify side effects.** When the report says files changed, confirm with project_status or project_read before telling the user it succeeded.
`,
    },
    {
        name: 'branch-convergence-report',
        description: 'Classify every touched branch into one final state before reporting a finished task.',
        triggers: ['report task completion', 'summarize branch status', 'is this work merged', 'finish a worktree task'],
        body: `# Branch convergence report

Before telling the user a task is complete, classify every node and branch the task touched into exactly one final state:

- **merged_to_main**: the change is on the main branch.
- **pushed_feature_branch_needs_merge**: pushed to a feature branch and not merged. Merging is the next step only if the request or the done criteria ask for landing.
- **blocked_review**: something needs the user's decision or approval first (for example unpushed commits in a nested repository). Name what is needed.
- **cleanup_candidate**: nothing left to merge; the branch or worktree can be removed.
- **not_mergeable**: conflicts or failing checks; say why.

Report each branch with its state in one line and name the next step. Merging is part of done only when the request or the done criteria ask for landing; a reviewed draft, a pull request or a tested local change can be the finish line the user asked for. If repo changes were expected, confirm with the project's git status instead of trusting a worker's "done".
`,
    },
    {
        name: 'deploy-verify-checklist',
        description: 'For requests to deploy or release: merge check, rebuild, live verification, only then release.',
        triggers: ['deploy a change', 'release a preview', 'ship this build', 'verify before deploying'],
        body: `# Deploy and verify checklist

Use this only when the user asked to deploy or release. A request to build, fix or review something is not a request to ship it.

Adapt the commands to the project; keep the order.

1. **Landed.** Confirm the change is merged and the local branch equals the remote main. Passing tests on a feature branch are not the same as landed.
2. **Rebuild.** Rebuild every package the change touches, dependencies first. A running process keeps the old code until it is rebuilt and restarted.
3. **Live check.** Start the app locally and exercise the exact screen or command the change affects. Look at the result; a green test report is not a substitute.
4. **Release.** Only after the live check passes, run the project's release command.
5. **After.** Check the deployed version, restart anything that must pick it up, and note the release in the changelog the project keeps.

Stop and tell the user if any step fails; do not skip ahead.
`,
    },
];

export function ensureStarterSkills(store: Pick<AssistantSkillStore, 'installStarterSkills'>): { installed: string[]; skipped: string[] } {
    return store.installStarterSkills(STARTER_SKILLS);
}
