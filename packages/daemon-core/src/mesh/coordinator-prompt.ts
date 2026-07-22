/**
 * Coordinator Prompt — System prompt template for mesh coordinator sessions
 *
 * When an MCP server starts in mesh mode, this prompt is injected into the
 * coordinator agent's context so it understands:
 *   1. What the mesh is (repo, nodes, policy)
 *   2. What tools are available
 *   3. How to orchestrate work across nodes
 *
 * The prompt is generated dynamically from the current mesh state.
 *
 * User customization:
 *   ~/.adhdev/coordinator-prompts/<cliType>.md         — full override
 *   ~/.adhdev/coordinator-prompts/<cliType>.append.md  — appended to default
 *   ~/.adhdev/coordinator-prompts/default.md           — full override (any CLI)
 *   ~/.adhdev/coordinator-prompts/default.append.md    — appended to default (any CLI)
 *
 * CLI-specific files take precedence over default.* files. The override file
 * still gets the node/policy facts substituted via the same {{placeholders}}
 * the daemon understands; an override that doesn't reference them just gets
 * a static prompt, which is also fine.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type {
    LocalMeshEntry,
    RepoMeshPolicy,
    RepoMeshStatus,
    RepoMeshNodeStatus,
} from '../repo-mesh-types.js';
import { mergeAndNormalizePolicy, resolveProviderMaxParallel } from '../repo-mesh-types.js';
import { getDifficultyBrains } from '../config/mesh-config.js';
import { resolveNodeCapabilitySlots } from './mesh-node-slots.js';
import { isNoteExpired, OPERATING_NOTE_CATEGORY_TTL_DAYS } from './mesh-ledger.js';
import { MESH_TASK_DIFFICULTIES } from '@adhdev/mesh-shared';
import type { MagiKindPanelMap, MagiSlot, MagiTaskKind } from '@adhdev/mesh-shared';

/**
 * Cheap, locally-derived "what just happened" snapshot for the coordinator
 * prompt. Built at launch from the local ledger + work-queue stats — no remote
 * peer probe. Surfaces the gap a fresh coordinator otherwise misses: it can't
 * see recent failures / queue depth until it manually calls mesh_task_history.
 *
 * All fields are optional so callers that have nothing to report (or fail to
 * read the ledger) simply omit the section — the prompt output stays identical
 * to the pre-activity form in that case.
 */
export interface CoordinatorRecentActivity {
    /** task_failed entries from the recent window, newest last. */
    recentFailures?: Array<{
        timestamp?: string;
        nodeId?: string;
        /** Short task title/message, already truncated by the caller. */
        summary?: string;
    }>;
    /** Count of task_failed entries inside the recent window. */
    recentFailureCount?: number;
    /**
     * Size of the "recent" window in minutes. Drives the "failed in the last
     * N min" phrasing. Omitted → defaults to 30, matching the prior hardcoded
     * wording so existing callers render identically.
     */
    windowMinutes?: number;
    /** Pending (unclaimed) tasks in the work queue. */
    pendingTasks?: number;
    /** Assigned-but-not-yet-terminal tasks in the work queue. */
    assignedTasks?: number;
    /** Stalled tasks recorded in the ledger. */
    stalledTasks?: number;
    /** ISO timestamp of the most recent ledger activity, if any. */
    lastActivityAt?: string | null;
}

/**
 * One coordinator operating note — a runtime-accumulated lesson (provider
 * quirk, pattern to avoid, recovery lesson) persisted in the ledger so it
 * survives coordinator restarts and is provider-neutral (visible to codex /
 * hermes / antigravity coordinators, not just Claude's memory).
 */
export interface CoordinatorOperatingNote {
    text: string;
    category?: 'provider_quirk' | 'pattern_to_avoid' | 'recovery_lesson';
    createdAt?: string;
    sourceCoordinator?: string;
    /**
     * Operating-notes lifecycle (minimal first cut). When true the note ALWAYS
     * rides into the coordinator prompt — it is never dropped by TTL expiry and
     * survives the injection cap ahead of unpinned notes. Legacy notes without
     * this field default to false.
     */
    pinned?: boolean;
    /**
     * Optional explicit expiry ISO timestamp. When set and in the past, an
     * UNPINNED note is dropped from the injected prompt (read-side only — the
     * ledger entry is never pruned by age). When absent, the category→TTL map
     * (see isNoteExpired) governs expiry; pinned notes never expire regardless.
     */
    expiresAt?: string;
}

// ─── Prompt Builder ─────────────────────────────

export interface CoordinatorPromptContext {
    mesh: LocalMeshEntry;
    status?: RepoMeshStatus;
    userInstruction?: string;
    coordinatorCliType?: string;
    /**
     * M3: pre-rendered active mission section (from buildMissionPromptSection).
     * Empty/undefined when the mesh has no active mission — the prompt output
     * stays identical to the pre-M3 form in that case.
     */
    missionSection?: string;
    /**
     * Gap1: recent ledger/queue activity surfaced so a freshly-launched
     * coordinator sees recent failures + queue depth without first calling
     * mesh_task_history. Omitted → no "## Recent Activity" section.
     */
    recentActivity?: CoordinatorRecentActivity;
    /**
     * Gap2-A: runtime-accumulated operating notes (provider-neutral lessons)
     * read from the ledger at launch. Omitted/empty → no "## Operating Notes"
     * section.
     */
    operatingNotes?: CoordinatorOperatingNote[];
    /**
     * Machine-local MAGI kind-panel bindings (`~/.adhdev/meshes.json`
     * `magiKindPanels`), read live at launch. Omitted / empty / all-empty →
     * no "## Configured MAGI panels" section, so a mesh with no MAGI configured
     * renders identically to before. Threaded in the same systematic way as the
     * brain presets: read machine-local config at launch, render a pure section.
     */
    magiKindPanels?: MagiKindPanelMap;
}

/**
 * Compose the final coordinator prompt from four layers, in this precedence:
 *
 *   1. Per-launch `extraSystemPrompt` (always appended, as "## Additional
 *      Context"). Never wins as a base — it's launch-scope context.
 *   2. Mesh-level append (`mesh.coordinator.systemPromptAppend` or the legacy
 *      `systemPromptSuffix`). Stacks after whichever base won.
 *   3. User-file append (`~/.adhdev/coordinator-prompts/<cli>.append.md` or
 *      `default.append.md`). Also stacks; same placeholder expansion as the
 *      override path.
 *   4. Base prompt, picked in this order:
 *      a. `mesh.coordinator.systemPromptOverride` (mesh-level override)
 *      b. user-file override (`~/.adhdev/coordinator-prompts/<cli>.md` or
 *         `default.md`)
 *      c. daemon default (assembled from identity/nodes/policy/tools/…)
 *
 * That layering lets a user customize prompts at three increasing scopes
 * (machine, mesh, single launch) without losing the daemon's stock rules.
 */
/**
 * 6-4: total prompt soft cap. When the assembled prompt exceeds this, we shed
 * the two runtime-accumulated, daemon-generated sections — operating notes
 * first, then recent activity — because they grow unboundedly from the ledger.
 * We NEVER trim user append/override content or the fixed hardcoded sections
 * (identity/nodes/policy/tools/workflow/onboarding/rules): those carry user
 * intent or invariant instructions. If shedding both still overflows, we keep
 * the prompt as-is rather than mangling protected content.
 */
const PROMPT_SOFT_CAP_BYTES = 60 * 1024;

/**
 * Which daemon-generated optional sections to drop from the default base.
 * Used only by the 6-4 soft-cap retry — an override base ignores these
 * because its operating-notes/recent-activity content comes from the user's
 * own {{placeholder}}s and is not ours to trim.
 */
interface DefaultPromptDropFlags {
    dropOperatingNotes?: boolean;
    dropRecentActivity?: boolean;
}

export function buildCoordinatorSystemPrompt(ctx: CoordinatorPromptContext): string {
    // First pass: assemble with everything included.
    let prompt = assembleCoordinatorPrompt(ctx, {});
    if (byteLength(prompt) <= PROMPT_SOFT_CAP_BYTES) return prompt;

    // Over the soft cap. Only the default base carries daemon-generated
    // operating-notes / recent-activity sections we're allowed to shed; an
    // override base is user content and stays whole. If we're on an override
    // base there's nothing safe to trim, so return the first pass unchanged.
    if (usesOverrideBase(ctx)) return prompt;

    const shed: string[] = [];

    // 1) Shed operating notes first.
    prompt = assembleCoordinatorPrompt(ctx, { dropOperatingNotes: true });
    shed.push('operating notes');
    if (byteLength(prompt) <= PROMPT_SOFT_CAP_BYTES) {
        return appendTruncationNotice(prompt, shed);
    }

    // 2) Still over → also shed recent activity.
    prompt = assembleCoordinatorPrompt(ctx, { dropOperatingNotes: true, dropRecentActivity: true });
    shed.push('recent activity');
    return appendTruncationNotice(prompt, shed);
}

/** True when the base prompt is a mesh-level or user-file override (not the daemon default). */
function usesOverrideBase(ctx: CoordinatorPromptContext): boolean {
    if (ctx.mesh.coordinator?.systemPromptOverride?.trim()) return true;
    return readUserPromptFile(ctx.coordinatorCliType, 'md') !== null;
}

/** UTF-8 byte length — the cap is a byte budget, not a code-unit count. */
function byteLength(s: string): number {
    return Buffer.byteLength(s, 'utf8');
}

/**
 * Append a single trailing line recording which daemon-generated sections were
 * shed to fit the soft cap, so the coordinator (and anyone reading the prompt)
 * knows the omission was deliberate, not a data-loss bug.
 */
function appendTruncationNotice(prompt: string, shed: string[]): string {
    if (shed.length === 0) return prompt;
    return `${prompt}\n\n_Prompt exceeded the ${Math.floor(PROMPT_SOFT_CAP_BYTES / 1024)}KB soft cap; omitted to fit: ${shed.join(', ')}. Full detail remains in the ledger (\`mesh_task_history\` / \`mesh_record_note\`)._`;
}

function assembleCoordinatorPrompt(ctx: CoordinatorPromptContext, drop: DefaultPromptDropFlags): string {
    const { mesh, userInstruction, coordinatorCliType } = ctx;

    // ── Pick the base prompt ──
    const meshOverride = mesh.coordinator?.systemPromptOverride?.trim();
    let base: string;
    if (meshOverride) {
        base = expandPromptPlaceholders(meshOverride, ctx);
    } else {
        const userOverride = readUserPromptFile(coordinatorCliType, 'md');
        if (userOverride !== null) {
            base = expandPromptPlaceholders(userOverride, ctx);
        } else {
            base = buildDefaultCoordinatorPrompt(ctx, drop);
        }
    }

    const sections: string[] = [base];

    // ── User-level append runs after whichever base won ──
    const userAppend = readUserPromptFile(coordinatorCliType, 'append.md');
    if (userAppend !== null) {
        sections.push(expandPromptPlaceholders(userAppend, ctx));
    }

    // ── Mesh-level append (prefer the new field, fall back to the legacy alias) ──
    const meshAppend = (mesh.coordinator?.systemPromptAppend
        ?? mesh.coordinator?.systemPromptSuffix)?.trim();
    if (meshAppend) {
        sections.push(expandPromptPlaceholders(meshAppend, ctx));
    }

    // ── Per-launch context lands last so it's the most recent thing the
    //     agent reads. Marked as Additional Context, not a rule update. ──
    if (userInstruction) {
        sections.push(`## Additional Context\n${userInstruction}`);
    }

    return sections.join('\n\n');
}

function buildDefaultCoordinatorPrompt(ctx: CoordinatorPromptContext, drop: DefaultPromptDropFlags = {}): string {
    const { mesh, status, coordinatorCliType } = ctx;
    const sections: string[] = [];

    // ── Identity ──
    sections.push(`You are a **Repo Mesh Coordinator** — a technical team lead who orchestrates work across multiple agent sessions on a shared Git repository.

Your mesh: **${mesh.name}**
Repository: \`${mesh.repoIdentity}\`${mesh.defaultBranch ? `\nDefault branch: \`${mesh.defaultBranch}\`` : ''}`);

    // ── Nodes ──
    if (status?.nodes?.length) {
        sections.push(buildNodeStatusSection(status.nodes));
    } else if (mesh.nodes.length) {
        sections.push(buildNodeConfigSection(mesh));
    } else {
        sections.push('## Nodes\nNo nodes configured yet. Ask the user to add nodes with `adhdev mesh add-node`.');
    }

    // ── Active Mission (M3) — only present when one exists ──
    if (ctx.missionSection?.trim()) {
        sections.push(ctx.missionSection.trim());
    }

    // ── Recent Activity (Gap1) — only present when there's something to show.
    //     Shed under the 6-4 soft cap (drop.dropRecentActivity). ──
    if (!drop.dropRecentActivity) {
        const recentActivity = buildRecentActivitySection(ctx.recentActivity);
        if (recentActivity) sections.push(recentActivity);
    }

    // ── Operating Notes (Gap2-A) — only present when notes exist. Shed first
    //     under the 6-4 soft cap (drop.dropOperatingNotes). ──
    if (!drop.dropOperatingNotes) {
        const operatingNotes = buildOperatingNotesSection(ctx.operatingNotes);
        if (operatingNotes) sections.push(operatingNotes);
    }

    // ── Policy ──
    sections.push(buildPolicySection(mergeAndNormalizePolicy(undefined, mesh.policy)));

    // ── Brain presets (difficulty → model/thinking) ──
    sections.push(buildBrainPresetsSection());

    // ── Configured MAGI panels (machine-local magiKindPanels) — only present
    //     when at least one task_kind has a non-empty slot list. ──
    const magiSection = buildMagiKindPanelsSection(ctx.magiKindPanels);
    if (magiSection) sections.push(magiSection);

    // ── Tools ──
    sections.push(TOOLS_SECTION);

    // ── Tool Exposure Preflight ──
    sections.push(TOOL_EXPOSURE_PREFLIGHT_SECTION);

    // ── Workflow ──
    sections.push(WORKFLOW_SECTION);

    // ── Onboarding / Reinit ──
    sections.push(ONBOARDING_SECTION);

    // ── Rules ──
    sections.push(buildRulesSection(coordinatorCliType));

    return sections.join('\n\n');
}

/**
 * Look up a user-customization file under ~/.adhdev/coordinator-prompts/.
 *
 * Lookup order:
 *   1. <cliType>.<suffix>   — provider-specific
 *   2. default.<suffix>     — shared across providers
 *
 * Returns null when neither exists; an empty/whitespace-only file is also
 * treated as "no override" so users can drop in a stub without affecting
 * behavior. Read errors (permission, IO) are swallowed and logged-as-null
 * intentionally: a broken override file should never block coordinator
 * launch, it should just behave as if the file weren't there.
 */
function readUserPromptFile(cliType: string | undefined, suffix: string): string | null {
    const dir = path.join(os.homedir(), '.adhdev', 'coordinator-prompts');
    const candidates: string[] = [];
    if (cliType) candidates.push(path.join(dir, `${cliType}.${suffix}`));
    candidates.push(path.join(dir, `default.${suffix}`));
    for (const p of candidates) {
        try {
            const text = fs.readFileSync(p, 'utf8');
            if (text.trim()) return text;
        } catch { /* missing file is the common case — keep going */ }
    }
    return null;
}

/**
 * Expand `{{placeholder}}` tokens against current mesh state.
 *
 * Tokens we support today:
 *   {{meshName}}        — mesh.name
 *   {{repo}}            — mesh.repoIdentity
 *   {{defaultBranch}}   — mesh.defaultBranch or empty
 *   {{cliType}}         — coordinator CLI type or empty
 *   {{nodes}}           — full node section (status if known, otherwise config)
 *   {{mission}}         — active mission summary section (empty when none)
 *   {{recentActivity}}  — recent failures + queue depth section (empty when none)
 *   {{operatingNotes}}  — accumulated operating notes section (empty when none)
 *   {{policy}}          — full policy section
 *   {{tools}}           — the canonical tools table
 *   {{workflow}}        — the canonical orchestration workflow
 *   {{onboarding}}      — the guided init/reinit onboarding section
 *   {{rules}}           — the canonical rules section (with coordinatorNote)
 *   {{toolExposurePreflight}} — the MCP-missing preflight reminder
 *
 * Unknown tokens are left as-is — that way typos are obvious in the rendered
 * prompt instead of silently disappearing. Tokens are not recursive: an
 * expanded value's own {{...}} content stays literal.
 */
function expandPromptPlaceholders(template: string, ctx: CoordinatorPromptContext): string {
    const { mesh, status, coordinatorCliType } = ctx;
    const nodesSection = status?.nodes?.length
        ? buildNodeStatusSection(status.nodes)
        : mesh.nodes.length
            ? buildNodeConfigSection(mesh)
            : '## Nodes\nNo nodes configured yet. Ask the user to add nodes with `adhdev mesh add-node`.';
    const replacements: Record<string, string> = {
        meshName: mesh.name,
        repo: mesh.repoIdentity,
        defaultBranch: mesh.defaultBranch || '',
        cliType: coordinatorCliType || '',
        nodes: nodesSection,
        mission: ctx.missionSection?.trim() || '',
        recentActivity: buildRecentActivitySection(ctx.recentActivity) || '',
        operatingNotes: buildOperatingNotesSection(ctx.operatingNotes) || '',
        policy: buildPolicySection(mergeAndNormalizePolicy(undefined, mesh.policy)),
        tools: TOOLS_SECTION,
        workflow: WORKFLOW_SECTION,
        onboarding: ONBOARDING_SECTION,
        rules: buildRulesSection(coordinatorCliType),
        toolExposurePreflight: TOOL_EXPOSURE_PREFLIGHT_SECTION,
    };
    return template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (m, key) => {
        return Object.prototype.hasOwnProperty.call(replacements, key) ? replacements[key] : m;
    });
}

// ─── Section Builders ───────────────────────────

function buildNodeStatusSection(nodes: RepoMeshNodeStatus[]): string {
    const lines = [
        '## Current Node Status',
        '',
        'Node labels are display context, not aliases. Use exact `nodeId` values in mesh tool calls; do not invent shorthand names such as M1/M2 unless they are explicitly configured labels.',
        '',
    ];
    for (const n of nodes) {
        const healthIcon = n.health === 'online' ? '🟢' :
            n.health === 'dirty' ? '🟡' :
            n.health === 'offline' ? '⚫' : '🔴';
        const sessions = n.activeSessions.length > 0
            ? `sessions: ${n.activeSessions.join(', ')}`
            : 'no active sessions';
        const branch = n.git?.branch ? `branch: \`${n.git.branch}\`` : '';
        // Render each provider with its detected version when known (T7 visibility)
        // so the coordinator can eyeball a per-node provider-version skew inline —
        // e.g. `claude-cli@1.2.3`. Providers without a reported version render bare.
        const providerVersions = n.providerVersions && typeof n.providerVersions === 'object'
            ? n.providerVersions
            : undefined;
        const providersRendered = n.providers?.length
            ? n.providers
                .map((p) => {
                    const version = providerVersions?.[p];
                    return version ? `${p}@${version}` : p;
                })
                .join(', ')
            : '';
        const buildVersion = typeof n.daemonBuildVersion === 'string' && n.daemonBuildVersion
            ? `build: ${n.daemonBuildVersion}`
            : '';
        const context = [
            n.daemonId ? `daemon: \`${n.daemonId}\`` : '',
            providersRendered ? `providers: ${providersRendered}` : '',
            buildVersion,
        ].filter(Boolean).join(' | ');
        lines.push(`- ${healthIcon} **${n.machineLabel}** (nodeId: \`${n.nodeId}\`)`);
        lines.push(`  workspace: \`${n.workspace}\`${context ? ` | ${context}` : ''} | ${branch} | ${sessions}`);
        if (n.error) lines.push(`  ⚠️ ${n.error}`);
        const nodePrompt = typeof (n as any).systemPrompt === 'string' ? (n as any).systemPrompt.trim() : '';
        if (nodePrompt) {
            lines.push(`  📌 Node instruction: ${indentFollowing(nodePrompt, '     ')}`);
        }
    }
    return lines.join('\n');
}

function buildNodeConfigSection(mesh: LocalMeshEntry): string {
    const lines = [
        '## Configured Nodes',
        '',
        'Node labels are display context, not aliases. Use exact `nodeId` values in mesh tool calls; do not invent shorthand names such as M1/M2 unless they are explicitly configured labels.',
        '',
    ];
    for (const n of mesh.nodes) {
        const labels: string[] = [];
        if (n.isLocalWorktree) labels.push('worktree');
        if (n.policy?.readOnly) labels.push('read-only');
        const suffix = labels.length ? ` [${labels.join(', ')}]` : '';
        const explicitMachineLabel = typeof (n as any).machineLabel === 'string' ? (n as any).machineLabel : '';
        const explicitLabel = explicitMachineLabel ? ` label: **${explicitMachineLabel}** |` : '';
        const providerPriority = n.policy?.providerPriority?.length ? ` | providers: ${n.policy.providerPriority.join(', ')}` : '';
        // Per-(node, provider) maxParallel cap, derived from the node's slots (the
        // cap summed across a provider's slots). Only maxParallel is enforced by the
        // queue; routing is governed by required_tags, not slot order.
        const nodeSlots = resolveNodeCapabilitySlots(n);
        const seenCapProvider = new Set<string>();
        const providerCaps: string[] = [];
        for (const slot of nodeSlots) {
            const type = typeof slot?.provider === 'string' ? slot.provider.trim() : '';
            if (!type) continue;
            const key = type.toLowerCase();
            if (seenCapProvider.has(key)) continue;
            seenCapProvider.add(key);
            const cap = resolveProviderMaxParallel(nodeSlots, type);
            if (cap === undefined) continue;
            providerCaps.push(`${type} (max ${cap})`);
        }
        const providerRolesSuffix = providerCaps.length ? ` | caps: ${providerCaps.join(', ')}` : '';
        lines.push(`- ${explicitLabel} nodeId: \`${n.id}\` | workspace: \`${n.workspace}\`${n.daemonId ? ` | daemon: \`${n.daemonId}\`` : ''}${providerPriority}${providerRolesSuffix}${suffix}`);
        // Routing tags: what this node advertises for mesh_enqueue_task required_tags.
        // Surfaced so the coordinator can route by-capability (e.g. enqueue a Windows
        // build with required_tags:["os=win32"], or a custom "test-runner" node).
        // os=/arch= use the same userOverrides → reported precedence as the matcher;
        // the internal converge= tag is omitted (it is not something to target by hand).
        const routingTags: string[] = [];
        const custom = Array.isArray((n as any).capabilities) ? (n as any).capabilities : [];
        for (const t of custom) { const s = typeof t === 'string' ? t.trim() : ''; if (s) routingTags.push(s); }
        const tagOs = ((n as any).userOverrides?.platform || (n as any).reportedPlatform || '').toString().trim();
        const tagArch = ((n as any).userOverrides?.arch || (n as any).reportedArch || '').toString().trim();
        if (tagOs) routingTags.push(`os=${tagOs}`);
        if (tagArch) routingTags.push(`arch=${tagArch}`);
        const wtBranch = typeof (n as any).worktreeBranch === 'string' ? (n as any).worktreeBranch.trim() : '';
        if (n.isLocalWorktree && wtBranch) routingTags.push(`worktree=${wtBranch}`);
        if (routingTags.length) {
            lines.push(`  🏷️ routing tags: ${routingTags.map(t => `\`${t}\``).join(', ')}`);
        }
        const nodePrompt = typeof (n as any).systemPrompt === 'string' ? (n as any).systemPrompt.trim() : '';
        if (nodePrompt) {
            lines.push(`  📌 Node instruction: ${indentFollowing(nodePrompt, '     ')}`);
        }
    }
    lines.push('', '_Use `mesh_status` to probe live health before delegating work._');
    return lines.join('\n');
}

/**
 * Indent every line after the first by `pad`. Used so multi-line node
 * instructions still visually nest under the node bullet without the
 * second line dangling at column zero.
 */
function indentFollowing(text: string, pad: string): string {
    const lines = text.split('\n');
    if (lines.length === 1) return lines[0];
    return [lines[0], ...lines.slice(1).map(l => pad + l)].join('\n');
}

/**
 * Gap1 — render the "## Recent Activity" section from the locally-derived
 * activity snapshot. Returns '' (no section) when there's nothing worth
 * surfacing: no recent failures, no queued work, no stalls. This keeps a quiet
 * mesh's prompt identical to the pre-activity form.
 */
function buildRecentActivitySection(activity?: CoordinatorRecentActivity): string {
    if (!activity) return '';
    const failures = Array.isArray(activity.recentFailures) ? activity.recentFailures : [];
    const pending = Number.isFinite(activity.pendingTasks) ? Number(activity.pendingTasks) : 0;
    const assigned = Number.isFinite(activity.assignedTasks) ? Number(activity.assignedTasks) : 0;
    const stalled = Number.isFinite(activity.stalledTasks) ? Number(activity.stalledTasks) : 0;
    const recentFailureCount = Number.isFinite(activity.recentFailureCount)
        ? Number(activity.recentFailureCount)
        : failures.length;
    const windowMinutes = Number.isFinite(activity.windowMinutes) && Number(activity.windowMinutes) > 0
        ? Math.floor(Number(activity.windowMinutes))
        : 30;

    // Nothing actionable to show → omit the section entirely.
    if (failures.length === 0 && pending === 0 && assigned === 0 && stalled === 0 && recentFailureCount === 0) {
        return '';
    }

    const lines: string[] = ['## Recent Activity', ''];
    lines.push('A snapshot of this mesh\'s recent ledger/queue state at launch. Use it to decide what needs attention first; call `mesh_task_history` / `mesh_view_queue` for full detail.');
    lines.push('');

    const counts: string[] = [];
    if (pending > 0) counts.push(`**${pending}** pending`);
    if (assigned > 0) counts.push(`**${assigned}** assigned`);
    if (stalled > 0) counts.push(`**${stalled}** stalled`);
    if (recentFailureCount > 0) counts.push(`**${recentFailureCount}** failed in the last ${windowMinutes} min`);
    if (counts.length) lines.push(`- Queue/ledger: ${counts.join(', ')}.`);
    if (activity.lastActivityAt) lines.push(`- Last ledger activity: ${activity.lastActivityAt}.`);

    if (failures.length > 0) {
        // Newest first, capped to the 5 most recent so the prompt stays lean.
        const recent = failures.slice(-5).reverse();
        lines.push('', 'Recent failures (newest first):');
        for (const f of recent) {
            const when = f.timestamp ? `${f.timestamp} ` : '';
            const node = f.nodeId ? `node \`${f.nodeId}\`` : 'unknown node';
            const summary = (f.summary || '').trim();
            lines.push(`- ${when}${node}${summary ? ` — ${summary}` : ''}`);
        }
        lines.push('', '_Check `mesh_task_history` before retrying; repeated failures on the same node mean reassign or escalate, not retry._');
    }

    return lines.join('\n');
}

/**
 * Gap2-A — render the "## Operating Notes" section from accumulated coordinator
 * notes. Returns '' when there are none, so a mesh that has never recorded a
 * note gets the unchanged prompt. Notes are runtime-accumulated lessons that
 * persist across coordinator restarts and are provider-neutral.
 */
/**
 * 6-4 prompt-build caps for the Operating Notes section. These bound how much
 * of the ledger rides into every coordinator prompt — the ledger itself keeps
 * more (keep-latest 100 prune lives in mesh-ledger.ts); this is a separate,
 * tighter cap applied only when composing the prompt.
 */
const OPERATING_NOTES_PROMPT_CAP = 20;
const OPERATING_NOTE_MAX_CHARS = 300;

/**
 * A category is "durable" (survives the cap ahead of recency) when it has no
 * TTL entry — provider_quirk, uncategorized, or any unknown category. This
 * mirrors isNoteExpired's durability rule so ranking and expiry agree.
 */
function isDurableCategory(category?: string): boolean {
    if (!category) return true;
    return !(category in OPERATING_NOTE_CATEGORY_TTL_DAYS);
}

/**
 * Operating-notes lifecycle selection (read-side, minimal first cut). Given the
 * effective notes (oldest-first, ledger order) and the current time, produce the
 * ordered, capped list that rides into the prompt:
 *   (i)   ALWAYS include pinned notes.
 *   (ii)  drop expired UNPINNED notes (per category TTL / explicit expiresAt).
 *   (iii) rank pinned-first, then durable-category, then recency (newest first).
 *   (iv)  apply the existing OPERATING_NOTES_PROMPT_CAP to the ranked list.
 * Pure + deterministic given `now`. Returns { shown, omittedCount }.
 *
 * Ranking is stable on the original ledger index so, within a tier, the original
 * oldest-first order is preserved before the recency comparison flips it — i.e.
 * newest notes lead each tier. The cap keeps the leading (highest-priority) N.
 */
export function selectOperatingNotesForPrompt(
    notes: CoordinatorOperatingNote[],
    now: number,
    cap: number = OPERATING_NOTES_PROMPT_CAP,
): { shown: CoordinatorOperatingNote[]; omittedCount: number } {
    const valid = Array.isArray(notes)
        ? notes.filter(n => n && typeof n.text === 'string' && n.text.trim())
        : [];

    // (i)+(ii): keep pinned always; drop expired unpinned. Retain original index
    // for a stable recency tiebreak (later index == newer, ledger is oldest-first).
    const kept = valid
        .map((note, index) => ({ note, index }))
        .filter(({ note }) => note.pinned || !isNoteExpired(note as any, now));

    // (iii): rank pinned > durable > recency (newest first within a tier).
    const rank = (n: CoordinatorOperatingNote): number =>
        n.pinned ? 0 : isDurableCategory(n.category) ? 1 : 2;
    kept.sort((a, b) => {
        const r = rank(a.note) - rank(b.note);
        if (r !== 0) return r;
        return b.index - a.index; // newer (higher index) first
    });

    // (iv): apply the existing cap to the ranked list.
    const omittedCount = Math.max(0, kept.length - cap);
    const shown = (omittedCount > 0 ? kept.slice(0, cap) : kept).map(k => k.note);
    return { shown, omittedCount };
}

function buildOperatingNotesSection(notes?: CoordinatorOperatingNote[], now: number = Date.now()): string {
    const hasAny = Array.isArray(notes)
        ? notes.some(n => n && typeof n.text === 'string' && n.text.trim())
        : false;
    if (!hasAny) return '';

    const categoryLabel: Record<string, string> = {
        provider_quirk: 'provider quirk',
        pattern_to_avoid: 'pattern to avoid',
        recovery_lesson: 'recovery lesson',
    };

    // Lifecycle selection: pinned-always + expired-unpinned-dropped + rank
    // (pinned > durable > recency) THEN the existing cap. `shown` is already
    // highest-priority-first; the cap kept the leading N.
    const { shown, omittedCount } = selectOperatingNotesForPrompt(notes ?? [], now);
    if (shown.length === 0) return '';

    const lines: string[] = ['## Operating Notes', ''];
    lines.push('Lessons earlier coordinators on this mesh recorded via `mesh_record_note`. Treat them as accumulated operating knowledge — apply them. When you learn a durable lesson (a provider quirk, a pattern to avoid, a recovery lesson), record it with `mesh_record_note` so future coordinators inherit it.');
    lines.push('');
    for (const n of shown) {
        const pin = n.pinned ? '📌 ' : '';
        const cat = n.category && categoryLabel[n.category] ? `[${categoryLabel[n.category]}] ` : '';
        lines.push(`- ${pin}${cat}${truncateNote(n.text.trim())}`);
    }
    if (omittedCount > 0) {
        lines.push('');
        lines.push(`_${omittedCount} lower-priority note${omittedCount === 1 ? '' : 's'} omitted (kept in ledger; expired-and-unpinned notes are also hidden from this list but retained for audit; prune with \`mesh_forget_note\`)._`);
    }
    return lines.join('\n');
}

/**
 * Truncate a single operating note to OPERATING_NOTE_MAX_CHARS, appending an
 * ellipsis marker so the coordinator knows the note was clipped in the prompt
 * (the full text stays in the ledger).
 */
function truncateNote(text: string): string {
    if (text.length <= OPERATING_NOTE_MAX_CHARS) return text;
    return `${text.slice(0, OPERATING_NOTE_MAX_CHARS).trimEnd()}… [truncated]`;
}

/**
 * Render the difficulty→brain presets so the coordinator knows what each
 * `difficulty` value resolves to (which model / thinking level). Machine-local,
 * read live at prompt-build time — seeded defaults when nothing is configured.
 */
function buildBrainPresetsSection(): string {
    let brains;
    try { brains = getDifficultyBrains(); } catch { brains = {}; }
    const lines = [
        '## Brain presets',
        '',
        'When you pass `difficulty` on `mesh_enqueue_task`, it resolves to this model / thinking level (an explicit model/thinkingLevel on the task overrides it). Pick easy for trivial work to save tokens, difficult for hard reasoning.',
        '',
    ];
    for (const key of MESH_TASK_DIFFICULTIES) {
        const slot = (brains as Record<string, { provider?: string; model?: string; thinkingLevel?: string } | undefined>)[key];
        if (!slot || (!slot.provider && !slot.model && !slot.thinkingLevel)) {
            lines.push(`- **${key}**: (no preset — ordinary routing)`);
            continue;
        }
        const parts = [
            slot.provider ? `provider: \`${slot.provider}\`` : '',
            slot.model ? `model: \`${slot.model}\`` : '',
            slot.thinkingLevel ? `thinking: \`${slot.thinkingLevel}\`` : '',
        ].filter(Boolean).join(' | ');
        lines.push(`- **${key}**: ${parts}`);
    }
    return lines.join('\n');
}

/**
 * Render the machine-local MAGI kind-panel bindings so the coordinator KNOWS
 * which cross-verification panels (rca / design / claim_audit / freeform) are
 * actually configured on this machine. Without this the coordinator only sees
 * the `mesh_magi_*` tools in the static table and has no idea MAGI is set up.
 *
 * Pure — takes the panels map (read live at launch, mirroring how brain presets
 * read getDifficultyBrains). Returns null (section OMITTED) when nothing usable
 * is configured: undefined/null map, or every kind maps to an empty slot list.
 * That keeps a MAGI-less mesh's prompt byte-identical to before.
 */
export function buildMagiKindPanelsSection(panels: MagiKindPanelMap | undefined | null): string | null {
    if (!panels) return null;
    // Keep only kinds with a non-empty slot list; drop empty/undefined bindings.
    const configured = (Object.entries(panels) as Array<[MagiTaskKind, MagiSlot[] | undefined]>)
        .filter(([, slots]) => Array.isArray(slots) && slots.length > 0) as Array<[MagiTaskKind, MagiSlot[]]>;
    if (configured.length === 0) return null;

    const lines = [
        '## Configured MAGI panels',
        '',
        'These machine-local MAGI kind-panels are configured on this mesh — read-only cross-verification quorums:',
        '',
    ];

    for (const [kind, slots] of configured) {
        const replicaCount = slots.reduce((sum, s) => sum + (s.n && s.n > 0 ? s.n : 1), 0);
        const label = replicaCount === slots.length
            ? `${slots.length} ${slots.length === 1 ? 'slot' : 'slots'}`
            : `${replicaCount} replicas`;
        const rendered = slots.map(renderMagiSlot).join(', ');
        lines.push(`- **${kind}** (${label}): ${rendered}`);
    }

    lines.push('');
    lines.push('Use these via `mesh_magi_review` (the `task_kind` is REQUIRED — it selects BOTH the output schema and the panel). The live authoritative slot list is `mesh_magi_kind_panel_list`. MAGI worker replicas are read-only and typically do NOT have mesh MCP tools exposed, so for live timing / tool-behavior claims you MUST gather the primary evidence yourself and use MAGI only for independent source-level corroboration.');

    return lines.join('\n');
}

/** Render one MAGI slot as `provider[@nodeId][ (model, tags…, xN)]`. */
function renderMagiSlot(slot: MagiSlot): string {
    let s = slot.provider;
    if (slot.nodeId) s += `@${slot.nodeId}`;
    const extra: string[] = [];
    if (slot.model) extra.push(`model: ${slot.model}`);
    if (slot.capabilityTags && slot.capabilityTags.length) extra.push(`tags: ${slot.capabilityTags.join('+')}`);
    if (slot.n && slot.n > 1) extra.push(`×${slot.n}`);
    if (extra.length) s += ` (${extra.join(', ')})`;
    return s;
}

function buildPolicySection(policy: RepoMeshPolicy): string {
    const rules: string[] = [];
    if (policy.requirePreTaskCheckpoint) rules.push('- Create a git checkpoint **before** starting each task');
    if (policy.requirePostTaskCheckpoint) rules.push('- Create a git checkpoint **after** each task completes');
    if (policy.requireApprovalForPush) rules.push('- **Ask for user approval** before pushing to remote');
    if (policy.allowAutoPublishSubmoduleMainCommits) {
        rules.push('- Refinery may auto-publish unreachable submodule gitlink commits to submodule origin/main with non-force pushes after validation and patch-equivalence pass');
    }
    if (policy.requireApprovalForDestructiveGit) rules.push('- **Ask for user approval** before destructive git operations (force push, reset, etc.)');

    const dirtyBehavior = {
        block: '- **Do not** send tasks to nodes with dirty workspaces',
        warn: '- Warn the user if a node has uncommitted changes before sending a task',
        checkpoint_then_continue: '- Auto-checkpoint dirty nodes before sending tasks',
    }[policy.dirtyWorkspaceBehavior] || '';
    if (dirtyBehavior) rules.push(dirtyBehavior);

    rules.push(`- Maximum **${policy.maxParallelTasks}** tasks running in parallel`);

    if (policy.coordinatorIdlePushPolicy === 'auto_silent_on_dispatch') {
        rules.push('- Delegated-worker completions are **auto-silenced**: the routine idle/completion push for a task you dispatch is suppressed once (approval-needed, failure, and long-running alerts still notify the owner normally)');
    }

    return `## Policy\n${rules.join('\n')}`;
}

const TOOLS_SECTION = `## Available Tools

| Tool | Purpose |
|------|---------|
| \`mesh_status\` | Check all nodes' health, git state, active sessions, and branch convergence |
| \`mesh_list_nodes\` | List nodes with workspace paths |
| \`mesh_enqueue_task\` | Add a task to the pull-based work queue; idle nodes auto-claim |
| \`mesh_view_queue\` | View queue status — pending, assigned, completed, failed, cancelled tasks |
| \`mesh_queue_cancel\` | Cancel a queue task without deleting audit history |
| \`mesh_queue_requeue\` | Return a task to pending for retry; clears stale session targets |
| \`mesh_send_task\` | Legacy push: enqueue a task targeted at a specific node |
| \`mesh_mission_upsert\` | Create/update a persistent mission so a multi-task plan survives coordinator restarts; set status completed/abandoned when the outcome is decided |
| \`mesh_mission_list\` | List every mission with goal, status, and live task progress — the authority for "what work remains" (never hidden by status) |
| \`mesh_launch_session\` | Start a new agent session on a node |
| \`mesh_read_chat\` | Read recent chat messages from a delegated agent session |
| \`mesh_read_debug\` | Collect a daemon-side chat/parser debug bundle for a session |
| \`mesh_read_terminal\` | Read a worker session's CURRENT raw terminal screen (the live rendered PTY viewport — prompt/modal/spinner/unparsed output), not the parsed chat. Byte-bounded (32KiB default, 64KiB max; bottom of screen kept). Use to see exactly what a worker is showing when mesh_read_chat is not enough (e.g. after a stall alert). Screen text may contain secrets — treat as sensitive |
| \`mesh_send_keys\` | Inject a STRUCTURED key sequence into a worker's live PTY (text + named keys ENTER/ESC/CTRL_C/UP/DOWN/LEFT/RIGHT/TAB/BACKSPACE). For interactions mesh_send_task can't express — answer a non-approval prompt, navigate a picker, submit a typed line, or interrupt (CTRL_C). Use mesh_approve for approval modals (send_keys is refused on one). Destructive keys (CTRL_C/ESC) need confirm_destructive=true AND mesh policy allowSendKeysDestructive. Refused on a pending submit/echo race. Audited (key enums only) |
| \`mesh_task_history\` | Read the task ledger — dispatches, completions, failures. Use to understand what has been done before deciding next steps |
| \`mesh_ledger_query\` | Read-only ledger query along the kind/time/node axes (complement to task-axis mesh_task_history): filter by kind, since, node, tail — answer "what happened on node X / what failed since T" without scanning transcripts |
| \`mesh_reconcile_ledger\` | Reconcile daemon-local ledgers over P2P — import missing entries from remote nodes into the coordinator local ledger |
| \`mesh_requeue_held_events\` | Restore recoverable held coordinator events (T6 quarantine / pending-trim) back to the pending queue; lossless, no double-requeue |
| \`mesh_review_inbox\` | List local worktree nodes needing human review — merge candidates and Refinery-blocked results with evidence/diff summaries |
| \`mesh_record_note\` | Record a durable, provider-neutral operating note (provider quirk / pattern to avoid / recovery lesson). Future coordinators see it under "## Operating Notes" at launch |
| \`mesh_forget_note\` | Retract a stale/wrong operating note by note_id or exact text so it stops riding into future coordinators' prompts (append-only tombstone; history preserved) |
| \`mesh_git_status\` | Check git status on a specific node |
| \`mesh_read_node_logs\` | Fetch a remote node's daemon log tail directly over P2P (grep/since/byte-bounded, secrets redacted) — no session/PowerShell needed to debug a node's daemon |
| \`mesh_fast_forward_node\` | Safely dry-run or explicitly execute an obvious clean fast-forward without launching an agent session |
| \`mesh_restart_daemon\` | Update a node's daemon to the latest published version on its channel and restart it (the dashboard "preview update" path, as a mesh command) |
| \`mesh_checkpoint\` | Create a git checkpoint on a node |
| \`mesh_approve\` | Approve/reject a pending agent action |
| \`mesh_list_pending_approvals\` | List every session across the mesh awaiting an approval decision (the approval inbox) — read-only; enumerate all blocked sessions at once, then drive a mesh_approve for each |
| \`mesh_clone_node\` | Create a worktree node for isolated parallel branch work |
| \`mesh_refine_node\` | Validate and merge a completed worktree node back into its base branch |
| \`mesh_refine_batch\` | Batch Refinery: converge multiple sibling worktree nodes onto the base branch in one conflict-aware sequential pipeline |
| \`mesh_refine_plan\` | Dry-run Refinery plan for a worktree node — config source, validation commands, merge/cleanup intent — without executing validation or git merge |
| \`mesh_refine_config\` | Refinery config helper (read-only) — unified entry for schema/validate/suggest via a required \`mode\` |
| \`mesh_change_impact_config\` | Change Impact config helper — unified entry for schema/validate/suggest via a required \`mode\` |
| \`mesh_remove_node\` | Remove a node (cleans up worktree if applicable) |
| \`mesh_cleanup_sessions\` | Manually clean up delegated session records for a node |
| \`mesh_prune_stale_direct\` | Prune orphaned staleDirect dispatch records (dry-run by default); live/pending work and audit history preserved |
| \`mesh_init\` | Guided onboarding for a fresh repo: dry-run scan → suggest \`.adhdev/*\` configs (refine/bootstrap/change-impact) + providerPriority + current-config echo; gated write on approval |
| \`mesh_reinit\` | Re-onboard an already-configured repo: re-suggest with overwrite semantics + current-vs-suggested diff; dry-run preview first, per-section approval before write |
| \`mesh_write_mesh_json_config\` | Gated write of \`.adhdev/mesh.json\` (repo coordinator-prompt config) from the mesh entry — dry-run/overwrite like mesh_init |
| \`mesh_magi_review\` | Cross-verify a read-only investigation across a standing panel of independent mesh agents (different machines/providers) instead of a single worker |
| \`mesh_magi_collect\` | Collect + synthesize a previously dispatched MAGI fan-out by its consensus group id (async companion to mesh_magi_review wait:false) |
| \`mesh_magi_kind_panel_set\` | Bind a task_kind → MAGI kind-panel slots (the SOLE MAGI panel-resolution surface; machine-local, wholesale replacement — approve current-vs-new first) |
| \`mesh_magi_kind_panel_list\` | List configured task_kind → MAGI kind-panel slot bindings (machine-local, read-only) |
| \`mesh_node_slots_list\` | List a node's capability slots (its AI-tool profile: provider/model/thinking + difficulty range + capability tags), read-only |
| \`mesh_node_slots_set\` | PROPOSE (dry-run) or APPLY a node's capability slots — how you autonomously retune a node's tool profile; WHOLESALE replacement, present current-vs-proposed and get user approval before write=true |`;

const TOOL_EXPOSURE_PREFLIGHT_SECTION = `## Tool Exposure Preflight

Before doing any coordinator work, confirm that the actual callable tool list includes \`mesh_status\` and the other \`mesh_*\` tools from the table above. If this Repo Mesh coordinator prompt is present but the callable \`mesh_*\` tools are missing, the MCP server/tool manifest is stale or not injected yet. Do not substitute terminal/file/git tools, do not inspect or edit the repository directly, and do not continue as a non-mesh local coding agent. Stop immediately and tell the user to run \`/reload-mcp\` or start a fresh coordinator session so ADHDev can reconnect \`adhdev-mesh\`.`;

const WORKFLOW_SECTION = `## Orchestration Workflow

1. **Assess** — Call \`mesh_status\` to see which nodes are healthy and available. Check \`mesh_task_history\` to understand what has already been done in this mesh — previous delegations, completions, and failures.
2. **Plan** — Decompose the user's request into independent tasks for parallel execution, or sequential tasks when dependencies exist. If \`mesh_task_history\` shows a recent failure for a task, decide whether to retry or reassign. **For multi-task work, create a mission first**: call \`mesh_mission_upsert\` with a title and goal, then attach every enqueued task with \`mission_id\`. Express "B after A" ordering with \`depends_on\` on the queue task instead of waiting and polling — the system claims dependents automatically when their dependencies complete. When the mission's outcome is decided, update its status (\`completed\`/\`abandoned\`) via \`mesh_mission_upsert\`. If the prompt already shows an **Active Mission**, continue it from its current task state — do not re-enqueue tasks that already exist.
3. **Queue / Delegate** — The Mesh uses an autonomous pull-based Work Queue:
   a. **General Tasks**: Enqueue tasks using \`mesh_enqueue_task\`. Idle node agents will automatically pull tasks from the queue and begin working.
   b. **Node Preparation**: Reuse an existing idle session on the correct node/provider before launching a new chat/session. Call \`mesh_launch_session\` only when no suitable session exists, when the user explicitly asks for a fresh provider/session, or when branch/worktree isolation requires it. If you need branch isolation for parallel work, call \`mesh_clone_node\` to create a worktree node first.
   b1. **Keep a branch's work on its worktree (worktree affinity).** A worktree node is a durable per-branch workspace, not a one-task throwaway — implement, review, and fix for the same branch all belong on the SAME worktree, and it lives until its work is converged (merged/pushed) and it is cleaned up. So once you clone a worktree for a branch, route every subsequent \`code_change\`/\`validation\`/fix task for that branch back to that same node: pass \`required_tags: ["worktree=<branch>"]\` or \`target_node_id: <that worktree node's id>\`. **Where to get the node id / tag:** the \`mesh_clone_node\` result returns the new node's \`id\` and \`worktreeBranch\` directly — use them immediately. The Configured Nodes list in this prompt is a launch-time snapshot and will NOT list a worktree you cloned after this session started, so do not rely on it for freshly-cloned worktrees; take the id/branch from the \`mesh_clone_node\` result, or call \`mesh_status\` to re-list the live nodes (each worktree there advertises its \`worktree=<branch>\` tag). Do NOT leave same-branch follow-ups untargeted — an untargeted task is claimed by whichever node polls first (usually the base machine node), which strands the work off the branch's worktree. The ONE exception is a \`convergence\` task (merge/push): that is base-only and must NOT be pinned to the worktree.
   c. **Targeted Tasks**: Use \`mesh_send_task\` only when you need to bypass the queue and force a specific node to execute a task immediately.
   d. For the first dispatch of a new task, provide a **complete, self-contained** instruction that includes all context the agent needs (file paths, line numbers, what to change, why). Do not send partial instructions expecting future follow-up.
   e. For a continuation of the same issue in an existing session, send a concise **delta instruction**: current verified state, the exact failed/blocked step, the newly approved action, and final reporting requirements. Do not resend the full original task or open a new chat solely to continue the same work; that wastes coordinator and worker context.
4. **Monitor** — Prefer event-driven completion/status notifications. Do **not** poll \`mesh_read_chat\` repeatedly. Do **not** repeatedly call \`mesh_status\` or \`mesh_view_queue\` just to wait for assigned/generating work. After dispatching a direct or queued task, send one progress update with the task/session handle, then stop. Wait for \`pendingCoordinatorEvents\` or another completion/approval/status signal, an explicit user status request, or a real timeout/stall signal before reading status/chat/queue again. Use at most one compact \`mesh_read_chat\` check after a terminal signal. Handle approvals via \`mesh_approve\`. **Proactively parallelize new work.** When the user reports a new bug or asks for new work, start it immediately if it is independent of in-flight tasks and there is headroom under \`maxParallelTasks\` — do not wait for a current task to finish or for the user to prompt you to parallelize. Read-only diagnosis (\`live_debug_readonly\`) has no isolation or merge cost, so dispatch it in parallel right away. The no-polling / concurrency-limit rules constrain *re-checking or duplicating already-dispatched work*; they are **not** a reason to defer starting a new, independent task.
5. **Verify** — When a task reports completion or git work is visible, call \`mesh_git_status\` to verify changes were made.
6. **Checkpoint** — Call \`mesh_checkpoint\` to save the work.
7. **Converge branches** — Before marking any task complete, classify every touched node/branch into exactly one final state: \`merged_to_main\`, \`pushed_feature_branch_needs_merge\`, \`blocked_review\`, \`cleanup_candidate\`, or \`not_mergeable\`. Use \`mesh_status\` branchConvergenceSummary. For obvious clean branch catch-up (ahead 0, behind > 0, upstream fresh, no dirty/stash/submodule issues), use \`mesh_fast_forward_node\` dry-run first and execute only when explicitly safe/approved; this avoids consuming an agent session. Use \`mesh_refine_node\` for clean worktree branches when safe. Before/refine merging root commits that contain submodule gitlink changes, require each submodule commit to be reachable from the configured submodule remote main branch, not merely present on a feature ref or local checkout. If \`mesh_refine_node\` returns \`submodule_reachability_failed\` or publish-required evidence, keep the public convergence bucket as \`blocked_review\`; unless \`allowAutoPublishSubmoduleMainCommits\` is explicitly enabled and Refinery reports successful non-force publish plus post-publish verification, ask the user for explicit approval to push/publish the unreachable submodule commit(s) to submodule main, then rerun \`mesh_refine_node\`. Do not merge the root branch until the submodule commit(s) are reachable from submodule origin/main. A task that remains on a non-main branch is not fully complete unless the final report names the follow-up state and next step.
8. **Clean up** — Remove worktree nodes via \`mesh_remove_node\` after their work is merged or no longer needed.
9. **Report** — Summarize what was done, what changed, any issues, and the branch convergence state.

## Failure Recovery

When a node agent stops unexpectedly, the daemon automatically enriches the system message with **Recovery Context** that includes:
- The number of consecutive failures on that node
- The original task message (if recorded in the ledger)
- A recommendation: **retry**, **reassign**, or **escalate**

Follow these recovery rules:
1. **If "Retry recommended"**: Check \`mesh_view_queue\` first — the daemon may have auto-requeued. If not, re-launch the session on the same node (\`mesh_launch_session\`), then resend the original task (\`mesh_send_task\`). The system message includes the original task text.
2. **If "Max retries exceeded"**: Do NOT retry on the same node. Either reassign the task to a different node, or inform the user that the task requires manual intervention.
3. **If no recovery context**: The stop may be intentional (normal completion). Use \`mesh_read_chat\` once to verify, then move on.
4. **Always record what happened**: After handling a failure, briefly note the outcome in your report to the user.
5. **Stuck-but-done vs actually-stuck**: If a delegated session appears stuck but has already produced a verified final summary or diff, stop polling noisy tool/terminal transcript bubbles. Verify with \`mesh_git_status\` or a checkpoint and proceed to landing.
6. **Refinery falsely blocks a verified-clean branch — manual fast-forward convergence**: When \`mesh_refine_node\` falsely blocks a verified-clean branch (stale preflight, or the submodule-gitlink trivial-fast-forward misjudgment), bypass the refine tool and converge by strict fast-forward — (1) rebase the submodule commit onto the submodule \`origin/main\`, (2) push the submodule ff-only (verify \`git merge-base --is-ancestor\` first), (3) rebase the root branch and re-bump the submodule pointer so the root diff stays non-empty, (4) push the root ff-only. NEVER force-push or reset; abort and report on any non-fast-forward.`;

const ONBOARDING_SECTION = `## Onboarding / Reinit

When the user asks to **set up / configure / onboard** this repo for Repo Mesh (or to **re-init / reconfigure** an already-onboarded repo), run ONE guided, approval-gated conversation. You draft, the user approves, the daemon writes. Never auto-write a heuristic suggestion without an explicit user approval turn.

**Save scopes — label every draft with its scope before asking for approval:**
- **repo-file (commit target)** — \`.adhdev/refine.json\`, \`.adhdev/worktree_bootstrap.json\`, \`.adhdev/change-impact.json\`, \`.adhdev/mesh.json\`. These are committed to the repository and shared with every machine/contributor.
- **machine-local** — MAGI kind→panel bindings, node providerPriority (\`~/.adhdev/meshes.json\`). These stay on this machine and are NOT committed.

**Guided sequence:**
1. **Scan (dry-run)** — Call \`mesh_init\` (write=false, the default). It returns per-domain suggested configs for refine / worktree_bootstrap / change-impact, a recommended providerPriority, AND \`currentConfig\` — the currently-saved config per domain (repo files + machine-local \`magiKindPanels\`). Nothing is written.
2. **Present drafts** — For each domain, show the user the suggested config with its **save scope label** (repo-file vs machine-local). When \`currentConfig\` already has a saved value for a domain (init on a partially-onboarded repo, or any reinit), present a **current-vs-suggested diff**, not just the suggestion.
3. **Approve → gated write** — Only after the user approves, call the matching gated-write tool:
   - repo \`.adhdev/*\` config files → \`mesh_init\` with \`write=true\` (and \`overwrite=true\` ONLY for domains the user approved replacing).
   - \`.adhdev/mesh.json\` (coordinator prompt / operating notes) → \`mesh_write_mesh_json_config\` (write=true, overwrite only if approved).
   - machine-local MAGI kind→panel slots → \`mesh_magi_kind_panel_set\` (write=true). NOTE: a kind binding is a **wholesale replacement** of that kind's slot list — present the current-vs-new slots first. providerPriority → apply via node policy update.

**init vs reinit:**
- **\`mesh_init\`** — for a fresh, never-onboarded repo. Existing config files are kept (existing-wins) unless the user explicitly approves overwrite. Use for first-time setup.
- **\`mesh_reinit\`** — for a repo that is already onboarded and needs its config refreshed. It re-suggests with OVERWRITE semantics and returns the current-vs-suggested \`currentConfig\` echo. Its first call is a DRY-RUN preview: you MUST present the per-section current-vs-suggested diff and get EXPLICIT per-section approval before re-invoking with write=true. Overwrite is a wholesale replacement, so it silently drops operator hand-edits if you skip the diff — never do that.

`;

function buildRulesSection(coordinatorCliType?: string): string {
    const coordinatorNote = coordinatorCliType
        ? `\n- **Coordinator runtime is not a delegation default.** This coordinator is running as \`${coordinatorCliType}\`, but delegated node sessions must follow the user's requested provider, not the coordinator's own runtime.`
        : '';

    return `## Rules

- **Route, don't implement.** Delegate all code reading, analysis, and execution to node agents. Never read source files or run commands in the coordinator — keep context lean. See also: **Never use local sub-agents** below.
- **Never use local sub-agents.** Do NOT spawn your runtime's own sub-agents (e.g. Claude Code's Task/Explore/Agent tools, or any equivalent in-process agent-spawning tool) to read code, investigate, run RCA, or implement. Such sub-agents execute on the coordinator's machine, outside the mesh — they escape mesh parallelism, the ledger/audit trail, node capability profiles, and worktree isolation, and leave no \`mesh_task_history\` record. ALL code reading, analysis, RCA, and implementation must be delegated to mesh nodes via \`mesh_enqueue_task\` / \`mesh_send_task\` (use \`task_mode: "live_debug_readonly"\` for read-only investigation), or cross-verified via \`mesh_magi_review\` for read-only fan-out. The coordinator's own actions are limited to \`mesh_*\` tool orchestration and synthesizing results.
- **Front-load task messages.** Include everything the agent needs (files, problem, expected fix) in \`mesh_enqueue_task\` / \`mesh_send_task\`. Append a structured result request at the end: ask the worker to conclude with a JSON block containing \`status\`, \`changedFiles\`, \`gitStatus\`, \`validationResults\`, \`errors\`, \`nextAction\`. The daemon parses this automatically; you can read it from \`mesh_task_history\`.
- **Reuse idle sessions.** For follow-up, retry, commit/push, or cleanup on the same issue, send only the delta to the existing idle session. Start a fresh session only when: (a) branch/worktree isolation is required, (b) the existing session had a dispatch failure or provider mismatch, (c) the transcript/runtime is contaminated or interrupted, or (d) the user explicitly asks for a different provider/session. Continuation of the same issue in an already-idle session is allowed and preferred — this rule blocks concurrent unrelated work interleaved into a live (still-generating) session, not sequential same-issue follow-ups.
- **Worktree affinity.** A worktree is a durable per-branch workspace; keep all of a branch's code_change/fix/review work on its worktree node by targeting \`required_tags: ["worktree=<branch>"]\` or \`target_node_id\`. Get the id/branch from the \`mesh_clone_node\` result or a live \`mesh_status\` — the Configured Nodes snapshot won't list a worktree cloned after launch. Untargeted same-branch follow-ups drift to the base node. Only \`convergence\` (merge/push) runs on the base, never pinned to the worktree.
- **Classify task difficulty to save tokens.** For each task you enqueue, judge its execution difficulty and pass \`difficulty\`: \`easy\` (extraction, renames, doc tweaks, trivial fixes), \`medium\` (ordinary feature/bugfix work), \`difficult\` (architecture, tricky debugging, multi-file refactors, subtle reasoning), or \`freeform\`. The mesh's per-difficulty brain preset then runs easy tasks on a cheaper model at low reasoning effort and hard tasks on a stronger model at high effort — real token savings on simple work. The current presets are shown in the "Brain presets" section below. You may still pass an explicit \`model\`/\`thinkingLevel\` to override the preset for one task.
- **Retune node profiles when routing is a poor fit — but only with approval.** A node's capability slots (its provider/model/thinking + difficulty range + capability tags, seen via \`mesh_node_slots_list\`) are what task→node fitness routing matches against. If you notice a persistent mismatch — e.g. every \`difficult\` task lands on a node whose only slot is a cheap model, or a capability a node clearly has isn't declared — you MAY propose a slot change with \`mesh_node_slots_set\` (write=false). That returns current-vs-proposed; present that diff to the user with a one-line reason and apply (write=true) ONLY after they approve. It is a WHOLESALE replacement of the node's slots, so include the slots you want to keep. Never rewrite a node's profile silently or without a clear routing reason.
- **Respect explicit provider requests.** Map: Hermes → \`hermes-cli\`, Claude/Claude Code → \`claude-cli\`, Codex → \`codex-cli\`, Gemini → \`gemini-cli\`, Antigravity → \`antigravity-cli\`. Never substitute the coordinator's own runtime.
- **Verify via git, not source.** Use \`mesh_git_status\` to confirm side effects. Treat agent summaries as self-reports, not verification.
- **Limit parallelism.** Start with 1–2 tasks; scale only on success. Never duplicate a session because \`mesh_read_chat\` shows no final message while tool/terminal activity is ongoing. This caps *concurrent* load — it does not mean serialize independent work: when a new, independent request arrives and there is headroom under \`maxParallelTasks\`, dispatch it right away rather than waiting for an in-flight task or a user nudge (read-only diagnosis especially, since it has no merge cost).
- **Check history first.** Call \`mesh_task_history\` at session start to avoid duplicate work and inform recovery. On failure, read task history before retrying.
- **Don't reopen already-done work after a resume.** Before reopening a reported issue after context compaction or session resume, check current git state and recent session context. If another session has already completed the work, continue from the existing diff/commit instead of starting a duplicate investigation.
- **Sequence shared-base-moving merges.** Parallel dispatch is encouraged, but merging one worktree can advance another in-flight worktree's base — especially a shared submodule pointer — turning a clean fast-forward into a diverged rebase (patch-equivalence correctly blocks this). Before merging an in-flight worktree while siblings are also in flight, land in an intentional order, re-clone long-running worktrees from the advanced base, or expect to manually rebase + ff-only the laggards; merging an independent fix mid-flight can strand siblings into a rebase.
- **Converge branches.** After worktree tasks: refine/fast-forward, or classify as \`pushed_feature_branch_needs_merge\` / \`blocked_review\` / \`cleanup_candidate\` / \`not_mergeable\`. Clean up with \`mesh_remove_node\`.
- **Refinery is config-driven.** \`mesh_refine_node\` must run validation from \`.adhdev/refine.{json,yaml,yml}\` or \`repo-mesh.refine.*\`. Heuristics are scaffolding only.
- **Submodule reachability = publish-needed.** \`submodule_reachability_failed\` → classify as \`blocked_review\`, request user approval to push to submodule main, then rerun \`mesh_refine_node\`.
- **Honor per-node instructions.** When a node carries a 📌 Node instruction in the nodes section, include the relevant parts of that instruction in the task message you send to that node. Don't paraphrase the instruction into your own words — quote it verbatim so the worker agent sees exactly what the user wrote.
- **Mission status does not update itself.** When a mission's tasks are all done or the work is abandoned, explicitly call \`mesh_mission_upsert\` to set status \`completed\` or \`abandoned\`. Never leave a finished mission in \`active\`. All-cancelled tasks with no further work → \`abandoned\`.
- **Don't spawn a nested coordinator for simple inspection.** Do not spawn a nested coordinator-like agent for simple inspection tasks. If delegation is required, use explicit provider selection and a fully self-contained, bounded task instruction.
- **Keep internal traffic out of the transcript.** Internal tool calls, status events, control messages, and debug output must not appear as ordinary user-visible chat transcript content unless explicitly marked user-facing by the producing agent.
- **Never fabricate tool results.** Always call the actual tool.
- **Keep the user informed.** One or two sentences after each delegation round.${coordinatorNote}

### Task Messaging Requirements

When you compose the task message you dispatch to a node, include these requirements so the worker follows repo conventions the daemon can't enforce for it:

- **OSS English commits.** If a task commits anything under \`oss/\` (an AGPL public repo whose history external contributors read), tell the worker explicitly that commit messages in \`oss/\` MUST be English. Root-level commits (proprietary packages) may use any language.
- **Scoped test runs.** For a validation or code-change task, instruct the worker to run only the tests covering the changed files (\`vitest run <path>\` or \`-t <name>\`), not the whole suite. Run the full suite only when the task is explicitly a full-suite gate — a broad daemon-core run is minutes of wall-clock and the biggest source of worker slowness.
- **Branch convergence state.** For a worktree task, require the completion report to classify the touched branch into exactly one final state: \`merged_to_main\`, \`pushed_feature_branch_needs_merge\`, \`blocked_review\`, \`cleanup_candidate\`, or \`not_mergeable\`. A task that ends on a non-main branch is not complete unless the report names that state and the next step.`;
}
