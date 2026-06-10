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

function loadGhosttyVtBinding(): GhosttyVtBinding {
    if (cachedBinding !== undefined) {
        if (!cachedBinding && cachedBindingError) throw cachedBindingError;
        return cachedBinding!;
    }

    const errors: string[] = [];

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
            const message = error instanceof Error ? error.message : String(error);
            errors.push(`${ref}: ${message}`);
        }
    }

    cachedBinding = null;
    cachedBindingError = new Error(
        `ghostty-vt binding unavailable (${errors.join('; ') || 'no candidates tried'})`,
    );
    throw cachedBindingError;
}

export class GhosttyVtTerminalBackend implements TerminalViewportBackend {
    readonly kind = 'ghostty-vt' as const;
    private terminal: GhosttyVtTerminal;

    constructor(options: TerminalViewportBackendOptions) {
        const binding = loadGhosttyVtBinding();
        this.terminal = binding.createTerminal({
            cols: Math.max(1, options.cols | 0),
            rows: Math.max(1, options.rows | 0),
            scrollback: Math.max(0, options.scrollback | 0),
        });
    }

    resize(rows: number, cols: number): void {
        this.terminal.resize(Math.max(1, cols | 0), Math.max(1, rows | 0));
    }

    write(data: string): void {
        if (!data) return;
        this.terminal.write(data);
    }

    getText(): string {
        // ghostty's `trim:true` collapses CUF-advanced cells — many TUIs including
        // Claude Code render spaces via cursor-forward rather than literal spaces,
        // which would break downstream regex matching. Keep per-row padding and
        // trim trailing whitespace ourselves.
        const raw = this.terminal.formatPlainText({ trim: false }) || '';
        if (!raw) return '';
        const lines = raw.split('\n').map((row) => row.replace(/\s+$/, ''));
        let first = 0;
        let last = lines.length;
        while (first < last && !lines[first]) first += 1;
        while (last > first && !lines[last - 1]) last -= 1;
        return lines.slice(first, last).join('\n');
    }

    getCursorPosition(): { col: number; row: number } {
        return this.terminal.getCursorPosition();
    }

    dispose(): void {
        this.terminal.dispose();
    }
}
