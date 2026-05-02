import { useCallback, useEffect, useMemo, useState } from 'react'
import type { GitDiffSummary, GitFileDiff, GitRepoStatus, GitWorkspaceUpdate, SubscribeRequest } from '@adhdev/daemon-core'
import { useTransport } from '../context/TransportContext'
import { subscriptionManager } from '../managers/SubscriptionManager'

export interface UseWorkspaceGitStatusOptions {
    daemonId?: string | null
    workspace?: string | null
    enabled?: boolean
    includeDiffSummary?: boolean
    intervalMs?: number
}

export interface UseWorkspaceGitStatusResult {
    status: GitRepoStatus | null
    diffSummary: GitDiffSummary | null
    loading: boolean
    error: string | null
    refresh: () => Promise<void>
}

export const DEFAULT_WORKSPACE_GIT_REFRESH_MS = 5_000

export function getWorkspaceGitSubscriptionKey(workspace: string): string {
    return `git:${workspace}`
}

export function buildWorkspaceGitSubscribeRequest({
    workspace,
    includeDiffSummary = false,
    intervalMs = DEFAULT_WORKSPACE_GIT_REFRESH_MS,
}: {
    workspace: string
    includeDiffSummary?: boolean
    intervalMs?: number
}): SubscribeRequest {
    return {
        type: 'subscribe',
        topic: 'workspace.git',
        key: getWorkspaceGitSubscriptionKey(workspace),
        params: {
            workspace,
            includeDiffSummary,
            intervalMs,
        },
    }
}

function unwrapDaemonCommandResult(response: any): any {
    if (response && typeof response === 'object' && 'result' in response && response.result && typeof response.result === 'object') {
        return response.result
    }
    return response
}

function getErrorMessage(value: unknown, fallback: string): string {
    if (value instanceof Error) return value.message
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>
        if (typeof record.error === 'string' && record.error.trim()) return record.error
        if (typeof record.message === 'string' && record.message.trim()) return record.message
    }
    return fallback
}

export function readGitStatusCommandResponse(response: any): { status: GitRepoStatus | null; error: string | null } {
    const body = unwrapDaemonCommandResult(response)
    if (body?.success === false) {
        return { status: null, error: getErrorMessage(body, 'Git status request failed') }
    }
    if (body?.status) return { status: body.status as GitRepoStatus, error: null }
    return { status: null, error: getErrorMessage(body, 'Git status response did not include status') }
}

export function readGitDiffSummaryCommandResponse(response: any): { diffSummary: GitDiffSummary | null; error: string | null } {
    const body = unwrapDaemonCommandResult(response)
    if (body?.success === false) {
        return { diffSummary: null, error: getErrorMessage(body, 'Git diff summary request failed') }
    }
    if (body?.diffSummary) return { diffSummary: body.diffSummary as GitDiffSummary, error: null }
    return { diffSummary: null, error: getErrorMessage(body, 'Git diff summary response did not include diffSummary') }
}

function isOptionalBoolean(value: unknown): boolean {
    return value === undefined || typeof value === 'boolean'
}

function isGitFileDiff(value: unknown): value is GitFileDiff {
    if (!value || typeof value !== 'object') return false
    const record = value as Record<string, unknown>
    return typeof record.path === 'string'
        && typeof record.diff === 'string'
        && isOptionalBoolean(record.binary)
        && isOptionalBoolean(record.truncated)
        && isOptionalBoolean(record.staged)
}

export function readGitDiffFileCommandResponse(response: any): { diff: GitFileDiff | null; error: string | null } {
    const body = unwrapDaemonCommandResult(response)
    if (body?.success === false) {
        return { diff: null, error: getErrorMessage(body, 'Git file diff request failed') }
    }
    if (isGitFileDiff(body?.diff)) return { diff: body.diff, error: null }
    return { diff: null, error: getErrorMessage(body, 'Git file diff response did not include a valid diff object') }
}

export function useWorkspaceGitStatus({
    daemonId,
    workspace,
    enabled = true,
    includeDiffSummary = false,
    intervalMs = DEFAULT_WORKSPACE_GIT_REFRESH_MS,
}: UseWorkspaceGitStatusOptions): UseWorkspaceGitStatusResult {
    const { sendCommand, sendData } = useTransport()
    const workspacePath = typeof workspace === 'string' ? workspace.trim() : ''
    const active = Boolean(enabled && daemonId && workspacePath)
    const [status, setStatus] = useState<GitRepoStatus | null>(null)
    const [diffSummary, setDiffSummary] = useState<GitDiffSummary | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const refresh = useCallback(async () => {
        if (!active || !daemonId || !workspacePath) return
        setLoading(true)
        setError(null)
        try {
            const statusResult = readGitStatusCommandResponse(
                await sendCommand(daemonId, 'git_status', { workspace: workspacePath }),
            )
            if (statusResult.error) {
                setStatus(null)
                setDiffSummary(null)
                setError(statusResult.error)
                return
            }
            setStatus(statusResult.status)

            if (!includeDiffSummary) {
                setDiffSummary(null)
                return
            }

            const diffResult = readGitDiffSummaryCommandResponse(
                await sendCommand(daemonId, 'git_diff_summary', { workspace: workspacePath }),
            )
            if (diffResult.error) {
                setDiffSummary(null)
                setError(diffResult.error)
                return
            }
            setDiffSummary(diffResult.diffSummary)
        } catch (err) {
            setError(getErrorMessage(err, 'Git status request failed'))
        } finally {
            setLoading(false)
        }
    }, [active, daemonId, includeDiffSummary, sendCommand, workspacePath])

    const request = useMemo(() => {
        if (!workspacePath) return null
        return buildWorkspaceGitSubscribeRequest({ workspace: workspacePath, includeDiffSummary, intervalMs })
    }, [includeDiffSummary, intervalMs, workspacePath])

    useEffect(() => {
        if (!active || !daemonId || !workspacePath || !request) {
            setStatus(null)
            setDiffSummary(null)
            setLoading(false)
            setError(null)
            return
        }

        const unsubscribe = sendData
            ? subscriptionManager.subscribe(
                { sendData },
                daemonId,
                request,
                (update: GitWorkspaceUpdate) => {
                    if (update.workspace !== workspacePath) return
                    setStatus(update.status)
                    setDiffSummary(update.diffSummary ?? null)
                    setError(update.status?.error || update.diffSummary?.error || null)
                    setLoading(false)
                },
                { retryIntervalMs: 1_000 },
            )
            : null

        void refresh()

        return () => {
            unsubscribe?.()
        }
    }, [active, daemonId, refresh, request, sendData, workspacePath])

    return { status, diffSummary, loading, error, refresh }
}
