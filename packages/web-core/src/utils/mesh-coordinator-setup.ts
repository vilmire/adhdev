export interface MeshCoordinatorMcpConfig {
    mode?: 'auto_import' | 'manual' | 'none'
    format?: string
    serverName?: string
    configPathCommand?: string
    requiresRestart?: boolean
    instructions?: string
    template?: string
}

export interface MeshCoordinatorMetadata {
    supported?: boolean
    reason?: string
    mcpConfig?: MeshCoordinatorMcpConfig
}

export interface MeshCoordinatorManualSetup {
    serverName?: string
    configFormat?: string
    configPathCommand?: string
    requiresRestart?: boolean
    instructions: string
    template: string
}

export function renderCoordinatorTemplate(
    template: string,
    values: {
        meshId?: string | null
        workspace?: string | null
        serverName?: string | null
        adhdevMcpCommand?: string | null
        adhdevMcpArgs?: string | null
    },
): string {
    const meshId = values.meshId || ''
    const resolvedValues: Record<string, string> = {
        meshId,
        workspace: values.workspace || '',
        serverName: values.serverName || 'adhdev-mesh',
        adhdevMcpCommand: values.adhdevMcpCommand || 'adhdev-mcp',
        adhdevMcpArgs: values.adhdevMcpArgs || `mcp --mode ipc --repo-mesh ${meshId}`,
    }
    return template.replace(/\{\{\s*(meshId|workspace|serverName|adhdevMcpCommand|adhdevMcpArgs)\s*\}\}/g, (_, key: string) => resolvedValues[key] || '')
}

export function buildManualCoordinatorSetup(
    metadata: MeshCoordinatorMetadata | null | undefined,
    values: {
        meshId?: string | null
        workspace?: string | null
        adhdevMcpCommand?: string | null
        adhdevMcpArgs?: string | null
    } = {},
): MeshCoordinatorManualSetup | null {
    const mcpConfig = metadata?.mcpConfig
    if (mcpConfig?.mode !== 'manual') return null
    // Mirror daemon-core mesh-coordinator.ts resolveMeshCoordinatorSetup: single-line non-JSON
    // templates are reclassified as cli_command and auto-run via PTY — no manual user action needed.
    const renderedForHeuristic = renderCoordinatorTemplate(mcpConfig.template || '', {
        ...values,
        serverName: mcpConfig.serverName || 'adhdev-mesh',
    })
    const trimmed = renderedForHeuristic.trim()
    if (!trimmed.includes('\n') && !trimmed.startsWith('{')) return null
    return {
        serverName: mcpConfig.serverName || 'adhdev-mesh',
        configFormat: mcpConfig.format,
        configPathCommand: mcpConfig.configPathCommand,
        requiresRestart: mcpConfig.requiresRestart === true,
        instructions: mcpConfig.instructions || 'This provider requires manual MCP setup before it can act as a Repo Mesh coordinator.',
        template: renderCoordinatorTemplate(mcpConfig.template || '', {
            ...values,
            serverName: mcpConfig.serverName || 'adhdev-mesh',
        }),
    }
}

export function normalizeManualCoordinatorSetup(value: unknown): MeshCoordinatorManualSetup | null {
    if (!value || typeof value !== 'object') return null
    const record = value as Record<string, unknown>
    const instructions = typeof record.instructions === 'string' ? record.instructions : ''
    const template = typeof record.template === 'string' ? record.template : ''
    if (!instructions && !template) return null
    return {
        serverName: typeof record.serverName === 'string' ? record.serverName : undefined,
        configFormat: typeof record.configFormat === 'string' ? record.configFormat : undefined,
        configPathCommand: typeof record.configPathCommand === 'string' ? record.configPathCommand : undefined,
        requiresRestart: record.requiresRestart === true,
        instructions: instructions || 'This provider requires manual MCP setup before it can act as a Repo Mesh coordinator.',
        template,
    }
}
