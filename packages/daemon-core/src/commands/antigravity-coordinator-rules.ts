/**
 * Antigravity CLI (`antigravity-cli` / `agy` 1.4.2) per-turn coordinator rule
 * delivery, >24KB split/include materialization, wrapper sentinel stripping,
 * and session/worker isolation.
 *
 * Why `antigravity-cli` needs special handling for `context_file`:
 *   1. Per-turn rule loading (`DeclarativeConfigLoader`):
 *      Unlike startup-once CLIs, `agy` 1.4.2 loads workspace rules (`AGENTS.md`,
 *      `.agents/rules/*.md`) on EVERY user turn (`buildUserRules` -> `loadRules`),
 *      not at TUI startup. Stripping `AGENTS.md` on startup TUI idle (~5-17 s after
 *      spawn, before the first user turn creates the native conversation) leaves
 *      `user_rules` empty on Turn 1 and every subsequent turn.
 *   2. 24,000-byte per-file truncation cap (`rules.go:528-545`):
 *      `parseRuleFile` calls `resolveFileIncludes(content, workspaceRoot)` FIRST
 *      and `go_utils.Truncate(content, 24000)` (24,000 UTF-8 bytes) SECOND.
 *      Because the coordinator system prompt is ~35.5 KB, putting the whole prompt
 *      in `AGENTS.md` truncates ~11.5 KB of tail instructions even if retained.
 *   3. Base-node delegated worker isolation:
 *      `resolveFileIncludes` (`rules.go:643-693`) expands `@[label](~/...)` against
 *      `os.UserHomeDir()` (`$HOME` / `USERPROFILE`). By writing the prompt chunks to
 *      `<coordHome>/.gemini/config/adhdev-mesh-coordinator/<scope>/part-XX.md` and
 *      referencing them via `@[...](~/.gemini/config/adhdev-mesh-coordinator/<scope>/part-XX.md)`:
 *        - The coordinator (whose `HOME` holds the chunk files) expands every part
 *          within the 24,000-byte per-file budget (`AGENTS.md` for part 1 when space
 *          permits, plus `.agents/rules/adhdev-mesh-coordinator-<scope>-part-XX.md`
 *          with `trigger: always_on` for overflow parts).
 *        - A base-node delegated worker (`launchedByCoordinator: true`) runs in the
 *          same workspace with a worker-private `HOME` (`/tmp/adhdev-worker-home/...`)
 *          where `.gemini/config/adhdev-mesh-coordinator/` does not exist; `resolveFileIncludes`
 *          leaves the 1-line `@[...](~/...)` pointer unexpanded, so the worker sees
 *          only the user's original `AGENTS.md` rules and never inherits the
 *          coordinator role.
 *        - Non-Antigravity CLIs do not expand `@[...](~/...)`, and Antigravity sessions
 *          in other workspaces do not auto-scan `.gemini/config/adhdev-mesh-coordinator/`
 *          (`discoverGlobalPaths` only scans `.gemini/config/rules/`).
 *   4. Markdown `---` horizontal rule safety (`rules.go:676-689`):
 *      `resolveFileIncludes` trims included file content and, if it begins with `---`,
 *      strips up to the next `\n---` as YAML frontmatter. Every chunk file is wrapped
 *      in `<!-- adhdev-mesh-coordinator-prompt (part X/N) -->` HTML comments so an
 *      included chunk never starts with `---` or loses leading/trailing newlines.
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import * as os from 'os';
import { dirname, join, resolve } from 'path';
import { ensureLocalGitExclude } from '../git/git-local-exclude.js';
import { LOG } from '../logging/logger.js';
import type {
    CoordinatorInjectionContext,
    CoordinatorInjectionEffect,
} from './mesh-coordinator.js';

/** The opening / closing marker pair a context_file wrapper writes around the prompt. */
export interface CoordinatorWrapperSentinels {
    /** Text before `{prompt}` (trimmed). Empty when the wrapper has none — then the block cannot be located again. */
    open: string;
    /** Text after `{prompt}` (trimmed). Empty ⇒ the block runs to end of file. */
    close: string;
}

/**
 * The legacy pair every built-in provider wrapper uses. Only a FALLBACK for a
 * strip that has no record of the wrapper it wrote (a registry entry persisted
 * by an older daemon) — a live launch always passes the provider's own pair.
 */
export const LEGACY_COORDINATOR_WRAPPER_SENTINELS: CoordinatorWrapperSentinels = {
    open: '<!-- adhdev-mesh-coordinator-prompt -->',
    close: '<!-- /adhdev-mesh-coordinator-prompt -->',
};

/** Derive the sentinels from a provider-declared wrapper exactly as the writer does. */
export function coordinatorWrapperSentinels(wrapper: string | undefined): CoordinatorWrapperSentinels {
    const w = wrapper && wrapper.includes('{prompt}') ? wrapper : '{prompt}';
    const [before, after] = w.split('{prompt}');
    return { open: (before ?? '').trim(), close: (after ?? '').trim() };
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches one written block (open … close, or open … EOF when there is no close). */
export function wrapperBlockPattern(sentinels: CoordinatorWrapperSentinels): RegExp {
    const open = escapeRegExp(sentinels.open);
    return sentinels.close
        ? new RegExp(`${open}[\\s\\S]*?${escapeRegExp(sentinels.close)}`, 'g')
        : new RegExp(`${open}[\\s\\S]*$`, 'g');
}

/** `text` with every block between the sentinels removed (unchanged when there is no opening sentinel). */
export function removeWrapperBlock(text: string, sentinels: CoordinatorWrapperSentinels): string {
    if (!sentinels.open) return text;
    return text.replace(wrapperBlockPattern(sentinels), '');
}

/** Hard per-file UTF-8 byte cap in Antigravity CLI 1.4.2 (`rules.go:537`). */
export const ANTIGRAVITY_RULE_FILE_MAX_BYTES = 24_000;

/** Safe post-include UTF-8 byte target per workspace rule file (1,000-byte headroom). */
export const ANTIGRAVITY_SAFE_EXPANDED_FILE_BYTES = 23_000;

/** Max UTF-8 bytes per companion chunk file referenced from `.agents/rules/*.md`. */
export const ANTIGRAVITY_COMPANION_CHUNK_MAX_BYTES = 22_000;

/** Minimum free UTF-8 budget in `AGENTS.md` required to place `part-01` inline there. */
export const ANTIGRAVITY_MIN_INLINE_PART_BYTES = 4_000;

/**
 * In-memory index mapping `resolve(contextFilePath)` -> companion files written by
 * the most recent injection in this process, so a 3-arg `stripCoordinatorWrapperFile`
 * call (including in tests with a custom `launchEnv.HOME`) cleans up all companion
 * files even when `additionalOwnedFiles` is not passed explicitly.
 */
const _companionFilesByContextPath = new Map<string, {
    workspace: string;
    homeDir: string;
    scope: string;
    files: string[];
}>();

export function computeAntigravityCoordinatorScope(workspace: string): string {
    return createHash('sha256').update(resolve(workspace)).digest('hex').slice(0, 12);
}

export function resolveAntigravityCoordinatorHome(launchEnv?: Record<string, string>): string {
    const envHome = launchEnv?.HOME?.trim() || launchEnv?.USERPROFILE?.trim();
    return envHome || os.homedir();
}

function wrapChunkFileContent(chunk: string, partNumber: number, totalParts: number): string {
    return (
        `<!-- adhdev-mesh-coordinator-prompt (part ${partNumber}/${totalParts}) -->\n`
        + `${chunk}\n`
        + `<!-- /adhdev-mesh-coordinator-prompt (part ${partNumber}/${totalParts}) -->\n`
    );
}

/**
 * Split `text` into UTF-8 byte-bounded slices where the first slice is at most
 * `firstMaxBytes` (when `firstMaxBytes > 0`) and each subsequent slice is at most
 * `restMaxBytes`. Prefers splitting at `\n` boundaries so markdown structure stays
 * intact, falling back to a valid UTF-8 codepoint boundary for overlong lines.
 */
export function splitPromptByUtf8ByteBudget(
    text: string,
    firstMaxBytes: number,
    restMaxBytes: number = ANTIGRAVITY_COMPANION_CHUNK_MAX_BYTES,
): string[] {
    if (!text) return [];
    const chunks: string[] = [];
    let remaining = text;
    let isFirst = true;

    while (remaining.length > 0) {
        const budget = isFirst && firstMaxBytes > 0 ? firstMaxBytes : restMaxBytes;
        isFirst = false;

        if (Buffer.byteLength(remaining, 'utf-8') <= budget) {
            chunks.push(remaining);
            break;
        }

        const sliceEnd = findUtf8SafeSplitIndex(remaining, budget);
        chunks.push(remaining.slice(0, sliceEnd));
        remaining = remaining.slice(sliceEnd);
    }

    return chunks;
}

function findUtf8SafeSplitIndex(text: string, maxBytes: number): number {
    let lo = 1;
    let hi = text.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (Buffer.byteLength(text.slice(0, mid), 'utf-8') <= maxBytes) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    let charIdx = lo;
    // Never split between a UTF-16 high surrogate and low surrogate.
    if (charIdx > 1 && charIdx < text.length) {
        const prevCode = text.charCodeAt(charIdx - 1);
        if (prevCode >= 0xd800 && prevCode <= 0xdbff) {
            charIdx -= 1;
        }
    }
    // Prefer the last newline at or after 50% of the character window.
    const lastNewline = text.lastIndexOf('\n', charIdx - 1);
    if (lastNewline >= Math.floor(charIdx * 0.5) && lastNewline > 0) {
        return lastNewline + 1;
    }
    return Math.max(1, charIdx);
}

function renderIntoExistingContent(
    existing: string | null,
    renderedWrapperBlock: string,
    sentinels: CoordinatorWrapperSentinels,
): string {
    if (existing === null) return renderedWrapperBlock;
    if (sentinels.open && existing.includes(sentinels.open)) {
        return existing.replace(wrapperBlockPattern(sentinels), () => renderedWrapperBlock);
    }
    return `${existing}\n\n${renderedWrapperBlock}`;
}

function cleanupStaleScopedFiles(workspace: string, homeDir: string, scope: string): void {
    const homeChunkDir = join(homeDir, '.gemini', 'config', 'adhdev-mesh-coordinator', scope);
    try {
        if (existsSync(homeChunkDir)) {
            rmSync(homeChunkDir, { recursive: true, force: true });
        }
    } catch { /* best-effort */ }

    const rulesDir = join(workspace, '.agents', 'rules');
    const prefix = `adhdev-mesh-coordinator-${scope}-part-`;
    try {
        if (existsSync(rulesDir)) {
            for (const entry of readdirSync(rulesDir)) {
                if (entry.startsWith(prefix) && entry.endsWith('.md')) {
                    try { unlinkSync(join(rulesDir, entry)); } catch { /* best-effort */ }
                }
            }
        }
    } catch { /* best-effort */ }
}

function removeDirIfEmpty(dirPath: string): void {
    try {
        if (!existsSync(dirPath)) return;
        if (readdirSync(dirPath).length === 0) {
            rmdirSync(dirPath);
        }
    } catch { /* best-effort */ }
}

/**
 * Write the Antigravity coordinator prompt across `<workspace>/AGENTS.md`,
 * `<coordHome>/.gemini/config/adhdev-mesh-coordinator/<scope>/part-XX.md`, and
 * `<workspace>/.agents/rules/adhdev-mesh-coordinator-<scope>-part-XX.md` so every
 * workspace rule file expands to `<= 24,000` UTF-8 bytes and base-node workers
 * with private `HOME` directories stay isolated from the coordinator prompt.
 */
export function writeAntigravityCoordinatorContextFiles(opts: {
    systemPrompt: string;
    target: string;
    wrapper: string;
    sentinels: CoordinatorWrapperSentinels;
    ownedDeclared: boolean;
    ctx: CoordinatorInjectionContext;
}): CoordinatorInjectionEffect {
    const { systemPrompt, target, wrapper, sentinels, ownedDeclared, ctx } = opts;
    const homeDir = resolveAntigravityCoordinatorHome(ctx.launchEnv);
    const scope = computeAntigravityCoordinatorScope(ctx.workspace);
    const homeChunkDir = join(homeDir, '.gemini', 'config', 'adhdev-mesh-coordinator', scope);
    const workspaceRulesDir = join(ctx.workspace, '.agents', 'rules');
    const managedNote =
        '> _Managed by adhdev mesh coordinator — do not hand-edit this block. '
        + 'Changes inside the sentinels are overwritten on next coordinator launch. '
        + 'Applies only to the active mesh coordinator session (never to delegated workers)._';

    let owned = ownedDeclared;
    try {
        mkdirSync(dirname(target), { recursive: true });
        const existing = existsSync(target) ? readFileSync(target, 'utf-8') : null;
        if (existing !== null && owned && removeWrapperBlock(existing, sentinels).trim()) {
            owned = false;
            LOG.warn(
                'MeshCoordinator',
                `${target} already exists with content the daemon did not write — keeping it and injecting between sentinels instead of taking ownership of the file (${ctx.cliType})`,
            );
        }

        cleanupStaleScopedFiles(ctx.workspace, homeDir, scope);

        // Calculate how many UTF-8 bytes of `AGENTS.md` are consumed by user content,
        // wrapper sentinels, managed note, and the ~120-byte part-01 comment header/footer.
        const shellWithManagedNote = renderIntoExistingContent(
            existing,
            wrapper.replace(/\{prompt\}/g, `${managedNote}\n\n`),
            sentinels,
        );
        const shellBytes = Buffer.byteLength(shellWithManagedNote, 'utf-8');
        const chunkWrapperOverheadBytes = 160;
        const availableInlineBytes = ANTIGRAVITY_SAFE_EXPANDED_FILE_BYTES - shellBytes - chunkWrapperOverheadBytes;
        const inlineFirstPartInAgentsMd = availableInlineBytes >= ANTIGRAVITY_MIN_INLINE_PART_BYTES;

        const chunks = splitPromptByUtf8ByteBudget(
            systemPrompt,
            inlineFirstPartInAgentsMd ? availableInlineBytes : 0,
            ANTIGRAVITY_COMPANION_CHUNK_MAX_BYTES,
        );
        const totalParts = chunks.length;

        mkdirSync(homeChunkDir, { recursive: true, mode: 0o700 });
        const additionalOwnedFiles: string[] = [];
        const includeRefs: string[] = [];

        for (let i = 0; i < totalParts; i++) {
            const partNum = i + 1;
            const padded = String(partNum).padStart(2, '0');
            const chunkPath = join(homeChunkDir, `part-${padded}.md`);
            const wrappedChunk = wrapChunkFileContent(chunks[i]!, partNum, totalParts);
            writeFileSync(chunkPath, wrappedChunk, { encoding: 'utf-8', mode: 0o600 });
            additionalOwnedFiles.push(chunkPath);
            includeRefs.push(
                `@[adhdev-mesh-coordinator-prompt-part-${partNum}](~/.gemini/config/adhdev-mesh-coordinator/${scope}/part-${padded}.md)`,
            );
        }

        // Write `AGENTS.md` (with `part-01` include if budget allows; otherwise just
        // the managed note or minimal sentinel block so large user `AGENTS.md` files
        // are never pushed past the 24,000-byte cap).
        let agentsPromptBody: string;
        if (inlineFirstPartInAgentsMd && includeRefs.length > 0) {
            agentsPromptBody = `${managedNote}\n\n${includeRefs[0]}`;
        } else if (shellBytes <= ANTIGRAVITY_RULE_FILE_MAX_BYTES) {
            agentsPromptBody = managedNote;
        } else {
            agentsPromptBody = '';
        }
        const renderedAgentsBlock = wrapper.replace(/\{prompt\}/g, agentsPromptBody);
        const nextAgentsContent = renderIntoExistingContent(existing, renderedAgentsBlock, sentinels);
        writeFileSync(target, nextAgentsContent, 'utf-8');

        // Any part not included directly in `AGENTS.md` gets its own companion
        // `.agents/rules/adhdev-mesh-coordinator-<scope>-part-XX.md` with `trigger: always_on`.
        const companionStartIndex = inlineFirstPartInAgentsMd ? 1 : 0;
        const hasGitDir = existsSync(join(ctx.workspace, '.git'));
        if (companionStartIndex < totalParts) {
            mkdirSync(workspaceRulesDir, { recursive: true });
            for (let i = companionStartIndex; i < totalParts; i++) {
                const partNum = i + 1;
                const padded = String(partNum).padStart(2, '0');
                const companionPath = join(workspaceRulesDir, `adhdev-mesh-coordinator-${scope}-part-${padded}.md`);
                const companionBody = [
                    '---',
                    'trigger: always_on',
                    '---',
                    sentinels.open || '<!-- adhdev-mesh-coordinator-prompt -->',
                    includeRefs[i]!,
                    sentinels.close || '<!-- /adhdev-mesh-coordinator-prompt -->',
                    '',
                ].join('\n');
                writeFileSync(companionPath, companionBody, 'utf-8');
                additionalOwnedFiles.push(companionPath);
                if (hasGitDir) ensureLocalGitExclude(ctx.workspace, companionPath);
            }
        }
        if (hasGitDir && existing === null) {
            ensureLocalGitExclude(ctx.workspace, target);
        }

        _companionFilesByContextPath.set(resolve(target), {
            workspace: ctx.workspace,
            homeDir,
            scope,
            files: [...additionalOwnedFiles],
        });

        LOG.info(
            'MeshCoordinator',
            `Wrote antigravity-cli coordinator prompt to ${target} (${totalParts} part(s), inlineFirst=${inlineFirstPartInAgentsMd})`,
        );
        return {
            contextFilePath: target,
            contextFileOwned: owned,
            contextFileSentinels: sentinels,
            additionalOwnedFiles,
            retainContextFileForSessionLifetime: true,
        };
    } catch (error: any) {
        LOG.warn('MeshCoordinator', `Could not write ${target}: ${error?.message || error}`);
        return {};
    }
}

/**
 * Remove any Antigravity companion rule files and home chunk files associated with
 * `contextFilePath`, plus empty directories they lived in. Best-effort and idempotent.
 */
export function cleanupAntigravityCompanionFiles(
    contextFilePath: string,
    explicitAdditionalFiles?: readonly string[],
): void {
    const resolvedTarget = resolve(contextFilePath);
    const tracked = _companionFilesByContextPath.get(resolvedTarget);
    _companionFilesByContextPath.delete(resolvedTarget);

    const filesToDelete = new Set<string>(explicitAdditionalFiles ?? []);
    if (tracked) {
        for (const f of tracked.files) filesToDelete.add(f);
    }

    for (const filePath of filesToDelete) {
        try {
            if (existsSync(filePath)) unlinkSync(filePath);
        } catch { /* best-effort */ }
    }

    const workspace = tracked?.workspace ?? dirname(resolvedTarget);
    const scope = tracked?.scope ?? computeAntigravityCoordinatorScope(workspace);
    const candidateHomes = new Set<string>([os.homedir()]);
    if (tracked?.homeDir) candidateHomes.add(tracked.homeDir);
    for (const f of filesToDelete) {
        const marker = `${join('.gemini', 'config', 'adhdev-mesh-coordinator')}`;
        const idx = f.indexOf(marker);
        if (idx > 0) candidateHomes.add(f.slice(0, idx - 1));
    }

    for (const homeDir of candidateHomes) {
        cleanupStaleScopedFiles(workspace, homeDir, scope);
        const baseCoordConfigDir = join(homeDir, '.gemini', 'config', 'adhdev-mesh-coordinator');
        removeDirIfEmpty(join(baseCoordConfigDir, scope));
        removeDirIfEmpty(baseCoordConfigDir);
    }

    const rulesDir = join(workspace, '.agents', 'rules');
    removeDirIfEmpty(rulesDir);
    removeDirIfEmpty(join(workspace, '.agents'));
}

/**
 * Strip the daemon's wrapper block from a context_file we previously wrote,
 * along with any companion rule/include files.
 */
export function stripCoordinatorWrapperFile(
    filePath: string,
    owned = false,
    sentinels: CoordinatorWrapperSentinels = LEGACY_COORDINATOR_WRAPPER_SENTINELS,
    additionalOwnedFiles?: readonly string[],
): void {
    try {
        cleanupAntigravityCompanionFiles(filePath, additionalOwnedFiles);
        if (!existsSync(filePath)) return;
        if (owned) {
            try { unlinkSync(filePath); } catch { /* best-effort */ }
            return;
        }
        if (!sentinels.open) return;
        const existing = readFileSync(filePath, 'utf-8');
        if (!existing.includes(sentinels.open)) return;
        const stripped = removeWrapperBlock(existing, sentinels);
        if (stripped === existing) return;
        const remaining = stripped
            .replace(/^\s*\n+/, '')
            .replace(/\n+\s*$/, '');
        if (!remaining.trim()) {
            try { unlinkSync(filePath); } catch { /* best-effort */ }
        } else {
            writeFileSync(filePath, remaining + '\n', 'utf-8');
        }
    } catch { /* best-effort */ }
}
