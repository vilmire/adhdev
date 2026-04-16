import type { ActiveConversation } from './types'
import { getConversationStopDialogLabel } from './conversation-presenters'

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
    const agentLabel = getConversationStopDialogLabel(activeConv)

    return (
        <div className="fixed inset-0 z-[1400] flex items-end justify-center overflow-y-auto px-2 pt-[calc(8px+env(safe-area-inset-top,0px))] pb-[calc(8px+env(safe-area-inset-bottom,0px))] sm:items-center sm:p-4">
            <div onClick={onCancel} className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <div
                role="dialog"
                aria-modal="true"
                className="card fade-in relative w-full sm:w-[min(92vw,420px)] md:w-[92%] md:max-w-[420px] max-h-[calc(100dvh-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px)-16px)] flex flex-col overflow-hidden rounded-[24px] sm:rounded-[18px] shadow-[0_20px_40px_rgba(0,0,0,0.4)]"
            >
                <div className="px-4 py-4 md:px-6 md:py-5 border-b border-border-subtle bg-[var(--surface-primary)]">
                    <h3 className="m-0 text-base md:text-lg font-extrabold">Stop {agentLabel}?</h3>
                    <div className="mt-1 text-[13px] md:text-sm text-text-muted leading-relaxed">
                        {canSaveAndStop
                            ? 'Stop asks the provider to exit cleanly when supported. Force Stop ends the runtime immediately.'
                            : 'This provider does not support graceful stop. Force Stop will end the runtime immediately.'}
                    </div>
                </div>

                <div className="px-4 py-4 md:px-6 md:py-5 bg-bg-primary flex flex-col gap-2.5">
                    {canSaveAndStop && (
                        <button
                            onClick={onSaveAndStop}
                            className="btn btn-primary w-full justify-center min-h-[42px]"
                        >
                            Stop
                        </button>
                    )}
                    <button
                        onClick={onStopNow}
                        className="btn btn-secondary w-full justify-center min-h-[42px] text-red-400 border-red-500/25 hover:bg-red-500/10"
                    >
                        Force Stop
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
