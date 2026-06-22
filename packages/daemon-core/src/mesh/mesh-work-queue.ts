import { randomUUID } from 'crypto';
import { requireMeshHostQueueOwner } from './mesh-host-ownership.js';
import type { RepoMeshDaemonRole } from '../repo-mesh-types.js';
import { MESH_CONVERGE_REFINE_TAG, resolveAutoConvergeCodeChange } from '../repo-mesh-types.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { getMesh } from '../config/mesh-config.js';
import { LOG } from '../logging/logger.js';
import { appendLedgerEntry } from './mesh-ledger.js';
import type { MeshLedgerKind } from './mesh-ledger.js';

export type MeshTaskStatus = 'pending' | 'assigned' | 'completed' | 'failed' | 'cancelled';
export type MeshActiveTaskStatus = Extract<MeshTaskStatus, 'pending' | 'assigned'>;
export type MeshHistoricalTaskStatus = Extract<MeshTaskStatus, 'completed' | 'failed' | 'cancelled'>;
export type MeshTaskMode = 'code_change' | 'validation' | 'live_debug_readonly' | 'launch_app' | 'convergence';

export const ACTIVE_MESH_QUEUE_STATUSES: MeshActiveTaskStatus[] = ['pending', 'assigned'];
export const HISTORICAL_MESH_QUEUE_STATUSES: MeshHistoricalTaskStatus[] = ['completed', 'failed', 'cancelled'];
export const MESH_TASK_MODES: MeshTaskMode[] = ['code_change', 'validation', 'live_debug_readonly', 'launch_app', 'convergence'];

export interface MeshTaskModeValidationResult {
    valid: boolean;
    taskMode?: MeshTaskMode;
    violations: string[];
    allowedOperations?: string[];
}

const LIVE_DEBUG_READONLY_FORBIDDEN: Array<{ label: string; pattern: RegExp }> = [
    { label: 'source_edit', pattern: /\b(edit|modify|patch|apply\s+patch|write\s+(?:to\s+)?(?:file|source)|overwrite|delete\s+file|remove\s+file|create\s+file|touch\s+file)\b/i },
    { label: 'checkpoint', pattern: /\b(checkpoint|mesh_checkpoint)\b/i },
    { label: 'deploy_or_version_bump', pattern: /\b(deploy|wrangler\s+deploy|version[-\s]?bump|npm\s+version|release|npm\s+publish|yarn\s+publish|pnpm\s+publish)\b/i },
    { label: 'destructive_shell', pattern: /\b(rm\s+-rf|mv\s+\S+\s+\S+|truncate\s|tee\s+\S+|sed\s+-i|shred\b)\b/i },
    { label: 'package_install', pattern: /\b(npm\s+(?:install|i|add|link|uninstall|remove)|yarn\s+(?:add|remove|link)|pnpm\s+(?:add|remove|link)|pip\s+install|brew\s+install|apt\s+install|cargo\s+install)\b/i },
    { label: 'container_mutation', pattern: /\b(docker\s+(?:build|run|exec|push|tag|rmi|rm|create|start|stop|kill)|kubectl\s+(?:apply|delete|patch|replace|create|scale))\b/i },
];

/**
 * Negation cues that, when they appear shortly before a mutation keyword inside
 * the same clause, mean the keyword is being *forbidden* or described rather
 * than invoked (e.g. "do not git reset", "절대 push 하지 마세요"). Matched
 * case-insensitively. The Korean cues intentionally include sub-string forms
 * ("않", "금지", "말 것") so conjugated variants are caught.
 */
const NEGATION_CUES: string[] = [
    "don't", 'do not', 'never', 'avoid', 'without', 'no longer', 'not', 'forbidden',
    '하지 마', '하지 마세요', '말 것', '금지', '없음', '않',
];

/** How many whitespace-delimited tokens before a keyword we scan for negation. */
const NEGATION_WINDOW_TOKENS = 6;

/**
 * Returns true if a negation cue appears within {@link NEGATION_WINDOW_TOKENS}
 * tokens before `matchIndex`, staying inside the same clause — we stop at
 * sentence/line/clause boundaries (newline, `.`/`!`/`?`, `;`) so a negation in a
 * previous sentence does not suppress a real command in the next one.
 */
function hasNegationBefore(text: string, matchIndex: number): boolean {
    const before = text.slice(0, matchIndex);
    // Restrict to the current clause: cut at the last clause/sentence/line break.
    const clauseStart = Math.max(
        before.lastIndexOf('\n'),
        before.lastIndexOf('. '),
        before.lastIndexOf('! '),
        before.lastIndexOf('? '),
        before.lastIndexOf(';'),
    );
    const clause = before.slice(clauseStart + 1);
    const lower = clause.toLowerCase();
    // Whitespace tokens immediately preceding the keyword, within the window.
    const tokens = clause.split(/\s+/).filter(Boolean);
    const windowTokens = tokens.slice(Math.max(0, tokens.length - NEGATION_WINDOW_TOKENS));
    const windowText = windowTokens.join(' ').toLowerCase();
    for (const cue of NEGATION_CUES) {
        const c = cue.toLowerCase();
        // ASCII cues are word-ish phrases — match in the bounded window only.
        // CJK cues have no spaces, so the window-join can miss them; for those
        // fall back to scanning the whole clause (still clause-bounded).
        if (/[^\x00-\x7f]/.test(c)) {
            if (lower.includes(c)) return true;
        } else if (windowText.includes(c)) {
            return true;
        }
    }
    return false;
}

/**
 * Korean (and other) negation often trails the verb it negates ("git reset 하지
 * 마세요" = "do not git reset"). Returns true if a CJK negation cue appears
 * shortly after `matchEnd`, within the same clause. Scoped to CJK cues only —
 * trailing ASCII words rarely negate a preceding command and would over-match.
 */
function hasTrailingNegation(text: string, matchEnd: number): boolean {
    const after = text.slice(matchEnd);
    // Clause-bound the lookahead: stop at the next clause/line break.
    const clauseEnd = (() => {
        const stops = [after.indexOf('\n'), after.indexOf('. '), after.indexOf('; ')]
            .filter(i => i >= 0);
        return stops.length ? Math.min(...stops) : after.length;
    })();
    const clause = after.slice(0, clauseEnd).toLowerCase();
    for (const cue of NEGATION_CUES) {
        const c = cue.toLowerCase();
        if (/[^\x00-\x7f]/.test(c) && clause.includes(c)) return true;
    }
    return false;
}

/**
 * Returns true when the keyword at [matchStart, matchEnd) looks like an actual
 * command invocation rather than a plain-prose mention. Command context is:
 *   - inside a fenced code block (``` ... ```) or inline backticks (`...`)
 *   - on a shell-prompt line (starts with `$ ` or `> `)
 *   - at a command-call position: line start (leading whitespace allowed) or
 *     right after a shell connective (`&&`, `||`, `|`, `;`) or an imperative
 *     connective ("then"/"run"/"," ) that introduces a command.
 * Plain mid-sentence prose mentions (no backticks, no command position) are not
 * command context and are excluded from violations.
 */
function isMutationKeywordInCommandContext(text: string, matchStart: number, matchEnd: number): boolean {
    if (isInsideBackticksOrFence(text, matchStart, matchEnd)) return true;

    // The line containing the match, and the portion of it before the keyword.
    const lineStart = text.lastIndexOf('\n', matchStart - 1) + 1;
    const linePrefix = text.slice(lineStart, matchStart);

    // Shell-prompt line: "$ ..." or "> ..." (leading whitespace allowed).
    if (/^\s*[$>]\s/.test(text.slice(lineStart))) return true;

    // Line start (only whitespace before the keyword on this line).
    if (/^\s*$/.test(linePrefix)) return true;

    // After a shell connective or imperative connective introducing a command.
    // We look at what immediately precedes the keyword on the same line.
    if (/(?:&&|\|\||\||;)\s*$/.test(linePrefix)) return true;
    if (/(?:^|[\s,])(?:then|run|first)\s+$/i.test(linePrefix)) return true;
    if (/,\s*$/.test(linePrefix)) return true;

    return false;
}

/**
 * True if [matchStart, matchEnd) lies inside an inline-backtick span or a fenced
 * code block. Fenced blocks (```...```) take precedence; otherwise we count
 * inline backticks before the match — an odd count means we are inside a span.
 */
function isInsideBackticksOrFence(text: string, matchStart: number, matchEnd: number): boolean {
    // Fenced code blocks: count ``` fences before the match.
    const fenceRe = /```/g;
    let fenceCount = 0;
    let m: RegExpExecArray | null;
    while ((m = fenceRe.exec(text)) !== null) {
        if (m.index >= matchStart) break;
        fenceCount++;
    }
    if (fenceCount % 2 === 1) return true;

    // Inline backticks: count single backticks before the match start, ignoring
    // those that are part of a ``` fence (handled above). An odd count → inside.
    let inlineCount = 0;
    for (let i = 0; i < matchStart; i++) {
        if (text[i] === '`') {
            // Skip triple-fence backticks.
            if (text[i + 1] === '`' && text[i + 2] === '`') {
                i += 2;
                continue;
            }
            inlineCount++;
        }
    }
    return inlineCount % 2 === 1;
}

/**
 * Decides whether a forbidden keyword match at [matchStart, matchEnd) should
 * count as a real violation. A match counts only when it is in command context
 * and not negated. Negation always wins (even inside a code block), per the
 * conservative rule: code-block + negation → exclude; other code-block → keep.
 */
function isRealMutationMatch(text: string, matchStart: number, matchEnd: number): boolean {
    if (hasNegationBefore(text, matchStart)) return false;
    if (hasTrailingNegation(text, matchEnd)) return false;
    return isMutationKeywordInCommandContext(text, matchStart, matchEnd);
}

/**
 * Runs a global regex over `text` and returns true if any match is a real
 * mutation (command context, not negated).
 */
function patternHasRealMutation(pattern: RegExp, text: string): boolean {
    const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
        if (isRealMutationMatch(text, match.index, match.index + match[0].length)) return true;
        if (match.index === re.lastIndex) re.lastIndex++; // avoid zero-width loop
    }
    return false;
}

/**
 * Git subcommands that mutate the working tree, index, refs, or remote.
 * `stash` and `checkout` are intentionally absent here: they have read-only
 * variants (`git stash list`/`show`, `git checkout-index`) and are classified
 * token-by-token in {@link detectGitMutation} rather than by bare keyword.
 */
const GIT_MUTATION_SUBCOMMANDS = new Set([
    'add', 'commit', 'push', 'reset', 'rebase', 'clean', 'switch', 'merge',
    'tag', 'restore', 'rm', 'mv', 'cherry-pick', 'revert', 'pull', 'fetch',
    'am', 'apply', 'gc', 'prune',
]);

/**
 * Read-only `git stash` variants. Any other `git stash <x>` (pop/apply/drop/
 * push/save/clear, or bare `git stash` which defaults to push) is a mutation.
 */
const GIT_STASH_READONLY_SUBCOMMANDS = new Set(['list', 'show']);

/**
 * Detects a true git mutation in free-text task message, token-aware so that
 * read-only diagnostics (`git stash list`, `git stash show --stat`,
 * `git checkout-index`, `git status`, `git diff`, `git log`, ...) are allowed.
 * Returns true only when a genuine mutating git invocation is present.
 */
function detectGitMutation(message: string): boolean {
    const re = /\bgit\s+([a-z][a-z0-9-]*)/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(message)) !== null) {
        const sub = match[1].toLowerCase();
        // Only treat a mutating `git <sub>` as a real violation when it appears
        // as an actual command (code/command context) and is not negated. Plain
        // prose mentions ("don't git reset", "we won't push") are ignored.
        const isReal = () => isRealMutationMatch(message, match!.index, match!.index + match![0].length);
        if (GIT_MUTATION_SUBCOMMANDS.has(sub)) {
            if (isReal()) return true;
            continue;
        }
        if (sub === 'stash') {
            // Token following `git stash`; read-only only for list/show.
            const after = message.slice(re.lastIndex).match(/^\s+([a-z][a-z0-9-]*)/i);
            const next = after ? after[1].toLowerCase() : '';
            if (!GIT_STASH_READONLY_SUBCOMMANDS.has(next) && isReal()) return true; // bare stash = push, or pop/apply/drop/...
        } else if (sub === 'checkout') {
            // `git checkout <ref/path>` mutates; `git checkout-index` is matched
            // as its own token by the regex (sub === 'checkout-index') and is read-only.
            if (isReal()) return true;
        } else if (sub === 'submodule') {
            // `git submodule update` mutates; `git submodule status` is read-only.
            const after = message.slice(re.lastIndex).match(/^\s+([a-z][a-z0-9-]*)/i);
            const next = after ? after[1].toLowerCase() : '';
            if ((next === 'update' || next === 'add' || next === 'sync' || next === 'deinit') && isReal()) return true;
        } else if (sub === 'worktree') {
            const after = message.slice(re.lastIndex).match(/^\s+([a-z][a-z0-9-]*)/i);
            const next = after ? after[1].toLowerCase() : '';
            if ((next === 'add' || next === 'remove' || next === 'move' || next === 'prune') && isReal()) return true;
        }
        // checkout-index, stash-with-no-next-already-handled, status/diff/log/show/
        // rev-parse/branch/submodule status fall through as read-only.
    }
    return false;
}

export function normalizeMeshTaskMode(value: unknown): MeshTaskMode | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim() as MeshTaskMode;
    return (MESH_TASK_MODES as string[]).includes(normalized) ? normalized : undefined;
}

export function validateMeshTaskModeRequest(mode: unknown, message: string): MeshTaskModeValidationResult {
    const taskMode = normalizeMeshTaskMode(mode);
    if (!taskMode) {
        return { valid: true, violations: [] };
    }
    if (taskMode !== 'live_debug_readonly') {
        return { valid: true, taskMode, violations: [] };
    }
    const text = message || '';
    // Only flag keywords that look like real commands (code/command context) and
    // are not negated — descriptive/prohibitive prose ("don't run `npm publish`",
    // "read-only, no deploy") must not trip the guardrail.
    const violations = LIVE_DEBUG_READONLY_FORBIDDEN
        .filter(rule => patternHasRealMutation(rule.pattern, text))
        .map(rule => rule.label);
    if (detectGitMutation(text)) {
        violations.push('git_mutation');
    }
    return {
        valid: violations.length === 0,
        taskMode,
        violations,
        allowedOperations: [
            'process/log/window/port/session inspection',
            'read-only filesystem listing/reading',
            'status probes and keep-running handle reporting',
            'diagnostic summaries without source edits, commits, checkpoints, pushes, deploys, resets, rebases, or destructive cleanups',
        ],
    };
}

export interface MeshWorkQueueEntry {
    id: string;
    meshId: string;
    message: string;
    status: MeshTaskStatus;
    taskMode?: MeshTaskMode;
    /** If specified, only this node can claim the task (used by legacy mesh_send_task) */
    targetNodeId?: string;
    /** If specified, only this runtime session can claim the task */
    targetSessionId?: string;
    /** If specified, a node must expose all tags before it can claim the task. */
    requiredTags?: string[];
    /**
     * M1: ids of tasks that must reach 'completed' before this task is claimable.
     * Forward references (ids not yet enqueued) are allowed for batch flows and
     * simply keep the task waiting until the referenced task exists and completes.
     */
    dependsOn?: string[];
    /** M1/M3: mission this task belongs to (joins mesh_missions). */
    missionId?: string;
    /**
     * M1: why this task is held back (e.g. "dependency_failed:<taskId>").
     * Only set by the system on dependency failure under the 'block' policy;
     * waiting-on-dependency state is computed at view time, not stored.
     */
    blockedReason?: string;
    /** The node that actually claimed and is executing the task */
    assignedNodeId?: string;
    /** The session currently executing the task */
    assignedSessionId?: string;
    /**
     * Provider type of the session that claimed the task. Recorded so the queue
     * can enforce per-(node, provider) maxParallel caps (RepoMeshNodePolicy
     * providerRoles) by counting active assignments grouped by node + provider.
     */
    assignedProviderType?: string;
    /** Human/operator reason for terminal cancellation. */
    cancelReason?: string;
    cancelledAt?: string;
    /** Human/operator reason for manually requeueing a task. */
    requeueReason?: string;
    requeuedAt?: string;
    requeueCount?: number;
    /** Max automatic requeue attempts. When requeueCount reaches this, task is auto-failed. */
    maxRetries?: number;
    /**
     * Bug B: number of times the reconcile assigned-stranded watchdog has reclaimed this
     * row from 'assigned' back to 'pending' because its dispatch was never confirmed
     * delivered. Separate from requeueCount (operator/execution retries) and bounded by
     * MAX_STRANDED_RECLAIMS so a permanently-undeliverable target auto-fails rather than
     * cycling reclaim→re-dispatch→strand forever.
     */
    strandedReclaimCount?: number;
    /** Last automatic queue session spin-up attempt, for mesh_view_queue/debug visibility. */
    autoLaunch?: {
        status: 'skipped' | 'started' | 'failed' | 'completed';
        reason?: string;
        nodeId?: string;
        providerType?: string;
        sessionId?: string;
        updatedAt: string;
    };
    /** ISO timestamp when the task was dispatched (assigned) to a node/session. Used for precise matching on completion. */
    dispatchTimestamp?: string;
    /**
     * (3) The ORIGINATING coordinator session that enqueued this task. Stamped onto the
     * worker at dispatch (meshCoordinatorSessionId) so the task's completion routes back to
     * the exact coordinator session — even when several coordinator sessions share one
     * daemon. Rides in the queue payload JSON (no column migration); absent on legacy rows
     * → daemon-level routing fallback (backward + version-skew safe).
     */
    sourceCoordinatorSessionId?: string;
    createdAt: string;
    updatedAt: string;
}

export interface MeshQueueMutationOptions {
    ownerRole?: RepoMeshDaemonRole;
}

export function normalizeMeshCapabilityTags(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    return value
        .map(tag => typeof tag === 'string' ? tag.trim() : '')
        .filter(Boolean)
        .filter(tag => {
            if (seen.has(tag)) return false;
            seen.add(tag);
            return true;
        });
}

function firstProviderPriority(policy: unknown): string | undefined {
    const raw = policy && typeof policy === 'object' && !Array.isArray(policy)
        ? (policy as Record<string, unknown>).providerPriority
        : undefined;
    if (!Array.isArray(raw)) return undefined;
    return raw.find(type => typeof type === 'string' && type.trim())?.trim();
}

function readNodeOverride(node: { userOverrides?: unknown } | undefined, key: 'platform' | 'arch'): string | null {
    const overrides = node?.userOverrides;
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return null;
    const value = (overrides as Record<string, unknown>)[key];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Live, self-reported platform/arch the owning daemon stamped onto the node from
 * its own process.platform/process.arch via the git_status envelope. Kept on a
 * field DISTINCT from userOverrides so capability-tag derivation can prefer an
 * explicit operator override while still self-healing auto-detected nodes — and
 * so the value reflects the node's real OS rather than the coordinator's.
 */
function readNodeReporter(node: { reportedPlatform?: unknown; reportedArch?: unknown } | undefined, key: 'platform' | 'arch'): string | null {
    const value = key === 'platform' ? node?.reportedPlatform : node?.reportedArch;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function buildMeshNodeCapabilityTags(
    node: { capabilities?: unknown; policy?: unknown; isLocalWorktree?: unknown; worktreeBranch?: unknown; userOverrides?: unknown; reportedPlatform?: unknown; reportedArch?: unknown } | undefined,
    providerType?: string,
): string[] {
    const provider = typeof providerType === 'string' && providerType.trim()
        ? providerType.trim()
        : firstProviderPriority(node?.policy);
    const worktreeBranch = typeof node?.worktreeBranch === 'string' && node.worktreeBranch.trim()
        ? node.worktreeBranch.trim()
        : null;
    // Per-node platform/arch precedence (highest → lowest):
    //   1. userOverrides.platform/arch — an EXPLICIT operator override always wins.
    //   2. reportedPlatform/reportedArch — the live OS the owning daemon
    //      self-reported (its own process.platform/process.arch via the git_status
    //      envelope), persisted to the node record on each direct probe. This is
    //      why a Windows member advertises os=win32 even though the COORDINATOR
    //      computing these tags runs on darwin — without it the consumer reads the
    //      persistent node (operator userOverrides empty) and would fall straight
    //      through to the coordinator's own process.platform, mislabeling every
    //      node os=darwin. We prefer this LIVE value over any stale auto-stamp.
    //   3. process.platform/process.arch — last-resort fallback, correct only for
    //      the local coordinator node / local worktree nodes that have not yet
    //      been probed (their workspace lives on THIS machine anyway).
    // Vocabulary is raw process.platform/process.arch ("darwin"/"win32"/"linux",
    // "arm64"/"x64") on both the advertiser and the required_tags matcher, which
    // compares with plain string equality (nodeSatisfiesRequiredTags) — so this
    // keeps the win32/darwin/linux vocabulary the matcher already expects.
    const os = readNodeOverride(node, 'platform') ?? readNodeReporter(node, 'platform') ?? process.platform;
    const arch = readNodeOverride(node, 'arch') ?? readNodeReporter(node, 'arch') ?? process.arch;
    return normalizeMeshCapabilityTags([
        ...(Array.isArray(node?.capabilities) ? node.capabilities : []),
        `os=${os}`,
        `arch=${arch}`,
        ...(provider ? [`provider=${provider}`] : []),
        // Worktree nodes automatically expose a "worktree=<branch>" tag so that
        // mesh_enqueue_task with required_tags: ["worktree=<branch>"] routes
        // only to the matching worktree node.
        ...(node?.isLocalWorktree === true && worktreeBranch ? [`worktree=${worktreeBranch}`] : []),
        // Convergence routing: advertise how this node can land its work onto base.
        //   - converge=refine: local worktree nodes (on ANY machine — refine_mesh_node
        //     now forwards to the owning daemon) can run the Refinery merge → push →
        //     cleanup against their own checkout, so they accept code_change tasks.
        //   - converge=fast_forward: non-worktree nodes (the machine itself) can only
        //     ff/push an already-converged branch; they are NOT a destination for
        //     code_change work (a worktree is created first, and that worktree node
        //     receives the task instead). Reuses the ordinary required-tags filter —
        //     the load-balancing scheduler auto-injects converge=refine for code_change
        //     so such work is hard-filtered onto refine-capable nodes.
        ...(node?.isLocalWorktree === true ? ['converge=refine'] : ['converge=fast_forward']),
    ]);
}

export function nodeSatisfiesRequiredTags(requiredTags: unknown, capabilityTags: unknown): boolean {
    const required = normalizeMeshCapabilityTags(requiredTags);
    if (required.length === 0) return true;
    const available = new Set(normalizeMeshCapabilityTags(capabilityTags));
    return required.every(tag => available.has(tag));
}

/**
 * Convergence-aware required-tags resolution (load-balancing scheduler, opt-in).
 *
 * When the mesh enables policy.autoConvergeCodeChange, a `converge=refine` required
 * tag is merged into a code_change task's required tags at enqueue time, so the
 * scheduler hard-filters the task onto refine-capable worktree nodes only (on any
 * machine — refine_mesh_node forwards to the owning daemon). Because the tag is
 * persisted on the queue entry, BOTH the eligibility scan (maybeAutoLaunchOneQueueSession)
 * and the claim transaction (claimNextQueueTask → nodeSatisfiesRequiredTags) enforce
 * it consistently.
 *
 * Strict backward compatibility — the injection is skipped (returns the explicit tags
 * unchanged) when ANY of:
 *   - the mesh does not opt in (autoConvergeCodeChange !== true), or
 *   - the task is not code_change (validation / live_debug_readonly / launch_app /
 *     convergence carry no merge cost and may run anywhere), or
 *   - the task is explicitly targeted (targetNodeId): the operator chose the node, so
 *     we do not second-guess it by filtering on convergence capability.
 * Idempotent: normalizeMeshCapabilityTags dedupes, so re-injection is a no-op.
 */
export function resolveConvergeRequiredTags(
    meshId: string,
    taskMode: MeshTaskMode | undefined,
    explicitRequiredTags: string[],
    opts?: { targetNodeId?: string },
): string[] {
    if (taskMode !== 'code_change') return explicitRequiredTags;
    if (typeof opts?.targetNodeId === 'string' && opts.targetNodeId.trim()) return explicitRequiredTags;
    let optedIn = false;
    try {
        optedIn = resolveAutoConvergeCodeChange(getMesh(meshId)?.policy as any);
    } catch {
        optedIn = false;
    }
    if (!optedIn) return explicitRequiredTags;
    return normalizeMeshCapabilityTags([...explicitRequiredTags, MESH_CONVERGE_REFINE_TAG]);
}

function withQueueLock<T>(_meshId: string, fn: () => T): T {
    return MeshRuntimeStore.getInstance().transaction(fn);
}

function readQueue(meshId: string): MeshWorkQueueEntry[] {
    return MeshRuntimeStore.getInstance().getQueueEntries(meshId);
}

function writeQueue(meshId: string, queue: MeshWorkQueueEntry[]): void {
    MeshRuntimeStore.getInstance().replaceQueue(meshId, queue);
}

function normalizeDependsOn(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    return value
        .map(id => typeof id === 'string' ? id.trim() : '')
        .filter(Boolean)
        .filter(id => {
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
        });
}

/**
 * M1: detect dependency cycles before enqueue. Walks the dependency graph of
 * existing queue entries plus the new task's edges. Fail-closed: a cycle
 * rejects the enqueue entirely. Synchronous and bounded by queue size.
 */
export function assertNoDependencyCycle(meshId: string, newTaskId: string, dependsOn: string[]): void {
    if (dependsOn.length === 0) return;
    if (dependsOn.includes(newTaskId)) {
        throw new Error(`dependency_cycle_detected: task '${newTaskId}' cannot depend on itself`);
    }
    const adjacency = new Map<string, string[]>();
    for (const entry of readQueue(meshId)) {
        adjacency.set(entry.id, normalizeDependsOn(entry.dependsOn));
    }
    adjacency.set(newTaskId, dependsOn);
    // DFS from the new task: if we can reach newTaskId again, the edges form a cycle.
    const stack = [...dependsOn];
    const visited = new Set<string>();
    while (stack.length > 0) {
        const current = stack.pop()!;
        if (current === newTaskId) {
            throw new Error(`dependency_cycle_detected: task '${newTaskId}' is part of a dependency cycle via '${dependsOn.join(', ')}'`);
        }
        if (visited.has(current)) continue;
        visited.add(current);
        stack.push(...(adjacency.get(current) ?? []));
    }
}

/**
 * Add a new task to the mesh queue.
 */
export function enqueueTask(
    meshId: string,
    message: string,
    opts?: {
        targetNodeId?: string;
        targetSessionId?: string;
        taskMode?: MeshTaskMode | string;
        requiredTags?: string[];
        /** M1: tasks that must complete before this one is claimable. */
        dependsOn?: string[];
        /** M1/M3: mission this task belongs to. */
        missionId?: string;
        /** Explicit task id for batch/template flows (M5). Random UUID when omitted. */
        id?: string;
        /** (3) Originating coordinator session id (for session-anchored completion routing). */
        sourceCoordinatorSessionId?: string;
    } & MeshQueueMutationOptions,
): MeshWorkQueueEntry {
    requireMeshHostQueueOwner(opts);
    const modeValidation = validateMeshTaskModeRequest(opts?.taskMode, message);
    if (!modeValidation.valid) {
        throw new Error(`live_debug_readonly_guardrail_violation: forbidden operations (${modeValidation.violations.join(', ')})`);
    }
    const id = typeof opts?.id === 'string' && opts.id.trim() ? opts.id.trim() : randomUUID();
    const dependsOn = normalizeDependsOn(opts?.dependsOn);
    return withQueueLock(meshId, () => {
        if (MeshRuntimeStore.getInstance().findQueueEntryById(meshId, id)) {
            throw new Error(`duplicate_task_id: task '${id}' already exists in mesh '${meshId}'`);
        }
        assertNoDependencyCycle(meshId, id, dependsOn);
        const callerTags = normalizeMeshCapabilityTags(opts?.requiredTags);
        // Convergence routing (opt-in): auto-inject converge=refine for code_change
        // tasks so they hard-filter onto refine-capable worktree nodes. No-op unless
        // the mesh opts in; explicit target_node_id / required_tags are preserved.
        // Routing is otherwise governed solely by the caller's required_tags (hard
        // filter through nodeSatisfiesRequiredTags) — no role/taskMode auto-routing.
        const resolvedRequiredTags = resolveConvergeRequiredTags(
            meshId,
            modeValidation.taskMode,
            callerTags,
            { targetNodeId: opts?.targetNodeId },
        );
        const entry: MeshWorkQueueEntry = {
            id,
            meshId,
            message,
            status: 'pending',
            taskMode: modeValidation.taskMode,
            targetNodeId: opts?.targetNodeId,
            targetSessionId: opts?.targetSessionId,
            requiredTags: resolvedRequiredTags,
            ...(dependsOn.length > 0 ? { dependsOn } : {}),
            ...(typeof opts?.missionId === 'string' && opts.missionId.trim() ? { missionId: opts.missionId.trim() } : {}),
            ...(typeof opts?.sourceCoordinatorSessionId === 'string' && opts.sourceCoordinatorSessionId.trim()
                ? { sourceCoordinatorSessionId: opts.sourceCoordinatorSessionId.trim() }
                : {}),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        MeshRuntimeStore.getInstance().insertQueueEntry(entry);
        return entry;
    });
}

/**
 * Record a direct-dispatch task (mesh_send_task) as an already-assigned queue
 * entry so it is attributable to a mission.
 *
 * Direct dispatch normally bypasses the queue entirely — the task lives only in
 * the ledger + mesh_direct_dispatches table, neither of which carries a
 * missionId, so {@link summarizeMissionTasks}/{@link computeMeshTaskStats}
 * (which both scan the queue for `task.missionId`) count it as 0. When a
 * mission is attached, we materialise the same queue entry shape an enqueued
 * task would have, but pre-assigned to the dispatched node/session and stamped
 * with the dispatch timestamp. The terminal event path (updateSessionTaskStatus
 * → findAssignedBySession) then flips it to completed/failed exactly like a
 * pulled task, so mission total + completed aggregates work with no extra wiring.
 *
 * Intentionally separate from {@link enqueueTask}: enqueue creates `pending`
 * work for the queue to assign, whereas this records work already dispatched
 * out-of-band. They share the missionId stamping rule and mode validation.
 */
export function recordDirectDispatchTask(
    meshId: string,
    message: string,
    opts: {
        id: string;
        missionId: string;
        assignedNodeId?: string;
        assignedSessionId?: string;
        taskMode?: MeshTaskMode | string;
        dispatchedAt?: string;
    },
): MeshWorkQueueEntry | null {
    const missionId = typeof opts.missionId === 'string' ? opts.missionId.trim() : '';
    if (!missionId) return null;
    const taskId = typeof opts.id === 'string' ? opts.id.trim() : '';
    if (!taskId) return null;
    const modeValidation = validateMeshTaskModeRequest(opts.taskMode, message);
    if (!modeValidation.valid) {
        throw new Error(`live_debug_readonly_guardrail_violation: forbidden operations (${modeValidation.violations.join(', ')})`);
    }
    const now = opts.dispatchedAt && opts.dispatchedAt.trim() ? opts.dispatchedAt : new Date().toISOString();
    return withQueueLock(meshId, () => {
        if (MeshRuntimeStore.getInstance().findQueueEntryById(meshId, taskId)) {
            // Already materialised (e.g. retry of the same dispatch) — leave it untouched.
            return null;
        }
        const entry: MeshWorkQueueEntry = {
            id: taskId,
            meshId,
            message,
            status: 'assigned',
            ...(modeValidation.taskMode ? { taskMode: modeValidation.taskMode } : {}),
            missionId,
            ...(opts.assignedNodeId ? { targetNodeId: opts.assignedNodeId, assignedNodeId: opts.assignedNodeId } : {}),
            ...(opts.assignedSessionId ? { targetSessionId: opts.assignedSessionId, assignedSessionId: opts.assignedSessionId } : {}),
            dispatchTimestamp: now,
            createdAt: now,
            updatedAt: now,
        };
        MeshRuntimeStore.getInstance().insertQueueEntry(entry);
        return entry;
    });
}

/**
 * Get all tasks in the queue, optionally filtered by status.
 */
export function getQueue(meshId: string, opts?: { status?: MeshTaskStatus[] }): MeshWorkQueueEntry[] {
    return MeshRuntimeStore.getInstance().getQueueEntries(meshId, opts?.status?.length ? opts.status : undefined);
}

export function getMeshQueueRevision(meshId: string): string {
    return MeshRuntimeStore.getInstance().getQueueRevision(meshId);
}

/**
 * Find the next pending task that this node is allowed to claim, and mark it as assigned.
 *
 * `opts.providerType` is stamped onto the claimed entry (assignedProviderType) so
 * per-(node, provider) caps can be counted. `opts.providerMaxParallel`, when set,
 * is the enforced per-(node, provider) cap from RepoMeshNodePolicy.providerRoles:
 * a task is not assigned to this (node, provider) once it already has that many
 * active assignments. This composes with the global/taskMode caps (stricter wins).
 */
export function claimNextTask(
    meshId: string,
    nodeId: string,
    sessionId: string,
    capabilityTags?: string[],
    opts?: { providerType?: string; providerMaxParallel?: number },
): MeshWorkQueueEntry | null {
    return MeshRuntimeStore.getInstance().claimNextQueueTask(meshId, nodeId, sessionId, capabilityTags, opts);
}

// ─── M1: Dependency Failure Propagation ─────────

export type DependencyFailurePolicy = 'block' | 'cancel';

function resolveDependencyFailurePolicy(meshId: string): DependencyFailurePolicy {
    try {
        const policy = (getMesh(meshId)?.policy ?? {}) as Record<string, unknown>;
        return policy.onDependencyFailure === 'cancel' ? 'cancel' : 'block';
    } catch {
        return 'block';
    }
}

/**
 * Apply the mesh's onDependencyFailure policy to pending dependents of a task
 * that just reached a failed/cancelled terminal state.
 *
 * - 'block' (default): dependents stay pending with blockedReason
 *   "dependency_failed:<taskId>" so an operator can requeue/cancel them.
 * - 'cancel': dependents are cancelled (cascading to their own dependents).
 *
 * Must be called inside the queue lock of the triggering transition.
 */
function propagateDependencyFailure(meshId: string, failedTaskId: string): void {
    const policy = resolveDependencyFailurePolicy(meshId);
    const store = MeshRuntimeStore.getInstance();
    const frontier = [failedTaskId];
    const seen = new Set<string>(frontier);
    while (frontier.length > 0) {
        const currentId = frontier.pop()!;
        const dependents = store.getQueueEntries(meshId, ['pending'])
            .filter(entry => Array.isArray(entry.dependsOn) && entry.dependsOn.includes(currentId));
        for (const dependent of dependents) {
            if (seen.has(dependent.id)) continue;
            seen.add(dependent.id);
            if (policy === 'cancel') {
                dependent.status = 'cancelled';
                dependent.cancelledAt = new Date().toISOString();
                dependent.cancelReason = `dependency_failed:${currentId}`;
                store.updateQueueEntry(dependent);
                frontier.push(dependent.id); // cascade to transitive dependents
            } else {
                dependent.blockedReason = `dependency_failed:${currentId}`;
                store.updateQueueEntry(dependent);
            }
        }
    }
}

const DEPENDENCY_FAILURE_TERMINALS = new Set<MeshTaskStatus>(['failed', 'cancelled']);

/**
 * Update the status of a specific task.
 * Used when a session completes, fails, or stalls.
 */
export function updateTaskStatus(
    meshId: string,
    taskId: string,
    status: MeshTaskStatus,
    opts?: MeshQueueMutationOptions,
): MeshWorkQueueEntry | null {
    requireMeshHostQueueOwner(opts);
    return withQueueLock(meshId, () => {
        const entry = MeshRuntimeStore.getInstance().findQueueEntryById(meshId, taskId);
        if (!entry) return null;
        entry.status = status;
        MeshRuntimeStore.getInstance().updateQueueEntry(entry);
        if (DEPENDENCY_FAILURE_TERMINALS.has(status)) propagateDependencyFailure(meshId, taskId);
        return entry;
    });
}

export function recordTaskAutoLaunch(
    meshId: string,
    taskId: string,
    autoLaunch: Omit<NonNullable<MeshWorkQueueEntry['autoLaunch']>, 'updatedAt'>,
): MeshWorkQueueEntry | null {
    return withQueueLock(meshId, () => {
        const entry = MeshRuntimeStore.getInstance().findQueueEntryById(meshId, taskId);
        if (!entry) return null;
        const now = new Date().toISOString();
        entry.autoLaunch = { ...autoLaunch, updatedAt: now };
        MeshRuntimeStore.getInstance().updateQueueEntry(entry);
        return entry;
    });
}

/**
 * Mark a queue task as manually cancelled without deleting audit history.
 */
export function cancelTask(
    meshId: string,
    taskId: string,
    opts?: { reason?: string } & MeshQueueMutationOptions,
): MeshWorkQueueEntry | null {
    requireMeshHostQueueOwner(opts);
    return withQueueLock(meshId, () => {
        const entry = MeshRuntimeStore.getInstance().findQueueEntryById(meshId, taskId);
        if (!entry) return null;
        const now = new Date().toISOString();
        entry.status = 'cancelled';
        entry.cancelledAt = now;
        if (opts?.reason) entry.cancelReason = opts.reason;
        MeshRuntimeStore.getInstance().updateQueueEntry(entry);
        propagateDependencyFailure(meshId, taskId);
        return entry;
    });
}

/**
 * Return a queue task to pending for retry. By default, dead session targeting
 * and assigned ownership are cleared so stale assignments do not strand again.
 */
export type RequeueResult =
    | { status: 'requeued'; entry: MeshWorkQueueEntry }
    | { status: 'failed_max_retries'; entry: MeshWorkQueueEntry; maxRetries: number; requeueCount: number }
    | { status: 'not_found' };

export function requeueTask(
    meshId: string,
    taskId: string,
    opts?: {
        reason?: string;
        targetNodeId?: string;
        targetSessionId?: string;
        clearTargetNode?: boolean;
        clearTargetSession?: boolean;
        /**
         * Override the retry cap for this call. Use only for explicit operator actions.
         * If true, the task is requeued even when requeueCount >= maxRetries.
         */
        force?: boolean;
        /** Per-task retry cap override. Falls back to mesh policy maxTaskRetries (default 1). */
        maxRetries?: number;
    } & MeshQueueMutationOptions,
): MeshWorkQueueEntry | null {
    requireMeshHostQueueOwner(opts);
    return withQueueLock(meshId, () => {
        const entry = MeshRuntimeStore.getInstance().findQueueEntryById(meshId, taskId);
        if (!entry) return null;
        const currentCount = entry.requeueCount || 0;
        const maxRetries = opts?.maxRetries ?? entry.maxRetries ?? 1;
        if (!opts?.force && currentCount >= maxRetries) {
            // Auto-fail: cap exceeded without explicit force override.
            entry.status = 'failed';
            entry.cancelReason = `max_retries_exceeded: requeued ${currentCount} time(s), limit is ${maxRetries}`;
            entry.updatedAt = new Date().toISOString();
            MeshRuntimeStore.getInstance().updateQueueEntry(entry);
            propagateDependencyFailure(meshId, taskId);
            return entry;
        }
        entry.status = 'pending';
        // Operator requeue clears a dependency-failure block — the operator is
        // explicitly overriding the held-back state.
        delete entry.blockedReason;
        delete entry.assignedNodeId;
        delete entry.assignedSessionId;
        delete entry.cancelledAt;
        delete entry.cancelReason;
        if (opts?.clearTargetNode) delete entry.targetNodeId;
        if (typeof opts?.targetNodeId === 'string') entry.targetNodeId = opts.targetNodeId;
        if (opts?.clearTargetSession !== false) delete entry.targetSessionId;
        if (typeof opts?.targetSessionId === 'string') entry.targetSessionId = opts.targetSessionId;
        entry.requeuedAt = new Date().toISOString();
        entry.requeueCount = currentCount + 1;
        if (opts?.reason) entry.requeueReason = opts.reason;
        MeshRuntimeStore.getInstance().updateQueueEntry(entry);
        return entry;
    });
}

/**
 * Max times the assigned-stranded watchdog will reclaim a single task before giving
 * up and failing it. Bounds the reclaim→re-dispatch→strand cycle so a permanently
 * undeliverable target (e.g. a node whose transport is wedged) eventually fails and
 * unblocks its dependents instead of looping every reconcile tick.
 */
const MAX_STRANDED_RECLAIMS = 3;

/**
 * Bug B: reclaim a task stuck in 'assigned' because its dispatch was never confirmed.
 *
 * claimNextTask atomically marks a row 'assigned' BEFORE the fire-and-forget dispatch
 * runs. If that dispatch neither rejects (→ no .catch requeue) nor is confirmed
 * delivered — a relay that hangs without acking, or a confirm timer lost across a
 * daemon restart — the row stays 'assigned' forever, contributing 0 pending so PHASE 3
 * reconcile never re-examines it. This returns such a row to 'pending' and clears its
 * dead assignment ownership (node / session / provider / dispatchTimestamp) — the same
 * ownership-clear requeueTask applies — so PHASE 3 can re-dispatch it onto a fresh idle
 * session.
 *
 * Guarded to 'assigned' rows only (a completion/cancel that already moved the row off
 * 'assigned' must never be resurrected) and bounded by MAX_STRANDED_RECLAIMS (beyond
 * which the task is failed so dependents unblock).
 */
export function reclaimStrandedAssignedTask(
    meshId: string,
    taskId: string,
    opts?: { reason?: string; ageMs?: number } & MeshQueueMutationOptions,
): MeshWorkQueueEntry | null {
    requireMeshHostQueueOwner(opts);
    return withQueueLock(meshId, () => {
        const entry = MeshRuntimeStore.getInstance().findQueueEntryById(meshId, taskId);
        if (!entry) return null;
        // Only a still-assigned row is stranded. If a completion/cancel already moved it
        // off 'assigned', there is nothing to reclaim — never resurrect a terminal row.
        if (entry.status !== 'assigned') return null;
        const now = new Date().toISOString();
        const reason = opts?.reason || 'assigned_stranded_dispatch_unconfirmed';
        const reclaims = (entry.strandedReclaimCount || 0) + 1;
        const prevNode = entry.assignedNodeId;
        const prevSession = entry.assignedSessionId;
        // Always clear the dead assignment ownership so a re-claim starts clean and the
        // assigned-counters (which filter status==='assigned') stop counting this row.
        delete entry.assignedNodeId;
        delete entry.assignedSessionId;
        delete entry.assignedProviderType;
        delete entry.dispatchTimestamp;
        entry.strandedReclaimCount = reclaims;
        entry.updatedAt = now;
        if (reclaims > MAX_STRANDED_RECLAIMS) {
            // Repeatedly undeliverable — stop cycling and fail it so dependents unblock.
            entry.status = 'failed';
            entry.cancelReason = `stranded_dispatch_unrecovered: reclaimed ${reclaims - 1} time(s) without a confirmed dispatch`;
            MeshRuntimeStore.getInstance().updateQueueEntry(entry);
            propagateDependencyFailure(meshId, taskId);
        } else {
            entry.status = 'pending';
            entry.requeuedAt = now;
            entry.requeueReason = reason;
            MeshRuntimeStore.getInstance().updateQueueEntry(entry);
        }
        try {
            appendLedgerEntry(meshId, {
                kind: 'task_reclaimed' as MeshLedgerKind,
                nodeId: prevNode,
                sessionId: prevSession,
                payload: {
                    taskId,
                    reason,
                    ...(typeof opts?.ageMs === 'number' ? { ageMs: opts.ageMs } : {}),
                    reclaimCount: reclaims,
                    outcome: entry.status,
                },
            });
        } catch { /* ledger write is best-effort */ }
        return entry;
    });
}

/**
 * Update the status of the task currently assigned to a specific session.
 */
export function updateSessionTaskStatus(
    meshId: string,
    sessionId: string,
    status: MeshTaskStatus,
    opts?: { occurredAt?: string; taskId?: string },
): MeshWorkQueueEntry | null {
    return withQueueLock(meshId, () => {
        const store = MeshRuntimeStore.getInstance();
        const occurredAtIso = opts?.occurredAt ? new Date(opts.occurredAt).toISOString() : undefined;
        const entry = store.findAssignedBySession(meshId, sessionId, occurredAtIso, opts?.taskId);
        if (!entry) {
            // C2: the silent null here is exactly what stranded a finished task as
            // `assigned` for 19 minutes. If the session still has an assigned row we
            // failed to resolve, surface it loudly instead of dropping the completion.
            const assignedRows = store.getActiveAssignmentDetails(meshId)
                .filter(r => r.sessionId === sessionId);
            if (assignedRows.length > 0) {
                LOG.warn('MeshQueue', `No assigned queue row matched completion for mesh ${meshId} session ${sessionId} `
                    + `(taskId=${opts?.taskId ?? 'none'}, occurredAt=${occurredAtIso ?? 'none'}); `
                    + `${assignedRows.length} assigned row(s) exist: ${assignedRows.map(r => r.id).join(',')}`);
            }
            return null;
        }
        entry.status = status;
        store.updateQueueEntry(entry);
        if (DEPENDENCY_FAILURE_TERMINALS.has(status)) propagateDependencyFailure(meshId, entry.id);
        return entry;
    });
}

/**
 * M1-3: true when at least one pending task is waiting on the given task.
 * Used by the completion event path to decide whether to wake the queue.
 */
export function hasPendingDependents(meshId: string, taskId: string): boolean {
    return MeshRuntimeStore.getInstance().getQueueEntries(meshId, ['pending'])
        .some(entry => Array.isArray(entry.dependsOn) && entry.dependsOn.includes(taskId));
}

/**
 * M1-4: view-time dependency state for a task — unmet dependency ids and
 * whether the task is currently claimable from a dependency standpoint.
 * Not stored (truth stays in task statuses).
 */
export function describeTaskDependencyState(
    entry: Pick<MeshWorkQueueEntry, 'dependsOn' | 'blockedReason'>,
    statusById: Map<string, MeshTaskStatus | string>,
): { waitingOn: string[]; dependenciesSatisfied: boolean } {
    const deps = Array.isArray(entry.dependsOn) ? entry.dependsOn : [];
    const waitingOn = deps.filter(depId => statusById.get(depId) !== 'completed');
    return {
        waitingOn,
        dependenciesSatisfied: waitingOn.length === 0 && !entry.blockedReason,
    };
}

export interface MeshWorkQueueStats {
    total: number;
    active: number;
    historical: number;
    pending: number;
    assigned: number;
    completed: number;
    failed: number;
    cancelled: number;
    /** Source-of-truth active queue counters; only pending/assigned are live work. */
    activeCounts: Record<MeshActiveTaskStatus, number>;
    /** Terminal ledger records kept for audit/history; never count as active work. */
    historicalCounts: Record<MeshHistoricalTaskStatus, number>;
    activeAssignments: Array<{
        id: string;
        nodeId?: string;
        sessionId?: string;
        message: string;
    }>;
}

/**
 * Return aggregate queue statistics for the given mesh.
 */
export function getMeshQueueStats(meshId: string): MeshWorkQueueStats {
    const rows = MeshRuntimeStore.getInstance().getQueueStatsByStatus(meshId);
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.status] = r.count;
    const pending = counts['pending'] ?? 0;
    const assigned = counts['assigned'] ?? 0;
    const completed = counts['completed'] ?? 0;
    const failed = counts['failed'] ?? 0;
    const cancelled = counts['cancelled'] ?? 0;
    return {
        total: pending + assigned + completed + failed + cancelled,
        active: pending + assigned,
        historical: completed + failed + cancelled,
        pending,
        assigned,
        completed,
        failed,
        cancelled,
        activeCounts: { pending, assigned },
        historicalCounts: { completed, failed, cancelled },
        activeAssignments: MeshRuntimeStore.getInstance().getActiveAssignmentDetails(meshId),
    };
}

export function __replaceMeshQueueForTests(meshId: string, queue: MeshWorkQueueEntry[]): void {
    MeshRuntimeStore.getInstance().transaction(() => {
        MeshRuntimeStore.getInstance().replaceQueue(meshId, queue);
    });
}

export function __clearMeshQueueForTests(meshId: string): void {
    MeshRuntimeStore.getInstance().deleteQueue(meshId);
}

export function __clearDirectDispatchesForTests(meshId: string): void {
    MeshRuntimeStore.getInstance().deleteDirectDispatches(meshId);
}

export function __resetMeshRuntimeStoreForTests(): void {
    MeshRuntimeStore.resetForTests();
}

// ── Direct Dispatch Tracking ─────────────────────────────────────────────────
// Persists direct (non-queue) task dispatches so buildMeshActiveWork can read
// active work from MeshRuntimeStore instead of scanning ledger JSONL entries.

export type DirectDispatchRecord = ReturnType<MeshRuntimeStore['getActiveDirectDispatches']>[number];

export function insertDirectDispatch(
    meshId: string,
    data: {
        taskId: string;
        nodeId?: string;
        sessionId?: string;
        providerType?: string;
        message: string;
        taskMode?: string;
        via: string;
        dispatchedToIdleSession?: boolean;
        dispatchedAt: string;
    },
): void {
    try {
        MeshRuntimeStore.getInstance().insertDirectDispatch({ ...data, meshId });
    } catch (e: any) {
        process.stderr.write(`[adhdev-mesh] insertDirectDispatch failed for task ${data.taskId}: ${e?.message || e}\n`);
    }
}

export function getActiveDirectDispatches(meshId: string): DirectDispatchRecord[] {
    try {
        return MeshRuntimeStore.getInstance().getActiveDirectDispatches(meshId);
    } catch {
        return [];
    }
}

export function updateDirectDispatchStatus(
    meshId: string,
    sessionId: string,
    status: 'acked' | 'completed' | 'failed' | 'stale',
    taskId?: string,
): void {
    try {
        // CANON-B: prefer the exact task_id row; fall back to the session_id match only when
        // the firing event carried no taskId (a legacy/relayed event). Warn on the fallback so
        // the residual PK-substitute path is observable when it strands a sibling dispatch.
        if (!taskId) {
            LOG.warn('MeshQueue', `updateDirectDispatchStatus(${status}) for mesh ${meshId} session ${sessionId} has no taskId — falling back to session_id match (may flip a sibling dispatch row)`);
        }
        MeshRuntimeStore.getInstance().updateDirectDispatchStatus(meshId, sessionId, status, taskId);
    } catch { /* best-effort */ }
}

export function cleanupTerminalDirectDispatches(olderThanMs = 7 * 24 * 60 * 60_000): void {
    try {
        MeshRuntimeStore.getInstance().cleanupTerminalDirectDispatches(olderThanMs);
    } catch { /* best-effort */ }
}

export function markStaleDirectDispatches(meshId: string, olderThanMs = 60 * 60_000): void {
    try {
        MeshRuntimeStore.getInstance().markStaleDirectDispatches(meshId, olderThanMs);
    } catch { /* best-effort */ }
}

/**
 * Delete specific direct dispatch rows by taskId. Returns the number of rows deleted.
 * Used by the staleDirect prune path to evict orphaned/terminal dispatch records from the
 * active staleDirect surface while leaving the append-only mesh ledger (audit history) intact.
 */
export function deleteDirectDispatchesByTaskId(meshId: string, taskIds: string[]): number {
    try {
        return MeshRuntimeStore.getInstance().deleteDirectDispatchesByTaskId(meshId, taskIds);
    } catch {
        return 0;
    }
}

export type MeshToolCallRateResult = { rateLimitExceeded: boolean; callsInWindow: number; advisory: string | null };

/**
 * Record a coordinator tool call and return a rate-limit advisory when the
 * call rate for that tool exceeds the allowed threshold.
 *
 * Defaults: 10-second sliding window, max 5 calls before advisory is raised.
 * Returns { rateLimitExceeded: false } on any store error so callers are not blocked.
 */
export function recordMeshToolCall(opts: {
    meshId: string;
    tool: string;
    sessionId?: string | null;
    windowMs?: number;
    maxCalls?: number;
}): MeshToolCallRateResult {
    try {
        return MeshRuntimeStore.getInstance().recordMeshToolCall(opts);
    } catch {
        return { rateLimitExceeded: false, callsInWindow: 0, advisory: null };
    }
}
