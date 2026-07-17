import { useTranslation } from 'react-i18next'
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
    const { t } = useTranslation('common')
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
                    className="px-3 py-1.5 rounded-md min-w-[200px] flex-1 text-sm bg-bg-primary border border-border-default focus:border-accent-primary focus:outline-none transition-colors"
                >
                    {(machine.workspaces || []).length > 0 ? (
                        <>
                            <option value="">{t('machine.workspace.noWorkspace')}</option>
                            {(machine.workspaces || []).map(w => (
                                <option key={w.id} value={w.id}>
                                    {w.id === machine.defaultWorkspaceId ? '⭐ ' : ''}
                                    {getWorkspaceDisplayLabel(w.path, w.label)}
                                </option>
                            ))}
                            <option value="__custom__">{canBrowse ? t('machine.workspace.selectWorkspace') : t('machine.workspace.customPath')}</option>
                        </>
                    ) : (
                        <>
                            <option value="">{t('machine.workspace.noWorkspacesSaved')}</option>
                            <option value="__custom__">{canBrowse ? t('machine.workspace.selectWorkspace') : t('machine.workspace.customPath')}</option>
                        </>
                    )}
                </select>
                {selectedWorkspace === '__custom__' && (
                    canBrowse ? (
                        <button
                            type="button"
                            className="px-3 py-1.5 rounded-md text-sm bg-bg-primary border border-border-default hover:border-accent-primary text-text-secondary hover:text-text-primary transition-colors"
                            onClick={onOpenBrowseDialog}
                        >
                            {t('machine.workspace.selectWorkspaceBtn')}
                        </button>
                    ) : (
                        <input
                            type="text"
                            placeholder={t('machine.workspace.enterAbsolutePath')}
                            value={customPath}
                            onChange={e => onCustomPathChange(e.target.value)}
                            className="px-3 py-1.5 rounded-md flex-1 min-w-[200px] text-sm bg-bg-primary border border-border-default focus:border-accent-primary focus:outline-none transition-colors"
                            autoFocus
                        />
                    )
                )}
            </div>
            <div className="mt-1.5 text-[10px] text-text-muted">
                {selectedWorkspace === '__custom__'
                    ? (resolvedWorkspacePath
                        ? <span className="font-mono truncate block" title={resolvedWorkspacePath}>{resolvedWorkspacePath}</span>
                        : (canBrowse ? t('machine.workspace.browseHint') : t('machine.workspace.absolutePathHint')))
                    : resolvedWorkspacePath
                        ? (
                            <>
                                <span className="font-medium text-text-secondary">
                                    {selectedWorkspace === machine.defaultWorkspaceId ? t('machine.workspace.defaultWorkspace') : t('machine.workspace.selectedWorkspace')}
                                </span>
                                <span className="font-mono truncate block" title={resolvedWorkspacePath}>{resolvedWorkspacePath}</span>
                            </>
                        )
                        : t('machine.workspace.noWorkspaceSelected')}
            </div>
        </div>
    )
}
