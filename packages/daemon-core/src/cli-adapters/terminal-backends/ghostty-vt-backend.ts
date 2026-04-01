import type {
    TerminalViewportBackend,
    TerminalViewportBackendOptions,
    TerminalViewportBackendPreference,
} from './types.js';

type GhosttyVtTerminal = {
    write(data: string | Uint8Array): void;
    resize(cols: number, rows: number): void;
    formatPlainText(options?: { trim?: boolean }): string;
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
    const code = (error as any).code;
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

function loadGhosttyVtBinding(required: boolean): GhosttyVtBinding | null {
    if (cachedBinding !== undefined) {
        if (!cachedBinding && required && cachedBindingError) {
            throw cachedBindingError;
        }
        return cachedBinding;
    }

    const errors: string[] = [];

    for (const ref of getBindingCandidates()) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const mod = require(ref);
            cachedBinding = normalizeBinding(mod, ref);
            cachedBindingError = null;
            return cachedBinding;
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
        `ghostty-vt backend requested but no binding is available (${errors.join('; ') || 'no candidates tried'})`,
    );

    if (required) throw cachedBindingError;
    return null;
}

export function resolveTerminalBackendPreference(): TerminalViewportBackendPreference {
    const raw = process.env.ADHDEV_TERMINAL_BACKEND?.trim().toLowerCase();
    if (raw === 'ghostty-vt' || raw === 'xterm' || raw === 'auto') return raw;
    return 'auto';
}

export function isGhosttyVtBackendAvailable(): boolean {
    return !!loadGhosttyVtBinding(false);
}

export class GhosttyVtTerminalBackend implements TerminalViewportBackend {
    readonly kind = 'ghostty-vt' as const;
    private terminal: GhosttyVtTerminal;

    constructor(options: TerminalViewportBackendOptions) {
        const binding = loadGhosttyVtBinding(true);
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
        return this.terminal.formatPlainText({ trim: true }) || '';
    }

    dispose(): void {
        this.terminal.dispose();
    }
}
