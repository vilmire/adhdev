/**
 * mesh-task-mode-guardrail — the read-only task-mode write guardrail.
 *
 * Pure move out of mesh-work-queue.ts (no behavior change): this is the
 * self-contained text-analysis half of the queue module — it decides whether a
 * task message asks a read-only task to perform a mutating operation. It owns
 * no queue state and touches no store; it only reads a message string and the
 * task's read-only classification, which is why it splits cleanly.
 *
 * The queue module re-exports every public symbol declared here, so existing
 * `from './mesh-work-queue.js'` imports keep working unchanged.
 *
 * OSS code (AGPL-3.0). Must not import from packages/ (proprietary).
 */
import { MESH_TASK_MODES, isTaskReadonly, type MeshTaskMode } from './mesh-work-queue.js';

/**
 * GUARDRAIL-TEACHING-ERROR: where a forbidden keyword actually matched, so a
 * rejected caller can see *what* tripped the guard instead of guessing and
 * rewording blind. Line/column are 1-based, counted over the task message.
 *
 * PRIVACY: `match` is the matched keyword span ONLY (capped by
 * {@link MAX_REPORTED_MATCH_LEN}) — never the surrounding instruction text. This
 * result is echoed into error strings that reach logs and the MCP wire, so the
 * task message itself must not ride along.
 */
export interface MeshTaskModeViolationDetail {
    /** Rule label — same vocabulary as {@link MeshTaskModeValidationResult.violations}. */
    label: string;
    /** The matched keyword span, truncated. Never the full instruction. */
    match: string;
    /** 1-based line number within the task message. */
    line: number;
    /** 1-based column within that line. */
    column: number;
}

export interface MeshTaskModeValidationResult {
    valid: boolean;
    taskMode?: MeshTaskMode;
    /**
     * Rule labels, e.g. `['git_mutation']`. Unchanged contract — existing callers
     * (mcp-server mesh-tools-session) surface this array as-is.
     */
    violations: string[];
    /**
     * Per-violation match locations, parallel in order to {@link violations}.
     * Additive: callers that only read `violations` are unaffected.
     */
    violationDetails?: MeshTaskModeViolationDetail[];
    allowedOperations?: string[];
}

/** Cap on the echoed match span — keeps user instruction text out of logs. */
const MAX_REPORTED_MATCH_LEN = 40;

/**
 * Renders violation details as the human-readable tail of a guardrail error:
 * `git_mutation: 'git worktree remove' at line 4 col 1`, joined by `; `.
 * Falls back to bare labels when no detail was captured.
 */
export function formatMeshTaskModeViolations(result: MeshTaskModeValidationResult): string {
    const details = result.violationDetails;
    if (!details?.length) return result.violations.join(', ');
    return details
        .map(d => `${d.label}: '${d.match}' at line ${d.line} col ${d.column}`)
        .join('; ');
}

/** Builds the full guardrail error string used by every rejection site. */
export function buildMeshTaskModeViolationError(result: MeshTaskModeValidationResult): string {
    return `live_debug_readonly_guardrail_violation: forbidden operations (${result.violations.join(', ')}) — ${formatMeshTaskModeViolations(result)}`;
}

/** 1-based line/column of `index` within `text`. */
function locateOffset(text: string, index: number): { line: number; column: number } {
    const before = text.slice(0, index);
    const line = before.split('\n').length;
    const lastNl = before.lastIndexOf('\n');
    return { line, column: index - lastNl };
}

/** Builds a privacy-safe detail record for a match at [start, end). */
function buildViolationDetail(label: string, text: string, start: number, end: number): MeshTaskModeViolationDetail {
    const raw = text.slice(start, end);
    const match = raw.length > MAX_REPORTED_MATCH_LEN
        ? `${raw.slice(0, MAX_REPORTED_MATCH_LEN)}…`
        : raw;
    return { label, match, ...locateOffset(text, start) };
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
 * GUARDRAIL-WRAPPER-GAP: command wrappers that take another command as their
 * argument. `cat l | xargs rm -rf` and `sudo rm -rf build` are real invocations,
 * but the wrapper token sat between the connective/line-start and the keyword, so
 * the command-position checks below never saw the keyword at a command position
 * and the mutation leaked through.
 *
 * Only wrappers that are *exclusively* command-invoking live here. Deliberately
 * EXCLUDED, because they are ordinary English words that appear in read-only
 * prose and would trade a rare miss for frequent false positives:
 *   • `time`     — "time deploy takes 20 minutes"
 *   • `command`  — "the command deploy is described in the runbook"
 *   • `env`      — "env deploy differences are the subject"
 *   • `nice`     — "nice release notes were written"
 *   • `exec`     — "exec patch semantics differ"
 *   • `builtin`  — "builtin edit support is missing"
 *   • `timeout`  — "timeout deploy behaviour is the question"
 * Those seven are still reachable in their genuine command form through the
 * evidence rule in {@link stripCommandWrappers}: a wrapper carrying a flag,
 * a `KEY=value` assignment, a numeric argument, or `-c` is command-shaped and
 * IS stripped (`timeout 30 npm publish`, `env FOO=1 npm publish`). A bare
 * `time deploy …` stays prose. See the FP fixtures in the test suite.
 */
const COMMAND_WRAPPERS = new Set(['xargs', 'sudo', 'doas', 'nohup', 'sh', 'bash', 'zsh']);

/**
 * Wrappers that are ordinary English words, so a BARE occurrence is prose. They
 * count as a wrapper only when the token carries command-shaped evidence — see
 * {@link stripCommandWrappers}.
 */
const EVIDENCE_ONLY_WRAPPERS = new Set(['time', 'command', 'env', 'nice', 'exec', 'builtin', 'timeout']);

/**
 * Consumes any leading command-wrapper tokens (plus their flags / `KEY=value`
 * assignments / numeric args) from `prefix`, returning the remaining prefix as it
 * would look if the wrappers were not there. Used so the command-position checks
 * see `rm -rf` in `xargs rm -rf` as sitting at command position.
 *
 * An {@link EVIDENCE_ONLY_WRAPPERS} word only counts when the wrapper run carries
 * command-shaped evidence (a `-flag`, a `KEY=value`, or a bare number) — that is
 * what separates `timeout 30 npm publish` (a command) from `timeout deploy
 * behaviour is the question` (prose). Returns null when nothing was stripped.
 */
function stripCommandWrappers(prefix: string): string | null {
    // Split at the LAST shell connective (greedy) so `cat l | xargs ` yields
    // head=`cat l | ` and rest=`xargs `; with no connective the whole prefix is
    // the token run and head is just its leading whitespace.
    const m = /^([\s\S]*(?:&&|\|\||\||;)\s*)([\s\S]*)$/.exec(prefix);
    const head = m ? m[1] : (/^\s*/.exec(prefix)?.[0] ?? '');
    let rest = m ? m[2] : prefix.slice(head.length);
    let stripped = false;
    let sawEvidence = false;
    let sawEvidenceOnlyWrapper = false;

    for (;;) {
        const tok = /^([^\s]+)\s+/.exec(rest);
        if (!tok) break;
        const word = tok[1];
        const lower = word.toLowerCase();
        if (COMMAND_WRAPPERS.has(lower)) {
            rest = rest.slice(tok[0].length);
            stripped = true;
            continue;
        }
        if (EVIDENCE_ONLY_WRAPPERS.has(lower)) {
            rest = rest.slice(tok[0].length);
            stripped = true;
            sawEvidenceOnlyWrapper = true;
            continue;
        }
        // Wrapper arguments: flags (-r, --no-run-if-empty), `-c`, KEY=value
        // assignments, and bare numbers (timeout 30). Each is command-shaped
        // evidence; none of them appear between two words in ordinary prose.
        if (stripped && (/^-/.test(word) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || /^\d+$/.test(word))) {
            rest = rest.slice(tok[0].length);
            sawEvidence = true;
            continue;
        }
        break;
    }
    if (!stripped) return null;
    // A run that relied on an ordinary-English wrapper needs corroborating
    // evidence; otherwise treat it as prose and do not strip.
    if (sawEvidenceOnlyWrapper && !sawEvidence) return null;
    return head + rest;
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

    // GUARDRAIL-WRAPPER-GAP: retry the command-position checks with leading
    // command wrappers removed, so `xargs rm -rf` / `sudo rm -rf` / `timeout 30
    // npm publish` are seen at the command position the wrapper displaced them
    // from. Only the two position checks are re-run — the wrapper says nothing
    // about backticks, prompts or run-prefix paths, which are already handled.
    const unwrapped = stripCommandWrappers(linePrefix);
    if (unwrapped !== null) {
        if (/^\s*$/.test(unwrapped)) return true;
        if (/(?:&&|\|\||\||;)\s*$/.test(unwrapped)) return true;
    }

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
    // GUARDRAIL-COMMA-FP: a bare comma before the keyword is NOT command context.
    // It was the only suppression layer keyed on grammar rather than command shape,
    // and it false-positived on ordinary prose in both English ("Read the logs,
    // deploy is the subject") and Korean, where a comma before a verb is entirely
    // normal ("로그를 읽고, deploy 실패 원인을 보고하라"). Miss-risk is low: every
    // real command shape still reaches this function via line-start, a shell
    // connective (&&/||/|/;), backticks/fences, a `$ `/`> ` prompt line, an
    // imperative connective (then/run/first), or a run-prefix path token.
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
 * Runs a global regex over `text` and returns the span of the FIRST real
 * mutation match (command context, not negated), or null when there is none.
 * Only the first match per rule is reported — one concrete example is enough to
 * locate the problem, and reporting every hit would bloat the error string.
 */
function findRealMutation(pattern: RegExp, text: string): { start: number; end: number } | null {
    const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
        const start = match.index;
        const end = match.index + match[0].length;
        if (isRealMutationMatch(text, start, end)) return { start, end };
        if (match.index === re.lastIndex) re.lastIndex++; // avoid zero-width loop
    }
    return null;
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
function detectGitMutation(message: string): { start: number; end: number } | null {
    const re = /\bgit\s+([a-z][a-z0-9-]*)/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(message)) !== null) {
        const sub = match[1].toLowerCase();
        const span = { start: match.index, end: match.index + match[0].length };
        // Only treat a mutating `git <sub>` as a real violation when it appears
        // as an actual command (code/command context) and is not negated. Plain
        // prose mentions ("don't git reset", "we won't push") are ignored.
        const isReal = () => isRealMutationMatch(message, span.start, span.end);
        if (GIT_MUTATION_SUBCOMMANDS.has(sub)) {
            if (isReal()) return span;
            continue;
        }
        if (sub === 'stash') {
            // Token following `git stash`; read-only only for list/show.
            const after = message.slice(re.lastIndex).match(/^\s+([a-z][a-z0-9-]*)/i);
            const next = after ? after[1].toLowerCase() : '';
            if (!GIT_STASH_READONLY_SUBCOMMANDS.has(next) && isReal()) return span; // bare stash = push, or pop/apply/drop/...
        } else if (sub === 'checkout') {
            // `git checkout <ref/path>` mutates; `git checkout-index` is matched
            // as its own token by the regex (sub === 'checkout-index') and is read-only.
            if (isReal()) return span;
        } else if (sub === 'submodule') {
            // `git submodule update` mutates; `git submodule status` is read-only.
            const after = message.slice(re.lastIndex).match(/^\s+([a-z][a-z0-9-]*)/i);
            const next = after ? after[1].toLowerCase() : '';
            if ((next === 'update' || next === 'add' || next === 'sync' || next === 'deinit') && isReal()) {
                // Report the full `git <sub> <next>` span so the message names the
                // actual mutating form rather than the bare `git submodule` prefix.
                return { start: span.start, end: re.lastIndex + after![0].length };
            }
        } else if (sub === 'worktree') {
            const after = message.slice(re.lastIndex).match(/^\s+([a-z][a-z0-9-]*)/i);
            const next = after ? after[1].toLowerCase() : '';
            if ((next === 'add' || next === 'remove' || next === 'move' || next === 'prune') && isReal()) {
                return { start: span.start, end: re.lastIndex + after![0].length };
            }
        }
        // checkout-index, stash-with-no-next-already-handled, status/diff/log/show/
        // rev-parse/branch/submodule status fall through as read-only.
    }
    return null;
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
    // GUARDRAIL-TEACHING-ERROR: collect WHERE each rule matched alongside the label,
    // so the rejection tells the caller what tripped it instead of forcing a blind
    // reword. `violations` keeps its exact prior shape (labels, same order).
    const violationDetails: MeshTaskModeViolationDetail[] = [];
    for (const rule of LIVE_DEBUG_READONLY_FORBIDDEN) {
        const hit = findRealMutation(rule.pattern, text);
        if (hit) violationDetails.push(buildViolationDetail(rule.label, text, hit.start, hit.end));
    }
    const gitHit = detectGitMutation(text);
    if (gitHit) {
        violationDetails.push(buildViolationDetail('git_mutation', text, gitHit.start, gitHit.end));
    }
    const violations = violationDetails.map(d => d.label);
    return {
        valid: violations.length === 0,
        taskMode,
        violations,
        ...(violationDetails.length ? { violationDetails } : {}),
        allowedOperations: [
            'process/log/window/port/session inspection',
            'read-only filesystem listing/reading',
            'status probes and keep-running handle reporting',
            'diagnostic summaries without source edits, commits, checkpoints, pushes, deploys, resets, rebases, or destructive cleanups',
        ],
    };
}
