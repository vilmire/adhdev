/**
 * LaunchCliContext — single owner of the launch_cli call chain.
 *
 * Owns the untrusted-external-provider confirm modal so every dashboard
 * call site that needs to spawn a CLI provider can route through a
 * shared helper and get consistent trust gating without each caller
 * having to host its own modal state.
 *
 * Render shape:
 *   <LaunchCliProvider sendDaemonCommand={…}>
 *     <App />
 *   </LaunchCliProvider>
 *
 * Inside the tree:
 *   const { launchCli } = useLaunchCli()
 *   const res = await launchCli(machineId, { cliType, dir, … })
 *
 * Modal markup is rendered by the provider; callers only need the
 * `launchCli` function and the raw daemon response. On `cancelled`
 * the response shape is `{ success: false, error: 'user_cancelled_untrusted_launch' }`,
 * which mirrors the rejection the daemon would emit, so downstream
 * post-processing (trackPendingLaunch, addLog, navigate, etc.) keeps
 * working without special cases.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useUntrustedLaunchGate } from '../hooks/useUntrustedLaunchGate'
import ConfirmExternalUntrustedModal from '../pages/machine/ConfirmExternalUntrustedModal'

type SendDaemonCommand = (id: string, type: string, args: Record<string, unknown>) => Promise<any>

interface LaunchCliContextValue {
    launchCli: (machineId: string, payload: Record<string, unknown>) => Promise<any>
}

const ctx = createContext<LaunchCliContextValue | null>(null)

interface LaunchCliProviderProps {
    sendDaemonCommand: SendDaemonCommand
    children: ReactNode
}

export function LaunchCliProvider({ sendDaemonCommand, children }: LaunchCliProviderProps) {
    const gate = useUntrustedLaunchGate(sendDaemonCommand)
    const value = useMemo<LaunchCliContextValue>(() => ({
        launchCli: gate.launchCli,
    }), [gate.launchCli])
    return (
        <ctx.Provider value={value}>
            {children}
            {gate.pending && (
                <ConfirmExternalUntrustedModal
                    providerType={gate.pending.providerType}
                    sourceName={gate.pending.sourceName}
                    description={gate.pending.description}
                    onConfirm={gate.confirm}
                    onCancel={gate.cancel}
                />
            )}
        </ctx.Provider>
    )
}

export function useLaunchCli(): LaunchCliContextValue {
    const v = useContext(ctx)
    if (!v) {
        // Fall back gracefully so older trees (e.g. tests, snippets that
        // forgot to wrap with the provider) keep compiling. Callers will
        // get a thrown error at call time instead of a silent miss.
        return {
            launchCli: async () => {
                throw new Error('useLaunchCli must be used inside <LaunchCliProvider>')
            },
        }
    }
    return v
}
