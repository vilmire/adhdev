/**
 * "Start assistant" (design 2026-10-07-assistant-layer.md §4.7): offered while
 * no assistant session exists and some machine can host one. Sends
 * `launch_assistant {cliType}` through the dashboard's normal command transport
 * (standalone REST/WS, cloud P2P) — the daemon is idempotent, so a double click
 * or a race with another dashboard returns the live session instead of a second one.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import type { DaemonData } from '../types'
import type { ActiveConversation } from '../components/dashboard/types'
import {
    LAUNCH_ASSISTANT_COMMAND,
    pickAssistantLaunchTarget,
    shouldOfferStartAssistant,
} from '../components/dashboard/assistant-session'

interface UseStartAssistantOptions {
    machineEntries: DaemonData[]
    conversations: ReadonlyArray<ActiveConversation>
    sendDaemonCommand: (id: string, type: string, data?: Record<string, unknown>) => Promise<any>
}

export interface StartAssistantState {
    visible: boolean
    pending: boolean
    error: string | null
    start: () => Promise<void>
}

export function useStartAssistant({ machineEntries, conversations, sendDaemonCommand }: UseStartAssistantOptions): StartAssistantState {
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const inFlight = useRef(false)
    const target = useMemo(() => pickAssistantLaunchTarget(machineEntries), [machineEntries])
    const visible = shouldOfferStartAssistant(conversations, target)

    const start = useCallback(async () => {
        if (!target || inFlight.current) return
        inFlight.current = true
        setPending(true)
        setError(null)
        try {
            const res: any = await sendDaemonCommand(target.machineId, LAUNCH_ASSISTANT_COMMAND, { cliType: target.cliType })
            const result = res?.result || res
            if (res?.success === false || result?.success === false) {
                setError(String(result?.error || res?.error || result?.code || 'launch_assistant failed'))
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        } finally {
            inFlight.current = false
            setPending(false)
        }
    }, [sendDaemonCommand, target])

    return { visible, pending, error, start }
}
