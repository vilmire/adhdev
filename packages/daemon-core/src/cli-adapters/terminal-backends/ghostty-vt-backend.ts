import type {
    TerminalViewportBackend,
    TerminalViewportBackendOptions,
} from './types.js';

type GhosttyVtTerminal = {
    write(data: string | Uint8Array): void;
    resize(cols: number, rows: number): void;
    formatPlainText(options?: { trim?: boolean }): string;
    getCursorPosition(): { col: number; row: number };
    dispose(): void;
};

type GhosttyVtBinding = {
    createTerminal(options: { cols: number; rows: number; scrollback: number }): GhosttyVtTerminal;
};

const DEFAULT_BINDING_CANDIDATES = [
    '@adhdev/ghostty-vt-node',
];

let cachedBinding: GhosttyVtBinding | null | undefined;
let cachedBindingError: Error | null = null;

function isModuleNotFoundError(error: unknown, ref: string): boolean {
    if (!(error instanceof Error)) return false;
    const message = error.message || '';
    const code = 'code' in error ? error.code : undefined;
    return code === 'MODULE_NOT_FOUND' && message.includes(ref);
}

// Identifies the host runtime so a binding-load failure names the exact ABI it
// looked for. The underlying binding is N-API (ABI-stable), so a failure here is
// almost always "no prebuilt directory addressed this triplet" rather than a
// true ABI incompatibility — making the triplet the single most useful
// diagnostic to surface in an env-blocker report.
function runtimeTriplet(): string {
    return `${process.platform}-${process.arch}-node${process.versions.modules}`;
}

function normalizeBinding(mod: any, ref: string): GhosttyVtBinding {
    const binding = mod?.default?.createTerminal
        ? mod.default
        : mod?.createTerminal
            ? mod
            : null;

    if (!binding) {
        throw new Error(`Ghostty VT binding "${ref}" does not export createTerminal()`);
    }

    return binding as GhosttyVtBinding;
}

function getBindingCandidates(): string[] {
    const explicit = process.env.ADHDEV_GHOSTTY_VT_BINDING?.trim();
    return explicit ? [explicit] : DEFAULT_BINDING_CANDIDATES;
}

/** Test-only: reset the memoized binding/error so a test can force a reload. */
export function __resetGhosttyVtBindingCacheForTests(): void {
    cachedBinding = undefined;
    cachedBindingError = null;
}

function loadGhosttyVtBinding(): GhosttyVtBinding {
    if (cachedBinding !== undefined) {
        if (!cachedBinding && cachedBindingError) throw cachedBindingError;
        return cachedBinding!;
    }

    const errors: string[] = [];
    // True only if every candidate failed with MODULE_NOT_FOUND. Any other
    // failure (native ABI crash, permission error, transient load issue) means
    // the binding may in fact be loadable, so the failure must NOT be
    // memoized — otherwise one bad load wedges this backend unavailable for
    // the rest of the daemon's life even though a later attempt could succeed.
    let allModuleNotFound = true;

    for (const ref of getBindingCandidates()) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const mod = require(ref);
            cachedBinding = normalizeBinding(mod, ref);
            cachedBindingError = null;
            return cachedBinding!;
        } catch (error) {
            if (isModuleNotFoundError(error, ref)) {
                errors.push(`${ref}: module not found`);
                continue;
            }
            allModuleNotFound = false;
            const message = error instanceof Error ? error.message : String(error);
            errors.push(`${ref}: ${message}`);
        }
    }

    const buildError = () =>
        new Error(
            `ghostty-vt binding unavailable for runtime ${runtimeTriplet()} ` +
                `(${errors.join('; ') || 'no candidates tried'})`,
        );

    if (allModuleNotFound) {
        cachedBinding = null;
        cachedBindingError = buildError();
    }
    throw buildError();
}

// DEC private modes that swap in the alternate screen buffer. 1049 is what
// modern TUIs emit; 47 and 1047 are the legacy spellings, kept because the
// cost of matching them is a wider character class and the cost of missing
// them is a silently collapsed viewport.
const ALT_SCREEN_MODE_RE = /\x1b\[\?(?:1049|1047|47)([hl])/g;

// Longest prefix of an alt-screen sequence that can be a proper prefix of a
// match: "\x1b[?1049" is 8 chars, so 8 characters of tail are enough to
// reassemble any sequence split across two writes. Bounded so the carry can
// never grow with input volume.
const ALT_SCREEN_SEQ_MAX_PREFIX = 8;

export class GhosttyVtTerminalBackend implements TerminalViewportBackend {
    readonly kind = 'ghostty-vt' as const;
    private terminal: GhosttyVtTerminal;
    private rows: number;
    private disposed = false;
    /**
     * Whether the alternate screen buffer is currently active.
     *
     * Tracked here because the native binding exposes no accessor for it, and
     * the distinction is load-bearing: the alternate screen has no scrollback,
     * so a mid-repaint sample of it is a *partial frame* rather than a short
     * buffer. See getText() for why that changes how the viewport is framed.
     */
    private altScreenActive = false;
    /**
     * Trailing bytes of the previous write that could be the start of an
     * alt-screen mode sequence. PTY reads chunk at arbitrary offsets, so
     * "\x1b[?10" and "49h" routinely arrive as two writes; scanning each chunk
     * in isolation would miss the mode change and leave altScreenActive stale.
     */
    private modeScanCarry = '';

    constructor(options: TerminalViewportBackendOptions) {
        const binding = loadGhosttyVtBinding();
        this.rows = Math.max(1, options.rows | 0);
        this.terminal = binding.createTerminal({
            cols: Math.max(1, options.cols | 0),
            rows: this.rows,
            scrollback: Math.max(0, options.scrollback | 0),
        });
    }

    resize(rows: number, cols: number): void {
        this.rows = Math.max(1, rows | 0);
        this.terminal.resize(Math.max(1, cols | 0), this.rows);
    }

    write(data: string): void {
        if (!data || this.disposed) return;
        this.trackAltScreenMode(data);
        this.terminal.write(data);
    }

    /**
     * Updates altScreenActive from any alt-screen mode sequence in `data`.
     *
     * Only the LAST match matters: a single write may both enter and leave the
     * alternate screen, and the resulting state is whichever transition came
     * last. ghostty's own parser is fed the unmodified chunk, so this scan is
     * purely observational and cannot alter what gets rendered.
     */
    private trackAltScreenMode(data: string): void {
        const haystack = this.modeScanCarry + data;

        ALT_SCREEN_MODE_RE.lastIndex = 0;
        let match: RegExpExecArray | null;
        let last: string | null = null;
        let lastMatchEnd = 0;
        while ((match = ALT_SCREEN_MODE_RE.exec(haystack)) !== null) {
            last = match[1];
            lastMatchEnd = ALT_SCREEN_MODE_RE.lastIndex;
        }
        if (last) this.altScreenActive = last === 'h';

        // Carry only the bytes *after* the last consumed match. Retaining a
        // matched sequence would let it be re-matched on the next write and
        // resurrect an already-superseded transition.
        this.modeScanCarry = haystack.slice(Math.max(lastMatchEnd, haystack.length - ALT_SCREEN_SEQ_MAX_PREFIX));
    }

    private formatLines(): string[] {
        // ghostty's `trim:true` collapses CUF-advanced cells — many TUIs including
        // Claude Code render spaces via cursor-forward rather than literal spaces,
        // which would break downstream regex matching. Keep per-row padding and
        // trim trailing whitespace ourselves.
        //
        // formatPlainText uses a .screen pin which includes scrollback history.
        const raw = this.terminal.formatPlainText({ trim: false }) || '';
        if (!raw) return [];
        return raw.split('\n').map((row) => row.replace(/\s+$/, ''));
    }

    private static trimBlankEnds(lines: string[]): string {
        let first = 0;
        let last = lines.length;
        while (first < last && !lines[first]) first += 1;
        while (last > first && !lines[last - 1]) last -= 1;
        return lines.slice(first, last).join('\n');
    }

    getText(): string {
        if (this.disposed) return '';
        const lines = this.formatLines();
        if (lines.length === 0) return '';
        // Take only the viewport (last `rows` lines) to exclude scrollback history.
        const viewport = lines.length > this.rows ? lines.slice(-this.rows) : lines;

        // On the normal screen the buffer accumulates scrollback, so a short
        // `viewport` genuinely means "little output so far" and collapsing the
        // blank margin is the right, long-standing behaviour. Preserve it
        // byte-for-byte — every non-alt-screen provider matches against it.
        if (!this.altScreenActive) return GhosttyVtTerminalBackend.trimBlankEnds(viewport);

        // The alternate screen has no scrollback: `viewport` IS the whole
        // buffer, and ghostty drops trailing blank rows from it. So a frame
        // sampled mid-repaint — after an erase-display but before the TUI has
        // painted the rest — arrives as a handful of rows rather than a short
        // screen. Trimming that collapses a 32-row viewport to the few bytes
        // that happen to be painted (observed: 3 bytes for a lone spinner),
        // which destroys the row offsets that viewport-relative matching and
        // the modal section anchors depend on.
        //
        // Restoring the full `rows` height keeps geometry stable across
        // repaints: content lands on the row the TUI actually drew it on, and
        // a partial frame reads as a mostly-blank screen instead of a
        // truncated one.
        return GhosttyVtTerminalBackend.padToRows(viewport, this.rows);
    }

    /** Pads `lines` with trailing blanks so the result is exactly `rows` tall. */
    private static padToRows(lines: string[], rows: number): string {
        const padded = lines.slice(0, rows);
        while (padded.length < rows) padded.push('');
        return padded.join('\n');
    }

    getTextWithScrollback(): string {
        if (this.disposed) return '';
        const lines = this.formatLines();
        if (lines.length === 0) return '';
        // On the alternate screen there is no scrollback to include — the whole
        // buffer is the viewport — so this must apply the same partial-frame
        // padding as getText(). Without it the modal/approval content matching
        // that relies on this method sees the same collapsed fragment.
        if (this.altScreenActive) {
            const viewport = lines.length > this.rows ? lines.slice(-this.rows) : lines;
            return GhosttyVtTerminalBackend.padToRows(viewport, this.rows);
        }

        // Full buffer including scrollback — does NOT slice to the viewport, so a
        // tall prompt whose top has scrolled above the visible rows is still
        // matchable by content patterns.
        return GhosttyVtTerminalBackend.trimBlankEnds(lines);
    }

    getCursorPosition(): { col: number; row: number } {
        if (this.disposed) return { col: 0, row: 0 };
        if (typeof this.terminal.getCursorPosition !== 'function') return { col: 0, row: 0 };
        return this.terminal.getCursorPosition();
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.terminal.dispose();
    }
}
