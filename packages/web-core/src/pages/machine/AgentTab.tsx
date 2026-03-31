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
import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { isManagedStatusWorking, normalizeManagedStatus } from '@adhdev/daemon-core/status/normalize'
import { formatIdeType } from '../../utils/daemon-utils'
import { IconChat, IconMonitor, IconSearch } from '../../components/Icons'
import type { MachineData, ManagedIde, ManagedCli, ManagedAcp, ProviderInfo } from './types'
import type { useMachineActions } from './useMachineActions'

type AgentCategory = 'ide' | 'cli' | 'acp'

// Union type for running entries
type AgentEntry = ManagedIde | ManagedCli | ManagedAcp

interface AgentTabProps {
    category: AgentCategory
    machine: MachineData
    machineId: string
    providers: ProviderInfo[]
    managedEntries: AgentEntry[]
    getIcon: (type: string) => string
    actions: ReturnType<typeof useMachineActions>
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
}: AgentTabProps) {
    const navigate = useNavigate()
    const {
        handleLaunchIde, handleLaunchCli, handleStopCli, handleRestartIde, handleStopIde,
        handleDetectIdes,
        cliHistory, loadingHistory, loadCliHistory, launchingIde,
    } = actions

    const config = CATEGORY_CONFIG[category]
    const isIde = category === 'ide'
    const isAcp = category === 'acp'
    const categoryProviders = providers.filter(p => p.category === category)

    // ─── Launch Form State ──────────────────────────
    const [selectedType, setSelectedType] = useState('')
    const [launchArgs, setLaunchArgs] = useState('')
    const [launchModel, setLaunchModel] = useState('')
    // Workspace selection: workspace-id | '__custom__' | '' (home)
    const [selectedWorkspace, setSelectedWorkspace] = useState(machine.defaultWorkspaceId || '')
    const [customPath, setCustomPath] = useState('')

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

    // ─── IDE Extension State ────────────────────────
    const [ideExtensions, setIdeExtensions] = useState<Record<string, { type: string; name: string; enabled: boolean }[]>>({})
    const [extToggling, setExtToggling] = useState<string | null>(null)

    useEffect(() => {
        if (!isIde || !machineId || !sendDaemonCommand) return
        const fetchExtensions = async () => {
            try {
                const res: any = await sendDaemonCommand(machineId, 'get_ide_extensions', {})
                const payload = res?.result || res
                if (payload?.success && payload?.ides) setIdeExtensions(payload.ides)
            } catch { /* silent */ }
        }
        fetchExtensions()
    }, [isIde, machineId, sendDaemonCommand])

    // ─── Helpers ────────────────────────────────────
    const getName = (entry: AgentEntry) =>
        isIde ? formatIdeType(entry.type)
            : category === 'cli' ? (entry as ManagedCli).cliName
                : (entry as ManagedAcp).acpName

    const launchableIdes = isIde ? (machine.detectedIdes || []) : []

    const handleLaunch = () => {
        if (isIde) {
            handleLaunchIde(selectedType, resolvedWorkspacePath ? { workspace: resolvedWorkspacePath } : undefined)
        } else {
            handleLaunchCli(selectedType, resolvedWorkspacePath, launchArgs || undefined, isAcp ? launchModel || undefined : undefined)
        }
    }

    const handleStop = (entry: AgentEntry) => {
        if (isIde) {
            handleStopIde(entry as ManagedIde)
        } else {
            handleStopCli(entry.type, (entry as ManagedCli).workspace, entry.id)
        }
    }

    // ─── Workspace Selector (shared across all categories) ───
    const workspaceSelector = (
        <div className="flex gap-2 items-center flex-wrap mb-3">
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
                                {w.label || w.path.split('/').filter(Boolean).pop() || w.path}
                                {' — '}
                                {w.path}
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
                                const isRunning = d.running || managedEntries.some(m => (m.type || '').toLowerCase() === (d.type || '').toLowerCase())
                                return (
                                    <button
                                        key={d.type}
                                        onClick={() => handleLaunchIde(d.type || d.id || '', resolvedWorkspacePath ? { workspace: resolvedWorkspacePath } : undefined)}
                                        disabled={!!launchingIde}
                                        className={`machine-btn-primary flex items-center gap-1.5 ${isRunning ? '!border-green-500/30' : ''}`}
                                        style={{ opacity: launchingIde && launchingIde !== d.type ? 0.4 : 1 }}
                                    >
                                        <span>{getIcon(d.type)}</span>
                                        {isRunning && <span className="w-1.5 h-1.5 rounded-full bg-green-500 shadow-[0_0_4px_rgba(34,197,94,0.4)]" />}
                                        {launchingIde === d.type ? '⏳ Launching...' : `▶ ${d.name || formatIdeType(d.type)}`}
                                        {isRunning && <span className="text-[9px] text-green-400 font-normal">+ window</span>}
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
                        <button onClick={handleLaunch} className="machine-btn-primary">▶ Launch</button>
                    </div>
                )}
            </div>

            {/* ═══ Running Agents ═══ */}
            <div className="text-[11px] text-text-muted font-semibold uppercase tracking-wider mb-2.5">
                Running ({managedEntries.length})
            </div>

            {managedEntries.length === 0 ? (
                <div className="py-7.5 px-5 text-center rounded-xl bg-bg-secondary border border-dashed border-border-subtle text-text-muted text-[13px] mb-5">
                    No {config.plural} running
                </div>
            ) : (
                <div className="flex flex-col gap-2.5 mb-5">
                    {managedEntries.map(entry => {
                        const ide = isIde ? (entry as ManagedIde) : null
                        const acp = isAcp ? (entry as ManagedAcp) : null
                        const normalizedStatus = normalizeManagedStatus(entry.status)

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
                                                {acp?.currentPlan && <span className="text-amber-500">📋 {acp.currentPlan}</span>}
                                            </div>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                        <span className={`px-2 py-0.5 rounded-md text-[10px] font-semibold ${
                                            normalizedStatus === 'stopped' ? 'bg-red-500/[0.08] text-red-500'
                                                : normalizedStatus === 'generating' ? 'bg-orange-500/[0.08] text-orange-400'
                                                    : 'bg-green-500/[0.08] text-green-500'
                                        }`}>{normalizedStatus}</span>
                                        {/* IDE: Control + Restart */}
                                        {isIde && (
                                            <>
                                                <button onClick={() => navigate(`/ide/${entry.id}`)} className="machine-btn flex items-center gap-1"><IconMonitor size={13} /> Control</button>
                                                <button onClick={() => handleRestartIde(entry as ManagedIde)} className="machine-btn text-amber-500 border-amber-500/30">↻</button>
                                            </>
                                        )}
                                        {/* ACP: Chat */}
                                        {isAcp && (
                                            <button onClick={() => navigate(`/ide/${entry.id}`)} className="machine-btn" title="View chat"><IconChat size={14} /></button>
                                        )}
                                        {/* All: Stop / Restart */}
                                        {normalizedStatus === 'stopped' ? (
                                            <button onClick={() => isIde ? handleLaunchIde(entry.type, (entry as any).workspace ? { workspace: (entry as any).workspace } : undefined) : handleLaunchCli(entry.type, (entry as any).workspace)} className="machine-btn text-green-500 border-green-500/30">▶</button>
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
                                                handleLaunchIde(item.cliType, item.workspace ? { workspace: item.workspace } : undefined)
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
