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
        <div className="machine-workspace-tab">
            <div className="machine-workspace-tab-header">
                <div className="machine-workspace-tab-title">Workspace launcher</div>
                <div className="machine-workspace-tab-subtitle">
                    Choose a workspace context first, then pick how you want to open it.
                </div>
            </div>

            <div className="machine-workspace-section-tabs">
                {WORKSPACE_SECTIONS.map(section => (
                    <button
                        key={section.id}
                        type="button"
                        className={`machine-workspace-section-tab${activeCategory === section.id ? ' active' : ''}`}
                        onClick={() => setActiveCategory(section.id)}
                    >
                        <span>{section.label}</span>
                        <span className="machine-workspace-section-count">{counts[section.id]}</span>
                    </button>
                ))}
            </div>

            <div className="machine-workspace-section-helper">
                {WORKSPACE_SECTIONS.find(section => section.id === activeCategory)?.helper}
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
