import type { Dispatch, KeyboardEvent, SetStateAction } from 'react'

interface RemoteViewToolbarProps {
    inputMode: 'touch' | 'mouse'
    onToggleInputMode: () => void
    isImeOpen: boolean
    setIsImeOpen: Dispatch<SetStateAction<boolean>>
    isMenuOpen: boolean
    setIsMenuOpen: Dispatch<SetStateAction<boolean>>
    imeText: string
    setImeText: Dispatch<SetStateAction<string>>
    handleImeSubmit: (event: KeyboardEvent<HTMLInputElement>) => Promise<void>
    isConnActive: boolean
    zoom: number
    isMobile: boolean
    mobileFillZoom: number
    onZoomOut: () => void
    onZoomReset: () => void
    onZoomIn: () => void
    transportType?: string
    screenshotUsage?: { dailyUsedMinutes: number; dailyBudgetMinutes: number; budgetExhausted: boolean } | null
    lastActionStatus: string | null
}

export default function RemoteViewToolbar({
    inputMode,
    onToggleInputMode,
    isImeOpen,
    setIsImeOpen,
    isMenuOpen,
    setIsMenuOpen,
    imeText,
    setImeText,
    handleImeSubmit,
    isConnActive,
    zoom,
    isMobile,
    mobileFillZoom,
    onZoomOut,
    onZoomReset,
    onZoomIn,
    transportType,
    screenshotUsage,
    lastActionStatus,
}: RemoteViewToolbarProps) {
    return (
        <>
            <div
                onTouchStart={e => e.stopPropagation()}
                className="absolute bottom-0 left-0 right-0 z-20 flex items-center justify-center gap-1.5 px-3 py-2 bg-black/75 backdrop-blur-xl border-t border-white/[0.08] touch-none"
            >
                <div
                    onClick={onToggleInputMode}
                    className={`h-8 px-2.5 rounded-lg flex items-center gap-[5px] cursor-pointer ${
                        inputMode === 'mouse' ? 'bg-blue-500/25 border border-blue-500/40' : 'bg-white/[0.08] border border-white/10'
                    }`}
                >
                    <span className="text-sm">{inputMode === 'mouse' ? '🖱️' : '👆'}</span>
                    <span className={`text-[10px] font-bold ${inputMode === 'mouse' ? 'text-blue-400' : 'text-slate-400'}`}>
                        {inputMode === 'mouse' ? 'Mouse' : 'Touch'}
                    </span>
                </div>

                <div className="relative">
                    <div
                        onClick={() => { setIsImeOpen(prev => !prev); setIsMenuOpen(false) }}
                        className={`w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer ${
                            isImeOpen ? 'bg-emerald-500/25 border border-emerald-500/40' : 'bg-white/[0.08] border border-white/10'
                        }`}
                    >
                        <span className="text-sm">⌨️</span>
                    </div>
                    {isImeOpen && (
                        <div className="absolute bottom-10 left-1/2 -translate-x-1/2 w-[220px] bg-neutral-950/[0.98] backdrop-blur-[30px] rounded-xl border border-white/20 p-[10px_12px] shadow-[0_10px_30px_rgba(0,0,0,0.8)] flex flex-col gap-2 z-20" style={{ animation: 'slideUp 0.15s ease-out' }}>
                            <input
                                type="text"
                                placeholder="Type & Enter..."
                                value={imeText}
                                autoFocus
                                onTouchStart={e => e.stopPropagation()}
                                onChange={e => setImeText(e.target.value)}
                                onKeyDown={event => { void handleImeSubmit(event) }}
                                className="w-full bg-black/60 border border-white/15 rounded-lg px-2.5 py-2 text-white text-[13px] outline-none"
                            />
                        </div>
                    )}
                </div>

                <div className="relative">
                    <div
                        onClick={() => { setIsMenuOpen(prev => !prev); setIsImeOpen(false) }}
                        className={`w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer ${
                            isMenuOpen ? 'bg-blue-500/25 border border-blue-500/40' : 'bg-white/[0.08] border border-white/10'
                        }`}
                    >
                        <span className="text-sm">⚙️</span>
                    </div>
                </div>

                <div className="w-px h-[18px] bg-white/10" />

                <div className="flex items-center gap-1.5">
                    <div
                        className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-md"
                        style={{ background: isConnActive ? 'rgba(34,197,94,0.12)' : 'rgba(234,179,8,0.12)' }}
                    >
                        <div className="w-1 h-1 rounded-full" style={{ background: isConnActive ? '#22c55e' : '#eab308', boxShadow: isConnActive ? '0 0 4px #22c55e80' : '0 0 4px #eab30880' }} />
                        <span className="text-[8px] font-extrabold" style={{ color: isConnActive ? '#22c55e' : '#eab308' }}>
                            {isConnActive ? 'Connected' : 'WS'}
                        </span>
                    </div>
                    {zoom > 1.0 && (
                        <span className="text-[8px] font-bold text-indigo-400">{Math.round(zoom * 100)}%</span>
                    )}
                    {transportType === 'direct' && (
                        <span
                            className="text-[8px] font-bold px-1 py-0.5 rounded"
                            style={{ color: '#22c55e', background: 'rgba(34,197,94,0.12)' }}
                            title="Direct P2P connection"
                        >
                            Direct
                        </span>
                    )}
                    {transportType === 'relay' && (
                        <span
                            className="text-[8px] font-bold px-1 py-0.5 rounded"
                            style={{ color: 'var(--status-warning)', background: 'color-mix(in srgb, var(--status-warning) 12%, transparent)' }}
                            title="TURN relay in use"
                        >
                            Relay
                        </span>
                    )}
                    {screenshotUsage && screenshotUsage.dailyBudgetMinutes > 0 && (
                        <span
                            className="text-[8px] font-bold px-1 py-0.5 rounded"
                            style={{
                                color: screenshotUsage.budgetExhausted ? '#ef4444' : '#c4b5fd',
                                background: screenshotUsage.budgetExhausted ? 'rgba(239,68,68,0.1)' : 'rgba(139,92,246,0.14)',
                            }}
                            title="Daily TURN relay usage"
                        >
                            {screenshotUsage.budgetExhausted
                                ? 'TURN blocked'
                                : `TURN ${screenshotUsage.dailyUsedMinutes}/${screenshotUsage.dailyBudgetMinutes}m`}
                        </span>
                    )}
                    {lastActionStatus && (
                        <span className="text-[8px] text-neutral-500 font-semibold max-w-[100px] overflow-hidden text-ellipsis whitespace-nowrap">{lastActionStatus}</span>
                    )}
                </div>
            </div>

            {isMenuOpen && (
                <div
                    onTouchStart={e => e.stopPropagation()}
                    style={{
                        position: 'absolute',
                        bottom: 56,
                        left: '50%',
                        transform: 'translateX(-50%)',
                        width: 220,
                        background: 'rgba(23, 23, 23, 0.95)',
                        backdropFilter: 'blur(25px)',
                        borderRadius: 14,
                        border: '1px solid rgba(255,255,255,0.1)',
                        padding: 14,
                        boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 12,
                        zIndex: 20,
                        touchAction: 'none',
                        animation: 'slideUpSidebar 0.15s ease-out',
                    }}
                >
                    <div style={{ fontSize: 9, fontWeight: 900, color: '#3b82f6', letterSpacing: 1.5 }}>SETTINGS</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <div style={{ fontSize: 10, color: '#888', fontWeight: 700 }}>
                            ZOOM: {zoom <= (isMobile ? mobileFillZoom : 1.0) + 0.01 ? (isMobile ? 'FILL' : 'FIT') : `${Math.round(zoom * 100)}%`}
                        </div>
                        <div style={{ display: 'flex', gap: 4 }}>
                            <button onClick={e => { e.stopPropagation(); onZoomOut() }} style={{ flex: 1, background: 'rgba(255,255,255,0.1)', color: '#fff', border: 'none', padding: '6px', borderRadius: 6, fontSize: 12, fontWeight: 800, cursor: 'pointer' }}>−</button>
                            <button onClick={e => { e.stopPropagation(); onZoomReset() }} style={{ flex: 1, background: 'rgba(255,255,255,0.1)', color: '#fff', border: 'none', padding: '6px', borderRadius: 6, fontSize: 9, fontWeight: 800, cursor: 'pointer' }}>{isMobile ? 'FILL' : 'FIT'}</button>
                            <button onClick={e => { e.stopPropagation(); onZoomIn() }} style={{ flex: 1, background: 'rgba(255,255,255,0.1)', color: '#fff', border: 'none', padding: '6px', borderRadius: 6, fontSize: 12, fontWeight: 800, cursor: 'pointer' }}>+</button>
                        </div>
                    </div>
                </div>
            )}
        </>
    )
}
