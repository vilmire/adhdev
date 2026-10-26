export type TerminalViewportBackendKind = 'ghostty-vt';

export type TerminalViewportBackendOptions = {
    rows: number;
    cols: number;
    scrollback: number;
};

export interface TerminalViewportBackend {
    readonly kind: TerminalViewportBackendKind;
    resize(rows: number, cols: number): void;
    write(data: string): void;
    getText(): string;
    /**
     * Like getText() but includes scrollback history (the lines that have
     * scrolled above the visible viewport). Used by content-pattern matching
     * (e.g. approval/modal button extraction) that must stay correct when a
     * tall prompt — a big diff or long explanation — pushes part of the
     * prompt box above the viewport. NOT for cursor-relative / stable_ms
     * conditions, whose row indices are viewport-relative.
     */
    getTextWithScrollback(): string;
    getCursorPosition(): { col: number; row: number };
    /**
     * The cursor's row, read exactly (SUBMIT-UNCONFIRMED-RECLAIM): `row` in the
     * active-screen coordinates the cursor moves in, `left`/`right` the row's
     * cells before / from the cursor column. Null when the backend cannot read
     * it exactly. Optional: without it every composer read is `unknown`.
     */
    getCursorRow?(): { row: number; col: number; left: string; right: string } | null;
    dispose(): void;
}
