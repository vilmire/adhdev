/**
 * LaunchPickModal — Workspace selection dialog for CLI/ACP launch.
 */
import type { MachineData } from './types'
import type { LaunchPickState } from './useMachineActions'
import type { useMachineActions } from './useMachineActions'

interface LaunchPickModalProps {
    machine: MachineData
    launchPick: LaunchPickState
    actions: ReturnType<typeof useMachineActions>
}

export default function LaunchPickModal({ machine, launchPick, actions }: LaunchPickModalProps) {
    const { runLaunchCliCore, setLaunchPick } = actions

    return (
        <div
            className="fixed inset-0 z-[100] flex items-end justify-center overflow-y-auto bg-black/55 backdrop-blur-[2px] px-2 pt-[calc(8px+env(safe-area-inset-top,0px))] pb-[calc(8px+env(safe-area-inset-bottom,0px))] sm:items-center sm:p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="launch-pick-title"
        >
            <div className="w-full max-w-md max-h-[calc(100dvh-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px)-16px)] rounded-[24px] sm:rounded-xl border border-border-subtle bg-bg-secondary shadow-xl p-4 sm:p-5 overflow-y-auto">
                <h2 id="launch-pick-title" className="text-sm font-semibold text-text-primary m-0 mb-1">
                    Where should this run?
                </h2>
                <p className="text-[11px] text-text-muted m-0 mb-4">
                    Nothing is assumed. Pick a saved workspace, your default workspace, or home — or cancel and type a path.
                </p>
                <div className="flex flex-col gap-2 mb-4 max-h-48 overflow-y-auto">
                    {(machine.workspaces || []).length === 0 ? (
                        <span className="text-[11px] text-text-muted">No saved workspaces yet. Add one in Overview or type a path above.</span>
                    ) : (
                        (machine.workspaces || []).map(w => (
                            <button
                                key={w.id}
                                type="button"
                                className="text-left text-xs px-3 py-2 rounded-lg border border-border-subtle bg-bg-primary hover:bg-violet-500/10 transition-colors"
                                onClick={() => {
                                    setLaunchPick(null)
                                    void runLaunchCliCore({
                                        cliType: launchPick.cliType,
                                        workspaceId: w.id,
                                        argsStr: launchPick.argsStr,
                                        model: launchPick.model,
                                    })
                                }}
                            >
                                <span className="font-medium text-text-primary block truncate">{w.label || w.path}</span>
                                <span className="text-[10px] text-text-muted font-mono truncate block">{w.path}</span>
                            </button>
                        ))
                    )}
                </div>
                <div className="flex flex-wrap gap-2">
                    <button
                        type="button"
                        className="machine-btn text-[11px] flex-1 min-w-[120px]"
                        disabled={!machine.defaultWorkspacePath}
                        onClick={() => {
                            setLaunchPick(null)
                            void runLaunchCliCore({
                                cliType: launchPick.cliType,
                                useDefaultWorkspace: true,
                                argsStr: launchPick.argsStr,
                                model: launchPick.model,
                            })
                        }}
                    >
                        Default workspace
                    </button>
                    <button
                        type="button"
                        className="machine-btn text-[11px] flex-1 min-w-[120px]"
                        onClick={() => {
                            setLaunchPick(null)
                            void runLaunchCliCore({
                                cliType: launchPick.cliType,
                                useHome: true,
                                argsStr: launchPick.argsStr,
                                model: launchPick.model,
                            })
                        }}
                    >
                        Home directory
                    </button>
                    <button
                        type="button"
                        className="machine-btn text-[11px] flex-1 min-w-[80px]"
                        onClick={() => setLaunchPick(null)}
                    >
                        Cancel
                    </button>
                </div>
            </div>
        </div>
    )
}
