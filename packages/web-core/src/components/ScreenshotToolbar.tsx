/**
 * ScreenshotToolbar — Zoom / fullscreen controls for screenshot viewer.
 *
 * Used by SessionShare and potentially Dashboard detail view.
 */

export interface ScreenshotToolbarProps {
    zoom: number;
    onZoomIn: () => void;
    onZoomOut: () => void;
    onZoomReset: () => void;
    isFullscreen: boolean;
    onToggleFullscreen: () => void;
    /** Optional extra buttons before zoom controls */
    children?: React.ReactNode;
}

export default function ScreenshotToolbar({
    zoom,
    onZoomIn,
    onZoomOut,
    onZoomReset,
    isFullscreen,
    onToggleFullscreen,
    children,
}: ScreenshotToolbarProps) {
    const btnClass = 'bg-bg-glass border border-border-default text-text-secondary px-2 py-1 rounded-md cursor-pointer text-xs font-semibold leading-none transition-all inline-flex items-center justify-center min-w-7 h-7 hover:bg-bg-glass-hover'

    return (
        <div className="flex items-center gap-1">
            {children}
            <button className={btnClass} onClick={onZoomOut} title="Zoom Out">➖</button>
            <span className="text-[11px] text-text-muted min-w-9 text-center font-semibold">
                {zoom}%
            </span>
            <button className={btnClass} onClick={onZoomIn} title="Zoom In">➕</button>
            <button className={btnClass} onClick={onZoomReset} title="Reset Zoom">🔍</button>
            <button className={btnClass} onClick={onToggleFullscreen} title="Toggle Fullscreen">
                {isFullscreen ? '✖' : '⛶'}
            </button>
        </div>
    );
}
