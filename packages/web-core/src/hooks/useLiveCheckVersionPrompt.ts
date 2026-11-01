/**
 * Post-deploy prompt: when a daemon's reported version CHANGES while the dashboard watches it (a
 * deploy + restart landed) and that machine has open live checks, offer a dismissible prompt that
 * opens Needs You filtered to the machine. Client-side only — the machine name is matched against
 * the live-check `machine` tag in the already-loaded inbox snapshot; nothing is sent anywhere.
 * First sighting of a daemon is a baseline, never a change.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DaemonData } from '../types'
import { getMachineDisplayName } from '../utils/daemon-utils'
import { countLiveChecksByMachine, type NeedsYouLiveCheck } from '../components/needs-you/needs-you-model'

export interface LiveCheckPrompt {
    daemonId: string
    machine: string
    count: number
    version: string
}

function machineNames(daemon: any): string[] {
    const out = new Set<string>()
    for (const v of [getMachineDisplayName(daemon, { fallbackId: daemon.id }), daemon.ownerMachineName, daemon.hostname, daemon.machineNickname, daemon.nickname]) {
        if (typeof v === 'string' && v.trim()) out.add(v.trim())
    }
    return [...out]
}

export function useLiveCheckVersionPrompt(ides: readonly DaemonData[], liveChecks: readonly Pick<NeedsYouLiveCheck, 'machine'>[]) {
    const seen = useRef(new Map<string, string>())
    const [changed, setChanged] = useState<Record<string, string>>({})
    const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set())

    useEffect(() => {
        const updates: Record<string, string> = {}
        for (const d of ides as any[]) {
            if (d?.type !== 'adhdev-daemon' || typeof d.id !== 'string') continue
            const version = typeof d.version === 'string' ? d.version.trim() : ''
            if (!version) continue
            const prev = seen.current.get(d.id)
            seen.current.set(d.id, version)
            if (prev !== undefined && prev !== version) updates[d.id] = version
        }
        if (Object.keys(updates).length) setChanged(prev => ({ ...prev, ...updates }))
    }, [ides])

    const byMachine = useMemo(() => countLiveChecksByMachine(liveChecks), [liveChecks])

    const prompts = useMemo<LiveCheckPrompt[]>(() => {
        const out: LiveCheckPrompt[] = []
        for (const d of ides as any[]) {
            const version = changed[d?.id]
            if (!version) continue
            const key = `${d.id}@${version}`
            if (dismissed.has(key)) continue
            for (const name of machineNames(d)) {
                const count = byMachine.get(name.toLowerCase())
                if (count) { out.push({ daemonId: d.id, machine: name, count, version }); break }
            }
        }
        return out
    }, [ides, changed, dismissed, byMachine])

    const dismiss = (p: LiveCheckPrompt) => setDismissed(prev => new Set(prev).add(`${p.daemonId}@${p.version}`))
    return { prompts, dismiss }
}
