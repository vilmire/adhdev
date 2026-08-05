import { randomUUID } from 'crypto';
import { requireMeshHostQueueOwner } from './mesh-host-ownership.js';
import type { RepoMeshDaemonRole } from '../repo-mesh-types.js';
import { MESH_CONVERGE_REFINE_TAG, resolveAutoConvergeCodeChange } from '../repo-mesh-types.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { getMesh, getDifficultyBrains } from '../config/mesh-config.js';
import { LOG } from '../logging/logger.js';
import { appendLedgerEntry } from './mesh-ledger.js';
import type { MeshLedgerKind } from './mesh-ledger.js';
import { createSessionDelivery } from './mesh-delivery-policy.js';
import { isTaskDispatchInFlight, endTaskDispatchInFlight } from './mesh-task-inflight.js';
import { closeAttemptForReassignment, openTurnAttempt, proposeTurnCompletion, recordTurnAck } from './mesh-turn-ledger.js';
import { sessionIdsEquivalent, isMeshTaskDifficulty, normalizeNodeCapabilitySlots, type MeshTaskDifficulty } from '@adhdev/mesh-shared';

export type MeshTaskStatus = 'pending' | 'assigned' | 'completed' | 'failed' | 'cancelled';
export type MeshActiveTaskStatus = Extract<MeshTaskStatus, 'pending' | 'assigned'>;
export type MeshHistoricalTaskStatus = Extract<MeshTaskStatus, 'completed' | 'failed' | 'cancelled'>;
export type MeshTaskMode = 'code_change' | 'validation' | 'live_debug_readonly' | 'launch_app' | 'convergence';

/** G6: task-level scheduling priority. Ranks which task a node pulls first (created_at tie-break). */
export type MeshTaskPriority = 'low' | 'normal' | 'high';

export const ACTIVE_MESH_QUEUE_STATUSES: MeshActiveTaskStatus[] = ['pending', 'assigned'];
export const HISTORICAL_MESH_QUEUE_STATUSES: MeshHistoricalTaskStatus[] = ['completed', 'failed', 'cancelled'];
export const MESH_TASK_MODES: MeshTaskMode[] = ['code_change', 'validation', 'live_debug_readonly', 'launch_app', 'convergence'];
export const MESH_TASK_PRIORITIES: MeshTaskPriority[] = ['low', 'normal', 'high'];

/**
 * G6: numeric rank of a task priority (higher = pulled first). Absent/unknown → 'normal' (1).
 * Shared by the claim-candidate ordering and any surface that must sort by task priority.
 */
export function meshTaskPriorityRank(priority: unknown): number {
    switch (priority) {
        case 'high': return 2;
        case 'low': return 0;
        default: return 1; // 'normal' and any absent/unknown value
    }
}

/** G6: coerce an arbitrary input to a valid MeshTaskPriority, or undefined when not one of the three. */
export function normalizeMeshTaskPriority(value: unknown): MeshTaskPriority | undefined {
    return value === 'low' || value === 'normal' || value === 'high' ? value : undefined;
}

/**
 * G7: resolve a not_before input to a stored ISO string (or undefined when absent/invalid).
 * Accepts an ISO/date string, an absolute epoch-ms number, or a small relative-ms offset from
 * `nowMs`. Disambiguation for numbers: a value below {@link NOT_BEFORE_RELATIVE_THRESHOLD_MS}
 * (~1 year in ms) is treated as a relative offset added to now; a larger value is an absolute
 * epoch-ms timestamp. A past/negative result is normalized to now (immediately claimable).
 */
export const NOT_BEFORE_RELATIVE_THRESHOLD_MS = 365 * 24 * 60 * 60 * 1000;
export function resolveNotBefore(value: unknown, nowMs: number = Date.now()): string | undefined {
    if (value === undefined || value === null) return undefined;
    let absMs: number;
    if (typeof value === 'number' && Number.isFinite(value)) {
        absMs = value < NOT_BEFORE_RELATIVE_THRESHOLD_MS ? nowMs + value : value;
    } else if (typeof value === 'string' && value.trim()) {
        const parsed = Date.parse(value.trim());
        if (Number.isNaN(parsed)) return undefined;
        absMs = parsed;
    } else {
        return undefined;
    }
    if (absMs <= nowMs) return new Date(nowMs).toISOString();
    return new Date(absMs).toISOString();
}

/** G7: is a task claimable now, or is it still held back by its notBefore gate? */
export function meshTaskNotBeforeReady(
    task: { notBefore?: string } | null | undefined,
    nowMs: number = Date.now(),
): boolean {
    const nb = task?.notBefore;
    if (!nb) return true;
    const parsed = Date.parse(nb);
    if (Number.isNaN(parsed)) return true; // unparseable → do not block (fail-open)
    return parsed <= nowMs;
}

/**
 * QUEUE-NODE-SERIALIZATION: single source of truth for "is this task read-only?".
 *
 * Read-only classification used to be inlined as `task.taskMode === 'live_debug_readonly'`
 * at every enforcement site (node-conflict claim gate, auto-launch isolation, the
 * write/readonly cap counters, the write guardrail). That spread-out comparison is the
 * exact recurring-defect class — one site drifting from the others silently makes the same
 * task read-only at some gates and write at others, i.e. partial serialization. All sites
 * MUST call this predicate so the classification is decided in exactly one place.
 *
 * Two orthogonal inputs feed the same boolean axis (kept backward-compatible):
 *   • `readonly === true` — the explicit boolean axis (new API surface).
 *   • `taskMode === 'live_debug_readonly'` — the original enum value, preserved as an
 *     OR-fallback so existing live_debug_readonly tasks keep behaving identically.
 *
 * Accepts any task-like shape (full {@link MeshWorkQueueEntry} or a bare
 * `{ readonly?, taskMode? }`) so the daemon-core and mcp-server boundaries can share it.
 */
export function isTaskReadonly(task: { readonly?: boolean; taskMode?: MeshTaskMode | string } | null | undefined): boolean {
    if (!task) return false;
    return task.readonly === true || task.taskMode === 'live_debug_readonly';
}

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

    // Executed script at command position: the keyword sits inside a run-prefix
    // path token (`./scripts/version-bump.sh`, `~/bin/deploy.sh`) that is the
    // leading token of the line or follows a shell connective — the script is
    // being invoked, so the keyword is a real command. (Path *arguments* like
    // `list build/Release` are excluded earlier by isInsidePathSegment.)
    let tokStart = matchStart;
    while (tokStart > lineStart && !/\s/.test(text[tokStart - 1])) tokStart--;
    const beforeToken = text.slice(lineStart, tokStart);
    const tokenLead = text.slice(tokStart, matchStart);
    const atCmdPos = /^\s*$/.test(beforeToken) || /(?:&&|\|\||\||;)\s*$/.test(beforeToken);
    if (atCmdPos && /^(?:\.\/|\.\.\/|~\/|\/)/.test(tokenLead)) return true;

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
 * True if the matched keyword is part of a filesystem-path-like token rather than
 * a standalone word/command. A "release" inside `build/Release`, `dist/release/`,
 * or `packages\release` is a directory/file name, not a deploy instruction. We
 * look at the characters immediately adjacent to the match: if either side is a
 * path separator (`/` or `\`) joining it to another path segment, the keyword is
 * a path component.
 *
 * IMPORTANT: a path token that is itself being *executed* — i.e. the leading
 * token of a command line such as `./scripts/version-bump.sh patch` — is NOT a
 * suppressible path; that is a real command. We therefore exclude the case where
 * the path token sits at command-invocation position (line start, optionally with
 * a leading `./` / `/` / `~/`, or right after a shell connective), which means it
 * is the program being run rather than an argument being inspected.
 */
function isInsidePathSegment(text: string, matchStart: number, matchEnd: number): boolean {
    const prev = matchStart > 0 ? text[matchStart - 1] : '';
    const next = matchEnd < text.length ? text[matchEnd] : '';
    const isSep = (c: string) => c === '/' || c === '\\';
    const segChar = (c: string) => /[A-Za-z0-9._~-]/.test(c);
    const inPath =
        (isSep(prev) && (next === '' || isSep(next) || segChar(next) || /\s/.test(next))) ||
        (isSep(next) && (prev === '' || isSep(prev) || segChar(prev) || /\s/.test(prev)));
    if (!inPath) return false;

    // Find the whole whitespace-delimited path token containing the match and the
    // text on its line before it. If the token is the first thing on the line
    // (after an optional `./`, `/`, `~/`, or `../` prefix) or directly follows a
    // shell connective, it is being executed → not a suppressible path.
    const lineStart = text.lastIndexOf('\n', matchStart - 1) + 1;
    let tokStart = matchStart;
    while (tokStart > lineStart && !/\s/.test(text[tokStart - 1])) tokStart--;
    const linePrefixBeforeToken = text.slice(lineStart, tokStart);
    const tokenPrefix = text.slice(tokStart, matchStart);
    // The path token is in command position when nothing but whitespace (or a
    // shell connective) precedes it on the line, AND the token itself is a
    // run-prefix path (`./`, `/`, `~/`, `../`). A bare `build/Release` argument
    // after a verb ("list build/Release") is NOT command position.
    const atLineStart = /^\s*$/.test(linePrefixBeforeToken);
    const afterConnective = /(?:&&|\|\||\||;)\s*$/.test(linePrefixBeforeToken);
    const isRunPrefixPath = /^(?:\.\/|\.\.\/|~\/|\/)/.test(tokenPrefix);
    if ((atLineStart || afterConnective) && isRunPrefixPath) return false;
    return true;
}

/**
 * True if [matchStart, matchEnd) lies inside a quoted span — straight quotes
 * (`"..."`, `'...'`), typographic quotes (`“...”`, `‘...’`), or CJK brackets
 * (`「...」`, `『...』`, `《...》`). Commit-message citations and other quoted prose
 * (e.g. quoting a `chore: ... version-bump ...` log line, or the Korean
 * "포인터 bump" phrase) are descriptive, not command invocations, so a forbidden
 * keyword inside such a quote must not trip the guardrail. Backticks are excluded
 * here on purpose — they denote shell/code snippets and are handled as command
 * context in {@link isInsideBackticksOrFence}.
 */
function isInsideQuotedSpan(text: string, matchStart: number, matchEnd: number): boolean {
    // Paired quotes: an opening char before the match without its closer in
    // between, and the matching closer after the match.
    const pairs: Array<[string, string]> = [
        ['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』'], ['《', '》'],
    ];
    for (const [open, close] of pairs) {
        const openIdx = text.lastIndexOf(open, matchStart - 1);
        if (openIdx < 0) continue;
        // No closer between the opener and the match → still open at the match.
        if (text.indexOf(close, openIdx + open.length) >= matchEnd) return true;
    }
    // Symmetric quotes (" and '): odd count of the quote char before the match,
    // within the same line (a quote does not span newlines), and a closing quote
    // later on the line.
    const lineStart = text.lastIndexOf('\n', matchStart - 1) + 1;
    const lineEnd = (() => { const i = text.indexOf('\n', matchEnd); return i < 0 ? text.length : i; })();
    for (const q of ['"', "'"]) {
        let count = 0;
        for (let i = lineStart; i < matchStart; i++) if (text[i] === q) count++;
        if (count % 2 === 1 && text.indexOf(q, matchEnd) >= 0 && text.indexOf(q, matchEnd) < lineEnd) {
            // For "'" guard against the apostrophe-in-prose case (e.g. "don't"):
            // require the opening quote to be preceded by a boundary (start/space/
            // open-paren) so a contraction apostrophe is not read as a quote opener.
            if (q === '"') return true;
            // find the opening quote (the one making the count odd)
            let openPos = -1, c = 0;
            for (let i = lineStart; i < matchStart; i++) { if (text[i] === q) { c++; if (c % 2 === 1) openPos = i; } }
            const beforeOpen = openPos > lineStart ? text[openPos - 1] : ' ';
            if (/[\s(\[{>]/.test(beforeOpen) || openPos === lineStart) return true;
        }
    }
    return false;
}

/**
 * True if the keyword at [matchStart, matchEnd) is glued directly to a Unicode
 * *letter* on either side with no separator — i.e. it is word-internal, part of a
 * larger word rather than a standalone command token.
 *
 * The keyword regexes use `\b` boundaries, which already exclude an *ASCII-letter*
 * suffix/prefix: `\bdeploy\b` does NOT match the "deploy" inside "deployed"
 * (`y`→`e` is not a boundary). But `\b` fires a boundary between a Latin letter
 * and a non-Latin letter, so `deploy된` ("deployed", Korean passive), `release한`,
 * or `version-bump됨` DO match even though they are single conjugated/compound
 * words in prose, not shell commands. That is the exact i18n asymmetry behind
 * GUARDRAIL-I18N-FP: the English "deployed worker" passes (mid-prose, no command
 * context) while the Korean "deploy된 워커" was flagged because the glued CJK
 * suffix left the bare keyword sitting at line-start, which the command-context
 * heuristic reads as a command invocation.
 *
 * We restore the symmetry `\b` provides for ASCII: a forbidden keyword fused to
 * ANY Unicode letter (Hangul, Han, Kana, accented Latin, …) is a word-internal
 * occurrence → descriptive prose, never a command. A genuine command keyword is
 * always followed by a non-letter — whitespace, end-of-input, a path separator,
 * a flag/redirect, or a shell metachar (`npm run deploy`, `wrangler deploy\n`,
 * `version-bump.sh`, `npm publish && ...`).
 */
function isGluedToLetterSuffix(text: string, matchStart: number, matchEnd: number): boolean {
    // \p{L} = any Unicode letter; \p{M} = combining mark (e.g. Jamo/diacritics
    // that compose with the adjacent letter). Either side counts as "glued".
    const letterOrMark = /[\p{L}\p{M}]/u;
    const next = matchEnd < text.length ? text[matchEnd] : '';
    const prev = matchStart > 0 ? text[matchStart - 1] : '';
    return letterOrMark.test(next) || letterOrMark.test(prev);
}

/**
 * Decides whether a forbidden keyword match at [matchStart, matchEnd) should
 * count as a real violation. A match counts only when it is in command context
 * and not negated, and is NOT merely a path segment or quoted (descriptive)
 * citation. Negation always wins (even inside a code block), per the conservative
 * rule: code-block + negation → exclude; other code-block → keep.
 */
function isRealMutationMatch(text: string, matchStart: number, matchEnd: number): boolean {
    if (hasNegationBefore(text, matchStart)) return false;
    if (hasTrailingNegation(text, matchEnd)) return false;
    // A keyword fused to a non-ASCII letter ("deploy된", "release한") is a single
    // conjugated/compound word in prose, not a command — `\b` only guards the
    // ASCII-letter case, so restore the same symmetry for all Unicode letters.
    if (isGluedToLetterSuffix(text, matchStart, matchEnd)) return false;
    // A keyword that is part of a file path (build/Release, dist/release/) or
    // sits inside quoted prose (a commit-message citation, "포인터 bump") is a
    // description, not a command — suppress it even if it lands at line-start.
    if (isInsidePathSegment(text, matchStart, matchEnd)) return false;
    if (isInsideQuotedSpan(text, matchStart, matchEnd)) return false;
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

export function validateMeshTaskModeRequest(mode: unknown, message: string, readonly?: boolean): MeshTaskModeValidationResult {
    const taskMode = normalizeMeshTaskMode(mode);
    // QUEUE-NODE-SERIALIZATION: the write guardrail (reject deploy/push/edit commands on a
    // read-only task) is driven by the unified read-only axis, not by the enum alone — so a
    // task flagged read-only via the explicit `readonly:true` boolean is guarded identically
    // to a legacy live_debug_readonly task. isTaskReadonly is the single classifier.
    const isReadonly = isTaskReadonly({ readonly, taskMode });
    if (!isReadonly) {
        return taskMode ? { valid: true, taskMode, violations: [] } : { valid: true, violations: [] };
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
    /**
     * QUEUE-NODE-SERIALIZATION: explicit read-only axis, orthogonal to taskMode. When
     * true the task is treated as read-only by every scheduling gate (no node-busy
     * isolation, counted under the read-only cap, write commands rejected) regardless of
     * its taskMode. Decided exclusively through {@link isTaskReadonly}; `taskMode ===
     * 'live_debug_readonly'` remains an OR-fallback so legacy rows behave unchanged.
     */
    readonly?: boolean;
    /** If specified, only this node can claim the task (used by legacy mesh_send_task) */
    targetNodeId?: string;
    /** If specified, only this runtime session can claim the task */
    targetSessionId?: string;
    /** If specified, a node must expose all tags before it can claim the task. */
    requiredTags?: string[];
    /**
     * G6 (task-level scheduling priority): 'low' | 'normal' | 'high'. Orders the
     * claim candidate list so a high-priority task is pulled ahead of an older
     * normal/low task within the same claim tier (created_at is the tie-break).
     * Absent → treated as 'normal'. This is the TASK-level priority, distinct from
     * the NODE-level schedulingPriority (resolveNodeSchedulingPriority), which ranks
     * which node a task goes to, not which task a node pulls first.
     */
    priority?: MeshTaskPriority;
    /**
     * G7 (delayed execution): ISO timestamp before which the task is NOT claimable.
     * The claim gate holds the task pending while now < notBefore; once the wall
     * clock passes it the task becomes a normal claim candidate. A pure time gate —
     * cron/webhook triggers are out of scope. Absent → immediately claimable.
     */
    notBefore?: string;
    /**
     * M1: ids of tasks that must reach 'completed' before this task is claimable.
     * Forward references (ids not yet enqueued) are allowed for batch flows and
     * simply keep the task waiting until the referenced task exists and completes.
     */
    dependsOn?: string[];
    /** M1/M3: mission this task belongs to (joins mesh_missions). */
    missionId?: string;
    /**
     * MAGI: consensus group id shared by every replica of one mesh_magi_review
     * fan-out. Marks the task as part of an INTENTIONAL same-prompt quorum so the
     * completion-event dedup (mesh-events-pending) never collapses grouped
     * replicas. Absent on ordinary tasks. Rides in the payload JSON (no column).
     */
    consensusGroupId?: string;
    /**
     * MAGI-KIND-PANEL (model axis): model override for the session that executes this
     * task. When the task auto-launches a session, this is passed to launch_cli as
     * `initialModel` (ACP → setConfigOption; CLI → modelLaunchArgs template). Absent on
     * ordinary tasks. Rides in the payload JSON (no column). Best-effort — a provider
     * that cannot honor the model still runs the task (never a fatal launch error).
     */
    model?: string;
    /**
     * BRAIN-ROUTING (thinking axis): standard reasoning level ('low'|'medium'|'high')
     * for the session that executes this task. When the task auto-launches, this is
     * passed to launch_cli as `initialThinkingLevel` (CLI → thinkingLaunchArgs; ACP →
     * setConfigOption('thought_level')). Rides in payload JSON. Best-effort like model.
     */
    thinkingLevel?: string;
    /**
     * MODEL-SOURCE marker: who put the value in {@link model}. 'explicit' = the
     * caller passed it; 'preset' = the difficulty→brain preset filled it at
     * enqueue. Without this the two are indistinguishable downstream, and an
     * unconditional "task.model wins" rule lets a preset silently override the
     * difficulty-matched slot's own model (or, with the fail-closed slot guard,
     * blocks the task on nodes that never declared the preset model). Same
     * marker class as quotaShowAccountEmailSetByUser (config.ts): machine-written
     * vs user-written values must be distinguishable.
     *
     * BACKWARD COMPAT: rows enqueued before this field existed carry no marker.
     * The assignment path treats an absent marker as 'explicit' — it never lets
     * a slot override a value that MIGHT be a user's choice. That keeps legacy
     * rows on exactly their pre-fix behaviour; only newly enqueued preset rows
     * get the relaxed precedence.
     */
    modelSource?: 'explicit' | 'preset';
    /** Same source marker as {@link modelSource}, for the thinkingLevel axis. */
    thinkingLevelSource?: 'explicit' | 'preset';
    /**
     * SLOT-ROUTING (ORCHESTRATION_NODE_SLOTS.md): the coordinator's difficulty
     * classification for this task ('easy'|'medium'|'difficult'|'freeform'),
     * PERSISTED on the entry so the scheduler can match it against node capability
     * slots at assignment time. Previously an enqueue-only option consumed to
     * resolve model/thinkingLevel and then discarded; keeping it lets task→node
     * fitness matching run. Absent on tasks enqueued without a difficulty.
     */
    difficulty?: string;
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
     * can enforce per-(node, provider) maxParallel caps (summed slots[].maxParallel)
     * by counting active assignments grouped by node + provider.
     */
    assignedProviderType?: string;
    /**
     * Transcript-authority class of the claiming session's provider, stamped at
     * claim time (P1 of the transcript-authority unification — root repo
     * docs/design/2026-07-25-transcript-authority-unification.md). Lets the
     * COORDINATOR side classify a remote worker (early-arm / redrive gates)
     * without resolving the provider module locally — the structural fix for
     * the "remote class unknowable → reprobe-only" blind spot. Absent on rows
     * claimed by older daemons; consumers must fall back to local resolution.
     */
    assignedTranscriptProfile?: {
        class: 'native-source' | 'pure-pty' | 'daemon-owned';
        timing: 'hold' | 'floor' | 'immediate';
        emitsPtyTurnEvents: boolean;
    };
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
     * REDRIVE-DUP: monotonic per-task dispatch nonce. Bumped on every (re)dispatch of
     * this task (assignQueueTask) AND on every reclaim (reclaimStrandedAssignedTask), and
     * carried to the worker in meshContext.dispatchNonce. The worker echoes it back on
     * agent:generating_started (metadataEvent.dispatchNonce). When a delivered-not-consumed
     * task is reclaimed and re-dispatched to a different node, the ORIGINAL inject to the
     * first node still carries the now-stale nonce; the coordinator rejects that node's
     * generating_started ack (and stops it) so the SAME taskId is never executed twice.
     * Absent on legacy rows → the coordinator skips the stale-nonce guard (backward safe).
     */
    dispatchNonce?: number;
    /**
     * TURN-LEDGER (Stage 5): the opaque attempt identity of the CURRENT dispatch of
     * this task — distinct from both the taskId and the monotonic dispatchNonce.
     * Stamped when the dispatch opens its attempt (openTurnAttempt, seq = the
     * post-bump dispatchNonce) and carried to the worker in meshContext.attemptId;
     * the worker echoes it on its lifecycle events so every ACK/completion proposal
     * correlates to (meshId, taskId, attemptId, coordinator identity, session). A
     * reclaim/reassign closes this attempt and the re-dispatch opens a NEW one, so
     * late old-attempt events are rejected by identity. Rides in the payload JSON
     * (no column migration); absent on pre-Stage-5 rows → the reducer lazily opens
     * a deterministic legacy attempt (never fabricating evidence) on first touch.
     */
    attemptId?: string;
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

/**
 * Ordered, de-duplicated provider types a node can launch, resolved from
 * `policy.slots` (the single source of truth — ORCHESTRATION_NODE_SLOTS.md) with a
 * fallback to the legacy `policy.providerPriority`. Used to advertise a
 * `provider=<type>` capability tag for EVERY provider the node supports, not just
 * providerPriority[0], so required_tags: ["provider=cursor-cli"] is satisfiable on a
 * node whose slots include cursor-cli even when it is not the first priority entry.
 *
 * Only provider NAMES are needed here, so slots are read via the dependency-light
 * normalizeNodeCapabilitySlots rather than resolveNodeCapabilitySlots (which pulls in
 * difficultyBrains) — keeping tag derivation free of scheduling-config imports.
 */
function readNodeProviderTypes(policy: unknown): string[] {
    const record = policy && typeof policy === 'object' && !Array.isArray(policy)
        ? policy as Record<string, unknown>
        : {};
    const seen = new Set<string>();
    const out: string[] = [];
    const push = (type: unknown) => {
        const trimmed = typeof type === 'string' ? type.trim() : '';
        if (!trimmed || seen.has(trimmed)) return;
        seen.add(trimmed);
        out.push(trimmed);
    };
    for (const slot of normalizeNodeCapabilitySlots(record.slots)) push(slot.provider);
    if (Array.isArray(record.providerPriority)) {
        for (const type of record.providerPriority) push(type);
    }
    return out;
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
    // When an explicit providerType is pinned (per-provider tag set used by the
    // queue slot matcher), advertise ONLY that provider's tag — so
    // provider=codex-cli matches only when codex-cli is the launched provider.
    // When no provider is pinned (the representative tag set consulted by
    // nodeSatisfiesRequiredTags), advertise a provider= tag for EVERY provider the
    // node can launch (all policy.slots, else providerPriority), so
    // required_tags: ["provider=cursor-cli"] is satisfiable on a node whose slots
    // include cursor-cli even when it is not the first priority entry.
    const pinnedProvider = typeof providerType === 'string' && providerType.trim()
        ? providerType.trim()
        : undefined;
    const providerTags = pinnedProvider
        ? [pinnedProvider]
        : readNodeProviderTypes(node?.policy);
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
        ...providerTags.map(p => `provider=${p}`),
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
        /** QUEUE-NODE-SERIALIZATION: explicit read-only axis (orthogonal to taskMode). */
        readonly?: boolean;
        requiredTags?: string[];
        /** M1: tasks that must complete before this one is claimable. */
        dependsOn?: string[];
        /** G6: task-level scheduling priority ('low' | 'normal' | 'high'). Absent → 'normal'. */
        priority?: MeshTaskPriority | string;
        /** G7: hold the task pending until this time. ISO string, absolute epoch-ms, or relative-ms offset from now. */
        notBefore?: string | number;
        /** P3: max automatic requeue attempts before the task auto-fails. Absent → policy default (1). */
        maxRetries?: number;
        /** M1/M3: mission this task belongs to. */
        missionId?: string;
        /** MAGI: consensus group id shared by every replica of a mesh_magi_review fan-out. */
        consensusGroupId?: string;
        /** MAGI-KIND-PANEL: model override forwarded to the executing session's launch (initialModel). */
        model?: string;
        /** BRAIN-ROUTING: standard thinking level forwarded to launch (initialThinkingLevel). */
        thinkingLevel?: string;
        /**
         * BRAIN-ROUTING: task execution difficulty ('easy'|'medium'|'difficult'|
         * 'freeform'). When set, the mesh's difficulty→brain preset fills in model /
         * thinkingLevel that were not passed explicitly (an explicit model/thinkingLevel
         * wins). Purely a convenience resolver — the stored task still carries the
         * resolved model/thinkingLevel, so downstream launch is unchanged.
         */
        difficulty?: string;
        /** Explicit task id for batch/template flows (M5). Random UUID when omitted. */
        id?: string;
        /** (3) Originating coordinator session id (for session-anchored completion routing). */
        sourceCoordinatorSessionId?: string;
    } & MeshQueueMutationOptions,
): MeshWorkQueueEntry {
    requireMeshHostQueueOwner(opts);
    // DELIVERY-MSG-GUARD (upstream defence): a task whose message is undefined /
    // non-string / blank must never reach the queue. Left unchecked it persists a
    // message-less payload that later crashes insertSessionDelivery's NOT NULL at
    // claim/dispatch time (the DB-level `message ?? ''` fallback still exists as
    // depth-in-defence, but silently dispatching an empty prompt is itself a bug).
    // Normalise and hard-reject at the single entry point so no caller can slip a
    // blank task past the schema's nominal `required`.
    message = String(message ?? '').trim();
    if (!message) {
        throw new Error('mesh task message must be a non-empty string');
    }
    const readonly = opts?.readonly === true;
    const modeValidation = validateMeshTaskModeRequest(opts?.taskMode, message, readonly);
    if (!modeValidation.valid) {
        throw new Error(`live_debug_readonly_guardrail_violation: forbidden operations (${modeValidation.violations.join(', ')})`);
    }
    const id = typeof opts?.id === 'string' && opts.id.trim() ? opts.id.trim() : randomUUID();
    const dependsOn = normalizeDependsOn(opts?.dependsOn);
    const priority = normalizeMeshTaskPriority(opts?.priority);
    const notBefore = resolveNotBefore(opts?.notBefore);
    const maxRetries = typeof opts?.maxRetries === 'number' && Number.isFinite(opts.maxRetries) && opts.maxRetries >= 0
        ? Math.floor(opts.maxRetries)
        : undefined;
    // BRAIN-ROUTING: resolve the difficulty preset into effective model / thinking
    // level. An explicit opts.model / opts.thinkingLevel always wins; the preset only
    // fills what the caller left blank. Best-effort — a missing/invalid difficulty or
    // an unconfigured preset just leaves the explicit values (or none) in place.
    let effectiveModel = typeof opts?.model === 'string' && opts.model.trim() ? opts.model.trim() : undefined;
    let effectiveThinkingLevel = typeof opts?.thinkingLevel === 'string' && opts.thinkingLevel.trim() ? opts.thinkingLevel.trim() : undefined;
    // MODEL-SOURCE: record WHO supplied each value so the assignment path can
    // tell a user's choice (never overridden by a slot) from a preset default
    // (a difficulty-matched slot's own model wins over it). A value the caller
    // passed is 'explicit' until proven preset-filled below.
    let modelSource: 'explicit' | 'preset' | undefined = effectiveModel ? 'explicit' : undefined;
    let thinkingLevelSource: 'explicit' | 'preset' | undefined = effectiveThinkingLevel ? 'explicit' : undefined;
    // SLOT-ROUTING: persist the difficulty class on the entry so the scheduler can
    // match it against node capability slots at assignment time (not just resolve
    // model/thinking here). Absent/invalid → undefined (task carries no difficulty).
    const taskDifficulty = isMeshTaskDifficulty(opts?.difficulty) ? (opts!.difficulty as MeshTaskDifficulty) : undefined;
    if (isMeshTaskDifficulty(opts?.difficulty)) {
        try {
            // Scoped to the mesh the task is being enqueued into: these presets pick
            // the MODEL the task runs on, so reading another mesh's map would stamp a
            // model this mesh never chose (and the slot-model guard would then block
            // or wait on it at launch).
            const preset = getDifficultyBrains(meshId)[opts!.difficulty as MeshTaskDifficulty];
            if (preset) {
                if (!effectiveModel && preset.model) { effectiveModel = preset.model; modelSource = 'preset'; }
                if (!effectiveThinkingLevel && preset.thinkingLevel) { effectiveThinkingLevel = preset.thinkingLevel; thinkingLevelSource = 'preset'; }
            }
        } catch { /* preset read is best-effort — never block enqueue */ }
    }
    const result = withQueueLock(meshId, () => {
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
            ...(readonly ? { readonly: true } : {}),
            targetNodeId: opts?.targetNodeId,
            targetSessionId: opts?.targetSessionId,
            requiredTags: resolvedRequiredTags,
            ...(dependsOn.length > 0 ? { dependsOn } : {}),
            // G6: only persist a non-default priority so legacy/normal rows stay minimal.
            ...(priority && priority !== 'normal' ? { priority } : {}),
            // G7: hold-until gate (stored ISO). Omitted when absent/immediate.
            ...(notBefore ? { notBefore } : {}),
            // P3: explicit retry cap. Omitted → requeue path falls back to policy default.
            ...(maxRetries !== undefined ? { maxRetries } : {}),
            ...(typeof opts?.missionId === 'string' && opts.missionId.trim() ? { missionId: opts.missionId.trim() } : {}),
            ...(typeof opts?.consensusGroupId === 'string' && opts.consensusGroupId.trim() ? { consensusGroupId: opts.consensusGroupId.trim() } : {}),
            ...(effectiveModel && modelSource ? { model: effectiveModel, modelSource } : {}),
            ...(effectiveThinkingLevel && thinkingLevelSource ? { thinkingLevel: effectiveThinkingLevel, thinkingLevelSource } : {}),
            ...(taskDifficulty ? { difficulty: taskDifficulty } : {}),
            ...(typeof opts?.sourceCoordinatorSessionId === 'string' && opts.sourceCoordinatorSessionId.trim()
                ? { sourceCoordinatorSessionId: opts.sourceCoordinatorSessionId.trim() }
                : {}),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        MeshRuntimeStore.getInstance().insertQueueEntry(entry);
        return entry;
    });
    // A fresh pending task returns its mission to a non-terminal state — reset any
    // stale close-candidate marker so a later re-completion can nudge again.
    scheduleMissionCloseCandidateCheck(meshId, [result]);
    return result;
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
 * out-of-band. They share the mode validation; missionId is stamped when present.
 *
 * MISSIONLESS-DIRECT-DISPATCH-NO-ATTEMPT: `missionId` is deliberately OPTIONAL.
 * It once gated this whole function, because the function's only job was mission
 * ATTRIBUTION (the counts described above). Two things were later folded in that
 * have nothing to do with missions, and both silently inherited that gate:
 *
 *   1. openTurnAttempt/recordTurnAck — without an attempt, a completion event
 *      reaches proposeTurnCompletion with nothing to resolve, so
 *      ensureLegacyTurnAttempt mints a `legacy-<taskId>-0` row whose sessionId
 *      does not match the worker binding. The reducer then refuses the flip
 *      (stale_attempt / session_mismatch) and mesh-event-forwarding returns
 *      early, skipping updateSessionTaskStatus, updateDirectDispatchStatus and
 *      markSessionDeliveriesTerminal — the session stays `generating` forever.
 *   2. createSessionDelivery — the confirmed-delivery record that stops
 *      recoverStrandedAssignedDispatches from reclaiming an already-completed
 *      task (see the note at that call). Skipping it does not merely delay a
 *      status: on an unlucky interleaving the watchdog REDRIVES finished work.
 *
 * So a `mesh_send_task` without a mission lost both terminal-state convergence
 * and redrive protection. Opening the attempt is what makes every direct
 * dispatch reducer-authoritative from `accepted`, exactly like the queue path
 * (mesh-queue-assignment.ts openTurnAttempt), and it must not depend on whether
 * the caller happened to pass a mission.
 */
export function recordDirectDispatchTask(
    meshId: string,
    message: string,
    opts: {
        id: string;
        /** Optional: stamped for mission attribution when present. Never gates
         *  attempt-opening or delivery recording — see the note above. */
        missionId?: string;
        assignedNodeId?: string;
        assignedSessionId?: string;
        taskMode?: MeshTaskMode | string;
        /** QUEUE-NODE-SERIALIZATION: explicit read-only axis (orthogonal to taskMode). */
        readonly?: boolean;
        dispatchedAt?: string;
    },
): MeshWorkQueueEntry | null {
    // A missing missionId only means "not attributable to a mission" — it must not
    // skip the turn attempt or the delivery record (see the note above).
    const missionId = typeof opts.missionId === 'string' ? opts.missionId.trim() : '';
    const taskId = typeof opts.id === 'string' ? opts.id.trim() : '';
    if (!taskId) return null;
    // DELIVERY-MSG-GUARD (upstream defence): the direct-dispatch path materialises the
    // same message-carrying queue entry AND writes a session delivery (createSessionDelivery
    // below), so a blank/undefined message would hit the same NOT NULL crash. Normalise and
    // hard-reject before we record anything — consistent with enqueueTask.
    message = String(message ?? '').trim();
    if (!message) {
        throw new Error('mesh task message must be a non-empty string');
    }
    const readonly = opts.readonly === true;
    const modeValidation = validateMeshTaskModeRequest(opts.taskMode, message, readonly);
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
            ...(readonly ? { readonly: true } : {}),
            ...(missionId ? { missionId } : {}),
            ...(opts.assignedNodeId ? { targetNodeId: opts.assignedNodeId, assignedNodeId: opts.assignedNodeId } : {}),
            ...(opts.assignedSessionId ? { targetSessionId: opts.assignedSessionId, assignedSessionId: opts.assignedSessionId } : {}),
            dispatchTimestamp: now,
            createdAt: now,
            updatedAt: now,
        };
        MeshRuntimeStore.getInstance().insertQueueEntry(entry);
        // TURN-LEDGER (Stage 5): the direct dispatch was already confirmed handed to
        // the transport (result.success) before this row materialised, so open the
        // attempt at 'accepted' and immediately record the 'delivered' ACK — the same
        // causal stage the 'delivered' delivery record below attests to. The attempt
        // gives this task's completion an authoritative (taskId, attemptId, session)
        // correlation instead of the session-scalar heuristic.
        try {
            entry.dispatchNonce = (entry.dispatchNonce || 0) + 1;
            const { attempt } = openTurnAttempt({
                meshId,
                taskId,
                dispatchNonce: entry.dispatchNonce,
                nodeId: opts.assignedNodeId,
                sessionId: opts.assignedSessionId,
            });
            entry.attemptId = attempt.attemptId;
            MeshRuntimeStore.getInstance().updateQueueEntry(entry);
            recordTurnAck({ meshId, taskId, kind: 'delivered', attemptId: attempt.attemptId, sessionId: opts.assignedSessionId });
        } catch { /* best-effort — the assigned row is already recorded */ }
        // R2 / NOTIF-DROP: a mission-attributed DIRECT dispatch (mesh_send_task) has
        // already been handed to the transport by the time we materialise this assigned
        // row — unlike a queue claim, there is no later delivery-confirmation write for
        // it. Without a confirmed delivery record keyed by this taskId, the assigned-
        // stranded watchdog (recoverStrandedAssignedDispatches → taskHasConfirmedDelivery)
        // sees the row as never-confirmed after ASSIGNED_STRANDED_DEADLINE_MS and reclaims
        // a task the worker already COMPLETED, dropping its agent:generating_completed
        // (live PROBE-B repro: "never confirmed delivered → pending"). Record a confirmed
        // delivery here so taskHasConfirmedDelivery() is true and the watchdog leaves the
        // row to PHASE 4 completion reconcile. This point is only reached after the direct
        // dispatch's result.success, so 'delivered' is the accurate state.
        try {
            createSessionDelivery({
                meshId,
                ...(opts.assignedNodeId ? { nodeId: opts.assignedNodeId } : {}),
                ...(opts.assignedSessionId ? { sessionId: opts.assignedSessionId } : {}),
                taskId,
                kind: 'task',
                message,
                status: 'delivered',
            });
        } catch { /* best-effort — the assigned row is already recorded */ }
        // NOTE (LEDGER-TASK-TRACEABILITY A): the direct-dispatch (mesh_send_task) path
        // appends its own task_dispatched ledger entry at the MCP layer (mesh-tools-session.ts
        // via buildDirectTaskPayload → routingDecision source:'direct') BEFORE calling this.
        // Do NOT append task_dispatched here — it would double-record the same dispatch.
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
 * is the enforced per-(node, provider) cap (summed slots[].maxParallel):
 * a task is not assigned to this (node, provider) once it already has that many
 * active assignments. This composes with the global/taskMode caps (stricter wins).
 */
export function claimNextTask(
    meshId: string,
    nodeId: string,
    sessionId: string,
    capabilityTags?: string[],
    opts?: {
        providerType?: string;
        providerMaxParallel?: number;
        nodeIsWorktree?: boolean;
        assignedTranscriptProfile?: MeshWorkQueueEntry['assignedTranscriptProfile'];
    },
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
/**
 * Cascade a dependency failure. Returns the dependents whose status was flipped to
 * `cancelled` (the 'cancel' policy) so the caller can trigger mission_close_candidate
 * detection for their missions too — a cascade can be the very transition that leaves
 * a *different* mission all-terminal. Under the 'block' policy nothing goes terminal
 * (dependents are only marked blocked), so the returned list is empty.
 */
function propagateDependencyFailure(meshId: string, failedTaskId: string): MeshWorkQueueEntry[] {
    const policy = resolveDependencyFailurePolicy(meshId);
    const store = MeshRuntimeStore.getInstance();
    const cancelled: MeshWorkQueueEntry[] = [];
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
                cancelled.push(dependent);
                frontier.push(dependent.id); // cascade to transitive dependents
            } else {
                dependent.blockedReason = `dependency_failed:${currentId}`;
                store.updateQueueEntry(dependent);
            }
        }
    }
    return cancelled;
}

const DEPENDENCY_FAILURE_TERMINALS = new Set<MeshTaskStatus>(['failed', 'cancelled']);

/**
 * CANCEL-STICKY-TERMINAL: the terminal task statuses. A row in one of these states is a
 * historical record — no live dispatch owns it — and must NEVER be flipped back to an
 * active (`pending`/`assigned`) state by a late writer. The canonical live example is a
 * cancel that races the dispatch-failure `.catch` (mesh-queue-assignment.ts): that catch
 * fires-and-forgets an unconditional `updateTaskStatus(...,'pending')`, resolving AFTER
 * the cancel commits, which resurrected the cancelled row → it got re-claimed and the
 * reclaim watchdog re-drove the same prompt. Guarding the write side (see
 * {@link updateTaskStatus}) applies the same terminal-row protection
 * {@link reclaimStrandedAssignedTask} already enforces to EVERY status writer at once.
 */
const TERMINAL_TASK_STATUSES = new Set<MeshTaskStatus>(['completed', 'failed', 'cancelled']);

/**
 * G3 (step ①) — fire-and-forget mission_close_candidate detection for the missions of
 * the given task ids. Called after any task-status mutation (completion / failure /
 * cancel / dependency-cascade / new-task enqueue) so a mission whose tasks all just
 * became terminal gets a one-shot "consider closing" nudge, and a mission that just
 * gained a non-terminal task has its idempotency marker reset.
 *
 * Loaded via a lazy dynamic import to break the static queue↔missions import cycle
 * (mesh-missions statically imports getQueue from here): the resolve happens off the
 * mutation's critical path, and any failure is swallowed — this is a best-effort hint,
 * never allowed to affect the task write that triggered it.
 */
function scheduleMissionCloseCandidateCheck(meshId: string, entries: Array<MeshWorkQueueEntry | null | undefined>): void {
    const missionIds = new Set<string>();
    for (const entry of entries) {
        const missionId = entry?.missionId;
        if (typeof missionId === 'string' && missionId.trim()) missionIds.add(missionId.trim());
    }
    if (missionIds.size === 0) return;
    void import('./mesh-missions.js')
        .then(({ maybeEmitMissionCloseCandidate }) => {
            for (const missionId of missionIds) {
                try { maybeEmitMissionCloseCandidate(meshId, missionId); } catch { /* best-effort per mission */ }
            }
        })
        .catch(() => { /* best-effort: never break a task mutation on the hint path */ });
}

/**
 * Update the status of a specific task.
 * Used when a session completes, fails, or stalls.
 */
export function updateTaskStatus(
    meshId: string,
    taskId: string,
    status: MeshTaskStatus,
    opts?: {
        /**
         * CANCEL-STICKY-TERMINAL: operator/system override to permit a terminal→non-terminal
         * transition (e.g. an explicit operator reopen). Without this, a write that would flip
         * a `completed`/`failed`/`cancelled` row back to `pending`/`assigned` is refused as a
         * no-op. Terminal→terminal and any transition FROM a non-terminal state are unaffected.
         */
        force?: boolean;
    } & MeshQueueMutationOptions,
): MeshWorkQueueEntry | null {
    requireMeshHostQueueOwner(opts);
    const result = withQueueLock(meshId, () => {
        const entry = MeshRuntimeStore.getInstance().findQueueEntryById(meshId, taskId);
        if (!entry) return null;
        // CANCEL-STICKY-TERMINAL: never resurrect a terminal row into an active state. A late
        // fire-and-forget writer (canonically the dispatch-failure `.catch` requeue to
        // 'pending' in mesh-queue-assignment.ts, which resolves AFTER a cancel commits) must
        // not undo a cancel/completion/failure — that revival let the row be re-claimed and the
        // reclaim watchdog re-drive the same prompt. Refuse the transition as a no-op unless an
        // explicit operator override is passed. This is the write-side sibling of the
        // status!=='assigned' guard reclaimStrandedAssignedTask already applies.
        if (!opts?.force
            && TERMINAL_TASK_STATUSES.has(entry.status)
            && !TERMINAL_TASK_STATUSES.has(status)) {
            LOG.debug('MeshQueue', `Refusing updateTaskStatus(${taskId} → ${status}) on mesh ${meshId}: row is terminal (${entry.status}). A late writer (e.g. dispatch-failure requeue) must not resurrect a cancelled/completed/failed task. Pass force to override.`);
            return { entry, cascaded: [] as MeshWorkQueueEntry[] };
        }
        entry.status = status;
        MeshRuntimeStore.getInstance().updateQueueEntry(entry);
        // Any transition OFF `assigned` ends the single-flight dispatch window (terminal
        // completion/failure, or the dispatch-failure requeue to `pending`).
        if (status !== 'assigned') endTaskDispatchInFlight(meshId, taskId);
        const cascaded = DEPENDENCY_FAILURE_TERMINALS.has(status) ? propagateDependencyFailure(meshId, taskId) : [];
        return { entry, cascaded };
    });
    if (result) scheduleMissionCloseCandidateCheck(meshId, [result.entry, ...result.cascaded]);
    return result ? result.entry : null;
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
    const result = withQueueLock(meshId, () => {
        const entry = MeshRuntimeStore.getInstance().findQueueEntryById(meshId, taskId);
        if (!entry) return null;
        const now = new Date().toISOString();
        // CANCEL-STICKY-TERMINAL (authoritative cancel): capture the prior assignment BEFORE
        // clearing it, so the caller can stop the bound live worker. Leaving assignedNodeId/
        // SessionId/ProviderType on the cancelled row let the still-running worker keep emitting
        // delivery/turn signals that re-ignited the reclaim watchdog (observed: nonce 6→9,
        // needing two cancels + a manual session stop). Clearing them also drops this row from
        // the status==='assigned' counters so it can never be treated as live again.
        const priorAssignment: CancelledTaskAssignment | undefined = entry.assignedSessionId
            ? {
                sessionId: entry.assignedSessionId,
                nodeId: entry.assignedNodeId,
                providerType: entry.assignedProviderType,
            }
            : undefined;
        entry.status = 'cancelled';
        entry.cancelledAt = now;
        if (opts?.reason) entry.cancelReason = opts.reason;
        delete entry.assignedNodeId;
        delete entry.assignedSessionId;
        delete entry.assignedProviderType;
        delete entry.dispatchTimestamp;
        // Belt-and-suspenders: bump the dispatch nonce so any in-flight inject the
        // now-orphaned worker later echoes carries a stale nonce and is rejected by the
        // coordinator's stale-nonce guard — same mechanism reclaimStrandedAssignedTask uses.
        entry.dispatchNonce = (entry.dispatchNonce || 0) + 1;
        delete entry.attemptId;
        MeshRuntimeStore.getInstance().updateQueueEntry(entry);
        endTaskDispatchInFlight(meshId, taskId);
        // TURN-LEDGER (Stage 5): cancellation is a terminal CompletionProposal like any
        // other — routed through the reducer so a cancel that races a late worker
        // completion commits exactly one terminal outcome (no resurrection either way).
        try {
            proposeTurnCompletion({
                meshId,
                taskId,
                outcome: 'cancelled',
                source: 'cancellation',
                reason: opts?.reason ?? 'operator_cancel',
            });
        } catch { /* reducer proposal is best-effort — the cancel already committed above */ }
        const cascaded = propagateDependencyFailure(meshId, taskId);
        return { entry, cascaded, priorAssignment };
    });
    if (result) scheduleMissionCloseCandidateCheck(meshId, [result.entry, ...result.cascaded]);
    // Surface the prior binding to the caller (out-of-band from the persisted row, so it is
    // never serialized) so the cancel command handler — which holds DaemonComponents — can
    // stop the now-orphaned worker via the transport-aware stopStaleMeshWorker helper.
    if (result?.priorAssignment) lastCancelledTaskAssignment.set(`${meshId}::${taskId}`, result.priorAssignment);
    return result ? result.entry : null;
}

/**
 * CANCEL-STICKY-TERMINAL: the assignment a task carried at cancel time, handed to the cancel
 * command handler so it can stop the bound worker. cancelTask runs in the pure queue-store
 * module (no DaemonComponents), so it records the binding here and the handler drains it.
 */
export interface CancelledTaskAssignment {
    sessionId: string;
    nodeId?: string;
    providerType?: string;
}

const lastCancelledTaskAssignment = new Map<string, CancelledTaskAssignment>();

/**
 * Read-and-clear the assignment a just-cancelled task was bound to. Returns undefined when the
 * cancelled task had no live assignment (nothing to stop). One-shot: the entry is deleted on read.
 */
export function takeCancelledTaskAssignment(meshId: string, taskId: string): CancelledTaskAssignment | undefined {
    const key = `${meshId}::${taskId}`;
    const value = lastCancelledTaskAssignment.get(key);
    if (value) lastCancelledTaskAssignment.delete(key);
    return value;
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
    const result = withQueueLock(meshId, () => {
        const entry = MeshRuntimeStore.getInstance().findQueueEntryById(meshId, taskId);
        if (!entry) return null;
        // CANON-IDENTITY single-flight: refuse (no-op) to reopen a task whose dispatch
        // is still in-flight — the worker is actively generating on it. Requeueing it
        // here would flip the row back to `pending` and let a SECOND session claim the
        // SAME task (the live `ade8586d` requeue-while-generating double-dispatch). A
        // STALE assigned row (dead session, dispatch never confirmed) is NOT in-flight
        // — its mark was cleared on the dispatch failure — so it still requeues as
        // before. An explicit operator override (`force`) bypasses this guard.
        // MAGI-NOTE: the future consensus group fan-out (separate mission) intentionally
        // re-dispatches a group-tagged task into multiple sessions and must be exempted
        // from this single-flight guard; the exemption hook (group-id check) belongs here.
        if (!opts?.force && isTaskDispatchInFlight(meshId, taskId)) {
            LOG.warn('MeshQueue', `Refusing to requeue task ${taskId} on mesh ${meshId}: it is actively dispatched/generating (single-flight in-flight). Requeueing now would open a duplicate second dispatch into another session. Pass force to override.`);
            // No status change → no mission aggregate change; nothing to re-check.
            return { entry, cascaded: [] as MeshWorkQueueEntry[], missionAffected: false };
        }
        // Proceeding to requeue (or force-override): the prior dispatch is being abandoned,
        // so end the single-flight window for this task id.
        endTaskDispatchInFlight(meshId, taskId);
        const currentCount = entry.requeueCount || 0;
        const maxRetries = opts?.maxRetries ?? entry.maxRetries ?? 1;
        if (!opts?.force && currentCount >= maxRetries) {
            // Auto-fail: cap exceeded without explicit force override.
            entry.status = 'failed';
            entry.cancelReason = `max_retries_exceeded: requeued ${currentCount} time(s), limit is ${maxRetries}`;
            entry.updatedAt = new Date().toISOString();
            MeshRuntimeStore.getInstance().updateQueueEntry(entry);
            const cascaded = propagateDependencyFailure(meshId, taskId);
            // Terminal (failed) → mission may now be all-terminal.
            return { entry, cascaded, missionAffected: true };
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
        // Non-terminal (back to pending) → mission left the all-terminal state; the
        // close-candidate check resets any stale idempotency marker so a later
        // re-completion can nudge again.
        return { entry, cascaded: [] as MeshWorkQueueEntry[], missionAffected: true };
    });
    if (result?.missionAffected) scheduleMissionCloseCandidateCheck(meshId, [result.entry, ...result.cascaded]);
    return result ? result.entry : null;
}

/**
 * RC.20 (target-session wedge): clear a STALE target pin (targetSessionId, and
 * optionally targetNodeId) from a still-PENDING task so it becomes claimable by any
 * compatible session — WITHOUT consuming the task's retry budget (requeueCount is
 * untouched; the pin expiry is an un-wedging operation, not a retry). This is the
 * documented bounded rule behind the TARGET_SESSION_PIN_TTL_MS expiry in the
 * auto-launch scan: a pin that has gone unclaimed past the TTL is expired rather than
 * leaving the task pending forever behind the target_session_constraint skip.
 *
 * Guarded to 'pending' rows only — an assigned/completed/cancelled row is never
 * mutated (explicit operator cancellation stays terminal).
 */
export function expireTaskTargetPin(
    meshId: string,
    taskId: string,
    opts?: { reason?: string; clearTargetNode?: boolean } & MeshQueueMutationOptions,
): MeshWorkQueueEntry | null {
    requireMeshHostQueueOwner(opts);
    return withQueueLock(meshId, () => {
        const entry = MeshRuntimeStore.getInstance().findQueueEntryById(meshId, taskId);
        if (!entry) return null;
        if (entry.status !== 'pending') return null;
        if (!entry.targetSessionId && !entry.targetNodeId) return null;
        const clearedSession = entry.targetSessionId;
        const clearedNode = opts?.clearTargetNode ? entry.targetNodeId : undefined;
        delete entry.targetSessionId;
        if (opts?.clearTargetNode) delete entry.targetNodeId;
        entry.updatedAt = new Date().toISOString();
        if (opts?.reason) entry.requeueReason = opts.reason;
        MeshRuntimeStore.getInstance().updateQueueEntry(entry);
        LOG.warn('MeshQueue', `Expired stale target pin on task ${taskId} (mesh ${meshId}): `
            + `cleared${clearedSession ? ` targetSessionId=${clearedSession}` : ''}${clearedNode ? ` targetNodeId=${clearedNode}` : ''} `
            + `(${opts?.reason ?? 'target_pin_expired'}) — the task is now claimable by any compatible session`);
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
 * TASK-PROMPT-REDRIVE-AFTER-COMPLETE: the reclaim reasons the assigned-stranded watchdog
 * uses when it RE-DRIVES a delivered-but-not-terminal task (returns it to 'pending' so the
 * SAME prompt is re-dispatched). These are distinct from `assigned_stranded_dispatch_unconfirmed`
 * (a dispatch that was NEVER handed off — nothing ran, so a late completion is impossible).
 *
 * A re-drive assumes the worker never finished. But for an autoLaunch/worktree worker the
 * turn-lifecycle events (agent:generating_started/completed) do NOT reliably reach the
 * coordinator ledger, so the deadline can elapse and re-drive fire while the worker's genuine
 * completion is merely LATE (observed live: it lands 0.9s–98s AFTER the reclaim). The late
 * completion must then SUPERSEDE the re-drive rather than be dropped — the completion handler's
 * flip-miss safety net checks a row reclaimed for one of these reasons within
 * {@link REDRIVE_SUPERSEDE_WINDOW_MS} of its `requeuedAt`.
 */
export const REDRIVE_RECLAIM_REASONS: ReadonlySet<string> = new Set([
    'delivered_no_turn_deadline',
    'reclaim_after_unknown_grace',
    'delivered_not_consumed_redrive',
]);

/**
 * How long after a re-drive reclaim's `requeuedAt` a late completion still supersedes the
 * re-dispatch. Comfortably covers the observed 0.9s–98s completion-vs-reclaim race with margin,
 * while staying far short of the time it would take a genuinely fresh re-dispatched turn to
 * produce its OWN completion — so a real second turn is never mistaken for the superseded one.
 */
export const REDRIVE_SUPERSEDE_WINDOW_MS = 5 * 60_000;

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
    const result = withQueueLock(meshId, () => {
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
        // REDRIVE-DUP: bump the dispatch nonce so the ORIGINAL inject to prevNode/prevSession
        // (which is delivered-but-unconsumed and about to be re-dispatched elsewhere) now
        // carries a stale nonce. When that stranded inject finally fires and the worker emits
        // agent:generating_started echoing the old nonce, the coordinator's stale-nonce guard
        // rejects the ack and stops that worker — so the reclaimed+re-dispatched task is never
        // executed by the originally-assigned session (no duplicate execution).
        entry.dispatchNonce = (entry.dispatchNonce || 0) + 1;
        entry.strandedReclaimCount = reclaims;
        entry.updatedAt = now;
        // TURN-LEDGER (Stage 5): reassignment closes the CURRENT attempt (terminal
        // 'cancelled' / reassigned:<reason>) — the TASK continues, and the re-dispatch
        // under the just-bumped nonce opens a NEW attempt identity. Late events naming
        // the old attempt are rejected as stale from here on and can never mutate the
        // new attempt. Best-effort: a missing attempt (legacy row) is a no-op.
        try {
            closeAttemptForReassignment({ meshId, taskId, reason });
        } catch { /* attempt close is best-effort — the queue mutation above already landed */ }
        delete entry.attemptId;
        // The stranded assignment is being torn down (→ pending or failed); end its
        // single-flight window so a re-claim/requeue is not blocked.
        endTaskDispatchInFlight(meshId, taskId);
        let cascaded: MeshWorkQueueEntry[] = [];
        if (reclaims > MAX_STRANDED_RECLAIMS) {
            // Repeatedly undeliverable — stop cycling and fail it so dependents unblock.
            entry.status = 'failed';
            entry.cancelReason = `stranded_dispatch_unrecovered: reclaimed ${reclaims - 1} time(s) without a confirmed dispatch`;
            MeshRuntimeStore.getInstance().updateQueueEntry(entry);
            cascaded = propagateDependencyFailure(meshId, taskId);
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
        return { entry, cascaded };
    });
    // Reclaim toggles the mission aggregate either way: → failed may make it all-terminal;
    // → pending resets any stale close-candidate marker. Re-check in both outcomes.
    if (result) scheduleMissionCloseCandidateCheck(meshId, [result.entry, ...result.cascaded]);
    return result ? result.entry : null;
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
    const result = withQueueLock(meshId, () => {
        const store = MeshRuntimeStore.getInstance();
        const occurredAtIso = opts?.occurredAt ? new Date(opts.occurredAt).toISOString() : undefined;
        const entry = store.findAssignedBySession(meshId, sessionId, occurredAtIso, opts?.taskId);
        if (!entry) {
            // C2: the silent null here is exactly what stranded a finished task as
            // `assigned` for 19 minutes. If the session still has an assigned row we
            // failed to resolve, surface it loudly instead of dropping the completion.
            const assignedRows = store.getActiveAssignmentDetails(meshId)
                .filter(r => sessionIdsEquivalent(r.sessionId, sessionId));
            if (assignedRows.length > 0) {
                LOG.warn('MeshQueue', `No assigned queue row matched completion for mesh ${meshId} session ${sessionId} `
                    + `(taskId=${opts?.taskId ?? 'none'}, occurredAt=${occurredAtIso ?? 'none'}); `
                    + `${assignedRows.length} assigned row(s) exist: ${assignedRows.map(r => r.id).join(',')}`);
            }
            return null;
        }
        entry.status = status;
        store.updateQueueEntry(entry);
        // The worker reported a terminal/non-assigned outcome — the dispatch is over;
        // release the single-flight mark so the task id can be re-dispatched later.
        if (status !== 'assigned') endTaskDispatchInFlight(meshId, entry.id);
        const cascaded = DEPENDENCY_FAILURE_TERMINALS.has(status) ? propagateDependencyFailure(meshId, entry.id) : [];
        return { entry, cascaded };
    });
    if (result) scheduleMissionCloseCandidateCheck(meshId, [result.entry, ...result.cascaded]);
    return result ? result.entry : null;
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
 * M1: THE single dependency-gate predicate. A task is claimable from a
 * dependency standpoint iff it carries no system block (`blockedReason`) AND
 * every id in `dependsOn` has reached 'completed'.
 *
 * DEPENDSON-GATE-SYMMETRY: every scheduler surface that decides whether a
 * pending task may run MUST route through this one predicate — the queue claim
 * (claimNextQueueTask), the auto-launch candidate filter
 * (maybeAutoLaunchOneQueueSession), and the cloud eager P2P push
 * (enqueue-and-push). If any surface computes dependency readiness on its own,
 * the gate goes asymmetric and a task blocked from the pull path can still be
 * eager-pushed straight to an idle session, silently bypassing its
 * prerequisites. The semantics here (all deps completed && !blocked) are the
 * invariant — do not fork them.
 */
export function taskDependenciesSatisfied(
    entry: Pick<MeshWorkQueueEntry, 'dependsOn' | 'blockedReason'>,
    statusById: Map<string, MeshTaskStatus | string>,
): boolean {
    if (entry.blockedReason) return false;
    const deps = Array.isArray(entry.dependsOn) ? entry.dependsOn : [];
    return deps.every(depId => statusById.get(depId) === 'completed');
}

/**
 * M1-4: view-time dependency state for a task — unmet dependency ids and
 * whether the task is currently claimable from a dependency standpoint.
 * Not stored (truth stays in task statuses). The `dependenciesSatisfied` field
 * is derived from {@link taskDependenciesSatisfied} so the view and the
 * scheduler gates can never disagree.
 */
export function describeTaskDependencyState(
    entry: Pick<MeshWorkQueueEntry, 'dependsOn' | 'blockedReason'>,
    statusById: Map<string, MeshTaskStatus | string>,
): { waitingOn: string[]; dependenciesSatisfied: boolean } {
    const deps = Array.isArray(entry.dependsOn) ? entry.dependsOn : [];
    const waitingOn = deps.filter(depId => statusById.get(depId) !== 'completed');
    return {
        waitingOn,
        dependenciesSatisfied: taskDependenciesSatisfied(entry, statusById),
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
