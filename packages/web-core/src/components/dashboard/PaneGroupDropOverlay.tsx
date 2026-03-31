interface PaneGroupDropOverlayProps {
    dropAction: 'split-left' | 'merge' | 'split-right' | null
    canSplit: boolean
}

export default function PaneGroupDropOverlay({ dropAction, canSplit }: PaneGroupDropOverlayProps) {
    return (
        <div className="absolute inset-0 z-10 pointer-events-none hidden md:flex">
            <div
                className="flex-1 border-r border-white/10 transition-all duration-150 flex items-center justify-center"
                style={{
                    background: dropAction === 'split-left' ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.04)',
                    boxShadow: dropAction === 'split-left' ? 'inset 0 0 0 2px var(--accent-primary)' : 'inset 0 0 0 1px rgba(255,255,255,0.05)',
                    opacity: canSplit ? 1 : 0.45,
                }}
            >
                <div className="px-3 py-1.5 rounded-full text-[11px] font-semibold text-white bg-black/45 backdrop-blur-sm">
                    Split Left
                </div>
            </div>
            <div
                className="flex-1 border-r border-white/10 transition-all duration-150 flex items-center justify-center"
                style={{
                    background: dropAction === 'merge' ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.04)',
                    boxShadow: dropAction === 'merge' ? 'inset 0 0 0 2px var(--accent-primary)' : 'inset 0 0 0 1px rgba(255,255,255,0.05)',
                }}
            >
                <div className="px-3 py-1.5 rounded-full text-[11px] font-semibold text-white bg-black/45 backdrop-blur-sm">
                    Move Here
                </div>
            </div>
            <div
                className="flex-1 transition-all duration-150 flex items-center justify-center"
                style={{
                    background: dropAction === 'split-right' ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.04)',
                    boxShadow: dropAction === 'split-right' ? 'inset 0 0 0 2px var(--accent-primary)' : 'inset 0 0 0 1px rgba(255,255,255,0.05)',
                    opacity: canSplit ? 1 : 0.45,
                }}
            >
                <div className="px-3 py-1.5 rounded-full text-[11px] font-semibold text-white bg-black/45 backdrop-blur-sm">
                    Split Right
                </div>
            </div>
        </div>
    )
}
