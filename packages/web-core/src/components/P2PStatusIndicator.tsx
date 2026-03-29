/**
 * P2PStatusIndicator — Connection state dot + label.
 *
 * Used by:
 *   - Dashboard (session tabs, header)
 *   - SessionShare (viewer header)
 */

export interface P2PStatusIndicatorProps {
    /** P2P connection state */
    state: string;
    /** Show text label (default: true) */
    showLabel?: boolean;
    /** Custom label map override */
    labels?: Record<string, string>;
    /** Optional className */
    className?: string;
    /** Optional inline style */
    style?: React.CSSProperties;
}

const DEFAULT_LABELS: Record<string, string> = {
    connected: 'Connected',
    connecting: 'Connecting...',
    new: 'Connecting...',
    disconnected: 'Disconnected',
    failed: 'Connection Failed',
    closed: 'Closed',
    evicted: 'Session Taken',
};

const STATE_COLORS: Record<string, string> = {
    connected: '#10b981',
    connecting: '#f59e0b',
    new: '#f59e0b',
    disconnected: '#ef4444',
    failed: '#ef4444',
    closed: '#6b7280',
    evicted: '#ef4444',
};

export default function P2PStatusIndicator({
    state,
    showLabel = true,
    labels,
    className,
    style,
}: P2PStatusIndicatorProps) {
    const color = STATE_COLORS[state] || '#6b7280';
    const label = (labels || DEFAULT_LABELS)[state] || state;
    const isPulsing = state === 'connecting' || state === 'new';

    return (
        <span
            className={`inline-flex items-center gap-1.5 text-xs ${className || ''}`}
            style={style}
        >
            <span
                className={`w-2 h-2 rounded-full shrink-0 ${isPulsing ? 'animate-[p2p-pulse_1.5s_ease-in-out_infinite]' : ''}`}
                style={{ background: color }}
            />
            {showLabel && (
                <span className="font-medium" style={{ color }}>{label}</span>
            )}
        </span>
    );
}
