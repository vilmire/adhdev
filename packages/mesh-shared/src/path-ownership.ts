/**
 * path-ownership — declared file-ownership sets for `code_change` mesh tasks
 * (wiring-unification Phase H1, `docs/design/2026-09-23-wiring-unification.md`
 * §7c).
 *
 * Today two `code_change` tasks on two different nodes (two worktrees of the
 * same branch, or main + a worktree) can silently touch the same file with
 * zero warning — the only existing isolation is node-level ("one active write
 * task per node"), never path-level. This module is the pure, dependency-free
 * core of the fix: normalizing a caller-declared `owned_paths` list, and
 * comparing declared sets for overlap. It has NO opinion on enforcement policy
 * (refuse vs warn, which axis a caller compares against) — that is the mesh
 * runtime's job (`claimNextTask` / `claimNextQueueTask` in daemon-core); this
 * module only answers "do these two declarations conflict" and "did the
 * touched-files report stay inside the declaration".
 *
 * SCOPE DECISION (glob support): minimal, deliberately. A declaration entry is
 * either an exact repo-relative path (`src/foo.ts`) or a directory prefix
 * spelled with a trailing `/**` (`src/mesh/**`) meaning "this path and
 * everything under it". No `*`/`?` mid-segment wildcards, no `!` negation, no
 * brace expansion. Two `code_change` tasks racing on overlapping files is a
 * coordination bug to catch, not a general glob engine to build — a full
 * minimatch-style matcher would need its own test suite and still leave the
 * same ambiguity (does `src/*.ts` "contain" `src/foo.ts`?) the design doc's
 * risk list calls out. `src/` (no `**`) is treated as an exact single-path
 * entry, i.e. it owns a literal file/dir node named `src`, NOT everything
 * under it — callers who want subtree ownership must write `src/**`.
 *
 * Rejected inputs (absolute paths, `..` segments, backslash-only entries that
 * still resolve outside the repo after normalization) are dropped rather than
 * silently coerced — `normalizeOwnedPaths` reports what it dropped so the
 * caller (enqueue-time validation) can decide whether to warn or refuse.
 */

/** One normalized ownership entry: a repo-relative path, optionally a `**` subtree prefix. */
export interface OwnedPathEntry {
    /** Repo-relative path with forward slashes, no leading `./`, no trailing slash. */
    readonly path: string
    /** True when this entry was declared as `<path>/**` (owns the whole subtree). */
    readonly subtree: boolean
}

/** A caller's normalized ownership declaration. */
export interface OwnedPathsDeclaration {
    readonly paths: readonly OwnedPathEntry[]
}

export interface NormalizeOwnedPathsResult {
    readonly declaration: OwnedPathsDeclaration
    /** Raw input entries that were dropped, with why — surfaced to the caller, never silently coerced. */
    readonly rejected: ReadonlyArray<{ input: string; reason: string }>
}

/** Cap mirrors `depends_on`'s implicit list-size discipline (design doc H1 proposal). */
export const MAX_OWNED_PATHS = 64

function toPosix(raw: string): string {
    return raw.replace(/\\/g, '/')
}

/**
 * Normalize one raw entry. Returns `null` (with a reason pushed to `rejected`)
 * for anything absolute, escaping the repo via `..`, or empty after trimming.
 */
function normalizeOne(raw: unknown, rejected: Array<{ input: string; reason: string }>): OwnedPathEntry | null {
    if (typeof raw !== 'string') {
        rejected.push({ input: String(raw), reason: 'not_a_string' })
        return null
    }
    const trimmed = raw.trim()
    if (!trimmed) {
        rejected.push({ input: raw, reason: 'empty' })
        return null
    }
    let posix = toPosix(trimmed)

    // Absolute paths (POSIX `/…`, Windows drive letter `C:\…` or `C:/…`, or a
    // stray leading `~`) are refused outright — ownership is repo-relative by
    // construction, and accepting an absolute path would let a declaration
    // silently escape the workspace it is meant to scope.
    if (posix.startsWith('/') || /^[a-zA-Z]:\//.test(posix) || posix.startsWith('~')) {
        rejected.push({ input: raw, reason: 'absolute_path' })
        return null
    }

    // Strip a leading './'.
    posix = posix.replace(/^\.\/+/, '')

    // Reject any '..' segment anywhere — no escaping the repo root.
    const segments = posix.split('/').filter(Boolean)
    if (segments.some(seg => seg === '..')) {
        rejected.push({ input: raw, reason: 'parent_traversal' })
        return null
    }
    if (segments.length === 0) {
        rejected.push({ input: raw, reason: 'empty' })
        return null
    }

    // Minimal glob support: a trailing '**' segment (from '<path>/**') marks a
    // subtree declaration. Any OTHER '*'/'?' anywhere is rejected — this module
    // does not implement general glob matching (see module doc).
    let subtree = false
    if (segments[segments.length - 1] === '**') {
        subtree = true
        segments.pop()
        if (segments.length === 0) {
            // '**' alone (or './**') claims the entire repo — allowed, but the
            // caller (enqueue-time validation) is expected to lint/warn on it
            // per the design doc's deadlock risk; this module only normalizes.
        }
    }
    if (segments.some(seg => seg.includes('*') || seg.includes('?'))) {
        rejected.push({ input: raw, reason: 'unsupported_glob' })
        return null
    }

    return { path: segments.join('/'), subtree }
}

/**
 * Normalize a caller-supplied `owned_paths` array. Never throws — invalid
 * entries are dropped and reported in `rejected`; duplicates (after
 * normalization) collapse to one entry (subtree wins if either declaration
 * form is present for the same path). Entries beyond `MAX_OWNED_PATHS` (after
 * dedup) are dropped with reason `over_cap`, preserving declaration order.
 */
export function normalizeOwnedPaths(input: unknown): NormalizeOwnedPathsResult {
    const rejected: Array<{ input: string; reason: string }> = []
    if (input === undefined || input === null) {
        return { declaration: { paths: [] }, rejected }
    }
    if (!Array.isArray(input)) {
        return { declaration: { paths: [] }, rejected: [{ input: String(input), reason: 'not_an_array' }] }
    }

    const byPath = new Map<string, OwnedPathEntry>()
    for (const raw of input) {
        const entry = normalizeOne(raw, rejected)
        if (!entry) continue
        const existing = byPath.get(entry.path)
        if (!existing) {
            byPath.set(entry.path, entry)
        } else if (entry.subtree && !existing.subtree) {
            byPath.set(entry.path, entry)
        }
        // else: duplicate, existing entry already at least as broad — keep it.
    }

    const all = [...byPath.values()]
    const kept = all.slice(0, MAX_OWNED_PATHS)
    for (const dropped of all.slice(MAX_OWNED_PATHS)) {
        rejected.push({ input: dropped.path, reason: 'over_cap' })
    }

    return { declaration: { paths: kept }, rejected }
}

/** True when `path` is exactly `base`, or (when `base` is a subtree entry) nested under it. */
function entryContains(base: OwnedPathEntry, path: string): boolean {
    if (path === base.path) return true
    if (base.subtree && (path === base.path || path.startsWith(`${base.path}/`))) return true
    return false
}

/** True when two normalized entries' claimed sets intersect (exact match, or one contains the other's directory). */
function entriesOverlap(a: OwnedPathEntry, b: OwnedPathEntry): boolean {
    if (a.path === b.path) return true
    if (a.subtree && (b.path === a.path || b.path.startsWith(`${a.path}/`))) return true
    if (b.subtree && (a.path === b.path || a.path.startsWith(`${b.path}/`))) return true
    return false
}

/** True when two declarations claim any overlapping path. Pure set comparison — no policy (refuse vs warn) here. */
export function pathsOverlap(a: OwnedPathsDeclaration, b: OwnedPathsDeclaration): boolean {
    if (a.paths.length === 0 || b.paths.length === 0) return false
    for (const pa of a.paths) {
        for (const pb of b.paths) {
            if (entriesOverlap(pa, pb)) return true
        }
    }
    return false
}

export interface InFlightOwnership {
    readonly taskId: string
    readonly paths: OwnedPathsDeclaration
}

export interface OwnershipConflict {
    readonly taskId: string
    /** The specific overlapping paths, for a readable refusal message. */
    readonly overlappingPaths: readonly string[]
}

/**
 * Compare a candidate declaration against every other in-flight task's
 * declaration and return every conflict found (not just the first), each
 * naming the owning task id and the specific overlapping path(s) — so a
 * refusal message can say exactly what collided, not just that it did.
 *
 * Backward compatibility (design doc risk #4): an EMPTY candidate declaration
 * never conflicts (opt-in only — absent `owned_paths` performs no overlap
 * check for that task), and an in-flight entry with an empty declaration is
 * never reported as a conflict source either.
 */
export function findOwnershipConflicts(
    candidate: OwnedPathsDeclaration,
    inFlight: readonly InFlightOwnership[],
): OwnershipConflict[] {
    if (candidate.paths.length === 0) return []
    const conflicts: OwnershipConflict[] = []
    for (const other of inFlight) {
        if (other.paths.paths.length === 0) continue
        const overlappingPaths: string[] = []
        for (const pa of candidate.paths) {
            for (const pb of other.paths.paths) {
                if (entriesOverlap(pa, pb)) {
                    const narrower = pa.path.length >= pb.path.length ? pa.path : pb.path
                    if (!overlappingPaths.includes(narrower)) overlappingPaths.push(narrower)
                }
            }
        }
        if (overlappingPaths.length > 0) {
            conflicts.push({ taskId: other.taskId, overlappingPaths })
        }
    }
    return conflicts
}

export interface TouchedFilesOutsideOwnershipResult {
    /** Touched files not covered by any declared owned-path entry. */
    readonly undeclaredTouched: readonly string[]
    /** Declared entries that no touched file matched (informational only — under-reporting is not flagged as a mismatch by policy, just visible here). */
    readonly unusedDeclarations: readonly string[]
}

/**
 * Compare a worker's `report_completion.touched_files` against its task's
 * declared `owned_paths`. Pure comparison only — per the design doc, a
 * mismatch is "surfaced as evidence, not silently accepted"; this function
 * does not decide whether that is an error. Each `touched` entry is
 * normalized with the same rules as a declaration (invalid entries — e.g. an
 * absolute path a worker reported by mistake — are treated as undeclared
 * rather than silently dropped, since they cannot match anything).
 */
export function touchedFilesOutsideOwnership(
    touched: readonly string[],
    owned: OwnedPathsDeclaration,
): TouchedFilesOutsideOwnershipResult {
    const undeclaredTouched: string[] = []
    const usedDeclarations = new Set<string>()

    for (const raw of touched ?? []) {
        const rejectedSink: Array<{ input: string; reason: string }> = []
        const entry = normalizeOne(raw, rejectedSink)
        if (!entry) {
            undeclaredTouched.push(raw)
            continue
        }
        const matches = owned.paths.filter(base => entryContains(base, entry.path))
        if (matches.length === 0) {
            undeclaredTouched.push(entry.path)
        } else {
            for (const m of matches) usedDeclarations.add(m.path)
        }
    }

    const unusedDeclarations = owned.paths.map(p => p.path).filter(p => !usedDeclarations.has(p))
    return { undeclaredTouched, unusedDeclarations }
}
