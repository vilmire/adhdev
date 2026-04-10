/**
 * ADHDev Web Core — Base API Client
 *
 * Operates with injected BASE_URL and auth method.
 * standalone: localhost without auth
 * cloud: auth with JWT/API Key + auto-refresh
 */

import type { DaemonData } from './types'

export interface ApiClientConfig {
    baseUrl: string
    getToken?: () => string | null
    onUnauthorized?: () => void
}

export interface MuxWriteOwner {
    clientId: string
    ownerType: 'agent' | 'user'
}

export interface MuxAttachedClient {
    clientId: string
    clientType: string
    attachedAt: number
    readOnly: boolean
}

export interface MuxViewportState {
    cols: number
    rows: number
    snapshotSeq: number
    text: string
}

export interface MuxRuntimePaneState {
    paneId: string
    paneKind: 'runtime' | 'mirror'
    runtimeId: string
    runtimeKey: string
    displayName: string
    workspaceLabel: string
    accessMode: 'interactive' | 'read-only'
    lifecycle: string
    writeOwner: MuxWriteOwner | null
    attachedClients: MuxAttachedClient[]
    viewport: MuxViewportState
}

export type MuxLayoutNode =
    | { type: 'pane'; paneId: string }
    | { type: 'split'; axis: 'horizontal' | 'vertical'; ratio: number; first: MuxLayoutNode; second: MuxLayoutNode }

export interface MuxWorkspaceState {
    workspaceId: string
    title: string
    root: MuxLayoutNode
    focusedPaneId: string
    zoomedPaneId?: string | null
    panes: Record<string, MuxRuntimePaneState>
}

export interface MuxPaneSummary {
    index: number
    paneId: string
    paneKind: 'runtime' | 'mirror'
    runtimeKey: string
    accessMode: 'interactive' | 'read-only'
    focused: boolean
}

export interface MuxWorkspaceSnapshot {
    workspaceName: string
    workspace: MuxWorkspaceState
    panes: MuxPaneSummary[]
}

export interface MuxSocketInfo {
    workspaceName: string
    live: boolean
    endpoint: {
        kind: 'unix' | 'pipe'
        path: string
    }
}

export interface MuxControlRequest {
    type: string
    payload?: Record<string, unknown>
}

export interface ApiClient {
    // Daemons
    getDaemons(): Promise<{ daemons: DaemonData[] }>
    getDaemonStatus(daemonId: string): Promise<DaemonData>
    sendCommand(daemonId: string, type: string, payload?: any): Promise<any>
    execTerminal(daemonId: string, command: string, name?: string): Promise<any>

    // Agents
    sendAgentMessage(daemonId: string, agentType: string, message: string): Promise<any>
    getAgentStatus(daemonId: string): Promise<any>
    approveAgent(daemonId: string, agentType: string, approve: boolean): Promise<any>

    // Terminal mux
    getMuxState(workspaceName: string): Promise<MuxWorkspaceSnapshot>
    getMuxSocketInfo(workspaceName: string): Promise<MuxSocketInfo>
    controlMux<T = any>(workspaceName: string, type: string, payload?: Record<string, unknown>): Promise<T>
    getMuxEventsUrl(workspaceName: string): string

    // Runtime terminal
    getRuntimeEventsUrl(sessionId: string): string

    // Raw request
    request<T>(path: string, options?: RequestInit): Promise<T>
}

export function createApiClient(config: ApiClientConfig): ApiClient {
    const { baseUrl, getToken, onUnauthorized } = config

    function buildUrl(path: string): string {
        return path.startsWith('http') ? path : `${baseUrl}${path.startsWith('/') ? '' : '/'}${path}`
    }

    function buildEventStreamUrl(path: string): string {
        const token = getToken?.()
        const rawUrl = buildUrl(path)
        const url = path.startsWith('http')
            ? new URL(rawUrl)
            : new URL(rawUrl, typeof window !== 'undefined' ? window.location.origin : 'http://localhost')

        if (token) url.searchParams.set('token', token)

        if (!path.startsWith('http') && !baseUrl) {
            return `${url.pathname}${url.search}${url.hash}`
        }

        return url.toString()
    }

    async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            ...(options.headers as Record<string, string> || {}),
        }

        const token = getToken?.()
        if (token) {
            headers['Authorization'] = `Bearer ${token}`
        }

        const url = buildUrl(path)
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 15000)
        try {
            const res = await fetch(url, { ...options, headers, signal: controller.signal })

            if (res.status === 401) {
                onUnauthorized?.()
                throw new Error('Unauthorized')
            }

            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: res.statusText }))
                throw new Error(err.error || `API Error: ${res.status}`)
            }

            return res.json()
        } finally {
            clearTimeout(timer)
        }
    }

    return {
        getDaemons: () => request('/api/v1/daemons'),
        getDaemonStatus: (id) => request(`/api/v1/daemons/${id}/status`),
        sendCommand: (id, type, payload = {}) =>
            request(`/api/v1/daemons/${id}/command`, {
                method: 'POST',
                body: JSON.stringify({ type, payload }),
            }),
        execTerminal: (id, command, name) =>
            request(`/api/v1/daemons/${id}/terminal`, {
                method: 'POST',
                body: JSON.stringify({ command, name }),
            }),
        sendAgentMessage: (id, agentType, message) =>
            request(`/api/v1/shortcuts/${id}/chat`, {
                method: 'POST',
                body: JSON.stringify({ agentType, message }),
            }),
        getAgentStatus: (id) => request(`/api/v1/shortcuts/${id}/status`),
        approveAgent: (id, agentType, approve) =>
            request(`/api/v1/shortcuts/${id}/approve`, {
                method: 'POST',
                body: JSON.stringify({ agentType, action: approve ? 'approve' : 'reject' }),
            }),
        getMuxState: (workspaceName) =>
            request(`/api/v1/mux/${encodeURIComponent(workspaceName)}/state`),
        getMuxSocketInfo: (workspaceName) =>
            request(`/api/v1/mux/${encodeURIComponent(workspaceName)}/socket-info`),
        controlMux: (workspaceName, type, payload = {}) =>
            request(`/api/v1/mux/${encodeURIComponent(workspaceName)}/control`, {
                method: 'POST',
                body: JSON.stringify({ type, payload }),
            }),
        getMuxEventsUrl: (workspaceName) =>
            buildEventStreamUrl(`/api/v1/mux/${encodeURIComponent(workspaceName)}/events`),
        getRuntimeEventsUrl: (sessionId) =>
            buildEventStreamUrl(`/api/v1/runtime/${encodeURIComponent(sessionId)}/events`),
        request,
    }
}
