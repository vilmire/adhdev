import { useEffect, useMemo, useState } from 'react'

import AgentTab from './AgentTab'
import type { useMachineActions } from './useMachineActions'
import type {
    AcpSessionEntry,
    CliSessionEntry,
    IdeSessionEntry,
    MachineData,
    ProviderInfo,
    WorkspaceLaunchKind,
} from './types'

interface MachineWorkspaceTabProps {
    machine: MachineData
    machineId: string
    providers: ProviderInfo[]
    ideSessions: IdeSessionEntry[]
    cliSessions: CliSessionEntry[]
    acpSessions: AcpSessionEntry[]
    actions: ReturnType<typeof useMachineActions>
    getIcon: (type: string) => string
    initialCategory?: WorkspaceLaunchKind
    initialWorkspaceId?: string | null
    initialWorkspacePath?: string | null
    sendDaemonCommand?: (id: string, type: string, data?: Record<string, unknown>) => Promise<any>
}

const WORKSPACE_SECTIONS: { id: WorkspaceLaunchKind; label: string; helper: string }[] = [
    { id: 'ide', label: 'IDE', helper: 'Open a graphical workspace and attach CDP' },
    { id: 'cli', label: 'CLI', helper: 'Launch a terminal-first workspace on this machine' },
    { id: 'acp', label: 'ACP', helper: 'Launch an ACP-backed workspace on this machine' },
]

export default function MachineWorkspaceTab({
    machine,
    machineId,
    providers,
    ideSessions,
    cliSessions,
    acpSessions,
    actions,
    getIcon,
    initialCategory = 'ide',
    initialWorkspaceId,
    initialWorkspacePath,
    sendDaemonCommand,
}: MachineWorkspaceTabProps) {
    const [activeCategory, setActiveCategory] = useState<WorkspaceLaunchKind>(initialCategory)

    useEffect(() => {
        setActiveCategory(initialCategory)
    }, [initialCategory])

    const counts = useMemo(() => ({
        ide: ideSessions.length,
        cli: cliSessions.length,
        acp: acpSessions.length,
    }), [ideSessions.length, cliSessions.length, acpSessions.length])

    return (
        <div className="flex flex-col flex-1 min-w-0 h-full">
            <div className="flex flex-col gap-1 pb-4 border-b border-[#ffffff0a] mb-4">
                <div className="text-lg font-semibold text-text-primary">Workspace Launcher</div>
                <div className="text-sm text-text-secondary">
                    Choose a workspace context first, then pick how you want to open it.
                </div>
            </div>

            <div className="flex flex-col sm:flex-row items-baseline gap-4 mb-4">
                <div className="flex bg-bg-surface p-1 rounded-lg border border-[#ffffff0a] w-fit">
                    {WORKSPACE_SECTIONS.map(section => (
                        <button
                            key={section.id}
                            type="button"
                            className={`flex items-center gap-2 px-4 py-1.5 rounded-md text-sm font-medium transition-all ${
                                activeCategory === section.id
                                    ? 'bg-[#ffffff10] text-text-primary shadow-sm'
                                    : 'text-text-secondary hover:text-text-primary hover:bg-[#ffffff05]'
                            }`}
                            onClick={() => setActiveCategory(section.id)}
                        >
                            <span>{section.label}</span>
                            <span className={`px-1.5 py-0.5 rounded-full text-[10px] ${
                                activeCategory === section.id ? 'bg-accent-primary/20 text-accent-primary' : 'bg-[#ffffff10] text-text-muted'
                            }`}>
                                {counts[section.id]}
                            </span>
                        </button>
                    ))}
                </div>
                <div className="text-xs text-text-muted italic">
                    {WORKSPACE_SECTIONS.find(section => section.id === activeCategory)?.helper}
                </div>
            </div>

            {activeCategory === 'ide' && (
                <AgentTab
                    category="ide"
                    machine={machine}
                    machineId={machineId}
                    providers={providers}
                    managedEntries={ideSessions}
                    getIcon={getIcon}
                    actions={actions}
                    sendDaemonCommand={sendDaemonCommand}
                    initialWorkspaceId={initialWorkspaceId}
                    initialWorkspacePath={initialWorkspacePath}
                />
            )}

            {activeCategory === 'cli' && (
                <AgentTab
                    category="cli"
                    machine={machine}
                    machineId={machineId}
                    providers={providers}
                    managedEntries={cliSessions}
                    getIcon={getIcon}
                    actions={actions}
                    initialWorkspaceId={initialWorkspaceId}
                    initialWorkspacePath={initialWorkspacePath}
                />
            )}

            {activeCategory === 'acp' && (
                <AgentTab
                    category="acp"
                    machine={machine}
                    machineId={machineId}
                    providers={providers}
                    managedEntries={acpSessions}
                    getIcon={getIcon}
                    actions={actions}
                    initialWorkspaceId={initialWorkspaceId}
                    initialWorkspacePath={initialWorkspacePath}
                />
            )}
        </div>
    )
}
