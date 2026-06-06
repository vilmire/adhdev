/**
 * Shared launch helper for every dashboard call site that invokes
 * `launch_cli`. Detects the daemon-side `untrusted_external_provider`
 * rejection, holds the original payload, prompts via a host-rendered
 * ConfirmExternalUntrustedModal, then retries with
 * `confirmExternalUntrusted: true` once the user accepts.
 *
 * Usage:
 *   const gate = useUntrustedLaunchGate(sendDaemonCommand)
 *   const res = await gate.launchCli(machineId, payload)
 *   if (res.ok) { … }
 *   else if (res.cancelled) { … }
 *   else { showError(res.error) }
 *
 *   // Render modal once per consumer
 *   {gate.pending && (
 *     <ConfirmExternalUntrustedModal
 *       providerType={gate.pending.providerType}
 *       sourceName={gate.pending.sourceName}
 *       description={gate.pending.description}
 *       onConfirm={gate.confirm}
 *       onCancel={gate.cancel}
 *     />
 *   )}
 */
import { useCallback, useState } from 'react'

export interface LaunchCliResult {
    ok: boolean
    cancelled?: boolean
    error?: string
    /** Raw daemon response (cloud envelope unwrapped). */
    response?: any
}

interface PendingConfirm {
    providerType: string
    sourceName: string | null
    description?: string
    retry: () => Promise<any>
    resolve: (res: LaunchCliResult) => void
}

interface UntrustedRejection {
    providerType: string | null
    sourceName: string | null
    description?: string
}

function unwrap(raw: any) {
    return (raw && typeof raw === 'object' && raw.result && typeof raw.result === 'object') ? raw.result : raw
}

function detectUntrustedRejection(res: any): UntrustedRejection | null {
    const inner = unwrap(res)
    if (!inner || inner.error !== 'untrusted_external_provider') return null
    const prov = inner.provider && typeof inner.provider === 'object' ? inner.provider : null
    return {
        providerType: typeof prov?.type === 'string' ? prov.type : null,
        sourceName: typeof prov?.sourceName === 'string' ? prov.sourceName : null,
        description: typeof inner.hint === 'string' ? inner.hint : undefined,
    }
}

type SendDaemonCommand = (id: string, type: string, args: Record<string, unknown>) => Promise<any>

export function useUntrustedLaunchGate(sendDaemonCommand: SendDaemonCommand) {
    const [pending, setPending] = useState<PendingConfirm | null>(null)

    /**
     * Wrap a launch_cli call. Returns the raw daemon response on success
     * or non-trust failure; on `untrusted_external_provider`, opens the
     * confirm prompt and only resolves after the user picks. After
     * confirm we replay with `confirmExternalUntrusted: true`.
     *
     * The returned response shape mirrors what callers got before, so
     * downstream post-processing (trackPendingLaunch, navigate, addLog,
     * etc.) keeps working unchanged.
     */
    const launchCli = useCallback(async (
        machineId: string,
        payload: Record<string, unknown>,
    ): Promise<any> => {
        const send = (extra: Record<string, unknown>) => sendDaemonCommand(machineId, 'launch_cli', { ...payload, ...extra })
        const first = await send({})
        const rejection = detectUntrustedRejection(first)
        if (!rejection) return first
        return new Promise<any>((resolve) => {
            setPending({
                providerType: rejection.providerType || String(payload.cliType ?? '?'),
                sourceName: rejection.sourceName,
                description: rejection.description,
                retry: () => send({ confirmExternalUntrusted: true }),
                resolve: (r) => {
                    if (r.cancelled) {
                        // Synthesize a "fail" shape that mirrors how the
                        // daemon would have refused — keeps the call-site
                        // error path uniform.
                        resolve({ success: false, error: 'user_cancelled_untrusted_launch' })
                    } else {
                        resolve(r.response)
                    }
                },
            })
        })
    }, [sendDaemonCommand])

    const confirm = useCallback(async () => {
        const p = pending
        if (!p) return
        setPending(null)
        try {
            const retried = await p.retry()
            const inner = unwrap(retried)
            if (inner?.success) p.resolve({ ok: true, response: retried })
            else p.resolve({ ok: false, error: inner?.error || 'launch failed after confirm', response: retried })
        } catch (e: any) {
            p.resolve({ ok: false, error: e?.message || String(e) })
        }
    }, [pending])

    const cancel = useCallback(() => {
        const p = pending
        if (!p) return
        setPending(null)
        p.resolve({ ok: false, cancelled: true })
    }, [pending])

    return { launchCli, pending, confirm, cancel }
}
