/**
 * AgentTab — Unified agent management component for IDE, CLI, and ACP.
 *
 * All three categories share:
 *   1. Launch form (provider selector + dir + args + buttons)
 *   2. Running agents list with status badges and actions
 *   3. History / Recent workspaces
 *
 * Category-specific features are handled via conditional rendering:
 *   - IDE: Detected IDEs list, extension toggles, Control button, multi-window
 *   - ACP: Model field in launch form, model/plan badges, chat button
 *   - CLI: Simplest — just the base
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { isManagedStatusWorking, normalizeManagedStatus } from '@adhdev/daemon-core/status/normalize'
import { formatIdeType, getWorkspaceDisplayLabel } from '../../utils/daemon-utils'
import { IconChat, IconMonitor, IconSearch } from '../../components/Icons'
import type { MachineData, IdeSessionEntry, CliSessionEntry, AcpSessionEntry, ProviderInfo } from './types'
import type { useMachineActions } from './useMachineActions'
import { describeMuxOwner } from '../../utils/mux-ui'

type AgentCategory = 'ide' | 'cli' | 'acp'

// Union type for running entries
type AgentEntry = IdeSessionEntry | CliSessionEntry | AcpSessionEntry

interface AgentTabProps {
    category: AgentCategory
    machine: MachineData
    machineId: string
    providers: ProviderInfo[]
    managedEntries: AgentEntry[]
    getIcon: (type: string) => string
    actions: ReturnType<typeof useMachineActions>
    isDashboardHidden?: (tabKey: string) => boolean
    onToggleDashboardVisibility?: (tabKey: string) => void
    /** Required for IDE extension toggles */
    sendDaemonCommand?: (id: string, type: string, data?: Record<string, unknown>) => Promise<any>
}

// ─── Category Config ────────────────────────────────
const CATEGORY_CONFIG = {
    ide: { label: 'IDE', plural: 'IDEs', accent: 'border-blue-500/[0.12]' },
    cli: { label: 'CLI', plural: 'CLIs', accent: 'border-violet-500/[0.12]' },
    acp: { label: 'ACP Agent', plural: 'ACP agents', accent: 'border-emerald-500/[0.12]' },
} as const

export default function AgentTab({
    category, machine, machineId, providers, managedEntries, getIcon, actions, sendDaemonCommand,
    isDashboardHidden,
    onToggleDashboardVisibility,
}: AgentTabProps) {
    const navigate = useNavigate()
    const {
        handleLaunchIde, handleLaunchCli, handleStopCli, handleRestartIde, handleStopIde,
        handleDetectIdes,
        cliHistory, loadingHistory, loadCliHistory, launchingIde, launchingAgentType,
    } = actions
    const [copiedRuntimeKey, setCopiedRuntimeKey] = useState<string | null>(null)
    const openSessionInDashboard = useCallback((sessionId: string) => {
        if (!sessionId) return
        navigate({ pathname: '/', search: `?activeTab=${encodeURIComponent(sessionId)}` })
    }, [navigate])

    const config = CATEGORY_CONFIG[category]
    const isIde = category === 'ide'
    const isAcp = category === 'acp'
    const categoryProviders = providers.filter(p => p.category === category)
    const providerLabelMap = new Map(categoryProviders.map(provider => [provider.type, provider.displayName || provider.type]))

    // ─── Launch Form State ──────────────────────────
    const [selectedType, setSelectedType] = useState('')
    const [launchArgs, setLaunchArgs] = useState('')
    const [launchModel, setLaunchModel] = useState('')
    // Workspace selection: workspace-id | '__custom__' | '' (home)
    const [selectedWorkspace, setSelectedWorkspace] = useState(machine.defaultWorkspaceId || '')
    const [customPath, setCustomPath] = useState('')
    const [pendingLaunchTypes, setPendingLaunchTypes] = useState<string[]>([])
    const visiblePendingLaunches = pendingLaunchTypes
        .filter(type => !managedEntries.some(entry => entry.type === type && normalizeManagedStatus(entry.status) !== 'stopped'))
    const pendingTimeoutsRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

    // Default provider selection
    useEffect(() => {
        if (!selectedType && categoryProviders.length > 0) {
            setSelectedType(categoryProviders[0].type)
        }
    }, [selectedType, categoryProviders.length])

    // Auto-select default workspace when machine data loads
    useEffect(() => {
        if (machine.defaultWorkspaceId && !selectedWorkspace) {
            setSelectedWorkspace(machine.defaultWorkspaceId)
        }
    }, [machine.defaultWorkspaceId])

    // Resolve the actual workspace path from selection
    const resolvedWorkspacePath = (() => {
        if (selectedWorkspace === '__custom__') return customPath.trim()
        if (!selectedWorkspace) return ''
        const ws = (machine.workspaces || []).find(w => w.id === selectedWorkspace)
        return ws?.path || ''
    })()

    const clearPendingLaunch = useCallback((type: string) => {
        const timeout = pendingTimeoutsRef.current[type]
        if (timeout) {
            clearTimeout(timeout)
            delete pendingTimeoutsRef.current[type]
        }
        setPendingLaunchTypes(prev => prev.filter(item => item !== type))
    }, [])

    const markPendingLaunch = useCallback((type: string) => {
        if (!type) return
        setPendingLaunchTypes(prev => (prev.includes(type) ? prev : [...prev, type]))
        const existing = pendingTimeoutsRef.current[type]
        if (existing) clearTimeout(existing)
        pendingTimeoutsRef.current[type] = setTimeout(() => {
            setPendingLaunchTypes(prev => prev.filter(item => item !== type))
            delete pendingTimeoutsRef.current[type]
        }, 20000)
    }, [])

    useEffect(() => {
        for (const entry of managedEntries) {
            if (normalizeManagedStatus(entry.status) !== 'stopped') {
                clearPendingLaunch(entry.type)
            }
        }
    }, [managedEntries, clearPendingLaunch])

    useEffect(() => () => {
        Object.values(pendingTimeoutsRef.current).forEach(clearTimeout)
        pendingTimeoutsRef.current = {}
    }, [])

    // ─── IDE Extension State ────────────────────────
    const [ideExtensions, setIdeExtensions] = useState<Record<string, { type: string; name: string; enabled: boolean }[]>>({})
    const [extToggling, setExtToggling] = useState<string | null>(null)

    useEffect(() => {
        if (!isIde || !machineId || !sendDaemonCommand) return
        const fetchExtensions = async () => {
            try {
                const res: any = await sendDaemonCommand(machineId, 'get_ide_extensions', {})
                const payload = res?.result || res
                if (payload?.success && payload?.ideExtensions) setIdeExtensions(payload.ideExtensions)
            } catch { /* silent */ }
        }
        fetchExtensions()
    }, [isIde, machineId, sendDaemonCommand])

    // ─── Helpers ────────────────────────────────────
    const getName = (entry: AgentEntry) =>
        isIde ? formatIdeType(entry.type)
            : category === 'cli' ? (entry as CliSessionEntry).cliName
                : (entry as AcpSessionEntry).acpName

    const launchableIdes = isIde ? (machine.detectedIdes || []) : []

    const handleLaunch = () => {
        void (async () => {
            if (isIde) {
                const launched = await handleLaunchIde(
                    selectedType,
                    resolvedWorkspacePath ? { workspace: resolvedWorkspacePath } : undefined,
                )
                if (launched) markPendingLaunch(selectedType)
                return
            }
            const launched = await handleLaunchCli(
                selectedType,
                resolvedWorkspacePath,
                launchArgs || undefined,
                isAcp ? launchModel || undefined : undefined,
            )
            if (launched.success) {
                markPendingLaunch(selectedType)
                if (launched.sessionId) openSessionInDashboard(launched.sessionId)
            }
        })()
    }

    const handleStop = (entry: AgentEntry) => {
        if (isIde) {
            handleStopIde(entry as IdeSessionEntry)
        } else {
            handleStopCli(entry.type, (entry as CliSessionEntry).workspace, entry.id)
        }
    }

    // ─── Workspace Selector (shared across all categories) ───
    const workspaceSelector = (
        <div className="mb-3">
            <div className="flex gap-2 items-center flex-wrap">
            <select
                value={selectedWorkspace}
                onChange={e => { setSelectedWorkspace(e.target.value); if (e.target.value !== '__custom__') setCustomPath('') }}
                className="machine-input min-w-[200px] flex-1"
            >
                {(machine.workspaces || []).length > 0 ? (
                    <>
                        <option value="">(no workspace — launch in home)</option>
                        {(machine.workspaces || []).map(w => (
                            <option key={w.id} value={w.id}>
                                {w.id === machine.defaultWorkspaceId ? '⭐ ' : ''}
                                {getWorkspaceDisplayLabel(w.path, w.label)}
                            </option>
                        ))}
                        <option value="__custom__">✏️ Custom path…</option>
                    </>
                ) : (
                    <>
                        <option value="">(no workspaces saved — add in Overview tab)</option>
                        <option value="__custom__">✏️ Custom path…</option>
                    </>
                )}
            </select>
            {selectedWorkspace === '__custom__' && (
                <input
                    type="text"
                    placeholder="Enter absolute path…"
                    value={customPath}
                    onChange={e => setCustomPath(e.target.value)}
                    className="machine-input flex-1 min-w-[200px]"
                    autoFocus
                />
            )}
            </div>
            <div className="mt-1.5 text-[10px] text-text-muted">
                {selectedWorkspace === '__custom__'
                    ? (resolvedWorkspacePath
                        ? <span className="font-mono truncate block" title={resolvedWorkspacePath}>{resolvedWorkspacePath}</span>
                        : 'Enter an absolute path to launch there.')
                    : resolvedWorkspacePath
                        ? (
                            <>
                                <span className="font-medium text-text-secondary">
                                    {selectedWorkspace === machine.defaultWorkspaceId ? 'Default workspace' : 'Selected workspace'}
                                </span>
                                <span className="font-mono truncate block" title={resolvedWorkspacePath}>{resolvedWorkspacePath}</span>
                            </>
                        )
                        : 'No workspace selected. This launches in the home directory.'}
            </div>
        </div>
    )

    return (
        <div>
            {/* ═══ Launch Form ═══ */}
            <div className={`px-5 py-4 rounded-xl mb-5 bg-bg-secondary border ${config.accent}`}>
                <div className="text-[11px] text-text-muted font-semibold uppercase tracking-wider mb-2.5">
                    Launch {config.label}
                </div>

                {/* Workspace selector (all categories) */}
                {workspaceSelector}

                {isIde ? (
                    /* IDE: Detected IDEs as launch buttons */
                    <>
                        <div className="flex flex-wrap gap-2">
                            {launchableIdes.map(d => {
                                const matchingEntry = managedEntries.find(m => (m.type || '').toLowerCase() === (d.type || '').toLowerCase() && normalizeManagedStatus(m.status) !== 'stopped')
                                const isRunning = d.running || !!matchingEntry
                                const isReady = !!matchingEntry && (matchingEntry as IdeSessionEntry).cdpConnected
                                const isPending = pendingLaunchTypes.includes(d.type || d.id || '')
                                return (
                                    <button
                                        key={d.type}
                                        onClick={() => {
                                            if (isReady && matchingEntry) {
                                                navigate(`/ide/${matchingEntry.id}`)
                                                return
                                            }
                                            if (isPending) return
                                            void (async () => {
                                                const launched = await handleLaunchIde(d.type || d.id || '', resolvedWorkspacePath ? { workspace: resolvedWorkspacePath } : undefined)
                                                if (launched) markPendingLaunch(d.type || d.id || '')
                                            })()
                                        }}
                                        disabled={!!launchingIde || isPending}
                                        className={`machine-btn-primary flex items-center gap-1.5 ${isRunning ? '!border-green-500/30' : ''}`}
                                        style={{ opacity: (launchingIde && launchingIde !== d.type) ? 0.4 : 1 }}
                                    >
                                        <span>{getIcon(d.type)}</span>
                                        {isRunning && <span className="w-1.5 h-1.5 rounded-full bg-green-500 shadow-[0_0_4px_rgba(34,197,94,0.4)]" />}
                                        {isPending
                                            ? `⏳ Waiting for ${d.name || formatIdeType(d.type)}...`
                                            : isReady
                                                ? `Open ${d.name || formatIdeType(d.type)}`
                                                : launchingIde === d.type
                                                    ? '⏳ Launching...'
                                                    : `▶ ${d.name || formatIdeType(d.type)}`}
                                        {isRunning && isReady && <span className="text-[9px] text-green-400 font-normal">running</span>}
                                    </button>
                                )
                            })}
                            {launchableIdes.length === 0 && (
                                <div className="text-xs text-text-muted italic">
                                    No IDEs detected.
                                    <button onClick={handleDetectIdes} className="machine-btn ml-2 flex items-center gap-1"><IconSearch size={12} /> Scan</button>
                                </div>
                            )}
                        </div>
                    </>
                ) : (
                    /* CLI / ACP: Provider selector + args */
                    <div className="flex gap-2 items-center flex-wrap">
                        <select
                            value={selectedType}
                            onChange={e => setSelectedType(e.target.value)}
                            className="machine-input"
                        >
                            {categoryProviders.length > 0 ? categoryProviders.map((p: any) => (
                                <option key={p.type} value={p.type}>{p.icon} {p.displayName}</option>
                            )) : (
                                <option value="" disabled>No {category.toUpperCase()} providers available</option>
                            )}
                        </select>
                        {isAcp && (
                            <input
                                type="text"
                                placeholder="Model (default)"
                                value={launchModel}
                                onChange={e => setLaunchModel(e.target.value)}
                                className="machine-input min-w-[120px]"
                            />
                        )}
                        <input
                            type="text"
                            placeholder="Args (optional)"
                            value={launchArgs}
                            onChange={e => setLaunchArgs(e.target.value)}
                            className="machine-input min-w-[120px]"
                        />
                        <button
                            onClick={handleLaunch}
                            disabled={!!launchingAgentType}
                            className="machine-btn-primary"
                        >
                            {launchingAgentType === selectedType ? '⏳ Launching...' : '▶ Launch'}
                        </button>
                    </div>
                )}
            </div>

            {/* ═══ Running Agents ═══ */}
            <div className="text-[11px] text-text-muted font-semibold uppercase tracking-wider mb-2.5">
                Running ({managedEntries.length + pendingLaunchTypes.filter(type => !managedEntries.some(entry => entry.type === type && normalizeManagedStatus(entry.status) !== 'stopped')).length})
            </div>

            {managedEntries.length === 0 && visiblePendingLaunches.length === 0 ? (
                <div className="py-7.5 px-5 text-center rounded-xl bg-bg-secondary border border-dashed border-border-subtle text-text-muted text-[13px] mb-5">
                    No {config.plural} running
                </div>
            ) : (
                <div className="flex flex-col gap-2.5 mb-5">
                    {visiblePendingLaunches.map(type => (
                            <div key={`pending:${type}`} className="px-4.5 py-3.5 rounded-xl bg-bg-secondary" style={{ border: '1px solid color-mix(in srgb, var(--status-warning) 20%, transparent)' }}>
                                <div className="flex justify-between items-center">
                                    <div className="flex items-center gap-2.5">
                                        <span className="text-lg">{getIcon(type)}</span>
                                        <div>
                                            <div className="font-semibold text-[13px] text-text-primary">
                                                {isIde ? formatIdeType(type) : (providerLabelMap.get(type) || type)}
                                            </div>
                                            <div className="text-[11px] text-text-muted">
                                                {launchingAgentType === type
                                                    ? 'Launching process...'
                                                    : 'Waiting for process and session to register...'}
                                            </div>
                                        </div>
                                    </div>
                                    <span
                                        className="px-2 py-0.5 rounded-md text-[10px] font-semibold"
                                        style={{ background: 'color-mix(in srgb, var(--status-warning) 8%, transparent)', color: 'var(--status-warning)' }}
                                    >
                                        starting
                                    </span>
                                </div>
                            </div>
                        ))}
                    {managedEntries.map(entry => {
                        const ide = isIde ? (entry as IdeSessionEntry) : null
                        const acp = isAcp ? (entry as AcpSessionEntry) : null
                        const cli = !isIde && !isAcp ? (entry as CliSessionEntry) : null
                        const normalizedStatus = normalizeManagedStatus(entry.status)
                        const isHidden = isDashboardHidden?.(entry.id) ?? false

                        return (
                            <div key={entry.id} className="px-4.5 py-3.5 rounded-xl bg-bg-secondary border border-border-subtle">
                                <div className="flex justify-between items-center mb-2">
                                    <div className="flex items-center gap-2.5">
                                        <span className="text-lg">{getIcon(entry.type)}</span>
                                        <div>
                                            <div className="font-semibold text-[13px] text-text-primary">
                                                {getName(entry)}
                                                {ide?.version && <span className="text-[10px] text-text-muted ml-1.5">v{ide.version}</span>}
                                            </div>
                                            <div className="text-[11px] text-text-muted flex gap-2">
                                                <span>{(entry as any).workspace || '—'}</span>
                                                {acp?.currentModel && <span className="text-cyan-500">🤖 {acp.currentModel}</span>}
                                                {acp?.currentPlan && <span style={{ color: 'var(--status-warning)' }}>📋 {acp.currentPlan}</span>}
                                            </div>
                                            {cli && (cli.runtimeKey || cli.runtimeWriteOwner) && (
                                                <div className="text-[10px] text-text-muted flex gap-2 mt-0.5 flex-wrap">
                                                    {cli.runtimeKey && (
                                                        <>
                                                            <span className="text-text-secondary">Local terminal:</span>
                                                            <span className="font-mono text-text-secondary">adhdev attach {cli.runtimeKey}</span>
                                                            <button
                                                                type="button"
                                                                className="machine-btn text-[9px] px-1.5 py-px"
                                                                onClick={() => {
                                                                    void navigator.clipboard?.writeText(`adhdev attach ${cli.runtimeKey}`)
                                                                    setCopiedRuntimeKey(cli.runtimeKey || null)
                                                                    window.setTimeout(() => {
                                                                        setCopiedRuntimeKey((current) => (current === cli.runtimeKey ? null : current))
                                                                    }, 1200)
                                                                }}
                                                            >
                                                                {copiedRuntimeKey === cli.runtimeKey ? 'Copied' : 'Copy'}
                                                            </button>
                                                        </>
                                                    )}
                                                    {cli.runtimeWriteOwner && (
                                                        <span style={{ color: cli.runtimeWriteOwner.ownerType === 'user' ? 'var(--status-warning)' : undefined }} className={cli.runtimeWriteOwner.ownerType !== 'user' ? 'text-violet-400' : ''}>
                                                            {describeMuxOwner(cli.runtimeWriteOwner)}
                                                        </span>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                        {onToggleDashboardVisibility && (
                                            <button
                                                onClick={() => onToggleDashboardVisibility(entry.id)}
                                                className={`machine-btn ${
                                                    isHidden
                                                        ? 'text-zinc-300 border-zinc-500/30'
                                                        : 'text-violet-400 border-violet-500/30'
                                                }`}
                                                title={isHidden ? 'Show on Dashboard' : 'Hide from Dashboard'}
                                            >
                                                {isHidden ? 'Show' : 'Hide'}
                                            </button>
                                        )}
                                        <span className={`px-2 py-0.5 rounded-md text-[10px] font-semibold ${
                                            normalizedStatus === 'stopped' ? 'bg-red-500/[0.08] text-red-500'
                                                : normalizedStatus === 'generating' ? 'bg-orange-500/[0.08] text-orange-400'
                                                    : 'bg-green-500/[0.08] text-green-500'
                                        }`}>{normalizedStatus}</span>
                                        {/* IDE: Control + Restart */}
                                        {isIde && (
                                            <>
                                                <button onClick={() => navigate(`/ide/${entry.id}`)} className="machine-btn flex items-center gap-1"><IconMonitor size={13} /> Control</button>
                                                <button onClick={() => handleRestartIde(entry as IdeSessionEntry)} className="machine-btn" style={{ color: 'var(--status-warning)', borderColor: 'color-mix(in srgb, var(--status-warning) 30%, transparent)' }}>↻</button>
                                            </>
                                        )}
                                        {/* ACP: Chat */}
                                        {isAcp && (
                                            <button onClick={() => navigate(`/ide/${entry.id}`)} className="machine-btn" title="View chat"><IconChat size={14} /></button>
                                        )}
                                        {cli && normalizedStatus !== 'stopped' && (
                                            <button
                                                onClick={() => openSessionInDashboard(entry.id)}
                                                className="machine-btn flex items-center gap-1"
                                                title="Open terminal in dashboard"
                                            >
                                                <IconMonitor size={13} /> Open
                                            </button>
                                        )}
                                        {/* All: Stop / Restart */}
                                        {normalizedStatus === 'stopped' ? (
                                            <button
                                                onClick={() => {
                                                    void (async () => {
                                                        if (isIde) {
                                                            const launched = await handleLaunchIde(
                                                                entry.type,
                                                                (entry as any).workspace ? { workspace: (entry as any).workspace } : undefined,
                                                            )
                                                            if (launched) markPendingLaunch(entry.type)
                                                            return
                                                        }
                                                        const launched = await handleLaunchCli(entry.type, (entry as any).workspace)
                                                        if (launched.success) {
                                                            markPendingLaunch(entry.type)
                                                            if (launched.sessionId) openSessionInDashboard(launched.sessionId)
                                                        }
                                                    })()
                                                }}
                                                disabled={pendingLaunchTypes.includes(entry.type)}
                                                className="machine-btn text-green-500 border-green-500/30"
                                            >
                                                {pendingLaunchTypes.includes(entry.type) ? '⏳' : '▶'}
                                            </button>
                                        ) : (
                                            <button onClick={() => handleStop(entry)} className="machine-btn text-red-500 border-red-500/30">■</button>
                                        )}
                                    </div>
                                </div>

                                {/* IDE: AI Agents */}
                                {ide && ide.aiAgents.length > 0 && (
                                    <div className="flex gap-1 mb-2 flex-wrap">
                                        {ide.aiAgents.map(a => (
                                            <span key={a.id} className={`px-2 py-0.5 rounded-md text-[10px] ${
                                                isManagedStatusWorking(a.status) ? 'bg-orange-500/[0.08] text-orange-400' : 'bg-indigo-500/[0.06] text-indigo-400'
                                            }`}>{a.name} · {normalizeManagedStatus(a.status)}</span>
                                        ))}
                                    </div>
                                )}

                                {/* IDE: Extension Toggles */}
                                {ide && (ideExtensions[ide.type] || []).length > 0 && sendDaemonCommand && (
                                    <div className="mt-2 pt-2 border-t border-border-subtle">
                                        <div className="text-[10px] text-text-muted font-semibold uppercase tracking-wider mb-1.5">Extensions</div>
                                        <div className="flex flex-wrap gap-2">
                                            {(ideExtensions[ide.type] || []).map(ext => (
                                                <button
                                                    key={ext.type}
                                                    disabled={extToggling === `${ide.type}.${ext.type}`}
                                                    onClick={async () => {
                                                        const key = `${ide.type}.${ext.type}`;
                                                        setExtToggling(key);
                                                        try {
                                                            await sendDaemonCommand(machineId, 'set_ide_extension', {
                                                                ideType: ide.type,
                                                                extensionType: ext.type,
                                                                enabled: !ext.enabled,
                                                            });
                                                            setIdeExtensions(prev => ({
                                                                ...prev,
                                                                [ide.type]: (prev[ide.type] || []).map(e =>
                                                                    e.type === ext.type ? { ...e, enabled: !e.enabled } : e
                                                                ),
                                                            }));
                                                        } catch (e) {
                                                            console.error('Extension toggle failed:', e);
                                                        } finally {
                                                            setExtToggling(null);
                                                        }
                                                    }}
                                                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium border transition-colors duration-150 cursor-pointer ${
                                                        ext.enabled
                                                            ? 'bg-violet-500/[0.08] border-violet-500/20 text-violet-400'
                                                            : 'bg-bg-glass border-border-subtle text-text-muted'
                                                    }`}
                                                >
                                                    <span className={`w-1.5 h-1.5 rounded-full ${
                                                        ext.enabled ? 'bg-violet-400 shadow-[0_0_4px_rgba(139,92,246,0.4)]' : 'bg-zinc-600'
                                                    }`} />
                                                    {ext.name}
                                                    <span className="text-[9px] font-normal">{ext.enabled ? 'ON' : 'OFF'}</span>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        )
                    })}
                </div>
            )}

            {/* ═══ History ═══ */}
            {(
                <>
                    <div className="flex items-center gap-2 mb-2.5">
                        <span className="text-[11px] text-text-muted font-semibold uppercase tracking-wider">History</span>
                        <button onClick={loadCliHistory} disabled={loadingHistory} className="machine-btn">
                            {loadingHistory ? '⏳' : '↻ Load'}
                        </button>
                    </div>
                    {(() => {
                        const categoryTypes = new Set(categoryProviders.map(p => p.type))
                        const filtered = cliHistory.filter((item: any) => {
                            const itemCategory = item.category || 'cli'
                            if (itemCategory !== category) return false
                            return category === 'ide' ? true : categoryTypes.has(item.cliType)
                        })
                        return filtered.length > 0 ? (
                            <div className="flex flex-col gap-1 max-h-[200px] overflow-y-auto">
                                {filtered.map((item: any, i: number) => (
                                    <div
                                        key={i}
                                        onClick={() => {
                                            setSelectedType(item.cliType)
                                            if (item.workspace || item.dir) {
                                                setSelectedWorkspace('__custom__')
                                                setCustomPath(item.workspace || item.dir)
                                            }
                                            setLaunchArgs((item.cliArgs || []).join(' '))
                                            setLaunchModel(item.model || '')
                                            if (isIde) {
                                                void (async () => {
                                                    const launched = await handleLaunchIde(item.cliType, item.workspace ? { workspace: item.workspace } : undefined)
                                                    if (launched) markPendingLaunch(item.cliType)
                                                })()
                                            }
                                        }}
                                        className="flex justify-between items-center px-2.5 py-1.5 rounded-md cursor-pointer bg-bg-glass border border-border-subtle text-xs transition-colors duration-150 hover:bg-bg-glass-hover"
                                    >
                                        <div className="flex gap-1.5 items-center text-text-secondary">
                                            <span>{getIcon(item.cliType)}</span>
                                            <span>{(item.workspace || item.dir)?.split('/').filter(Boolean).pop() || item.cliType || 'root'}</span>
                                            {item.model && <span className="text-cyan-500 text-[10px]">model={item.model}</span>}
                                            {item.newWindow && <span className="text-text-muted text-[10px]">new window</span>}
                                            {item.cliArgs?.length > 0 && <span className="text-text-muted text-[10px]">{item.cliArgs.join(' ')}</span>}
                                        </div>
                                        <span className="text-text-muted text-[10px]">
                                            {item.timestamp ? new Date(item.timestamp).toLocaleDateString() : ''}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="text-[11px] text-text-muted italic mb-2">No {config.label} launch history yet.</div>
                        )
                    })()}
                </>
            )}
        </div>
    )
}
