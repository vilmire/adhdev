/**
 * SpecFormBuilder — structured editor for adhdev:cli/spec@4 FSM specs.
 *
 * The spec IS a state machine, so the editor is a state-machine builder, not a
 * text box: states are cards, transitions are cards with from/to dropdowns
 * (constrained to existing states — a dangling reference is impossible to
 * author), and `when` is a recursive condition builder fed by a type palette.
 *
 * Every edit mutates a typed in-memory spec model; the parent serializes it to
 * JSON on save. A condition's regex can be tested against the live session
 * screen inline (onPreview), and the whole spec is validated on the daemon on
 * every change (the parent gates Save on the result).
 */
import { useCallback } from 'react'

// ── Spec model (mirrors fsm-types.ts) ───────────────────────────────────────

export type FsmCond =
    | { section?: string; matches: string; flags?: string }
    | { cursor_above: number; changed: boolean; stable_ms?: number }
    | { elapsed_ms: number }
    | { stable_ms: number; cursor_above?: number }
    | { all: FsmCond[] }
    | { any: FsmCond[] }
    | { not: FsmCond }

/** Screen section definition (mirrors SectionDef in types.ts). A section is
 *  either positional (from_top/from_bottom + until) or anchor-based (a regex
 *  that locates the section's start). */
export interface SectionDefModel {
    from_top?: number | string
    from_bottom?: number | string
    until?: string
    anchor?: string
    anchor_flags?: string
    anchor_last?: boolean
    anchor_context?: { prev?: string; next?: string; prev_flags?: string; next_flags?: string }
    lines?: number
    until_regex?: string
    until_regex_flags?: string
}

export interface FsmStateModel {
    id: string
    label: string
    initial?: boolean
    modal?: boolean
    status?: 'idle' | 'generating' | 'approval'
    extract?: { title?: unknown; buttons?: unknown }
}

export interface FsmTransitionModel {
    from: string | string[]
    to: string
    when?: FsmCond
    min_hold_ms?: number
    priority?: number
    label?: string
}

export interface SpecModel {
    $schema: 'adhdev:cli/spec@4'
    id: string
    name: string
    binary: string
    cli_version_range?: string
    spawn_args?: string[]
    send_message: { submit_key: string; delay_ms_before_submit?: number; delay_ms_per_char?: number }
    sections: Record<string, SectionDefModel>
    states: FsmStateModel[]
    transitions: FsmTransitionModel[]
    control_bar?: unknown[]
    notifications?: unknown[]
    delegate?: unknown[]
    native_history?: unknown
}

// ── Condition type palette ──────────────────────────────────────────────────

type CondKind = 'regex' | 'elapsed' | 'stable' | 'changed' | 'all' | 'any' | 'not'

const PALETTE: { kind: CondKind; label: string; hint: string; make: (sections: string[]) => FsmCond }[] = [
    { kind: 'regex', label: 'section matches', hint: 'regex against a screen section', make: s => ({ section: s[0], matches: '' }) },
    { kind: 'elapsed', label: 'elapsed_ms', hint: 'N ms since state entered', make: () => ({ elapsed_ms: 1000 }) },
    { kind: 'stable', label: 'stable_ms', hint: 'region unchanged for N ms', make: () => ({ stable_ms: 1000, cursor_above: 5 }) },
    { kind: 'changed', label: 'changed', hint: 'region changed vs prev frame', make: () => ({ cursor_above: 3, changed: true }) },
    { kind: 'all', label: 'all (AND)', hint: 'every child must match', make: () => ({ all: [] }) },
    { kind: 'any', label: 'any (OR)', hint: 'some child must match', make: () => ({ any: [] }) },
    { kind: 'not', label: 'not', hint: 'invert a condition', make: () => ({ not: { matches: '' } }) },
]

// ── Verified claude-cli pattern snippets ────────────────────────────────────

const SNIPPETS: { label: string; cond: FsmCond }[] = [
    { label: 'active spinner (busy)', cond: { section: 'body', matches: '(?:^|\\n)\\s*[·✢✳✶✽✷✸✹]\\s+\\w.*?(?:…|\\.\\.\\.)' } },
    { label: 'completion marker (done)', cond: { section: 'body', matches: '✻\\s+\\w+ed\\s+for\\s+(?:\\d+h\\s+)?(?:\\d+m\\s+)?\\d+s' } },
    { label: 'approval prompt (❯ 1.)', cond: { section: 'footer', matches: '(?:^|\\n)\\s*[❯›>]\\s*1\\.\\s*.+' } },
    { label: 'picker (Select a …)', cond: { section: 'modal', matches: 'Select (?:a |an )?(?:model|mode|option)\\b' } },
    { label: 'stable 1.2s (settled)', cond: { stable_ms: 1200, cursor_above: 5 } },
]

function condKind(c: FsmCond): CondKind {
    if ('all' in c) return 'all'
    if ('any' in c) return 'any'
    if ('not' in c) return 'not'
    if ('elapsed_ms' in c) return 'elapsed'
    if ('stable_ms' in c && !('changed' in c)) return 'stable'
    if ('changed' in c) return 'changed'
    return 'regex'
}

// ── Live preview state, keyed by a stable path string per condition node ─────

export interface PreviewMap { [path: string]: { result: boolean; detail?: string } | 'loading' }

interface CondProps {
    cond: FsmCond
    path: string
    sections: string[]
    onChange: (next: FsmCond) => void
    onRemove?: () => void
    onPreview: (path: string, cond: FsmCond) => void
    preview: PreviewMap
}

function ConditionEditor({ cond, path, sections, onChange, onRemove, onPreview, preview }: CondProps) {
    const kind = condKind(cond)
    const pv = preview[path]

    const replaceKind = (k: CondKind) => {
        const entry = PALETTE.find(p => p.kind === k)
        if (entry) onChange(entry.make(sections))
    }

    return (
        <div className="border border-zinc-700/60 rounded bg-zinc-800/30 p-1.5 space-y-1">
            <div className="flex items-center gap-1.5">
                <select
                    value={kind}
                    onChange={e => replaceKind(e.target.value as CondKind)}
                    className="bg-zinc-900 text-zinc-200 text-[10px] font-mono rounded border border-zinc-700 px-1 py-0.5"
                >
                    {PALETTE.map(p => <option key={p.kind} value={p.kind}>{p.label}</option>)}
                </select>
                {(kind === 'regex' || kind === 'stable' || kind === 'changed' || kind === 'elapsed') && (
                    <button
                        type="button"
                        className="text-[10px] text-sky-300 hover:text-sky-100 px-1.5 py-0.5 rounded border border-sky-700/40 hover:bg-sky-600/20"
                        onClick={() => onPreview(path, cond)}
                    >
                        test
                    </button>
                )}
                {pv && pv !== 'loading' && (
                    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${pv.result ? 'text-green-200 bg-green-600/25' : 'text-zinc-400 bg-zinc-700/40'}`}>
                        {pv.result ? 'match ✓' : 'no match'}
                    </span>
                )}
                {pv === 'loading' && <span className="text-[10px] text-zinc-500">testing…</span>}
                {onRemove && (
                    <button type="button" className="ml-auto text-zinc-500 hover:text-red-300 text-xs px-1" onClick={onRemove}>×</button>
                )}
            </div>

            {/* Leaf editors */}
            {kind === 'regex' && (
                <div className="flex items-center gap-1">
                    <select
                        value={(cond as any).section ?? ''}
                        onChange={e => onChange({ ...(cond as any), section: e.target.value || undefined })}
                        className="bg-zinc-900 text-sky-300 text-[10px] font-mono rounded border border-zinc-700 px-1 py-0.5"
                    >
                        <option value="">(whole screen)</option>
                        {sections.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <input
                        value={(cond as any).matches ?? ''}
                        onChange={e => onChange({ ...(cond as any), matches: e.target.value })}
                        placeholder="regex"
                        spellCheck={false}
                        className="flex-1 bg-black/40 text-zinc-200 text-[10px] font-mono rounded border border-zinc-700 px-1.5 py-0.5 outline-none focus:border-sky-500/50"
                    />
                </div>
            )}
            {kind === 'elapsed' && (
                <NumField label="elapsed_ms" value={(cond as any).elapsed_ms} onChange={v => onChange({ elapsed_ms: v })} />
            )}
            {kind === 'stable' && (
                <div className="flex items-center gap-2">
                    <NumField label="stable_ms" value={(cond as any).stable_ms} onChange={v => onChange({ ...(cond as any), stable_ms: v })} />
                    <NumField label="cursor_above" value={(cond as any).cursor_above ?? 0} onChange={v => onChange({ ...(cond as any), cursor_above: v || undefined })} />
                </div>
            )}
            {kind === 'changed' && (
                <div className="flex items-center gap-2">
                    <NumField label="cursor_above" value={(cond as any).cursor_above} onChange={v => onChange({ ...(cond as any), cursor_above: v })} />
                    <label className="flex items-center gap-1 text-[10px] text-zinc-400">
                        <input type="checkbox" checked={!!(cond as any).changed} onChange={e => onChange({ ...(cond as any), changed: e.target.checked })} className="accent-sky-500" />
                        changed
                    </label>
                </div>
            )}

            {/* Composite editors */}
            {(kind === 'all' || kind === 'any') && (
                <CompositeEditor
                    kind={kind}
                    cond={cond as any}
                    path={path}
                    sections={sections}
                    onChange={onChange}
                    onPreview={onPreview}
                    preview={preview}
                />
            )}
            {kind === 'not' && (
                <div className="pl-2 border-l border-zinc-700">
                    <ConditionEditor
                        cond={(cond as any).not}
                        path={`${path}.not`}
                        sections={sections}
                        onChange={inner => onChange({ not: inner })}
                        onPreview={onPreview}
                        preview={preview}
                    />
                </div>
            )}
        </div>
    )
}

function CompositeEditor({ kind, cond, path, sections, onChange, onPreview, preview }: {
    kind: 'all' | 'any'
    cond: { all?: FsmCond[]; any?: FsmCond[] }
    path: string
    sections: string[]
    onChange: (c: FsmCond) => void
    onPreview: (path: string, cond: FsmCond) => void
    preview: PreviewMap
}) {
    const children: FsmCond[] = (kind === 'all' ? cond.all : cond.any) ?? []
    const setChildren = (next: FsmCond[]) => onChange(kind === 'all' ? { all: next } : { any: next })
    return (
        <div className="pl-2 border-l border-zinc-700 space-y-1">
            {children.map((c, i) => (
                <ConditionEditor
                    key={i}
                    cond={c}
                    path={`${path}.${kind}[${i}]`}
                    sections={sections}
                    onChange={nc => setChildren(children.map((x, xi) => xi === i ? nc : x))}
                    onRemove={() => setChildren(children.filter((_, xi) => xi !== i))}
                    onPreview={onPreview}
                    preview={preview}
                />
            ))}
            <div className="flex items-center gap-1 flex-wrap">
                <button
                    type="button"
                    className="text-[10px] text-zinc-300 hover:text-white px-1.5 py-0.5 rounded border border-zinc-700 hover:bg-zinc-700/40"
                    onClick={() => setChildren([...children, { section: sections[0], matches: '' }])}
                >
                    + condition
                </button>
                {SNIPPETS.map(s => (
                    <button
                        key={s.label}
                        type="button"
                        className="text-[10px] text-sky-300/80 hover:text-sky-100 px-1.5 py-0.5 rounded border border-sky-700/30 hover:bg-sky-600/15"
                        onClick={() => setChildren([...children, JSON.parse(JSON.stringify(s.cond))])}
                        title="insert verified pattern"
                    >
                        + {s.label}
                    </button>
                ))}
            </div>
        </div>
    )
}

function NumField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
    return (
        <label className="flex items-center gap-1 text-[10px] text-zinc-400 font-mono">
            {label}
            <input
                type="number"
                value={Number.isFinite(value) ? value : 0}
                onChange={e => onChange(Number(e.target.value))}
                className="w-20 bg-black/40 text-zinc-200 rounded border border-zinc-700 px-1 py-0.5 outline-none focus:border-sky-500/50"
            />
        </label>
    )
}

// ── Sections editor ─────────────────────────────────────────────────────────
//
// A section is positional (from_top/from_bottom + until) OR anchor-based
// (a regex that locates its start). The "test" button previews the resolved
// section text against the live screen via the regex-preview path (we wrap the
// section's own bounds into a throwaway condition the parent can evaluate).

function SectionsEditor({ sections, otherSectionIds, onChange }: {
    sections: Record<string, SectionDefModel>
    otherSectionIds: (self: string) => string[]
    onChange: (next: Record<string, SectionDefModel>) => void
}) {
    const ids = Object.keys(sections)

    const renameSection = (oldId: string, newId: string) => {
        if (!newId || newId === oldId || sections[newId]) return
        const next: Record<string, SectionDefModel> = {}
        for (const [k, v] of Object.entries(sections)) next[k === oldId ? newId : k] = v
        onChange(next)
    }
    const updateSection = (id: string, def: SectionDefModel) =>
        onChange({ ...sections, [id]: def })
    const removeSection = (id: string) => {
        const next = { ...sections }; delete next[id]; onChange(next)
    }
    const addSection = () => {
        let n = 'section'; let i = 1
        while (sections[n]) { n = `section${i++}` }
        onChange({ ...sections, [n]: { from_top: 0 } })
    }

    return (
        <div>
            <div className="flex items-center gap-2 mb-1">
                <span className="text-zinc-400 text-[10px] uppercase tracking-widest font-semibold">Sections</span>
                <span className="text-zinc-600 text-[10px]">— how the screen is split; conditions match against these</span>
                <button
                    type="button"
                    className="ml-auto text-[10px] text-zinc-300 hover:text-white px-1.5 py-0.5 rounded border border-zinc-700 hover:bg-zinc-700/40"
                    onClick={addSection}
                >+ section</button>
            </div>
            <div className="space-y-1.5">
                {ids.map(id => {
                    const def = sections[id]
                    const mode: 'anchor' | 'positional' = def.anchor != null ? 'anchor' : 'positional'
                    const setMode = (m: 'anchor' | 'positional') => {
                        if (m === 'anchor') updateSection(id, { anchor: def.anchor ?? '^', anchor_last: def.anchor_last, until: def.until })
                        else updateSection(id, { from_top: def.from_top ?? 0, until: def.until })
                    }
                    return (
                        <div key={id} className="border border-zinc-700/60 rounded bg-zinc-800/30 p-2 space-y-1.5">
                            <div className="flex items-center gap-2">
                                <input
                                    value={id}
                                    onChange={e => renameSection(id, e.target.value.trim())}
                                    className="w-28 bg-black/40 text-sky-300 font-mono text-[11px] rounded border border-zinc-700 px-1.5 py-0.5 outline-none focus:border-sky-500/50"
                                />
                                <div className="inline-flex rounded border border-zinc-700 overflow-hidden text-[10px]">
                                    <button type="button" className={`px-1.5 py-0.5 ${mode === 'positional' ? 'bg-sky-600/30 text-sky-100' : 'text-zinc-400 hover:bg-zinc-700/40'}`} onClick={() => setMode('positional')}>positional</button>
                                    <button type="button" className={`px-1.5 py-0.5 ${mode === 'anchor' ? 'bg-sky-600/30 text-sky-100' : 'text-zinc-400 hover:bg-zinc-700/40'}`} onClick={() => setMode('anchor')}>anchor</button>
                                </div>
                                <button type="button" className="ml-auto text-zinc-500 hover:text-red-300 text-sm px-1" onClick={() => removeSection(id)}>×</button>
                            </div>

                            {mode === 'positional' ? (
                                <div className="flex items-center gap-2 flex-wrap">
                                    <NumField label="from_top" value={typeof def.from_top === 'number' ? def.from_top : 0} onChange={v => updateSection(id, { ...def, from_top: v, from_bottom: undefined })} />
                                    <NumField label="from_bottom" value={typeof def.from_bottom === 'number' ? def.from_bottom : 0} onChange={v => updateSection(id, { ...def, from_bottom: v || undefined })} />
                                    <UntilField def={def} otherIds={otherSectionIds(id)} onChange={d => updateSection(id, d)} />
                                </div>
                            ) : (
                                <div className="space-y-1">
                                    <div className="flex items-center gap-1.5">
                                        <span className="text-[10px] text-zinc-500 w-16">anchor</span>
                                        <input
                                            value={def.anchor ?? ''}
                                            onChange={e => updateSection(id, { ...def, anchor: e.target.value })}
                                            placeholder="^regex locating section start"
                                            spellCheck={false}
                                            className="flex-1 bg-black/40 text-zinc-200 text-[10px] font-mono rounded border border-zinc-700 px-1.5 py-0.5 outline-none focus:border-sky-500/50"
                                        />
                                        <label className="flex items-center gap-1 text-[10px] text-zinc-400">
                                            <input type="checkbox" checked={!!def.anchor_last} onChange={e => updateSection(id, { ...def, anchor_last: e.target.checked || undefined })} className="accent-sky-500" />
                                            last
                                        </label>
                                    </div>
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <UntilField def={def} otherIds={otherSectionIds(id)} onChange={d => updateSection(id, d)} />
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                        <span className="text-[10px] text-zinc-500 w-16">ctx next</span>
                                        <input
                                            value={def.anchor_context?.next ?? ''}
                                            onChange={e => updateSection(id, { ...def, anchor_context: { ...def.anchor_context, next: e.target.value || undefined } })}
                                            placeholder="optional: line after anchor must match"
                                            spellCheck={false}
                                            className="flex-1 bg-black/40 text-zinc-300 text-[10px] font-mono rounded border border-zinc-700 px-1.5 py-0.5 outline-none focus:border-sky-500/50"
                                        />
                                    </div>
                                </div>
                            )}
                        </div>
                    )
                })}
            </div>
        </div>
    )
}

/** `until` is either another section id (dropdown) or a regex (starts with ^). */
function UntilField({ def, otherIds, onChange }: {
    def: SectionDefModel; otherIds: string[]; onChange: (d: SectionDefModel) => void
}) {
    const val = def.until ?? ''
    const isRegex = val.startsWith('^')
    return (
        <label className="flex items-center gap-1 text-[10px] text-zinc-400">
            until
            <select
                value={isRegex ? '__regex__' : val}
                onChange={e => {
                    const v = e.target.value
                    if (v === '') onChange({ ...def, until: undefined })
                    else if (v === '__regex__') onChange({ ...def, until: val.startsWith('^') ? val : '^' })
                    else onChange({ ...def, until: v })
                }}
                className="bg-zinc-900 text-sky-300 rounded border border-zinc-700 px-1 py-0.5"
            >
                <option value="">(none)</option>
                {otherIds.map(s => <option key={s} value={s}>{s}</option>)}
                <option value="__regex__">regex…</option>
            </select>
            {isRegex && (
                <input
                    value={val}
                    onChange={e => onChange({ ...def, until: e.target.value })}
                    spellCheck={false}
                    className="w-40 bg-black/40 text-zinc-200 font-mono rounded border border-zinc-700 px-1.5 py-0.5 outline-none focus:border-sky-500/50"
                />
            )}
        </label>
    )
}

// ── Top-level builder ───────────────────────────────────────────────────────

interface Props {
    model: SpecModel
    onChange: (next: SpecModel) => void
    onPreview: (path: string, cond: FsmCond) => void
    preview: PreviewMap
}

export default function SpecFormBuilder({ model, onChange, onPreview, preview }: Props) {
    const stateIds = model.states.map(s => s.id)
    const sectionIds = Object.keys(model.sections ?? {})

    const patch = useCallback((p: Partial<SpecModel>) => onChange({ ...model, ...p }), [model, onChange])

    const updateState = (i: number, p: Partial<FsmStateModel>) =>
        patch({ states: model.states.map((s, si) => si === i ? { ...s, ...p } : s) })
    const updateTransition = (i: number, p: Partial<FsmTransitionModel>) =>
        patch({ transitions: model.transitions.map((t, ti) => ti === i ? { ...t, ...p } : t) })

    return (
        <div className="space-y-3">
            {/* Sections — the screen-splitting layer everything else references */}
            <SectionsEditor
                sections={model.sections ?? {}}
                otherSectionIds={(self) => sectionIds.filter(s => s !== self)}
                onChange={sections => patch({ sections })}
            />

            {/* States */}
            <div>
                <div className="flex items-center gap-2 mb-1">
                    <span className="text-zinc-400 text-[10px] uppercase tracking-widest font-semibold">States</span>
                    <button
                        type="button"
                        className="text-[10px] text-zinc-300 hover:text-white px-1.5 py-0.5 rounded border border-zinc-700 hover:bg-zinc-700/40"
                        onClick={() => patch({ states: [...model.states, { id: `state${model.states.length}`, label: 'New' }] })}
                    >+ state</button>
                </div>
                <div className="space-y-1.5">
                    {model.states.map((s, i) => (
                        <div key={i} className="border border-zinc-700/60 rounded bg-zinc-800/30 p-2 space-y-1">
                            <div className="flex items-end gap-2 flex-wrap">
                                <label className="flex flex-col gap-0.5">
                                    <span className="text-[9px] text-zinc-500 uppercase tracking-wide">id (used by transitions)</span>
                                    <input
                                        value={s.id}
                                        onChange={e => updateState(i, { id: e.target.value })}
                                        placeholder="idle"
                                        className="w-32 bg-black/40 text-sky-300 font-mono text-[11px] rounded border border-zinc-700 px-1.5 py-0.5 outline-none focus:border-sky-500/50"
                                    />
                                </label>
                                <label className="flex flex-col gap-0.5 flex-1">
                                    <span className="text-[9px] text-zinc-500 uppercase tracking-wide">label (shown in dashboard)</span>
                                    <input
                                        value={s.label}
                                        onChange={e => updateState(i, { label: e.target.value })}
                                        placeholder="Ready"
                                        className="w-full bg-black/40 text-zinc-200 text-[11px] rounded border border-zinc-700 px-1.5 py-0.5 outline-none focus:border-sky-500/50"
                                    />
                                </label>
                                <button type="button" className="text-zinc-500 hover:text-red-300 text-sm px-1 pb-0.5" onClick={() => patch({ states: model.states.filter((_, si) => si !== i) })}>×</button>
                            </div>
                            <div className="flex items-center gap-3 text-[10px] text-zinc-400 flex-wrap">
                                <label className="flex items-center gap-1">
                                    <input type="radio" name="initial" checked={!!s.initial} onChange={() => patch({ states: model.states.map((x, xi) => ({ ...x, initial: xi === i })) })} className="accent-sky-500" />
                                    initial
                                </label>
                                <label className="flex items-center gap-1">
                                    <input type="checkbox" checked={!!s.modal} onChange={e => updateState(i, { modal: e.target.checked || undefined })} className="accent-sky-500" />
                                    modal
                                </label>
                                <label className="flex items-center gap-1">
                                    status
                                    <select
                                        value={s.status ?? ''}
                                        onChange={e => updateState(i, { status: (e.target.value || undefined) as any })}
                                        className="bg-zinc-900 text-zinc-200 rounded border border-zinc-700 px-1 py-0.5"
                                    >
                                        <option value="">(auto)</option>
                                        <option value="idle">idle</option>
                                        <option value="generating">generating</option>
                                        <option value="approval">approval</option>
                                    </select>
                                </label>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* Transitions */}
            <div>
                <div className="flex items-center gap-2 mb-1">
                    <span className="text-zinc-400 text-[10px] uppercase tracking-widest font-semibold">Transitions</span>
                    <button
                        type="button"
                        className="text-[10px] text-zinc-300 hover:text-white px-1.5 py-0.5 rounded border border-zinc-700 hover:bg-zinc-700/40"
                        onClick={() => patch({ transitions: [...model.transitions, { from: stateIds[0] ?? '', to: stateIds[0] ?? '' }] })}
                    >+ transition</button>
                </div>
                <div className="space-y-1.5">
                    {model.transitions.map((t, i) => {
                        return (
                            <div key={i} className="border border-zinc-700/60 rounded bg-zinc-800/30 p-2 space-y-1.5">
                                <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-[10px] text-zinc-500">from</span>
                                    <MultiStateSelect value={t.from} states={stateIds} onChange={from => updateTransition(i, { from })} />
                                    <span className="text-[10px] text-zinc-500">→</span>
                                    <select
                                        value={t.to}
                                        onChange={e => updateTransition(i, { to: e.target.value })}
                                        className="bg-zinc-900 text-green-200 font-mono text-[10px] rounded border border-zinc-700 px-1 py-0.5"
                                    >
                                        {stateIds.map(s => <option key={s} value={s}>{s}</option>)}
                                    </select>
                                    <span className="text-[10px] text-zinc-500 ml-1">label</span>
                                    <input
                                        value={t.label ?? ''}
                                        onChange={e => updateTransition(i, { label: e.target.value || undefined })}
                                        placeholder="debug name only (optional)"
                                        title="Display name shown in the debug history/transition table. Does not affect behaviour."
                                        className="flex-1 min-w-[120px] bg-black/40 text-zinc-300 text-[10px] rounded border border-zinc-700 px-1.5 py-0.5 outline-none focus:border-sky-500/50"
                                    />
                                    <button type="button" className="text-zinc-500 hover:text-red-300 text-sm px-1" onClick={() => patch({ transitions: model.transitions.filter((_, ti) => ti !== i) })}>×</button>
                                </div>
                                <div className="flex items-center gap-3">
                                    <NumField label="min_hold_ms" value={t.min_hold_ms ?? 0} onChange={v => updateTransition(i, { min_hold_ms: v || undefined })} />
                                    <NumField label="priority" value={t.priority ?? 0} onChange={v => updateTransition(i, { priority: v || undefined })} />
                                </div>
                                <div>
                                    <div className="flex items-center gap-2 mb-1">
                                        <span className="text-[10px] text-zinc-500">when</span>
                                        {!t.when && (
                                            <button
                                                type="button"
                                                className="text-[10px] text-zinc-300 hover:text-white px-1.5 py-0.5 rounded border border-zinc-700 hover:bg-zinc-700/40"
                                                onClick={() => updateTransition(i, { when: { section: sectionIds[0], matches: '' } })}
                                            >+ guard condition</button>
                                        )}
                                        {t.when && (
                                            <button type="button" className="text-[10px] text-zinc-500 hover:text-red-300" onClick={() => updateTransition(i, { when: undefined })}>remove guard</button>
                                        )}
                                    </div>
                                    {t.when && (
                                        <ConditionEditor
                                            cond={t.when}
                                            path={`t${i}`}
                                            sections={sectionIds}
                                            onChange={when => updateTransition(i, { when })}
                                            onPreview={onPreview}
                                            preview={preview}
                                        />
                                    )}
                                </div>
                            </div>
                        )
                    })}
                </div>
            </div>
        </div>
    )
}

function MultiStateSelect({ value, states, onChange }: { value: string | string[]; states: string[]; onChange: (v: string | string[]) => void }) {
    const selected = new Set(Array.isArray(value) ? value : value === '*' ? states : [value])
    const isWildcard = value === '*'
    const toggle = (s: string) => {
        const next = new Set(selected)
        if (next.has(s)) next.delete(s); else next.add(s)
        const arr = states.filter(x => next.has(x))
        onChange(arr.length === 1 ? arr[0] : arr)
    }
    return (
        <div className="flex items-center gap-0.5 flex-wrap">
            {states.map(s => (
                <button
                    key={s}
                    type="button"
                    onClick={() => toggle(s)}
                    className={`font-mono text-[10px] px-1 py-0.5 rounded border ${(isWildcard || selected.has(s)) ? 'text-sky-200 bg-sky-600/25 border-sky-500/40' : 'text-zinc-500 border-zinc-700 hover:border-zinc-500'}`}
                >{s}</button>
            ))}
        </div>
    )
}
