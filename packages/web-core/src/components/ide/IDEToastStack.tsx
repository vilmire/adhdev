interface IDEToastStackProps {
    toasts: { id: number; message: string; type: 'success' | 'info' | 'warning' }[]
    onDismiss: (id: number) => void
}

export default function IDEToastStack({ toasts, onDismiss }: IDEToastStackProps) {
    if (toasts.length === 0) return null

    return (
        <div className="ide-toasts">
            {toasts.map(toast => (
                <div
                    key={toast.id}
                    className={`ide-toast ${toast.type}`}
                    onClick={() => onDismiss(toast.id)}
                >
                    {toast.message}
                </div>
            ))}
        </div>
    )
}
