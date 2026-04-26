import { getWorkspaceDisplayLabel } from '../../utils/daemon-utils'
import type { MachineData } from './types'

interface AgentWorkspaceSelectorProps {
    machine: MachineData
    selectedWorkspace: string
    resolvedWorkspacePath: string
    customPath: string
    canBrowse: boolean
    onWorkspaceChange: (value: string) => void
    onCustomPathChange: (value: string) => void
    onOpenBrowseDialog: () => void
}

export default function AgentWorkspaceSelector({
    machine,
    selectedWorkspace,
    resolvedWorkspacePath,
    customPath,
    canBrowse,
    onWorkspaceChange,
    onCustomPathChange,
    onOpenBrowseDialog,
}: AgentWorkspaceSelectorProps) {
    return (
        <div className="mb-3">
            <div className="flex gap-2 items-center flex-wrap">
                <select
                    value={selectedWorkspace}
                    onChange={e => {
                        const nextValue = e.target.value
                        onWorkspaceChange(nextValue)
                        if (nextValue === '__custom__' && canBrowse) {
                            onOpenBrowseDialog()
                            return
                        }
                        if (nextValue !== '__custom__') onCustomPathChange('')
                    }}
                    className="px-3 py-1.5 rounded-md min-w-[200px] flex-1 text-sm bg-bg-primary border border-[#ffffff1a] focus:border-accent-primary focus:outline-none transition-colors"
                >
                    {(machine.workspaces || []).length > 0 ? (
                        <>
                            <option value="">(no workspace — launch in home)</option>
                            {(machine.workspaces || []).map(w => (
                                <option key={w.id} value={w.id}>
                                    {w.id === machine.defaultWorkspaceId ? '⭐ ' : ''}
                                    {getWorkspaceDisplayLabel(w.path, w.label)}
                                </option>
                            ))}
                            <option value="__custom__">{canBrowse ? '📁 Select workspace…' : '✏️ Custom path…'}</option>
                        </>
                    ) : (
                        <>
                            <option value="">(no workspaces saved — add in Overview tab)</option>
                            <option value="__custom__">{canBrowse ? '📁 Select workspace…' : '✏️ Custom path…'}</option>
                        </>
                    )}
                </select>
                {selectedWorkspace === '__custom__' && (
                    canBrowse ? (
                        <button
                            type="button"
                            className="px-3 py-1.5 rounded-md text-sm bg-bg-primary border border-[#ffffff1a] hover:border-accent-primary text-text-secondary hover:text-text-primary transition-colors"
                            onClick={onOpenBrowseDialog}
                        >
                            Select workspace…
                        </button>
                    ) : (
                        <input
                            type="text"
                            placeholder="Enter absolute path…"
                            value={customPath}
                            onChange={e => onCustomPathChange(e.target.value)}
                            className="px-3 py-1.5 rounded-md flex-1 min-w-[200px] text-sm bg-bg-primary border border-[#ffffff1a] focus:border-accent-primary focus:outline-none transition-colors"
                            autoFocus
                        />
                    )
                )}
            </div>
            <div className="mt-1.5 text-[10px] text-text-muted">
                {selectedWorkspace === '__custom__'
                    ? (resolvedWorkspacePath
                        ? <span className="font-mono truncate block" title={resolvedWorkspacePath}>{resolvedWorkspacePath}</span>
                        : (canBrowse ? 'Browse to a folder before launching there.' : 'Enter an absolute path to launch there.'))
                    : resolvedWorkspacePath
                        ? (
                            <>
                                <span className="font-medium text-text-secondary">
                                    {selectedWorkspace === machine.defaultWorkspaceId ? 'Default workspace' : 'Selected workspace'}
                                </span>
                                <span className="font-mono truncate block" title={resolvedWorkspacePath}>{resolvedWorkspacePath}</span>
                            </>
                        )
                        : 'No workspace selected. This launches in the home directory.'}
            </div>
        </div>
    )
}
