/**
 * NodeSlotEditor — the per-node "Preferred AI tools" capability-slot editor
 * (ORCHESTRATION_NODE_SLOTS.md).
 *
 * A node's slots are an ordered array; order = preference. Each slot bundles a
 * provider + optional model + thinking level + the task difficulty range it
 * handles + capability tags + a per-slot maxParallel cap. This one editor absorbs
 * what used to be three surfaces: provider priority (order), per-node maxParallel
 * (providerRoles), and the machine-global difficulty→model/thinking brain presets.
 *
 * Saves the whole array via onSave; the daemon persists it as node.policy.slots.
 * An empty array clears slots (the node falls back to legacy providerPriority
 * routing).
 */
import { useEffect, useMemo, useState } from 'react'
import { MESH_TASK_DIFFICULTIES, type MeshTaskDifficulty, type NodeCapabilitySlot } from '@adhdev/mesh-shared'
import { buildProviderOptionMap, type AvailableCliProviderOption } from '../../utils/provider-priority'
import { IconX, IconPlus } from '../../components/Icons'

const THINKING_LEVELS = ['', 'low', 'medium', 'high'] as const
const DIFFICULTY_LABEL: Record<MeshTaskDifficulty, string> = {
    easy: 'Easy', medium: 'Medium', difficult: 'Difficult', freeform: 'Freeform',
}

/** Editable draft of a slot (all fields as strings/arrays for form binding). */
interface SlotDraft {
    provider: string
    model: string
    thinkingLevel: string
    difficulty: MeshTaskDifficulty[]
    capability: string[]
    maxParallel: string
}

function slotToDraft(s: NodeCapabilitySlot): SlotDraft {
    return {
        provider: s.provider || '',
        model: s.model || '',
        thinkingLevel: s.thinkingLevel || '',
        difficulty: Array.isArray(s.difficulty) ? s.difficulty : [],
        capability: Array.isArray(s.capability) ? s.capability : [],
        maxParallel: s.maxParallel != null ? String(s.maxParallel) : '',
    }
}

function draftToSlot(d: SlotDraft): NodeCapabilitySlot | null {
    const provider = d.provider.trim()
    if (!provider) return null
    const model = d.model.trim()
    // Provider's own thinking vocabulary passed through (e.g. 'max'); empty = default.
    const thinkingLevel = d.thinkingLevel.trim() || undefined
    const maxNum = Number(d.maxParallel)
    const maxParallel = Number.isFinite(maxNum) && maxNum > 0 ? Math.floor(maxNum) : undefined
    return {
        provider,
        ...(model ? { model } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        ...(d.difficulty.length ? { difficulty: d.difficulty } : {}),
        ...(d.capability.length ? { capability: d.capability } : {}),
        ...(maxParallel !== undefined ? { maxParallel } : {}),
    }
}

function emptyDraft(): SlotDraft {
    return { provider: '', model: '', thinkingLevel: '', difficulty: [], capability: [], maxParallel: '' }
}

interface Props {
    slots: NodeCapabilitySlot[]
    availableProviders: AvailableCliProviderOption[]
    saving?: boolean
    onSave: (slots: NodeCapabilitySlot[]) => void
}

const selectCls = 'w-full rounded-lg border border-border-subtle bg-bg-secondary text-text-primary px-2.5 py-1.5 text-xs'

export default function NodeSlotEditor({ slots, availableProviders, saving, onSave }: Props) {
    const [drafts, setDrafts] = useState<SlotDraft[]>(() => slots.map(slotToDraft))
    // Re-seed from server value when it changes (after a save / reload).
    const savedKey = useMemo(() => JSON.stringify(slots), [slots])
    useEffect(() => { setDrafts(slots.map(slotToDraft)) }, [savedKey]) // eslint-disable-line react-hooks/exhaustive-deps

    const providerTypes = useMemo(
        () => [...new Set(availableProviders.map(p => p.type).filter(Boolean))],
        [availableProviders],
    )
    // Per-provider advisory model / thinking option lists (from the provider
    // manifest), so a slot's Model dropdown only offers models that provider
    // actually supports (e.g. codex has no 'haiku'). Falls back to free text when
    // the provider declares no model list. Shared lookup — same source the
    // New-session dialog and MAGI editor read.
    const optionsByProvider = useMemo(() => buildProviderOptionMap(availableProviders), [availableProviders])

    const dirty = useMemo(() => {
        const next = drafts.map(draftToSlot).filter(Boolean) as NodeCapabilitySlot[]
        return JSON.stringify(next) !== JSON.stringify(slots)
    }, [drafts, slots])

    const update = (i: number, patch: Partial<SlotDraft>) =>
        setDrafts(prev => prev.map((d, idx) => idx === i ? { ...d, ...patch } : d))
    // Switching provider must clear a model the new provider can't offer — otherwise
    // a leftover model (e.g. claude's 'opus') is treated as a custom value and the
    // Model dropdown silently falls back to a free-text input for the new provider.
    const changeProvider = (i: number, provider: string) => setDrafts(prev => prev.map((d, idx) => {
        if (idx !== i) return d
        const models = optionsByProvider.get(provider)?.models ?? []
        const keepModel = !d.model || models.length === 0 || models.includes(d.model)
        return { ...d, provider, ...(keepModel ? {} : { model: '' }) }
    }))
    const remove = (i: number) => setDrafts(prev => prev.filter((_, idx) => idx !== i))
    const add = () => setDrafts(prev => [...prev, emptyDraft()])
    const move = (i: number, dir: -1 | 1) => setDrafts(prev => {
        const j = i + dir
        if (j < 0 || j >= prev.length) return prev
        const next = [...prev]
        ;[next[i], next[j]] = [next[j], next[i]]
        return next
    })
    const toggleDifficulty = (i: number, diff: MeshTaskDifficulty) => setDrafts(prev => prev.map((d, idx) => {
        if (idx !== i) return d
        const has = d.difficulty.includes(diff)
        return { ...d, difficulty: has ? d.difficulty.filter(x => x !== diff) : [...d.difficulty, diff] }
    }))

    const save = () => onSave(drafts.map(draftToSlot).filter(Boolean) as NodeCapabilitySlot[])

    return (
        <div className="flex flex-col gap-2" onClick={e => e.stopPropagation()}>
            {drafts.length === 0 && (
                <div className="text-[12px] text-text-muted">
                    No capability slots set — that's fine. This node still runs tasks using its provider priority order (below). Slots are optional fine-tuning: add one to route specific task difficulties or capabilities to a specific tool.
                </div>
            )}
            {drafts.map((d, i) => (
                <div key={i} className="rounded-xl border border-border-subtle bg-bg-secondary/40 p-2.5">
                    <div className="flex items-center gap-1.5 mb-2">
                        <span className="text-[11px] font-semibold text-text-muted">#{i + 1}</span>
                        <div className="ml-auto flex items-center gap-1">
                            <button type="button" className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-border-subtle text-text-muted hover:text-text-primary disabled:opacity-40" disabled={i === 0} onClick={() => move(i, -1)} title="Move up">↑</button>
                            <button type="button" className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-border-subtle text-text-muted hover:text-text-primary disabled:opacity-40" disabled={i === drafts.length - 1} onClick={() => move(i, 1)} title="Move down">↓</button>
                            <button type="button" className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-status-error/30 text-status-error hover:bg-status-error/10" onClick={() => remove(i)} aria-label={`Remove slot ${i + 1}`}>
                                <IconX size={12} />
                            </button>
                        </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        <label className="flex flex-col gap-1">
                            <span className="text-[11px] text-text-muted">Provider</span>
                            {providerTypes.length > 0 ? (
                                <select className={selectCls} value={d.provider} onChange={e => changeProvider(i, e.target.value)}>
                                    <option value="">(select)</option>
                                    {providerTypes.map(t => <option key={t} value={t}>{t}</option>)}
                                    {d.provider && !providerTypes.includes(d.provider) && <option value={d.provider}>{d.provider}</option>}
                                </select>
                            ) : (
                                <input className={selectCls} value={d.provider} placeholder="claude-cli" onChange={e => update(i, { provider: e.target.value })} />
                            )}
                        </label>
                        {(() => {
                            const opts = optionsByProvider.get(d.provider)
                            const models = opts?.models ?? []
                            // Provider-declared thinking list wins; else the standard axis.
                            const thinking = (opts?.thinking?.length ? ['', ...opts.thinking] : THINKING_LEVELS) as readonly string[]
                            const modelIsCustom = !!d.model && models.length > 0 && !models.includes(d.model)
                            return (
                                <>
                                    <label className="flex flex-col gap-1">
                                        <span className="text-[11px] text-text-muted">Model</span>
                                        {models.length > 0 && !modelIsCustom ? (
                                            <select className={selectCls} value={models.includes(d.model) ? d.model : ''}
                                                onChange={e => update(i, { model: e.target.value === '__custom__' ? ' ' : e.target.value })}>
                                                <option value="">(provider default)</option>
                                                {models.map(m => <option key={m} value={m}>{m}</option>)}
                                                <option value="__custom__">Custom…</option>
                                            </select>
                                        ) : (
                                            <>
                                                <input className={selectCls} value={d.model.trim()}
                                                    placeholder={d.provider ? `${d.provider} model` : 'model'}
                                                    onChange={e => update(i, { model: e.target.value })} />
                                                {/* Back to the dropdown — only when the provider has a list to go back to. */}
                                                {models.length > 0 && (
                                                    <button type="button"
                                                        className="self-start bg-transparent border-none cursor-pointer p-0 text-[10px] text-text-muted hover:underline"
                                                        onClick={() => update(i, { model: '' })}>
                                                        ← Back to model list
                                                    </button>
                                                )}
                                            </>
                                        )}
                                    </label>
                                    <label className="flex flex-col gap-1">
                                        <span className="text-[11px] text-text-muted">Thinking</span>
                                        <select className={selectCls} value={d.thinkingLevel} onChange={e => update(i, { thinkingLevel: e.target.value })}>
                                            {thinking.map(l => <option key={l || '_default'} value={l}>{l || '(default)'}</option>)}
                                        </select>
                                    </label>
                                </>
                            )
                        })()}
                    </div>
                    <div className="mt-2">
                        <span className="text-[11px] text-text-muted">Difficulty (blank = all)</span>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                            {MESH_TASK_DIFFICULTIES.map(diff => {
                                const on = d.difficulty.includes(diff)
                                return (
                                    <button key={diff} type="button"
                                        className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${on ? 'border-accent-primary/60 bg-accent-primary/15 text-accent-primary' : 'border-border-subtle bg-bg-primary/60 text-text-muted hover:text-text-primary'}`}
                                        onClick={() => toggleDifficulty(i, diff)}>
                                        {DIFFICULTY_LABEL[diff]}
                                    </button>
                                )
                            })}
                        </div>
                    </div>
                    <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <label className="flex flex-col gap-1">
                            <span className="text-[11px] text-text-muted">Capability tags (comma-separated)</span>
                            <input className={selectCls} value={d.capability.join(', ')}
                                placeholder="worktree, os=darwin"
                                onChange={e => update(i, { capability: e.target.value.split(',').map(t => t.trim()).filter(Boolean) })} />
                        </label>
                        <label className="flex flex-col gap-1">
                            <span className="text-[11px] text-text-muted">Max parallel (per slot)</span>
                            <input type="number" inputMode="numeric" min={1} className={selectCls} value={d.maxParallel}
                                placeholder="unlimited"
                                onChange={e => update(i, { maxParallel: e.target.value })} />
                        </label>
                    </div>
                </div>
            ))}
            <div className="flex items-center gap-2">
                <button type="button" className="btn btn-secondary btn-sm inline-flex items-center gap-1" onClick={add}>
                    <IconPlus size={13} /> Add slot
                </button>
                <button type="button" className="btn btn-primary btn-sm ml-auto" onClick={save} disabled={!!saving || !dirty}>
                    {saving ? 'Saving…' : 'Save slots'}
                </button>
            </div>
        </div>
    )
}
