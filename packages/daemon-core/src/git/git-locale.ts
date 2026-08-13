/**
 * Git child-process locale pinning.
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
 * the locale pinned to C so git's messages stay in English.
 *
 * Pass the result as `env` to execFile/spawn. Callers that already build their
 * own env should pass it as `base` so their vars are preserved.
 */
export function gitChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    return { ...base, ...C_LOCALE_OVERRIDES };
}
