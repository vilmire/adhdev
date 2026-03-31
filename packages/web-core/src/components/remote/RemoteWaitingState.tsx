interface RemoteWaitingStateProps {
    waitingLabel: string
    waitingHint: string
    transportType?: string
}

export default function RemoteWaitingState({
    waitingLabel,
    waitingHint,
    transportType,
}: RemoteWaitingStateProps) {
    return (
        <div className="text-center flex flex-col items-center gap-3 px-6">
            <div
                className="w-14 h-14 rounded-2xl flex items-center justify-center border border-white/10 bg-white/[0.04] shadow-[0_10px_30px_rgba(0,0,0,0.35)]"
                style={{ animation: 'remote-float 2.8s ease-in-out infinite' }}
            >
                <img src="/otter-logo.png" alt="" className="w-8 h-8 opacity-90" />
            </div>
            <div className="text-white/85 text-[13px] font-semibold tracking-wide">{waitingLabel}</div>
            <div className="text-[11px] text-white/40">{waitingHint}</div>
            {transportType === 'relay' && (
                <div className="text-[10px] text-amber-300/80">TURN relay active</div>
            )}
        </div>
    )
}
