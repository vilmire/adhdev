/**
 * Console symbol set — UTF-8 glyphs with an ASCII fallback for consoles that
 * cannot render them.
 *
 * ## The bug this exists for
 *
 * On a Korean-locale Windows console (default output code page CP949/949),
 * the UTF-8 bytes Node writes to stdout are decoded as CP949. The result is
 * not merely ugly — it is *ambiguous*:
 *
 *   '✓' = UTF-8 e2 9c 93  → CP949 reads it as a single replacement char → "?"
 *   '✗' = UTF-8 e2 9c 97  → CP949 reads it as a single replacement char → "?"
 *
 * Both the success and the failure marker collapse to the SAME character, so
 * `adhdev doctor` output like "?? Doctor checks passed." leaves the user
 * unable to tell which checks failed. That is a correctness problem, not a
 * cosmetic one.
 *
 * The owner's log also showed a second, different-looking corruption:
 *
 *   '🩺' = UTF-8 f0 9f a9 ba → CP949 reads it as "?㈉"
 *   '📦' = UTF-8 f0 9f 93 a6 → CP949 reads it as "??"
 *
 * These are the SAME root cause, not two bugs. A 3-byte glyph leaves no
 * trailing byte pair that forms a valid CP949 double-byte character, so it
 * degrades to pure replacement chars ("??"); a 4-byte emoji leaves a trailing
 * pair that *does* happen to map to a printable Hangul-block character, so it
 * degrades to "?㈉" / "?봽". One encoding mismatch, two visual shapes.
 * (Verified by decoding the exact UTF-8 byte sequences through a CP949
 * decoder — see console-symbols.test.ts, which pins the mechanism.)
 *
 * ## Why an ASCII fallback rather than switching the code page
 *
 * The alternative fix is to force the console to UTF-8 (`chcp 65001`). It was
 * rejected:
 *
 *  - It mutates state the CLI does not own. `chcp` changes the code page for
 *    the whole console, and the change OUTLIVES the process — the user's shell
 *    keeps the new code page after `adhdev` exits, which can break other
 *    tooling in that session (notably native Korean output, the very locale
 *    that hits this bug).
 *  - It requires spawning a subprocess on every CLI start, on the hot path of
 *    every command, purely for output cosmetics.
 *  - It does not help the case that is NOT a console at all: output redirected
 *    to a file or piped into another tool.
 *
 * The fallback degrades one presentational detail and is deterministic,
 * testable on any host OS, and side-effect-free. It also keeps full UTF-8 on
 * every console that can render it, including modern Windows Terminal.
 *
 * ## Note on the log FILE
 *
 * Log files are written by Node as UTF-8 and are NOT corrupted at rest. When
 * the owner saw '?봽' in a log, that was the VIEWER (PowerShell `Get-Content`
 * / `type` under CP949) decoding a correct UTF-8 file with the wrong code
 * page. Nothing in the writer needs fixing; `Get-Content -Encoding utf8`
 * renders those same files correctly.
 */

/** The symbols a caller can ask for. Keep this list small and semantic. */
export interface ConsoleSymbols {
    /** Success / check passed. */
    readonly ok: string;
    /** Failure / check failed. */
    readonly fail: string;
    /** Warning — non-fatal, needs attention. */
    readonly warn: string;
    /** Informational bullet. */
    readonly info: string;
}

const UNICODE_SYMBOLS: ConsoleSymbols = {
    ok: '✓',
    fail: '✗',
    warn: '⚠',
    info: '•',
};

/**
 * ASCII fallback. Deliberately asymmetric in WIDTH as well as in content:
 * `[OK]` and `[X]` cannot be confused with each other even in a monospace
 * column, which is the property CP949-mangled output lost.
 */
const ASCII_SYMBOLS: ConsoleSymbols = {
    ok: '[OK]',
    fail: '[X]',
    warn: '[!]',
    info: '-',
};

export interface UnicodeSupportProbe {
    platform: string;
    env: Record<string, string | undefined>;
}

/**
 * Decide whether the current console can render the UTF-8 symbol set.
 *
 * Only win32 is ever downgraded: every POSIX terminal ADHDev targets is UTF-8
 * by default, and downgrading them would be a pointless regression.
 *
 * On win32 we treat the console as UTF-8-capable when we can positively
 * identify a modern host:
 *  - Windows Terminal sets WT_SESSION.
 *  - VS Code / Cursor / other embedded terminals set TERM_PROGRAM.
 *  - An explicit UTF-8 code page in the environment (chcp 65001 exported by
 *    the user, or a *.UTF-8 locale) is an explicit opt-in.
 *
 * Otherwise — legacy conhost, which is what `powershell.exe` opens by default
 * and what the owner reproduced on — we fall back to ASCII. Failing to the
 * SAFE side matters more than maximizing glyphs: an unnecessary `[OK]` is
 * merely plain, whereas an unrenderable '✓' is actively misleading.
 *
 * `ADHDEV_ASCII_SYMBOLS` forces the fallback on ('1') or off ('0') on any
 * platform, so the behavior is reachable for support and for manual checks.
 */
export function supportsUnicodeSymbols(probe: UnicodeSupportProbe): boolean {
    const forced = probe.env.ADHDEV_ASCII_SYMBOLS;
    if (forced === '1') return false;
    if (forced === '0') return true;

    if (probe.platform !== 'win32') return true;

    if (probe.env.WT_SESSION) return true;
    if (probe.env.TERM_PROGRAM) return true;

    // An explicitly UTF-8 code page / locale is a deliberate user opt-in.
    const codePageHints = [probe.env.ADHDEV_CONSOLE_CODEPAGE, probe.env.LC_ALL, probe.env.LANG];
    for (const hint of codePageHints) {
        if (!hint) continue;
        if (hint === '65001' || /utf-?8/i.test(hint)) return true;
    }

    return false;
}

/** Resolve the symbol set for a given environment. Pure — inject the probe. */
export function resolveConsoleSymbols(probe: UnicodeSupportProbe): ConsoleSymbols {
    return supportsUnicodeSymbols(probe) ? UNICODE_SYMBOLS : ASCII_SYMBOLS;
}

/**
 * Symbols for the CURRENT process.
 *
 * Resolved lazily on first use rather than at module load: the CLI reads env
 * that may be set up during startup, and a module-load-time constant would
 * also make the behavior untestable without module-cache surgery.
 */
let cached: ConsoleSymbols | null = null;

export function consoleSymbols(): ConsoleSymbols {
    if (!cached) {
        cached = resolveConsoleSymbols({ platform: process.platform, env: process.env });
    }
    return cached;
}

/** Test seam — drop the memoized value so a test can vary the environment. */
export function resetConsoleSymbolsCache(): void {
    cached = null;
}

/** Shorthand accessors for the common call sites. */
export const SYM = {
    get ok(): string { return consoleSymbols().ok; },
    get fail(): string { return consoleSymbols().fail; },
    get warn(): string { return consoleSymbols().warn; },
    get info(): string { return consoleSymbols().info; },
};
