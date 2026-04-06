import type { ActiveConversation } from './types'

interface CliStopDialogProps {
    activeConv: ActiveConversation
    canSaveAndStop?: boolean
    onCancel: () => void
    onStopNow: () => void
    onSaveAndStop: () => void
}

export default function CliStopDialog({
    activeConv,
    canSaveAndStop = false,
    onCancel,
    onStopNow,
    onSaveAndStop,
}: CliStopDialogProps) {
    const agentLabel = activeConv.agentName || activeConv.ideType || 'CLI'

    return (
        <div className="fixed inset-0 z-[1400] flex items-center justify-center p-4">
            <div onClick={onCancel} className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <div
                role="dialog"
                aria-modal="true"
                className="card fade-in relative w-[min(92vw,420px)] md:w-[92%] md:max-w-[420px] flex flex-col overflow-hidden rounded-[18px] shadow-[0_20px_40px_rgba(0,0,0,0.4)]"
            >
                <div className="px-4 py-4 md:px-6 md:py-5 border-b border-border-subtle bg-[var(--surface-primary)]">
                    <h3 className="m-0 text-base md:text-lg font-extrabold">Stop {agentLabel}?</h3>
                    <div className="mt-1 text-[13px] md:text-sm text-text-muted leading-relaxed">
                        {canSaveAndStop
                            ? 'The CLI runtime will stop. Choose whether to stop immediately or ask the provider to save and exit first.'
                            : 'The CLI runtime will stop immediately. This provider does not expose save-and-stop.'}
                    </div>
                </div>

                <div className="px-4 py-4 md:px-6 md:py-5 bg-bg-primary flex flex-col gap-2.5">
                    {canSaveAndStop && (
                        <button
                            onClick={onSaveAndStop}
                            className="btn btn-primary w-full justify-center min-h-[42px]"
                        >
                            Save and stop
                        </button>
                    )}
                    <button
                        onClick={onStopNow}
                        className="btn btn-secondary w-full justify-center min-h-[42px] text-red-400 border-red-500/25 hover:bg-red-500/10"
                    >
                        Stop now
                    </button>
                    <button
                        onClick={onCancel}
                        className="btn btn-secondary w-full justify-center min-h-[42px]"
                    >
                        Cancel
                    </button>
                </div>
            </div>
        </div>
    )
}
