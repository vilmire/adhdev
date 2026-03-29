/**
 * ConnectionBadge — Connection status badge component
 *
 * Generic badge: platform injects the connection info.
 * Cloud: shows P2P state. Standalone: hidden (no badge needed).
 */

interface ConnectionBadgeProps {
    /** Connection info from platform context */
    connection?: { status: string; label: string; peers?: number }
}

export default function ConnectionBadge({ connection }: ConnectionBadgeProps) {
    if (!connection) return null

    const connected = connection.status === 'connected'
    return (
        <div className={`px-2 py-0.5 rounded text-[9px] font-semibold flex items-center gap-1 ${
            connected ? 'bg-green-500/[0.08] text-green-400' : 'bg-yellow-500/[0.08] text-yellow-400'
        }`}>
            <span
                className="w-1 h-1 rounded-full"
                style={{
                    background: connected ? '#22c55e' : '#eab308',
                    boxShadow: connected ? '0 0 6px rgba(34,197,94,0.4)' : 'none',
                }}
            />
            {connection.label}{connected && connection.peers ? ` · ${connection.peers}` : ''}
        </div>
    )
}
