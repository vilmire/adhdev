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
 *          permits after expanding any existing user `@[label](path)` includes, plus
 *          `.agents/rules/adhdev-mesh-coordinator-<scope>-part-XX.md` with
 *          `trigger: always_on` for overflow parts).
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
import { dirname, isAbsolute, join, resolve } from 'path';
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

export interface RecordedWrapperSeparators {
    leading: string;
    trailing: string;
    createdFile: boolean;
}

/**
 * Remove the sentinel wrapper block while preserving surrounding user content
 * byte-for-byte (including files without a trailing newline, files with leading
 * or trailing blank lines, CRLF line endings, and concurrent user edits before
 * or after the sentinel block).
 */
export function stripSentinelBlockPreservingSurroundingBytes(
    text: string,
    sentinels: CoordinatorWrapperSentinels,
    recordedSeparators?: RecordedWrapperSeparators,
): string {
    if (!sentinels.open) return text;
    const pattern = wrapperBlockPattern(sentinels);
    const match = pattern.exec(text);
    if (!match || match.index === undefined) return text;
    let before = text.slice(0, match.index);
    let after = text.slice(match.index + match[0].length);

    if (recordedSeparators) {
        const { leading, trailing } = recordedSeparators;
        if (leading && before.endsWith(leading)) {
            before = before.slice(0, -leading.length);
        }
        if (trailing && after.startsWith(trailing)) {
            after = after.slice(trailing.length);
        }
        return before + after;
    }

    // Legacy fallback when no separator provenance was recorded:
    // Only strip the standard `\n\n` separator that the daemon appends before the
    // wrapper block when appending to the end of an existing file (`after === ''`).
    // Never delete uncertain user bytes when content exists after the block or
    // when `before` does not end with `\n\n`.
    if (before.length > 0 && after.length === 0 && before.endsWith('\n\n')) {
        return before.slice(0, -2);
    }
    return before + after;
}

/** Hard per-file UTF-8 byte cap in Antigravity CLI 1.4.2 (`rules.go:537`). */
export const ANTIGRAVITY_RULE_FILE_MAX_BYTES = 24_000;

/** Safe post-include UTF-8 byte target per workspace rule file (1,000-byte headroom). */
export const ANTIGRAVITY_SAFE_EXPANDED_FILE_BYTES = 23_000;

/** Max UTF-8 bytes per companion chunk file referenced from `.agents/rules/*.md`. */
export const ANTIGRAVITY_COMPANION_CHUNK_MAX_BYTES = 22_000;

/** Minimum free UTF-8 budget in `AGENTS.md` required to place `part-01` inline there. */
export const ANTIGRAVITY_MIN_INLINE_PART_BYTES = 4_000;

interface TrackedCompanionState {
    workspace: string;
    homeDir: string;
    scope: string;
    files: string[];
}

export interface AntigravityInjectionOwnershipRecord {
    generation: number;
    targetPath: string;
    workspace: string;
    homeDir: string;
    scope: string;
    systemPrompt: string;
    wrapper: string;
    sentinels: CoordinatorWrapperSentinels;
    renderedWrapperBlock: string;
    writtenFiles: string[];
    chunkContents: Map<string, string>;
    status: 'provisional' | 'registered' | 'failed' | 'terminated';
    sessionId?: string;
}

interface TargetContextFileState {
    records: AntigravityInjectionOwnershipRecord[];
    wrapperSeparators?: RecordedWrapperSeparators;
    deferredDepartingFiles?: Set<string>;
}

interface SynchronousWriteRollbackSnapshot {
    targetPath: string;
    workspace: string;
    homeDir: string;
    scope: string;
    targetContentBefore: string | null;
    previousScopedFiles: Map<string, string>;
    writtenFiles: string[];
}

let _nextGeneration = 0;

/**
 * In-memory index mapping `resolve(contextFilePath)` -> companion files written by
 * the most recent active injection in this process, so a 3-arg `stripCoordinatorWrapperFile`
 * call cleans up all companion files even when `additionalOwnedFiles` is not passed.
 */
const _companionFilesByContextPath = new Map<string, TrackedCompanionState>();

/** Per-target-file ownership records and wrapper separator metadata. */
const _stateByTarget = new Map<string, TargetContextFileState>();

/** Ownership record keyed by returned `CoordinatorInjectionEffect` object. */
const _recordByEffect = new WeakMap<object, AntigravityInjectionOwnershipRecord>();

function getOrCreateTargetState(resolvedTarget: string): TargetContextFileState {
    let state = _stateByTarget.get(resolvedTarget);
    if (!state) {
        state = { records: [] };
        _stateByTarget.set(resolvedTarget, state);
    }
    return state;
}

export function recordContextFileWrapperSeparators(
    targetPath: string,
    leading: string,
    trailing: string,
    createdFile: boolean,
): void {
    const state = getOrCreateTargetState(resolve(targetPath));
    state.wrapperSeparators = { leading, trailing, createdFile };
}

export function getRecordedWrapperSeparators(
    targetPath: string,
): RecordedWrapperSeparators | undefined {
    const state = _stateByTarget.get(resolve(targetPath));
    return state?.wrapperSeparators ? { ...state.wrapperSeparators } : undefined;
}

export function computeAntigravityCoordinatorScope(workspace: string, systemPrompt?: string): string {
    const hash = createHash('sha256').update(resolve(workspace));
    if (systemPrompt) {
        hash.update('\0').update(systemPrompt);
    }
    return hash.digest('hex').slice(0, 12);
}

export function resolveAntigravityCoordinatorHome(launchEnv?: Record<string, string>): string {
    const envHome = launchEnv?.HOME?.trim() || launchEnv?.USERPROFILE?.trim();
    return envHome || os.homedir();
}

/**
 * Derive the coordinator's `HOME` directory from recorded companion chunk paths
 * (`<coordHome>/.gemini/config/adhdev-mesh-coordinator/<scope>/part-XX.md`).
 * Used when daemon restore (`restoreHostedSessions`) re-materializes rules without
 * a live `launchEnv` object.
 */
export function extractAntigravityCoordinatorHomeFromPaths(
    paths: readonly string[] | undefined,
): string | undefined {
    if (!paths?.length) return undefined;
    const marker = join('.gemini', 'config', 'adhdev-mesh-coordinator');
    for (const filePath of paths) {
        const idx = filePath.indexOf(marker);
        if (idx > 0) {
            return filePath.slice(0, idx - 1);
        }
    }
    return undefined;
}

function wrapChunkFileContent(chunk: string, partNumber: number, totalParts: number): string {
    return (
        `<!-- adhdev-mesh-coordinator-prompt (part ${partNumber}/${totalParts}) -->\n`
        + `${chunk}\n`
        + `<!-- /adhdev-mesh-coordinator-prompt (part ${partNumber}/${totalParts}) -->\n`
    );
}

/**
 * Measure the UTF-8 byte length of `shellContent` AFTER Antigravity's
 * `resolveFileIncludes` (`rules.go:643-693`) expands any existing user
 * `@[label](path)` references in `AGENTS.md`.
 *
 * If any user include target does not exist or cannot be read at injection time,
 * `hasUnresolvedInclude` is set to `true` so all coordinator parts are routed to
 * separate `.agents/rules/` files and can never push `AGENTS.md` over 24,000 bytes.
 */
function measureExpandedAntigravityShellBytes(
    shellContent: string,
    workspaceRoot: string,
    homeDir: string,
): { expandedBytes: number; hasUnresolvedInclude: boolean } {
    let hasUnresolvedInclude = false;
    const expanded = shellContent.replace(
        /@\[([^\]]*)\]\(([^)]+)\)/g,
        (fullMatch, _label: string, rawTarget: string) => {
            const trimmedTarget = rawTarget.trim();
            if (!trimmedTarget) return fullMatch;
            const resolvedTarget =
                trimmedTarget.startsWith('~/') || trimmedTarget.startsWith('~\\')
                    ? join(homeDir, trimmedTarget.slice(2))
                    : isAbsolute(trimmedTarget)
                      ? trimmedTarget
                      : join(workspaceRoot, trimmedTarget);
            try {
                if (!existsSync(resolvedTarget)) {
                    hasUnresolvedInclude = true;
                    return fullMatch;
                }
                const included = readFileSync(resolvedTarget, 'utf-8');
                return Buffer.byteLength(included, 'utf-8') >= Buffer.byteLength(fullMatch, 'utf-8')
                    ? included
                    : fullMatch;
            } catch {
                hasUnresolvedInclude = true;
                return fullMatch;
            }
        },
    );
    return {
        expandedBytes: Buffer.byteLength(expanded, 'utf-8'),
        hasUnresolvedInclude,
    };
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

function snapshotExistingScopedFiles(workspace: string, homeDir: string, scope: string): Map<string, string> {
    const snap = new Map<string, string>();
    const homeChunkDir = join(homeDir, '.gemini', 'config', 'adhdev-mesh-coordinator', scope);
    try {
        if (existsSync(homeChunkDir)) {
            for (const entry of readdirSync(homeChunkDir)) {
                const full = join(homeChunkDir, entry);
                try { snap.set(full, readFileSync(full, 'utf-8')); } catch { /* ignore */ }
            }
        }
    } catch { /* ignore */ }

    const rulesDir = join(workspace, '.agents', 'rules');
    const prefix = `adhdev-mesh-coordinator-${scope}-part-`;
    try {
        if (existsSync(rulesDir)) {
            for (const entry of readdirSync(rulesDir)) {
                if (entry.startsWith(prefix) && entry.endsWith('.md')) {
                    const full = join(rulesDir, entry);
                    try { snap.set(full, readFileSync(full, 'utf-8')); } catch { /* ignore */ }
                }
            }
        }
    } catch { /* ignore */ }
    return snap;
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

function restoreSynchronousWriteFailure(snapshot: SynchronousWriteRollbackSnapshot): void {
    for (const written of snapshot.writtenFiles) {
        if (!snapshot.previousScopedFiles.has(written)) {
            try {
                if (existsSync(written)) unlinkSync(written);
            } catch { /* best-effort */ }
        }
    }
    for (const [filePath, prevContent] of snapshot.previousScopedFiles.entries()) {
        try {
            mkdirSync(dirname(filePath), { recursive: true });
            writeFileSync(filePath, prevContent, 'utf-8');
        } catch { /* best-effort */ }
    }
    try {
        if (snapshot.targetContentBefore !== null) {
            mkdirSync(dirname(snapshot.targetPath), { recursive: true });
            writeFileSync(snapshot.targetPath, snapshot.targetContentBefore, 'utf-8');
        } else if (existsSync(snapshot.targetPath)) {
            unlinkSync(snapshot.targetPath);
        }
    } catch { /* best-effort */ }

    const baseCoordConfigDir = join(snapshot.homeDir, '.gemini', 'config', 'adhdev-mesh-coordinator');
    removeDirIfEmpty(join(baseCoordConfigDir, snapshot.scope));
    removeDirIfEmpty(baseCoordConfigDir);
    const rulesDir = join(snapshot.workspace, '.agents', 'rules');
    removeDirIfEmpty(rulesDir);
    removeDirIfEmpty(join(snapshot.workspace, '.agents'));
}

function getActiveRecordsForTarget(resolvedTarget: string): AntigravityInjectionOwnershipRecord[] {
    const state = _stateByTarget.get(resolvedTarget);
    if (!state) return [];
    return state.records.filter((r) => r.status === 'provisional' || r.status === 'registered');
}

function collectActiveRecordFiles(resolvedTarget: string): Set<string> {
    const protectedFiles = new Set<string>();
    for (const record of getActiveRecordsForTarget(resolvedTarget)) {
        for (const f of record.writtenFiles) {
            protectedFiles.add(f);
        }
    }
    return protectedFiles;
}

/**
 * Restore an active ownership record's chunk files and replace only the sentinel
 * wrapper block in `AGENTS.md` in-place, preserving any concurrent user edits
 * outside the sentinels.
 *
 * Returns `true` when all chunk files and `record.targetPath` were updated on
 * disk, or `false` if any write failed.
 */
function restoreActiveOwnershipRecordInPlace(record: AntigravityInjectionOwnershipRecord): boolean {
    for (const [filePath, content] of record.chunkContents.entries()) {
        try {
            mkdirSync(dirname(filePath), { recursive: true });
            writeFileSync(filePath, content, 'utf-8');
        } catch (error: any) {
            LOG.warn('MeshCoordinator', `Could not restore companion file ${filePath}: ${error?.message || error}`);
            return false;
        }
    }

    const resolvedTarget = resolve(record.targetPath);
    const state = getOrCreateTargetState(resolvedTarget);
    try {
        mkdirSync(dirname(record.targetPath), { recursive: true });
        if (existsSync(record.targetPath)) {
            const current = readFileSync(record.targetPath, 'utf-8');
            if (record.sentinels.open && current.includes(record.sentinels.open)) {
                const updated = current.replace(
                    wrapperBlockPattern(record.sentinels),
                    () => record.renderedWrapperBlock,
                );
                if (updated !== current) {
                    writeFileSync(record.targetPath, updated, 'utf-8');
                }
            } else {
                writeFileSync(record.targetPath, `${current}\n\n${record.renderedWrapperBlock}`, 'utf-8');
                state.wrapperSeparators = { leading: '\n\n', trailing: '', createdFile: false };
            }
        } else {
            writeFileSync(record.targetPath, record.renderedWrapperBlock, 'utf-8');
            state.wrapperSeparators = { leading: '', trailing: '', createdFile: true };
        }
    } catch (error: any) {
        LOG.warn('MeshCoordinator', `Could not repoint ${record.targetPath}: ${error?.message || error}`);
        return false;
    }

    _companionFilesByContextPath.set(resolvedTarget, {
        workspace: record.workspace,
        homeDir: record.homeDir,
        scope: record.scope,
        files: [...record.writtenFiles],
    });
    return true;
}

function deleteUnsharedRecordFiles(
    record: AntigravityInjectionOwnershipRecord,
    protectedFiles: ReadonlySet<string>,
): void {
    for (const filePath of record.writtenFiles) {
        if (protectedFiles.has(filePath)) continue;
        try {
            if (existsSync(filePath)) unlinkSync(filePath);
        } catch { /* best-effort */ }
    }
    const baseCoordConfigDir = join(record.homeDir, '.gemini', 'config', 'adhdev-mesh-coordinator');
    removeDirIfEmpty(join(baseCoordConfigDir, record.scope));
    removeDirIfEmpty(baseCoordConfigDir);
    const rulesDir = join(record.workspace, '.agents', 'rules');
    removeDirIfEmpty(rulesDir);
    removeDirIfEmpty(join(record.workspace, '.agents'));
}

export function hasActiveAntigravityOwnershipRecord(targetPath: string): boolean {
    return getActiveRecordsForTarget(resolve(targetPath)).length > 0;
}

export function markAntigravityCoordinatorRegistered(opts: {
    sessionId: string;
    workspace: string;
    systemPrompt?: string;
    targetPath?: string;
    additionalOwnedFiles?: readonly string[];
}): void {
    if (!opts.targetPath) return;
    const resolvedTarget = resolve(opts.targetPath);
    const state = _stateByTarget.get(resolvedTarget);
    if (!state) return;

    const expectedScope = opts.systemPrompt
        ? computeAntigravityCoordinatorScope(opts.workspace, opts.systemPrompt)
        : undefined;

    for (let i = state.records.length - 1; i >= 0; i--) {
        const rec = state.records[i]!;
        if (rec.status === 'failed' || rec.status === 'terminated') continue;
        if (rec.sessionId && rec.sessionId !== opts.sessionId) continue;
        if (expectedScope && rec.scope === expectedScope) {
            rec.status = 'registered';
            rec.sessionId = opts.sessionId;
            return;
        }
        if (
            opts.additionalOwnedFiles?.length
            && opts.additionalOwnedFiles.every((f) => rec.writtenFiles.includes(f))
        ) {
            rec.status = 'registered';
            rec.sessionId = opts.sessionId;
            return;
        }
    }
}

export interface SurvivingCoordinatorDescriptor {
    sessionId: string;
    workspace: string;
    cliType?: string;
    systemPrompt?: string;
    targetPath: string;
    openSentinel?: string;
    closeSentinel?: string;
    owned?: boolean;
    additionalOwnedFiles?: readonly string[];
    homeDir?: string;
    separators?: RecordedWrapperSeparators;
}

function extractScopeFromOwnedPaths(paths: readonly string[] | undefined): string | undefined {
    if (!paths?.length) return undefined;
    const marker = join('.gemini', 'config', 'adhdev-mesh-coordinator');
    for (const f of paths) {
        const idx = f.indexOf(marker);
        if (idx >= 0) {
            const after = f.slice(idx + marker.length + 1);
            const seg = after.split(/[\\/]/)[0];
            if (seg) return seg;
        }
    }
    return undefined;
}

/**
 * Repoint the shared `AGENTS.md` wrapper to the newest surviving owner (registered
 * or provisional) BEFORE deleting a departing coordinator's companion chunk files.
 *
 * Returns:
 *   - `'repointed'`: a surviving owner remains active, `AGENTS.md` was verified to
 *     point to the survivor, and unshared departing files were deleted.
 *   - `'repoint_failed'`: a surviving owner remains active, but rewriting `AGENTS.md`
 *     failed (e.g. read-only file); departing files are retained on disk and recorded
 *     in `state.deferredDepartingFiles` for idempotent retry.
 *   - `false`: no surviving owner remains active; caller should strip the wrapper.
 */
export function repointAntigravityContextFileOnCoordinatorExit(
    departing: SurvivingCoordinatorDescriptor,
    survivingRegistered: readonly SurvivingCoordinatorDescriptor[],
): 'repointed' | 'repoint_failed' | false {
    const resolvedTarget = resolve(departing.targetPath);
    const state = getOrCreateTargetState(resolvedTarget);
    const departingScope =
        departing.systemPrompt && departing.workspace
            ? computeAntigravityCoordinatorScope(departing.workspace, departing.systemPrompt)
            : extractScopeFromOwnedPaths(departing.additionalOwnedFiles);

    const departingFiles = new Set<string>(departing.additionalOwnedFiles ?? []);

    const survivingIds = new Set(survivingRegistered.map((s) => s.sessionId));
    let marked = false;
    for (let i = state.records.length - 1; i >= 0; i--) {
        const rec = state.records[i]!;
        if (rec.status === 'failed' || rec.status === 'terminated') continue;
        if (rec.sessionId === departing.sessionId) {
            rec.status = 'terminated';
            for (const f of rec.writtenFiles) departingFiles.add(f);
            marked = true;
        } else if (rec.status === 'registered' && rec.sessionId && !survivingIds.has(rec.sessionId)) {
            rec.status = 'terminated';
            for (const f of rec.writtenFiles) departingFiles.add(f);
        }
    }
    if (!marked && departingScope) {
        for (let i = state.records.length - 1; i >= 0; i--) {
            const rec = state.records[i]!;
            if (rec.status === 'failed' || rec.status === 'terminated') continue;
            if (!rec.sessionId && rec.scope === departingScope) {
                rec.status = 'terminated';
                for (const f of rec.writtenFiles) departingFiles.add(f);
                break;
            }
        }
    }

    const activeRecords = getActiveRecordsForTarget(resolvedTarget);
    const hasSurvivingOwner = activeRecords.length > 0 || survivingRegistered.length > 0;
    if (!hasSurvivingOwner) {
        return false;
    }

    // 1. Repoint/materialize the newest surviving owner BEFORE deleting departing files.
    const newestRecord = activeRecords[activeRecords.length - 1];
    const newestRegistered = survivingRegistered[survivingRegistered.length - 1];
    const survivorScope =
        newestRecord?.scope
        ?? (newestRegistered?.systemPrompt && newestRegistered.workspace
            ? computeAntigravityCoordinatorScope(newestRegistered.workspace, newestRegistered.systemPrompt)
            : extractScopeFromOwnedPaths(newestRegistered?.additionalOwnedFiles));

    let repointWriteSucceeded = false;
    if (newestRecord) {
        repointWriteSucceeded = restoreActiveOwnershipRecordInPlace(newestRecord);
    } else if (newestRegistered?.systemPrompt && newestRegistered.workspace) {
        if (newestRegistered.separators && !state.wrapperSeparators) {
            state.wrapperSeparators = { ...newestRegistered.separators };
        }
        const open = newestRegistered.openSentinel || LEGACY_COORDINATOR_WRAPPER_SENTINELS.open;
        const close = newestRegistered.closeSentinel || LEGACY_COORDINATOR_WRAPPER_SENTINELS.close;
        const wrapper = `${open}\n{prompt}\n${close}`;
        const effectiveHome =
            newestRegistered.homeDir?.trim()
            || extractAntigravityCoordinatorHomeFromPaths(newestRegistered.additionalOwnedFiles);
        const effect = writeAntigravityCoordinatorContextFiles({
            systemPrompt: newestRegistered.systemPrompt,
            target: newestRegistered.targetPath,
            wrapper,
            sentinels: { open, close },
            ownedDeclared: newestRegistered.owned === true,
            ctx: {
                cliArgs: [],
                launchEnv: effectiveHome ? { HOME: effectiveHome } : {},
                workspace: newestRegistered.workspace,
                cliType: newestRegistered.cliType || 'antigravity-cli',
            },
        });
        repointWriteSucceeded = Boolean(effect.contextFilePath && !effect.error);
        if (repointWriteSucceeded) {
            markAntigravityCoordinatorRegistered({
                sessionId: newestRegistered.sessionId,
                workspace: newestRegistered.workspace,
                systemPrompt: newestRegistered.systemPrompt,
                targetPath: newestRegistered.targetPath,
            });
        }
    } else {
        repointWriteSucceeded = existsSync(departing.targetPath);
    }

    let stillReferencesDepartingScope = false;
    if (departingScope && departingScope !== survivorScope) {
        try {
            if (existsSync(departing.targetPath)) {
                const currentOnDisk = readFileSync(departing.targetPath, 'utf-8');
                stillReferencesDepartingScope = currentOnDisk.includes(departingScope);
            }
        } catch {
            stillReferencesDepartingScope = true;
        }
    }

    if (!repointWriteSucceeded || stillReferencesDepartingScope) {
        if (!state.deferredDepartingFiles) {
            state.deferredDepartingFiles = new Set<string>();
        }
        for (const f of departingFiles) {
            state.deferredDepartingFiles.add(f);
        }
        LOG.warn(
            'MeshCoordinator',
            `Could not repoint ${departing.targetPath} to surviving coordinator; retaining departing companion files until repoint succeeds (${departing.sessionId})`,
        );
        return 'repoint_failed';
    }

    // 2. Delete only the departing coordinator's unshared companion files (plus any
    // previously deferred departing files now that AGENTS.md has been repointed).
    const protectedFiles = collectActiveRecordFiles(resolvedTarget);
    for (const survivor of survivingRegistered) {
        for (const f of survivor.additionalOwnedFiles ?? []) {
            protectedFiles.add(f);
        }
    }
    const filesToClean = new Set<string>(departingFiles);
    if (state.deferredDepartingFiles) {
        for (const f of state.deferredDepartingFiles) {
            filesToClean.add(f);
        }
    }
    if (filesToClean.size > 0) {
        cleanupAntigravityCompanionFiles(departing.targetPath, [...filesToClean], protectedFiles);
    }
    if (state.deferredDepartingFiles) {
        for (const f of filesToClean) {
            if (!protectedFiles.has(f) && !existsSync(f)) {
                state.deferredDepartingFiles.delete(f);
            }
        }
    }
    return 'repointed';
}

/**
 * Write the Antigravity coordinator prompt across `<workspace>/AGENTS.md`,
 * `<coordHome>/.gemini/config/adhdev-mesh-coordinator/<scope>/part-XX.md`, and
 * `<workspace>/.agents/rules/adhdev-mesh-coordinator-<scope>-part-XX.md` so every
 * workspace rule file expands to `<= 24,000` UTF-8 bytes and base-node workers
 * with private `HOME` directories stay isolated from the coordinator prompt.
 *
 * Transactional: if any directory creation or file write fails, all partial
 * changes are rolled back and a fail-closed `{ error, errorCode }` effect is
 * returned.
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
    const resolvedTarget = resolve(target);
    const homeDir = resolveAntigravityCoordinatorHome(ctx.launchEnv);
    const scope = computeAntigravityCoordinatorScope(ctx.workspace, systemPrompt);
    const homeChunkDir = join(homeDir, '.gemini', 'config', 'adhdev-mesh-coordinator', scope);
    const workspaceRulesDir = join(ctx.workspace, '.agents', 'rules');
    const managedNote =
        '> _Managed by adhdev mesh coordinator — do not hand-edit this block. '
        + 'Changes inside the sentinels are overwritten on next coordinator launch. '
        + 'Applies only to the active mesh coordinator session (never to delegated workers)._';

    const targetExistedBefore = existsSync(target);
    let targetContentBefore: string | null = null;
    try {
        if (targetExistedBefore) {
            targetContentBefore = readFileSync(target, 'utf-8');
        }
    } catch (error: any) {
        const message = `Could not read ${target}: ${error?.message || error}`;
        LOG.warn('MeshCoordinator', message);
        return { error: message, errorCode: 'mesh_coordinator_context_file_write_failed' };
    }

    const hadCoordinatorBlockBefore = Boolean(
        targetContentBefore !== null && sentinels.open && targetContentBefore.includes(sentinels.open),
    );
    const previousScopedFiles = snapshotExistingScopedFiles(ctx.workspace, homeDir, scope);
    const writtenFiles: string[] = [];
    const chunkContents = new Map<string, string>();

    const syncRollbackSnapshot: SynchronousWriteRollbackSnapshot = {
        targetPath: target,
        workspace: ctx.workspace,
        homeDir,
        scope,
        targetContentBefore,
        previousScopedFiles,
        writtenFiles,
    };

    let owned = ownedDeclared;
    try {
        mkdirSync(dirname(target), { recursive: true });
        if (targetContentBefore !== null && owned && removeWrapperBlock(targetContentBefore, sentinels).trim()) {
            owned = false;
            LOG.warn(
                'MeshCoordinator',
                `${target} already exists with content the daemon did not write — keeping it and injecting between sentinels instead of taking ownership of the file (${ctx.cliType})`,
            );
        }

        // Calculate how many UTF-8 bytes of `AGENTS.md` are consumed by user content
        // (including any user `@[label](path)` includes after AGY expands them!),
        // wrapper sentinels, managed note, and the ~160-byte part-01 comment header/footer.
        const shellWithManagedNote = renderIntoExistingContent(
            targetContentBefore,
            wrapper.replace(/\{prompt\}/g, `${managedNote}\n\n`),
            sentinels,
        );
        const { expandedBytes: shellBytes, hasUnresolvedInclude } = measureExpandedAntigravityShellBytes(
            shellWithManagedNote,
            ctx.workspace,
            homeDir,
        );
        const chunkWrapperOverheadBytes = 160;
        const availableInlineBytes = hasUnresolvedInclude
            ? 0
            : ANTIGRAVITY_SAFE_EXPANDED_FILE_BYTES - shellBytes - chunkWrapperOverheadBytes;
        const inlineFirstPartInAgentsMd = availableInlineBytes >= ANTIGRAVITY_MIN_INLINE_PART_BYTES;

        const chunks = splitPromptByUtf8ByteBudget(
            systemPrompt,
            inlineFirstPartInAgentsMd ? availableInlineBytes : 0,
            ANTIGRAVITY_COMPANION_CHUNK_MAX_BYTES,
        );
        const totalParts = chunks.length;
        const companionStartIndex = inlineFirstPartInAgentsMd ? 1 : 0;

        // Validate/create target directories BEFORE mutating files on disk so a blocked
        // `.agents/rules` directory fails before touching `AGENTS.md`.
        mkdirSync(homeChunkDir, { recursive: true, mode: 0o700 });
        if (companionStartIndex < totalParts) {
            mkdirSync(workspaceRulesDir, { recursive: true });
        }

        cleanupStaleScopedFiles(ctx.workspace, homeDir, scope);
        mkdirSync(homeChunkDir, { recursive: true, mode: 0o700 });

        const additionalOwnedFiles: string[] = [];
        const includeRefs: string[] = [];

        for (let i = 0; i < totalParts; i++) {
            const partNum = i + 1;
            const padded = String(partNum).padStart(2, '0');
            const chunkPath = join(homeChunkDir, `part-${padded}.md`);
            const wrappedChunk = wrapChunkFileContent(chunks[i]!, partNum, totalParts);
            writeFileSync(chunkPath, wrappedChunk, { encoding: 'utf-8', mode: 0o600 });
            writtenFiles.push(chunkPath);
            additionalOwnedFiles.push(chunkPath);
            chunkContents.set(chunkPath, wrappedChunk);
            includeRefs.push(
                `@[adhdev-mesh-coordinator-prompt-part-${partNum}](~/.gemini/config/adhdev-mesh-coordinator/${scope}/part-${padded}.md)`,
            );
        }

        let agentsPromptBody: string;
        if (inlineFirstPartInAgentsMd && includeRefs.length > 0) {
            agentsPromptBody = `${managedNote}\n\n${includeRefs[0]}`;
        } else if (!hasUnresolvedInclude && shellBytes <= ANTIGRAVITY_RULE_FILE_MAX_BYTES) {
            agentsPromptBody = managedNote;
        } else {
            agentsPromptBody = '';
        }
        const renderedAgentsBlock = wrapper.replace(/\{prompt\}/g, agentsPromptBody);
        const nextAgentsContent = renderIntoExistingContent(targetContentBefore, renderedAgentsBlock, sentinels);
        writeFileSync(target, nextAgentsContent, 'utf-8');

        const hasGitDir = existsSync(join(ctx.workspace, '.git'));
        if (companionStartIndex < totalParts) {
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
                writtenFiles.push(companionPath);
                additionalOwnedFiles.push(companionPath);
                chunkContents.set(companionPath, companionBody);
                if (hasGitDir) ensureLocalGitExclude(ctx.workspace, companionPath);
            }
        }
        if (hasGitDir && targetContentBefore === null) {
            ensureLocalGitExclude(ctx.workspace, target);
        }

        const state = getOrCreateTargetState(resolvedTarget);
        if (!hadCoordinatorBlockBefore) {
            state.wrapperSeparators = {
                leading: targetContentBefore === null ? '' : '\n\n',
                trailing: '',
                createdFile: targetContentBefore === null,
            };
        } else if (!state.wrapperSeparators && targetContentBefore !== null) {
            const matchBefore = wrapperBlockPattern(sentinels).exec(targetContentBefore);
            const prefixBefore = matchBefore && matchBefore.index !== undefined
                ? targetContentBefore.slice(0, matchBefore.index)
                : '';
            state.wrapperSeparators = {
                leading: prefixBefore === '' ? '' : prefixBefore.endsWith('\n\n') ? '\n\n' : '',
                trailing: '',
                createdFile: prefixBefore === '' && matchBefore?.[0].length === targetContentBefore.length,
            };
        }

        const record: AntigravityInjectionOwnershipRecord = {
            generation: ++_nextGeneration,
            targetPath: target,
            workspace: ctx.workspace,
            homeDir,
            scope,
            systemPrompt,
            wrapper,
            sentinels,
            renderedWrapperBlock: renderedAgentsBlock,
            writtenFiles: [...additionalOwnedFiles],
            chunkContents,
            status: 'provisional',
        };
        state.records.push(record);

        if (state.deferredDepartingFiles && state.deferredDepartingFiles.size > 0) {
            const protectedFiles = collectActiveRecordFiles(resolvedTarget);
            const deferred = [...state.deferredDepartingFiles];
            cleanupAntigravityCompanionFiles(target, deferred, protectedFiles);
            for (const f of deferred) {
                if (!protectedFiles.has(f) && !existsSync(f)) {
                    state.deferredDepartingFiles.delete(f);
                }
            }
        }

        _companionFilesByContextPath.set(resolvedTarget, {
            workspace: ctx.workspace,
            homeDir,
            scope,
            files: [...additionalOwnedFiles],
        });

        const effect: CoordinatorInjectionEffect = {
            contextFilePath: target,
            contextFileOwned: owned,
            contextFileSentinels: sentinels,
            additionalOwnedFiles,
            retainContextFileForSessionLifetime: true,
            contextFileHomeDir: homeDir,
            ...(state.wrapperSeparators ? { contextFileSeparators: { ...state.wrapperSeparators } } : {}),
        };
        _recordByEffect.set(effect, record);

        LOG.info(
            'MeshCoordinator',
            `Wrote antigravity-cli coordinator prompt to ${target} (${totalParts} part(s), inlineFirst=${inlineFirstPartInAgentsMd})`,
        );
        return effect;
    } catch (error: any) {
        restoreSynchronousWriteFailure(syncRollbackSnapshot);
        const message = `Could not write ${target}: ${error?.message || error}`;
        LOG.warn('MeshCoordinator', message);
        return {
            error: message,
            errorCode: 'mesh_coordinator_context_file_write_failed',
        };
    }
}

/**
 * Roll back a failed launch's `CoordinatorInjectionEffect` when another active
 * coordinator (registered in `coordinator-registry` OR an active unsettled
 * provisional injection) still owns `effect.contextFilePath`.
 *
 * Returns `true` if an overlapping active owner was preserved and restored
 * (so the caller MUST NOT strip `effect.contextFilePath`), or `false` if no
 * other active owner exists and normal failed-launch stripping should proceed.
 */
export function rollbackOverlappingFailedContextFileInjection(
    effect: object,
    hasRegisteredLiveOwner: boolean,
    liveRegisteredOwners?: readonly SurvivingCoordinatorDescriptor[],
): boolean {
    const failedRecord = _recordByEffect.get(effect);
    if (!failedRecord) {
        return hasRegisteredLiveOwner;
    }
    failedRecord.status = 'failed';

    const resolvedTarget = resolve(failedRecord.targetPath);
    const state = _stateByTarget.get(resolvedTarget);
    if (state && liveRegisteredOwners) {
        const liveIds = new Set(liveRegisteredOwners.map((o) => o.sessionId));
        for (const rec of state.records) {
            if (rec.status === 'registered' && rec.sessionId && !liveIds.has(rec.sessionId)) {
                rec.status = 'terminated';
            }
        }
    }

    const activeRecords = getActiveRecordsForTarget(resolvedTarget);
    const protectedFiles = collectActiveRecordFiles(resolvedTarget);
    for (const owner of liveRegisteredOwners ?? []) {
        for (const f of owner.additionalOwnedFiles ?? []) {
            protectedFiles.add(f);
        }
    }

    // Always clean up the failed record's own unshared files.
    deleteUnsharedRecordFiles(failedRecord, protectedFiles);

    if (activeRecords.length === 0 && !hasRegisteredLiveOwner) {
        return false;
    }

    const newestActiveRecord = activeRecords[activeRecords.length - 1];
    if (newestActiveRecord) {
        restoreActiveOwnershipRecordInPlace(newestActiveRecord);
    }
    return true;
}

/**
 * Remove any Antigravity companion rule files and home chunk files associated with
 * `contextFilePath`, plus empty directories they lived in. Best-effort and idempotent.
 */
export function cleanupAntigravityCompanionFiles(
    contextFilePath: string,
    explicitAdditionalFiles?: readonly string[],
    protectedFiles?: ReadonlySet<string>,
): void {
    const resolvedTarget = resolve(contextFilePath);
    const tracked = _companionFilesByContextPath.get(resolvedTarget);

    const activeProtected = collectActiveRecordFiles(resolvedTarget);
    const effectiveProtected = new Set<string>(protectedFiles ?? []);
    for (const f of activeProtected) {
        effectiveProtected.add(f);
    }

    const filesToDelete = new Set<string>();
    if (explicitAdditionalFiles && explicitAdditionalFiles.length > 0) {
        for (const f of explicitAdditionalFiles) filesToDelete.add(f);
    } else if (tracked) {
        for (const f of tracked.files) filesToDelete.add(f);
    }

    if (effectiveProtected.size === 0) {
        _companionFilesByContextPath.delete(resolvedTarget);
    }

    for (const filePath of filesToDelete) {
        if (effectiveProtected.has(filePath)) continue;
        try {
            if (existsSync(filePath)) unlinkSync(filePath);
        } catch { /* best-effort */ }
    }

    const workspace = tracked?.workspace ?? dirname(resolvedTarget);
    const candidateScopes = new Set<string>();
    if (!explicitAdditionalFiles?.length && tracked?.scope) {
        candidateScopes.add(tracked.scope);
    }
    const candidateHomes = new Set<string>([os.homedir()]);
    if (tracked?.homeDir) candidateHomes.add(tracked.homeDir);

    const marker = join('.gemini', 'config', 'adhdev-mesh-coordinator');
    for (const f of filesToDelete) {
        const idx = f.indexOf(marker);
        if (idx > 0) {
            candidateHomes.add(f.slice(0, idx - 1));
            const afterMarker = f.slice(idx + marker.length + 1);
            const scopeSeg = afterMarker.split(/[\\/]/)[0];
            if (scopeSeg) candidateScopes.add(scopeSeg);
        }
    }

    for (const homeDir of candidateHomes) {
        const baseCoordConfigDir = join(homeDir, '.gemini', 'config', 'adhdev-mesh-coordinator');
        for (const scope of candidateScopes) {
            if (effectiveProtected.size === 0) {
                cleanupStaleScopedFiles(workspace, homeDir, scope);
            }
            removeDirIfEmpty(join(baseCoordConfigDir, scope));
        }
        removeDirIfEmpty(baseCoordConfigDir);
    }

    const rulesDir = join(workspace, '.agents', 'rules');
    removeDirIfEmpty(rulesDir);
    removeDirIfEmpty(join(workspace, '.agents'));
}

/**
 * Strip the daemon's wrapper block from a context_file we previously wrote,
 * along with any companion rule/include files. Preserves user content byte-for-byte.
 *
 * Returns `true` when `filePath` was stripped/unlinked (or did not exist) and
 * companion files were cleaned up, or `false` if modifying `filePath` failed
 * (in which case referenced companion files are retained on disk).
 */
export function stripCoordinatorWrapperFile(
    filePath: string,
    owned = false,
    sentinels: CoordinatorWrapperSentinels = LEGACY_COORDINATOR_WRAPPER_SENTINELS,
    additionalOwnedFiles?: readonly string[],
    explicitSeparators?: RecordedWrapperSeparators,
): boolean {
    const resolvedTarget = resolve(filePath);
    const state = _stateByTarget.get(resolvedTarget);
    const recordedSeparators = explicitSeparators ?? state?.wrapperSeparators;

    try {
        if (existsSync(filePath)) {
            if (owned && !sentinels.open) {
                unlinkSync(filePath);
            } else if (sentinels.open) {
                const existing = readFileSync(filePath, 'utf-8');
                if (!existing.includes(sentinels.open)) {
                    if (owned && !existing.trim()) {
                        unlinkSync(filePath);
                    }
                } else {
                    const remaining = stripSentinelBlockPreservingSurroundingBytes(
                        existing,
                        sentinels,
                        recordedSeparators,
                    );
                    if (remaining !== existing) {
                        if (!remaining.trim()) {
                            unlinkSync(filePath);
                        } else {
                            writeFileSync(filePath, remaining, 'utf-8');
                        }
                    }
                }
            }
        }
    } catch (error: any) {
        if (additionalOwnedFiles?.length) {
            const targetState = getOrCreateTargetState(resolvedTarget);
            if (!targetState.deferredDepartingFiles) {
                targetState.deferredDepartingFiles = new Set<string>();
            }
            for (const f of additionalOwnedFiles) {
                targetState.deferredDepartingFiles.add(f);
            }
        }
        LOG.warn('MeshCoordinator', `Could not strip coordinator wrapper from ${filePath}: ${error?.message || error}`);
        return false;
    }

    try {
        if (state) {
            for (const rec of state.records) {
                if (rec.status === 'provisional' || rec.status === 'registered') {
                    rec.status = 'terminated';
                }
            }
            state.wrapperSeparators = undefined;
        }
        const combinedFiles = new Set<string>(additionalOwnedFiles ?? []);
        if (state?.deferredDepartingFiles) {
            for (const f of state.deferredDepartingFiles) {
                combinedFiles.add(f);
            }
            state.deferredDepartingFiles.clear();
        }
        cleanupAntigravityCompanionFiles(
            filePath,
            combinedFiles.size > 0 ? [...combinedFiles] : undefined,
        );
    } catch { /* best-effort */ }
    return true;
}

