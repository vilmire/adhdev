import { useCallback, useEffect, useMemo, useState } from 'react'
import { connectionManager } from '../compat'

interface UseIdeRemoteStreamOptions {
    doId: string
    ideId: string
    ideType: string | undefined
    connState: string
    viewMode: 'split' | 'remote' | 'chat'
    instanceId?: string
}

export function useIdeRemoteStream({
    doId,
    ideId,
    ideType,
    connState,
    viewMode,
    instanceId,
}: UseIdeRemoteStreamOptions) {
    const [connScreenshot, setConnScreenshot] = useState<string | null>(null)
    const [screenshotUsage, setScreenshotUsage] = useState<{
        dailyUsedMinutes: number
        dailyBudgetMinutes: number
        budgetExhausted: boolean
    } | null>(null)

    const screenshotTarget = useMemo(() => {
        if (!ideId) return ideType
        const parts = ideId.split(':')
        if (parts.length >= 3 && parts[1] === 'ide') return parts.slice(2).join(':')
        return ideType
    }, [ideId, ideType])

    useEffect(() => {
        if (!doId) return
        const unsub = connectionManager.onScreenshot('ide-page', (sourceDaemonId: string, blob: Blob) => {
            if (sourceDaemonId !== doId) return
            const reader = new FileReader()
            reader.onload = () => setConnScreenshot(reader.result as string)
            reader.readAsDataURL(blob)
        })
        return unsub
    }, [doId])

    useEffect(() => {
        if (connState !== 'connected') {
            setConnScreenshot(null)
        }
    }, [connState])

    useEffect(() => {
        if (!doId) return
        const unsub = connectionManager.onStatus?.((sourceDaemonId: string, payload: any) => {
            if (sourceDaemonId !== doId) return
            if (payload?.screenshotUsage) {
                setScreenshotUsage(payload.screenshotUsage)
            }
        })
        return unsub || (() => {})
    }, [doId])

    useEffect(() => {
        setConnScreenshot(null)
    }, [doId, ideId, screenshotTarget])

    useEffect(() => {
        const conn = doId ? connectionManager.get(doId) : null
        if (!conn || connState !== 'connected') return
        if (viewMode !== 'chat' && screenshotTarget) {
            conn.startScreenshots(screenshotTarget)
        } else {
            conn.stopScreenshots(screenshotTarget)
        }
        return () => {
            conn.stopScreenshots(screenshotTarget)
        }
    }, [viewMode, connState, screenshotTarget, doId])

    const handleRemoteAction = useCallback(async (action: string, params: any) => {
        const conn = doId ? connectionManager.get(doId) : null
        if (!conn || connState !== 'connected') {
            console.warn('[RemoteInput] P2P not connected')
            return { success: false, error: 'P2P not connected' }
        }

        return conn.sendInput(action, params, instanceId || screenshotTarget)
    }, [doId, connState, instanceId, screenshotTarget])

    return {
        connScreenshot,
        screenshotUsage,
        handleRemoteAction,
    }
}
