/**
 * ToastContainer — Toast notification container for Dashboard
 */
import type { Toast } from '../../context/BaseDaemonContext';
export type { Toast };

export interface ToastContainerProps {
    toasts: Toast[];
    onDismiss: (id: number) => void;
    onClickToast?: (toast: Toast) => void;
}

const TYPE_TONE: Record<string, { accent: string; chipBg: string; chipText: string; label: string }> = {
    success: {
        accent: 'var(--accent-primary)',
        chipBg: 'color-mix(in srgb, var(--accent-primary) 14%, transparent)',
        chipText: 'var(--accent-primary-light)',
        label: 'Done',
    },
    warning: {
        accent: 'var(--accent-primary)',
        chipBg: 'color-mix(in srgb, var(--accent-primary) 14%, transparent)',
        chipText: 'var(--accent-primary-light)',
        label: 'Attention',
    },
    info: {
        accent: 'var(--accent-primary)',
        chipBg: 'color-mix(in srgb, var(--accent-primary) 14%, transparent)',
        chipText: 'var(--accent-primary-light)',
        label: 'Update',
    },
}

export default function ToastContainer({ toasts, onDismiss, onClickToast }: ToastContainerProps) {
    return (
        <div className="fixed right-4 z-[9999] flex flex-col gap-2 pointer-events-none" style={{ top: 'calc(env(safe-area-inset-top, 0px) + 16px)' }}>
            {toasts.map(toast => {
                const tone = TYPE_TONE[toast.type] || TYPE_TONE.info
                return (
                    <div
                        key={toast.id}
                        className="fade-in pointer-events-auto cursor-pointer animate-[toast-in_0.3s_ease-out] max-w-[380px] relative group overflow-hidden rounded-[16px] border shadow-[0_18px_40px_rgba(2,6,23,0.24)] backdrop-blur-xl"
                        style={{
                            background: 'color-mix(in srgb, var(--surface-primary) 94%, var(--bg-secondary) 6%)',
                            borderColor: 'color-mix(in srgb, var(--border-default) 88%, transparent)',
                            color: 'var(--text-primary)',
                        }}
                        onClick={() => {
                            if (!toast.actions?.length) {
                                if (onClickToast) onClickToast(toast);
                            }
                        }}
                    >
                        <div
                            className="absolute inset-y-0 left-0 w-[3px]"
                            style={{ background: `linear-gradient(180deg, ${tone.accent}, color-mix(in srgb, ${tone.accent} 55%, transparent))` }}
                        />
                        <button
                            className="absolute top-2 right-2 w-7 h-7 rounded-full flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-bg-glass transition-colors text-[13px] leading-none cursor-pointer"
                            onClick={(e) => { e.stopPropagation(); onDismiss(toast.id); }}
                            aria-label="Dismiss"
                        >×</button>
                        <div className="px-4 py-3.5 pl-5">
                            <div className="flex items-center gap-2 pr-8">
                                <span
                                    className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em]"
                                    style={{
                                        background: tone.chipBg,
                                        color: tone.chipText,
                                        border: `1px solid color-mix(in srgb, ${tone.accent} 22%, transparent)`,
                                    }}
                                >
                                    {tone.label}
                                </span>
                            </div>
                            <div className="mt-2 text-[13px] font-semibold leading-[1.45] text-text-primary">
                                {toast.message}
                            </div>
                            {toast.actions && toast.actions.length > 0 && (
                                <div className="flex gap-2 mt-3">
                                    {toast.actions.map((action, idx) => (
                                        <button
                                            key={idx}
                                            className={`text-xs px-3 py-1.5 rounded-lg font-bold border transition-colors cursor-pointer ${
                                                action.variant === 'primary'
                                                    ? ''
                                                    : action.variant === 'danger'
                                                        ? ''
                                                        : ''
                                            }`}
                                            style={
                                                action.variant === 'primary'
                                                    ? {
                                                        background: 'color-mix(in srgb, var(--accent-primary) 12%, var(--surface-primary))',
                                                        color: 'var(--text-primary)',
                                                        borderColor: 'color-mix(in srgb, var(--accent-primary) 26%, transparent)',
                                                    }
                                                    : action.variant === 'danger'
                                                        ? {
                                                            background: 'color-mix(in srgb, var(--status-error) 10%, var(--surface-primary))',
                                                            color: 'var(--status-error)',
                                                            borderColor: 'color-mix(in srgb, var(--status-error) 22%, transparent)',
                                                        }
                                                        : {
                                                            background: 'var(--surface-secondary)',
                                                            color: 'var(--text-secondary)',
                                                            borderColor: 'var(--border-subtle)',
                                                        }
                                            }
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                action.onClick();
                                                onDismiss(toast.id);
                                            }}
                                        >
                                            {action.label}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                )
            })}
        </div>
    );
}
