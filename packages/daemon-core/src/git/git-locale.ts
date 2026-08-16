/**
 * Git child-process environment: locale pinning + repo-location sanitization.
 *
 * Git translates its human-readable messages via gettext. Every place in this
 * codebase that decides control flow by matching git's stderr/stdout against an
 * English phrase — "not a git repository", "nothing to commit", "No local
 * changes to save", "working trees containing submodules cannot be moved or
 * removed", "not fully merged" — silently stops matching the moment the daemon
 * runs under a non-English locale.
 *
 * Observed live (2026-08-13): a Refinery run on a Korean-locale node ended in
 * `merged_cleanup_failed`. The merge and push had both succeeded; only the
 * worktree cleanup failed, because git emitted
 *   `fatal: 하위 모듈이 포함된 작업 폴더는 옮기거나 제거할 수 없습니다`
 * and the submodule force-fallback regex did not match, so a recoverable case
 * hard-threw. Re-running the same removal with `LC_ALL=C` exited 0 immediately:
 * git was never the problem, the stderr parsing was.
 *
 * The fix is to pin the locale of the git CHILD PROCESS, so stderr is always
 * the English that the matchers were written against.
 *
 * Why LC_ALL and not LANG: LC_ALL is the highest-precedence locale variable in
 * POSIX — it overrides LC_MESSAGES and LANG both. Setting only LANG would be
 * defeated by an inherited LC_ALL or LC_MESSAGES in the user's environment,
 * which is exactly the environment we are defending against. We also clear
 * LC_MESSAGES and set LANGUAGE='' because GNU gettext consults LANGUAGE ahead
 * of LC_ALL, and an inherited `LANGUAGE=ko` would otherwise still translate.
 *
 * Scope discipline — this is deliberately NOT a process-wide setenv:
 *   - It returns a child env object; `process.env` is never mutated. The daemon's
 *     own locale still drives user-facing output (see logging/console-symbols.ts,
 *     which reads LC_ALL/LANG to choose console glyphs — flipping those to "C"
 *     would silently downgrade win32 console rendering to ASCII).
 *   - It SPREADS process.env rather than replacing it, so PATH, HOME,
 *     GIT_SSH_COMMAND, proxy vars and credential-helper config all survive.
 *     Replacing the env wholesale would break authenticated fetch/push.
 */

/**
 * Repo-location variables stripped from every git child process.
 *
 * These are the variables that make git act on a DIFFERENT repository than the
 * one the caller named. When `GIT_DIR` (with or without `GIT_WORK_TREE`) is
 * present in the inherited environment it takes precedence over BOTH `-C <dir>`
 * and the child's `cwd` — the caller's explicit targeting is silently ignored:
 *
 *   GIT_DIR=<A/.git> GIT_WORK_TREE=<A> git -C B rev-parse --show-toplevel  →  A
 *
 * That is a correctness bug for read commands and a DATA-LOSS bug for
 * destructive ones. Verified live in the same shape:
 *
 *   GIT_DIR=<A/.git> GIT_WORK_TREE=<A> git -C B worktree remove --force <A's wt>
 *     → exit 0, A's worktree directory deleted
 *
 * i.e. a removal aimed at repo B can delete a worktree belonging to repo A,
 * leaving NO stale registration behind (git de-registers it properly), which is
 * precisely the forensic signature of a worktree that "vanished" with no
 * `node_removed` ledger entry. `router-worktree-cleanup.ts` runs
 * `git worktree remove --force` / `submodule deinit --all -f` / `worktree prune`
 * through this env, so an inherited `GIT_DIR` reaches destructive commands.
 *
 * This is the same defect class already proven in the vendor hooks, where an
 * inherited `GIT_DIR` defeated `execFileSync`'s `cwd` and overwrote the root
 * hook with oss content (fixed by `CLEAN_ENV` in scripts/setup-hooks.mjs and
 * scripts/vendor-precommit.mjs). This is the daemon-side equivalent.
 *
 * Scope: ONLY location/state-redirection vars are stripped. `GIT_SSH_COMMAND`,
 * `GIT_ASKPASS`, credential-helper and proxy vars are deliberately preserved —
 * removing those would break authenticated fetch/push. A caller that genuinely
 * wants one of these (mesh-refine-gates.ts intentionally sets `GIT_INDEX_FILE`
 * for a scratch index) must set it EXPLICITLY on the env it passes; that still
 * works, because the strip runs before the caller's own overrides are applied.
 */
const REPO_LOCATION_VARS = [
    // Redirects which repository/worktree git operates on — overrides -C and cwd.
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    // Redirects which index file is read/written (staging-area corruption).
    'GIT_INDEX_FILE',
    // Redirects object/ref lookup across repositories.
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_NAMESPACE',
    // Set by git while running a hook; the prefix leaks into grandchild commands.
    'GIT_PREFIX',
] as const;

/** Locale variables pinned on git child processes, in gettext precedence order. */
const C_LOCALE_OVERRIDES = {
    // GNU gettext checks LANGUAGE first; an inherited value would win over LC_ALL.
    LANGUAGE: '',
    // Highest-precedence POSIX locale var — overrides LC_MESSAGES and LANG.
    LC_ALL: 'C',
    // Belt-and-braces: explicit so an inherited LC_MESSAGES cannot re-translate.
    LC_MESSAGES: 'C',
    LANG: 'C',
} as const;

/**
 * Build the environment for a git child process: the caller's environment with
 * every repo-location variable stripped (so `-C`/`cwd` actually decides which
 * repository is acted on) and the locale pinned to C (so git's messages stay in
 * English for the stderr matchers).
 *
 * Pass the result as `env` to execFile/spawn. Callers that already build their
 * own env should pass it as `base` so their vars are preserved.
 *
 * Ordering note: the strip is applied to `base` FIRST, and the locale pins are
 * layered on top. A caller that deliberately wants a repo-location variable
 * (e.g. a scratch `GIT_INDEX_FILE`) sets it on the object it builds AFTER
 * calling this, which is the only way such a value should ever reach git —
 * inherited ambiently, it is always a bug.
 */
export function gitChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...base, ...C_LOCALE_OVERRIDES };
    for (const key of REPO_LOCATION_VARS) {
        delete env[key];
    }
    return env;
}
