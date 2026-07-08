/**
 * Per-node scheduling editor, rendered inside the mesh Scheduling section.
 *
 * Consolidates the scheduling knobs that used to live in a per-node "Advanced"
 * disclosure inside each Nodes & Providers card: scheduling priority and
 * per-provider max-parallel caps. Keeping them next to the mesh-level Max
 * parallel + Distribution controls means all scheduling lives in one place,
 * instead of being split between two sections.
 *
 * Provider caps reference the node's own detected CLI providers (resolved via
 * resolveNodeAvailableProviders) so the operator picks from a dropdown of real
 * tools on that machine rather than free-typing a provider id.
 */
import { useMemo, useState } from 'react'
import { FormField } from '../../components/ui/FormField'
import { IconX } from '../../components/Icons'
import { IconPlus } from './icons'
import { buildProvidersByDaemonId, resolveNodeAvailableProviders } from './node-providers'
import type { RepoMeshDaemonEntry } from '../../context/RepoMeshContext'
import type { MeshNode, MeshProviderRole, MeshSchedulingStrategy } from './types'

function readNodeSchedulingPriority(node: MeshNode): number {
    const raw = Number(node.policy?.schedulingPriority)
    return Number.isFinite(raw) ? raw : 0
}

function readNodeProviderRoles(node: MeshNode): MeshProviderRole[] {
    const roles = node.policy?.providerRoles
    if (!Array.isArray(roles)) return []
    return roles
        .map((r: any) => ({
            providerType: String(r?.providerType || '').trim(),
            maxParallel: Number.isFinite(Number(r?.maxParallel)) && Number(r?.maxParallel) >= 0 ? Math.floor(Number(r?.maxParallel)) : undefined,
        }))
        .filter(r => r.providerType.length > 0)
}

function nodeLabel(node: MeshNode): string {
    const n = node as any
    return n.machine_label || n.machine_nickname || n.hostname || (typeof node.workspace === 'string' ? node.workspace.split('/').filter(Boolean).pop() : '') || node.id
}

interface Props {
    nodes: MeshNode[]
    daemons: RepoMeshDaemonEntry[]
    schedulingStrategy: MeshSchedulingStrategy
    savingNodeSchedulingId: string | null
    onUpdateNodeScheduling: (node: MeshNode, patch: { schedulingPriority?: number; providerRoles?: MeshProviderRole[] }) => void
}

export default function MeshSchedulingNodes({ nodes, daemons, schedulingStrategy, savingNodeSchedulingId, onUpdateNodeScheduling }: Props) {
    const providersByDaemonId = useMemo(() => buildProvidersByDaemonId(daemons), [daemons])
    // Priority only matters when the mesh distributes work. An unset strategy
    // resolves to the 'first_eligible' (In order) default on the daemon, which
    // ignores priority — so treat unset the same as first_eligible here, not as
    // "some other strategy" (which the old `!== 'first_eligible'` check did).
    const priorityRelevant = !!schedulingStrategy && schedulingStrategy !== 'first_eligible'

    if (nodes.length === 0) {
        return <div className="text-[12px] text-text-muted">No nodes yet — add one under Nodes &amp; Providers to set per-node scheduling.</div>
    }

    return (
        <div className="flex flex-col gap-2">
            {nodes.map(node => (
                <NodeSchedulingRow
                    key={node.id}
                    node={node}
                    detectedProviders={resolveNodeAvailableProviders(node, providersByDaemonId).map(p => p.type)}
                    priorityRelevant={priorityRelevant}
                    saving={savingNodeSchedulingId === node.id}
                    onSave={patch => onUpdateNodeScheduling(node, patch)}
                />
            ))}
        </div>
    )
}

function NodeSchedulingRow({
    node,
    detectedProviders,
    priorityRelevant,
    saving,
    onSave,
}: {
    node: MeshNode
    detectedProviders: string[]
    priorityRelevant: boolean
    saving: boolean
    onSave: (patch: { schedulingPriority?: number; providerRoles?: MeshProviderRole[] }) => void
}) {
    const savedPriority = readNodeSchedulingPriority(node)
    const savedRoles = useMemo(() => readNodeProviderRoles(node), [node])
    const [priority, setPriority] = useState<string>(String(savedPriority))
    const [roles, setRoles] = useState<MeshProviderRole[]>(savedRoles)

    // Providers not already given an explicit cap — offered in the add dropdown.
    const cappedTypes = new Set(roles.map(r => r.providerType))
    const addableProviders = detectedProviders.filter(p => !cappedTypes.has(p))

    function updateRole(i: number, patch: Partial<MeshProviderRole>) {
        setRoles(prev => prev.map((r, idx) => idx === i ? { ...r, ...patch } : r))
    }
    function removeRole(i: number) {
        setRoles(prev => prev.filter((_, idx) => idx !== i))
    }
    function addRole(providerType: string) {
        if (!providerType) return
        setRoles(prev => [...prev, { providerType }])
    }

    function save() {
        const cleanedRoles: MeshProviderRole[] = roles
            .map(r => ({
                providerType: r.providerType.trim(),
                maxParallel: Number.isFinite(Number(r.maxParallel)) && Number(r.maxParallel) >= 0 ? Math.floor(Number(r.maxParallel)) : undefined,
            }))
            .filter(r => r.providerType.length > 0)
        const parsedPriority = Number(priority)
        onSave({
            schedulingPriority: Number.isFinite(parsedPriority) ? parsedPriority : 0,
            providerRoles: cleanedRoles,
        })
    }

    const dirty = priority !== String(savedPriority) || JSON.stringify(roles) !== JSON.stringify(savedRoles)

    return (
        <div className="rounded-xl border border-border-subtle bg-bg-secondary/40 p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-text-primary truncate">{nodeLabel(node)}</span>
                {detectedProviders.length > 0
                    ? detectedProviders.map(p => (
                        <span key={p} className="rounded-full border border-border-subtle bg-bg-primary px-2 py-0.5 font-mono text-[10px] text-text-muted">{p}</span>
                    ))
                    : <span className="text-[11px] text-text-muted">no detected providers</span>}
            </div>

            <div className="grid gap-3 sm:grid-cols-[auto_1fr] sm:items-start">
                <FormField label="Priority"
                    hint={priorityRelevant ? 'Higher wins when spreading.' : 'Not used in In order — switch to Spread to enable.'}>
                    <input type="number" step={1}
                        className="w-24 px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary disabled:opacity-50 disabled:cursor-not-allowed"
                        value={priority} onChange={e => setPriority(e.target.value)}
                        disabled={saving || !priorityRelevant}
                        title={priorityRelevant ? undefined : 'Priority only affects Spread distribution. This mesh is set to In order.'} />
                </FormField>

                <FormField label="Per-provider max parallel (optional)"
                    hint="Cap concurrent tasks for a tool on this node.">
                    <div className="flex flex-col gap-2">
                        {roles.length === 0 && (
                            <div className="text-[12px] text-text-muted">No caps — uses the mesh-wide Max parallel above.</div>
                        )}
                        {roles.map((r, i) => (
                            <div key={i} className="flex flex-wrap items-center gap-2">
                                <span className="min-w-[9rem] flex-1 font-mono text-[12px] text-text-primary">{r.providerType}</span>
                                <input type="number" min={0} step={1} placeholder="max ∥"
                                    className="w-20 px-2 py-1.5 rounded-lg bg-bg-secondary border border-border-subtle text-[12px] text-text-primary"
                                    value={r.maxParallel ?? ''}
                                    onChange={e => updateRole(i, { maxParallel: e.target.value === '' ? undefined : Number(e.target.value) })}
                                    disabled={saving} />
                                <button type="button" className="text-text-muted hover:text-red-400 bg-transparent border-none cursor-pointer"
                                    onClick={() => removeRole(i)} title="Remove cap" disabled={saving}>
                                    <IconX size={13} />
                                </button>
                            </div>
                        ))}
                        {addableProviders.length > 0 && (
                            <div className="flex items-center gap-2">
                                <select
                                    className="rounded-lg bg-bg-secondary border border-border-subtle px-2 py-1.5 text-[12px] text-text-primary"
                                    value=""
                                    onChange={e => { addRole(e.target.value); e.currentTarget.value = '' }}
                                    disabled={saving}
                                >
                                    <option value="">Add cap for…</option>
                                    {addableProviders.map(p => <option key={p} value={p}>{p}</option>)}
                                </select>
                                <span className="text-text-muted"><IconPlus size={12} /></span>
                            </div>
                        )}
                    </div>
                </FormField>
            </div>

            <div className="mt-2 flex items-center gap-2">
                <button type="button" className="btn btn-secondary btn-sm" onClick={save} disabled={saving || !dirty}>
                    {saving ? 'Saving…' : 'Save'}
                </button>
            </div>
        </div>
    )
}
