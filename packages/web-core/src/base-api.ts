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

    // Raw request
    request<T>(path: string, options?: RequestInit): Promise<T>
}

export function createApiClient(config: ApiClientConfig): ApiClient {
    const { baseUrl, getToken, onUnauthorized } = config

    async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            ...(options.headers as Record<string, string> || {}),
        }

        const token = getToken?.()
        if (token) {
            headers['Authorization'] = `Bearer ${token}`
        }

        const url = path.startsWith('http') ? path : `${baseUrl}${path.startsWith('/') ? '' : '/'}${path}`
        const res = await fetch(url, { ...options, headers })

        if (res.status === 401) {
            onUnauthorized?.()
            throw new Error('Unauthorized')
        }

        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }))
            throw new Error(err.error || `API Error: ${res.status}`)
        }

        return res.json()
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
        request,
    }
}
