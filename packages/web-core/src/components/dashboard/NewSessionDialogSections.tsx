// Presentational sections of the New Session dialog. Each receives the values it
// shows plus change callbacks; state and remembered-choice bookkeeping stay in
// DashboardNewSessionDialog.
import { useTranslation } from 'react-i18next'
import type { DaemonData } from '../../types'
import { getMachineDisplayName } from '../../utils/daemon-utils'
import { InfoTip } from '../ui/InfoTip'
import LaunchSectionCard from '../LaunchSectionCard'
import type { MeshLaunchOption } from '../../hooks/useDashboardCommandActions'
import { LAUNCH_CATEGORY_LABELS } from './launch-category-labels'
import type { LaunchKind } from './newSessionLaunchState'

const FIELD_CLASS = 'w-full rounded-lg border border-border-subtle bg-bg-secondary text-text-primary px-3 py-2.5 text-sm'

export function NewSessionMachinePicker({ machines, selectedMachineId, useDropdown, busy, onSelect, onPrefetch }: {
    machines: DaemonData[]
    selectedMachineId: string
    useDropdown: boolean
    busy: boolean
    onSelect: (machineId: string) => void
    onPrefetch: (machineId: string) => void
}) {
    const { t } = useTranslation()
    return (
        <LaunchSectionCard title={t('newSession.machine')}>
            {useDropdown ? (
                <select
                    aria-label={t('newSession.machine')}
                    value={selectedMachineId}
                    onChange={(event) => onSelect(event.target.value)}
                    onFocus={() => machines.forEach(machine => onPrefetch(machine.id))}
                    className={FIELD_CLASS}
                    disabled={busy}
                >
                    {machines.map(machine => (
                        <option key={machine.id} value={machine.id}>
                            {getMachineDisplayName(machine, { fallbackId: machine.id })}
                        </option>
                    ))}
                </select>
            ) : (
                <div className="flex flex-wrap gap-2" role="group" aria-label={t('newSession.machine')}>
                    {machines.map(machine => {
                        const label = getMachineDisplayName(machine, { fallbackId: machine.id })
                        const selected = selectedMachineId === machine.id
                        return (
                            <button
                                key={machine.id}
                                type="button"
                                aria-label={t('newSession.selectMachine', { name: label })}
                                aria-pressed={selected}
                                className={`inline-flex min-w-0 items-center gap-2 rounded-full border px-3 py-2 text-sm transition-colors ${selected ? 'border-accent bg-accent/10 text-text-primary' : 'border-border-subtle bg-bg-secondary/60 text-text-secondary hover:bg-bg-secondary hover:text-text-primary'}`}
                                onClick={() => onSelect(machine.id)}
                                onMouseEnter={() => onPrefetch(machine.id)}
                                onFocus={() => onPrefetch(machine.id)}
                                disabled={busy}
                                title={label}
                            >
                                <span className={`h-2 w-2 shrink-0 rounded-full ${machine.status === 'offline' ? 'bg-text-muted' : 'bg-emerald-500'}`} />
                                <span className="truncate">{label}</span>
                            </button>
                        )
                    })}
                </div>
            )}
        </LaunchSectionCard>
    )
}

export function NewSessionMeshPicker({ loading, error, meshes, selectedMeshId, busy, onSelect }: {
    loading: boolean
    error: string
    meshes: MeshLaunchOption[]
    selectedMeshId: string
    busy: boolean
    onSelect: (meshId: string) => void
}) {
    const { t } = useTranslation()
    return (
        <div className="space-y-3">
            {loading && (
                <div className="text-sm text-text-muted">{t('newSession.loadingMeshes')}</div>
            )}
            {!loading && error && (
                <div className="rounded-lg border border-status-error/25 bg-status-error/10 px-3 py-2 text-sm text-status-error">
                    {error}
                </div>
            )}
            {!loading && !error && meshes.length === 0 && (
                <div className="flex items-center gap-1 rounded-lg border border-border-subtle bg-bg-secondary/40 px-3 py-2 text-sm text-text-muted">
                    {t('newSession.noMeshesShort')}
                    <InfoTip content={t('newSession.noMeshes')} />
                </div>
            )}
            {meshes.length > 0 && (
                <div className="grid grid-cols-1 gap-2" role="radiogroup" aria-label={t('newSession.mesh')}>
                    {meshes.map(mesh => (
                        <button
                            key={mesh.id}
                            type="button"
                            role="radio"
                            aria-checked={selectedMeshId === mesh.id}
                            className={`w-full rounded-xl border px-3.5 py-3 text-left transition-colors ${selectedMeshId === mesh.id ? 'border-accent bg-accent/10' : 'border-border-subtle bg-bg-secondary/40 hover:bg-bg-secondary/70'}`}
                            onClick={() => onSelect(mesh.id)}
                            disabled={busy}
                        >
                            <div className="text-sm font-semibold text-text-primary">{mesh.name}</div>
                            <div className="mt-1 text-xs text-text-secondary">
                                {mesh.repoIdentity || t('newSession.repoMesh')}{typeof mesh.nodesCount === 'number' ? ` · ${t('newSession.nodeCount', { count: mesh.nodesCount })}` : ''}
                            </div>
                            {mesh.workspace && (
                                <div className="mt-1 text-2xs text-text-muted break-all">{t('newSession.coordinatorWorkspace', { path: mesh.workspace })}</div>
                            )}
                        </button>
                    ))}
                </div>
            )}
        </div>
    )
}

export interface NewSessionLaunchTarget {
    kind: LaunchKind
    id: string
    label: string
    meta?: string
}

export function NewSessionAgentPicker({ targets, activeKind, selectedTarget, showCategory, busy, onSelect }: {
    targets: NewSessionLaunchTarget[]
    activeKind: LaunchKind | null
    selectedTarget: string
    showCategory: boolean
    busy: boolean
    onSelect: (target: NewSessionLaunchTarget) => void
}) {
    const { t } = useTranslation()
    return (
        <LaunchSectionCard title={t('newSession.agent')}>
            <div className="grid grid-cols-1 gap-1.5" role="radiogroup" aria-label={t('newSession.agent')}>
                {targets.map(target => {
                    const selected = activeKind === target.kind && selectedTarget === target.id
                    return (
                        <button
                            key={`${target.kind}:${target.id}`}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            data-launch-kind={target.kind}
                            className={`flex w-full items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-colors ${selected ? 'border-accent bg-accent/10' : 'border-border-subtle bg-bg-secondary/40 hover:bg-bg-secondary/70'}`}
                            onClick={() => onSelect(target)}
                            disabled={busy}
                        >
                            <span className="min-w-0 truncate text-sm font-semibold text-text-primary">{target.label}</span>
                            <span className="flex shrink-0 items-center gap-2">
                                {target.meta && <span className="text-2xs text-text-muted">{target.meta}</span>}
                                {showCategory && (
                                    <span className="rounded-full border border-border-subtle px-1.5 py-px text-3xs font-semibold uppercase tracking-wide text-text-muted">
                                        {LAUNCH_CATEGORY_LABELS[target.kind]}
                                    </span>
                                )}
                            </span>
                        </button>
                    )
                })}
                {targets.length === 0 && (
                    <div className="flex items-center gap-1 text-sm text-text-muted">
                        {t('newSession.noProvidersShort')}
                        <InfoTip content={t('newSession.noProviders')} />
                    </div>
                )}
            </div>
        </LaunchSectionCard>
    )
}

export function NewSessionStartupArgs({ value, recentOptions, busy, onChange }: {
    value: string
    recentOptions: string[]
    busy: boolean
    onChange: (value: string) => void
}) {
    const { t } = useTranslation()
    return (
        <LaunchSectionCard title={t('newSession.startupArguments')}>
            <input
                type="text"
                value={value}
                onChange={(event) => onChange(event.target.value)}
                placeholder={t('newSession.optionalFlags')}
                className={FIELD_CLASS}
                disabled={busy}
            />
            {recentOptions.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                    {recentOptions.map(argsOption => (
                        <button
                            key={argsOption}
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => onChange(argsOption)}
                            disabled={busy}
                            title={argsOption}
                        >
                            {argsOption}
                        </button>
                    ))}
                </div>
            )}
        </LaunchSectionCard>
    )
}

export function NewSessionModelThinkingFields({
    modelOptions, thinkingOptions, model, thinkingLevel, modelIsCustom, busy,
    onModelIsCustomChange, onModelChange, onThinkingChange,
}: {
    modelOptions: string[]
    thinkingOptions: string[]
    model: string
    thinkingLevel: string
    modelIsCustom: boolean
    busy: boolean
    onModelIsCustomChange: (custom: boolean) => void
    /** User edits only — the dialog records them with source 'user'. */
    onModelChange: (value: string) => void
    onThinkingChange: (value: string) => void
}) {
    const { t } = useTranslation()
    return (
        <LaunchSectionCard title={t('newSession.modelAndThinking')}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <label className="flex flex-col gap-1">
                    <span className="text-2xs text-text-muted">{t('newSession.model')}</span>
                    {modelOptions.length > 0 && !modelIsCustom ? (
                        <>
                            <select
                                value={modelOptions.includes(model) ? model : ''}
                                onChange={(event) => {
                                    if (event.target.value === '__custom__') {
                                        onModelIsCustomChange(true)
                                        onModelChange('')
                                    } else {
                                        onModelChange(event.target.value)
                                    }
                                }}
                                className={FIELD_CLASS}
                                disabled={busy}
                            >
                                <option value="">{t('newSession.providerDefault')}</option>
                                {modelOptions.map((m: string) => <option key={m} value={m}>{m}</option>)}
                                <option value="__custom__">{t('newSession.custom')}</option>
                            </select>
                            {/* Phase E: what "provider default" resolves to — the daemon records
                                the same value (discovery models[0], else the manifest's first
                                option), which is exactly this list's head. */}
                            {!model.trim() && (
                                <span className="text-2xs text-text-muted" data-testid="new-session-default-model">
                                    {t('newSession.defaultResolvesTo', { model: modelOptions[0], defaultValue: 'Default resolves to {{model}}' })}
                                </span>
                            )}
                        </>
                    ) : (
                        <>
                            <input
                                type="text"
                                value={model}
                                onChange={(event) => onModelChange(event.target.value)}
                                placeholder={t('newSession.typeModelName')}
                                className={FIELD_CLASS}
                                disabled={busy}
                                autoFocus={modelIsCustom}
                            />
                            {modelOptions.length > 0 && (
                                <button
                                    type="button"
                                    className="self-start text-2xs text-accent-primary bg-transparent border-none cursor-pointer p-0"
                                    onClick={() => { onModelIsCustomChange(false); onModelChange('') }}
                                    disabled={busy}
                                >
                                    {t('newSession.backToModelList')}
                                </button>
                            )}
                        </>
                    )}
                </label>
                <label className="flex flex-col gap-1">
                    <span className="text-2xs text-text-muted">{t('newSession.thinkingLevel')}</span>
                    <select
                        value={thinkingLevel}
                        onChange={(event) => onThinkingChange(event.target.value)}
                        className={FIELD_CLASS}
                        disabled={busy}
                    >
                        <option value="">{t('newSession.providerDefault')}</option>
                        {thinkingOptions.map((l: string) => <option key={l} value={l}>{l}</option>)}
                    </select>
                </label>
            </div>
        </LaunchSectionCard>
    )
}
