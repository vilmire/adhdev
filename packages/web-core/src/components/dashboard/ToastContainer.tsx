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

const TYPE_BG: Record<string, string> = {
    success: 'rgba(16, 185, 129, 0.95)',
    warning: 'color-mix(in srgb, var(--status-warning) 95%, transparent)',
    info: 'rgba(99, 102, 241, 0.95)',
}

export default function ToastContainer({ toasts, onDismiss, onClickToast }: ToastContainerProps) {
    return (
        <div className="fixed right-4 z-[9999] flex flex-col gap-2 pointer-events-none" style={{ top: 'calc(env(safe-area-inset-top, 0px) + 16px)' }}>
            {toasts.map(toast => (
                <div
                    key={toast.id}
                    className="fade-in text-white px-5 py-3 rounded-xl text-[13px] font-semibold shadow-[0_8px_32px_rgba(0,0,0,0.3)] backdrop-blur-lg pointer-events-auto cursor-pointer animate-[toast-in_0.3s_ease-out] max-w-[360px] relative group"
                    style={{ background: TYPE_BG[toast.type] || TYPE_BG.info }}
                    onClick={() => {
                        if (!toast.actions?.length) {
                            if (onClickToast) onClickToast(toast);
                            onDismiss(toast.id);
                        }
                    }}
                >
                    {/* Close button */}
                    <button
                        className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full flex items-center justify-center text-white/50 hover:text-white hover:bg-white/20 transition-all text-[11px] leading-none opacity-0 group-hover:opacity-100 cursor-pointer"
                        onClick={(e) => { e.stopPropagation(); onDismiss(toast.id); }}
                        aria-label="Dismiss"
                    >×</button>
                    <div className="pr-4">{toast.message}</div>
                    {toast.actions && toast.actions.length > 0 && (
                        <div className="flex gap-2 mt-2">
                            {toast.actions.map((action, idx) => (
                                <button
                                    key={idx}
                                    className={`text-xs px-3 py-1 rounded-md font-bold transition-all cursor-pointer ${
                                        action.variant === 'primary'
                                            ? 'bg-white text-text-primary hover:bg-gray-100'
                                            : action.variant === 'danger'
                                            ? 'bg-red-500/30 text-white hover:bg-red-500/50'
                                            : 'bg-white/20 text-white hover:bg-white/30'
                                    }`}
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
            ))}
        </div>
    );
}
