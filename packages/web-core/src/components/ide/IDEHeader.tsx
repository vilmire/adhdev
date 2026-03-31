import type { ReactNode } from 'react'
import { IconChat, IconMonitor, IconScroll } from '../Icons'

interface IDEHeaderProps {
    ideName: string
    workspaceName?: string
    connState: string
    machineName?: string
    viewMode: 'split' | 'remote' | 'chat'
    onChangeView: (mode: 'split' | 'remote' | 'chat') => void
    onOpenHistory: () => void
    headerActions?: ReactNode
    onBack: () => void
}

export default function IDEHeader({
    ideName,
    workspaceName,
    connState,
    machineName,
    viewMode,
    onChangeView,
    onOpenHistory,
    headerActions,
    onBack,
}: IDEHeaderProps) {
    return (
        <header className="ide-header">
            <div className="ide-header-left">
                <div className="ide-title">
                    <IconChat size={16} />
                    <span className="ide-name">{ideName}</span>
                    <span className="ide-name-mobile">IDE</span>
                    {workspaceName && <span className="ide-workspace">{workspaceName}</span>}
                    <span className="ide-badge">REMOTE</span>
                </div>
                <div className="ide-status-pill">
                    <span className={`ide-dot ${connState === 'connected' ? 'online' : 'connecting'}`} />
                    <span className="ide-status-text">
                        {connState === 'connected' ? 'Connected' : connState === 'connecting' ? 'Connecting' : 'WS'}
                    </span>
                </div>
                {machineName && <span className="ide-machine-label">{machineName}</span>}
            </div>
            <div className="ide-header-right">
                {(['chat', 'split', 'remote'] as const).map(mode => (
                    <button
                        key={mode}
                        className="btn btn-secondary btn-sm"
                        style={{
                            border: viewMode === mode ? '1px solid var(--accent-primary)' : 'none',
                            background: viewMode === mode ? 'rgba(99,102,241,0.12)' : 'var(--bg-secondary)',
                            padding: '6px 10px',
                            color: viewMode === mode ? 'var(--accent-primary)' : undefined,
                        }}
                        onClick={() => onChangeView(mode)}
                    >
                        {mode === 'chat' ? <IconChat size={14} /> : mode === 'split' ? '⊞' : <IconMonitor size={14} />}
                    </button>
                ))}
                <button
                    className="btn btn-secondary btn-sm flex items-center justify-center shrink-0"
                    onClick={onOpenHistory}
                    title="Chat History"
                >
                    <IconScroll size={14} />
                </button>
                {headerActions}
                <button
                    className="btn btn-primary btn-sm flex items-center justify-center shrink-0"
                    onClick={onBack}
                >
                    ←<span className="hidden md:inline ml-1">Back</span>
                </button>
            </div>
        </header>
    )
}
