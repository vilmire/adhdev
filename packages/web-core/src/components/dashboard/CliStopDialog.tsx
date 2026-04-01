import type { ActiveConversation } from './types'

interface CliStopDialogProps {
    activeConv: ActiveConversation
    onCancel: () => void
    onStopNow: () => void
    onSaveAndStop: () => void
}

export default function CliStopDialog({
    activeConv,
    onCancel,
    onStopNow,
    onSaveAndStop,
}: CliStopDialogProps) {
    const agentLabel = activeConv.agentName || activeConv.ideType || 'CLI'

    return (
        <div className="fixed inset-0 z-[1000] flex items-center justify-center">
            <div onClick={onCancel} className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <div
                role="dialog"
                aria-modal="true"
                className="card fade-in relative w-[92%] max-w-[420px] flex flex-col overflow-hidden rounded-[18px] shadow-[0_20px_40px_rgba(0,0,0,0.4)]"
            >
                <div className="px-6 py-5 border-b border-border-subtle bg-[var(--surface-primary)]">
                    <h3 className="m-0 text-lg font-extrabold">Stop {agentLabel}?</h3>
                    <div className="mt-1 text-sm text-text-muted">
                        The CLI runtime will stop. Choose whether to stop immediately or ask the provider to save and exit first.
                    </div>
                </div>

                <div className="px-6 py-5 bg-bg-primary flex flex-col gap-3">
                    <button
                        onClick={onSaveAndStop}
                        className="btn btn-primary w-full justify-center"
                    >
                        Save and stop
                    </button>
                    <button
                        onClick={onStopNow}
                        className="btn btn-secondary w-full justify-center text-red-400 border-red-500/25 hover:bg-red-500/10"
                    >
                        Stop now
                    </button>
                    <button
                        onClick={onCancel}
                        className="btn btn-secondary w-full justify-center"
                    >
                        Cancel
                    </button>
                </div>
            </div>
        </div>
    )
}
