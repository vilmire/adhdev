import { useCallback, useEffect, useState } from 'react'
import { connectionManager } from '../compat'

interface UseIdeRemoteStreamOptions {
    doId: string
    targetSessionId?: string
    connState: string
    viewMode: 'split' | 'remote' | 'chat'
}

export function useIdeRemoteStream({
    doId,
    targetSessionId,
    connState,
    viewMode,
}: UseIdeRemoteStreamOptions) {
    const [connScreenshot, setConnScreenshot] = useState<string | null>(null)
    const [screenshotUsage, setScreenshotUsage] = useState<{
        dailyUsedMinutes: number
        dailyBudgetMinutes: number
        budgetExhausted: boolean
    } | null>(null)

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
    }, [doId, targetSessionId])

    useEffect(() => {
        const conn = doId ? connectionManager.get(doId) : null
        if (!conn || connState !== 'connected') return
        if (viewMode !== 'chat' && targetSessionId) {
            conn.startScreenshots(targetSessionId)
        } else {
            conn.stopScreenshots(targetSessionId)
        }
        return () => {
            conn.stopScreenshots(targetSessionId)
        }
    }, [viewMode, connState, targetSessionId, doId])

    const handleRemoteAction = useCallback(async (action: string, params: any) => {
        const conn = doId ? connectionManager.get(doId) : null
        if (!conn || connState !== 'connected') {
            console.warn('[RemoteInput] P2P not connected')
            return { success: false, error: 'P2P not connected' }
        }

        return conn.sendInput(action, params, targetSessionId)
    }, [doId, connState, targetSessionId])

    return {
        connScreenshot,
        screenshotUsage,
        handleRemoteAction,
    }
}
