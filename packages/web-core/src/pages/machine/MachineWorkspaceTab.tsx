import ManagedWorkspacesSection from './ManagedWorkspacesSection'
import type { useMachineActions } from './useMachineActions'
import type {
    AcpSessionEntry,
    CliSessionEntry,
    IdeSessionEntry,
    MachineData,
} from './types'

interface MachineWorkspaceTabProps {
    machine: MachineData
    machineId: string
    ideSessions: IdeSessionEntry[]
    cliSessions: CliSessionEntry[]
    acpSessions: AcpSessionEntry[]
    actions: ReturnType<typeof useMachineActions>
    sendDaemonCommand?: (id: string, type: string, data?: Record<string, unknown>) => Promise<any>
}

export default function MachineWorkspaceTab({
    machine,
    machineId,
    ideSessions,
    cliSessions,
    acpSessions,
    actions,
    sendDaemonCommand,
}: MachineWorkspaceTabProps) {
    return (
        <div className="flex flex-col flex-1 min-w-0 h-full">
            <div className="flex flex-col gap-1 pb-4 border-b border-border-subtle mb-4">
                <div className="text-lg font-semibold text-text-primary">Workspaces</div>
                <div className="text-sm text-text-secondary">
                    Save folders as workspaces on this machine. Use the dashboard "+" button to launch a session.
                </div>
            </div>

            {sendDaemonCommand && (
                <ManagedWorkspacesSection
                    machineId={machineId}
                    machine={machine}
                    ideSessions={ideSessions}
                    cliSessions={cliSessions}
                    acpSessions={acpSessions}
                    actions={actions}
                    sendDaemonCommand={sendDaemonCommand}
                />
            )}
        </div>
    )
}
