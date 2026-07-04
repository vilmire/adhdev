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

/** Resolved-section preview: per-section line range + captured text. */
export interface SectionPreview { id: string; fromLine: number; toLine: number; text: string }
export type SectionPreviewState = { sections: SectionPreview[]; screenLineCount: number } | 'loading' | { error: string } | null

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
        <div className="border border-border-default/60 rounded bg-surface-secondary p-1.5 space-y-1">
            <div className="flex items-center gap-1.5">
                <select
                    value={kind}
                    onChange={e => replaceKind(e.target.value as CondKind)}
                    className="bg-bg-secondary text-text-primary text-[10px] font-mono rounded border border-border-default px-1 py-0.5"
                >
                    {PALETTE.map(p => <option key={p.kind} value={p.kind}>{p.label}</option>)}
                </select>
                {(kind === 'regex' || kind === 'stable' || kind === 'changed' || kind === 'elapsed') && (
                    <button
                        type="button"
                        className="text-[10px] text-accent-primary hover:text-accent-primary px-1.5 py-0.5 rounded border border-accent hover:bg-accent-primary/20"
                        onClick={() => onPreview(path, cond)}
                    >
                        test
                    </button>
                )}
                {pv && pv !== 'loading' && (
                    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${pv.result ? 'text-status-online bg-status-online/20' : 'text-text-secondary bg-bg-glass'}`}>
                        {pv.result ? 'match ✓' : 'no match'}
                    </span>
                )}
                {pv === 'loading' && <span className="text-[10px] text-text-muted">testing…</span>}
                {onRemove && (
                    <button type="button" className="ml-auto text-text-muted hover:text-status-error text-xs px-1" onClick={onRemove}>×</button>
                )}
            </div>

            {/* Leaf editors */}
            {kind === 'regex' && (
                <div className="flex items-center gap-1">
                    <select
                        value={(cond as any).section ?? ''}
                        onChange={e => onChange({ ...(cond as any), section: e.target.value || undefined })}
                        className="bg-bg-secondary text-accent-primary text-[10px] font-mono rounded border border-border-default px-1 py-0.5"
                    >
                        <option value="">(whole screen)</option>
                        {sections.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <input
                        value={(cond as any).matches ?? ''}
                        onChange={e => onChange({ ...(cond as any), matches: e.target.value })}
                        placeholder="regex"
                        spellCheck={false}
                        className="flex-1 bg-bg-secondary text-text-primary text-[10px] font-mono rounded border border-border-default px-1.5 py-0.5 outline-none focus:border-accent"
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
                    <label className="flex items-center gap-1 text-[10px] text-text-secondary">
                        <input type="checkbox" checked={!!(cond as any).changed} onChange={e => onChange({ ...(cond as any), changed: e.target.checked })} className="accent-[var(--accent-primary)]" />
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
                <div className="pl-2 border-l border-border-default">
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
        <div className="pl-2 border-l border-border-default space-y-1">
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
                    className="text-[10px] text-text-secondary hover:text-text-primary px-1.5 py-0.5 rounded border border-border-default hover:bg-bg-glass-hover"
                    onClick={() => setChildren([...children, { section: sections[0], matches: '' }])}
                >
                    + condition
                </button>
                {SNIPPETS.map(s => (
                    <button
                        key={s.label}
                        type="button"
                        className="text-[10px] text-accent-primary/80 hover:text-accent-primary px-1.5 py-0.5 rounded border border-accent hover:bg-accent-primary/20"
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
        <label className="flex items-center gap-1 text-[10px] text-text-secondary font-mono">
            {label}
            <input
                type="number"
                value={Number.isFinite(value) ? value : 0}
                onChange={e => onChange(Number(e.target.value))}
                className="w-20 bg-bg-secondary text-text-primary rounded border border-border-default px-1 py-0.5 outline-none focus:border-accent"
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

function SectionsEditor({ sections, otherSectionIds, onChange, onTest, testResult }: {
    sections: Record<string, SectionDefModel>
    otherSectionIds: (self: string) => string[]
    onChange: (next: Record<string, SectionDefModel>) => void
    onTest: () => void
    testResult: SectionPreviewState
}) {
    const ids = Object.keys(sections)
    const previewById = (testResult && testResult !== 'loading' && !('error' in testResult))
        ? Object.fromEntries(testResult.sections.map(s => [s.id, s]))
        : {}

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
                <span className="text-text-secondary text-[10px] uppercase tracking-widest font-semibold">Sections</span>
                <span className="text-text-muted text-[10px]">— how the screen is split; conditions match against these</span>
                <button
                    type="button"
                    className="ml-auto text-[10px] text-accent-primary hover:text-accent-primary px-1.5 py-0.5 rounded border border-accent hover:bg-accent-primary/20"
                    onClick={onTest}
                    title="Resolve all sections against the live session screen"
                >{testResult === 'loading' ? 'testing…' : 'test on live screen'}</button>
                <button
                    type="button"
                    className="text-[10px] text-text-secondary hover:text-text-primary px-1.5 py-0.5 rounded border border-border-default hover:bg-bg-glass-hover"
                    onClick={addSection}
                >+ section</button>
            </div>
            {testResult && testResult !== 'loading' && 'error' in testResult && (
                <div className="text-status-error bg-status-error/15 border border-status-error/40 rounded p-1.5 text-[10px] mb-1">{testResult.error}</div>
            )}
            <div className="space-y-1.5">
                {ids.map(id => {
                    const def = sections[id]
                    const mode: 'anchor' | 'positional' = def.anchor != null ? 'anchor' : 'positional'
                    const setMode = (m: 'anchor' | 'positional') => {
                        if (m === 'anchor') updateSection(id, { anchor: def.anchor ?? '^', anchor_last: def.anchor_last, until: def.until })
                        else updateSection(id, { from_top: def.from_top ?? 0, until: def.until })
                    }
                    return (
                        <div key={id} className="border border-border-default/60 rounded bg-surface-secondary p-2 space-y-1.5">
                            <div className="flex items-center gap-2">
                                <input
                                    value={id}
                                    onChange={e => renameSection(id, e.target.value.trim())}
                                    className="w-28 bg-bg-secondary text-accent-primary font-mono text-[11px] rounded border border-border-default px-1.5 py-0.5 outline-none focus:border-accent"
                                />
                                <div className="inline-flex rounded border border-border-default overflow-hidden text-[10px]">
                                    <button type="button" className={`px-1.5 py-0.5 ${mode === 'positional' ? 'bg-accent-primary/20 text-accent-primary' : 'text-text-secondary hover:bg-bg-glass-hover'}`} onClick={() => setMode('positional')}>positional</button>
                                    <button type="button" className={`px-1.5 py-0.5 ${mode === 'anchor' ? 'bg-accent-primary/20 text-accent-primary' : 'text-text-secondary hover:bg-bg-glass-hover'}`} onClick={() => setMode('anchor')}>anchor</button>
                                </div>
                                <button type="button" className="ml-auto text-text-muted hover:text-status-error text-sm px-1" onClick={() => removeSection(id)}>×</button>
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
                                        <span className="text-[10px] text-text-muted w-16">anchor</span>
                                        <input
                                            value={def.anchor ?? ''}
                                            onChange={e => updateSection(id, { ...def, anchor: e.target.value })}
                                            placeholder="^regex locating section start"
                                            spellCheck={false}
                                            className="flex-1 bg-bg-secondary text-text-primary text-[10px] font-mono rounded border border-border-default px-1.5 py-0.5 outline-none focus:border-accent"
                                        />
                                        <label className="flex items-center gap-1 text-[10px] text-text-secondary">
                                            <input type="checkbox" checked={!!def.anchor_last} onChange={e => updateSection(id, { ...def, anchor_last: e.target.checked || undefined })} className="accent-[var(--accent-primary)]" />
                                            last
                                        </label>
                                    </div>
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <UntilField def={def} otherIds={otherSectionIds(id)} onChange={d => updateSection(id, d)} />
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                        <span className="text-[10px] text-text-muted w-16">ctx next</span>
                                        <input
                                            value={def.anchor_context?.next ?? ''}
                                            onChange={e => updateSection(id, { ...def, anchor_context: { ...def.anchor_context, next: e.target.value || undefined } })}
                                            placeholder="optional: line after anchor must match"
                                            spellCheck={false}
                                            className="flex-1 bg-bg-secondary text-text-secondary text-[10px] font-mono rounded border border-border-default px-1.5 py-0.5 outline-none focus:border-accent"
                                        />
                                    </div>
                                </div>
                            )}

                            {/* Live preview: what this section actually captures */}
                            {previewById[id] && (
                                <div className="border-t border-border-subtle pt-1">
                                    <div className="text-[9px] text-text-muted mb-0.5">
                                        captured lines {previewById[id].fromLine}–{previewById[id].toLine}
                                        {previewById[id].text.trim() === '' && <span className="text-amber-400 ml-1">(empty — check bounds)</span>}
                                    </div>
                                    <pre className="font-mono text-[10px] text-text-secondary whitespace-pre-wrap break-all bg-bg-secondary rounded border border-border-subtle px-2 py-1 max-h-28 overflow-y-auto">
                                        {previewById[id].text || '(empty)'}
                                    </pre>
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
        <label className="flex items-center gap-1 text-[10px] text-text-secondary">
            until
            <select
                value={isRegex ? '__regex__' : val}
                onChange={e => {
                    const v = e.target.value
                    if (v === '') onChange({ ...def, until: undefined })
                    else if (v === '__regex__') onChange({ ...def, until: val.startsWith('^') ? val : '^' })
                    else onChange({ ...def, until: v })
                }}
                className="bg-bg-secondary text-accent-primary rounded border border-border-default px-1 py-0.5"
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
                    className="w-40 bg-bg-secondary text-text-primary font-mono rounded border border-border-default px-1.5 py-0.5 outline-none focus:border-accent"
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
    onTestSections: (sections: Record<string, SectionDefModel>) => void
    sectionPreview: SectionPreviewState
}

export default function SpecFormBuilder({ model, onChange, onPreview, preview, onTestSections, sectionPreview }: Props) {
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
                onTest={() => onTestSections(model.sections ?? {})}
                testResult={sectionPreview}
            />

            {/* States */}
            <div>
                <div className="flex items-center gap-2 mb-1">
                    <span className="text-text-secondary text-[10px] uppercase tracking-widest font-semibold">States</span>
                    <button
                        type="button"
                        className="text-[10px] text-text-secondary hover:text-text-primary px-1.5 py-0.5 rounded border border-border-default hover:bg-bg-glass-hover"
                        onClick={() => patch({ states: [...model.states, { id: `state${model.states.length}`, label: 'New' }] })}
                    >+ state</button>
                </div>
                <div className="space-y-1.5">
                    {model.states.map((s, i) => (
                        <div key={i} className="border border-border-default/60 rounded bg-surface-secondary p-2 space-y-1">
                            <div className="flex items-end gap-2 flex-wrap">
                                <label className="flex flex-col gap-0.5">
                                    <span className="text-[9px] text-text-muted uppercase tracking-wide">id (used by transitions)</span>
                                    <input
                                        value={s.id}
                                        onChange={e => updateState(i, { id: e.target.value })}
                                        placeholder="idle"
                                        className="w-32 bg-bg-secondary text-accent-primary font-mono text-[11px] rounded border border-border-default px-1.5 py-0.5 outline-none focus:border-accent"
                                    />
                                </label>
                                <label className="flex flex-col gap-0.5 flex-1">
                                    <span className="text-[9px] text-text-muted uppercase tracking-wide">label (shown in dashboard)</span>
                                    <input
                                        value={s.label}
                                        onChange={e => updateState(i, { label: e.target.value })}
                                        placeholder="Ready"
                                        className="w-full bg-bg-secondary text-text-primary text-[11px] rounded border border-border-default px-1.5 py-0.5 outline-none focus:border-accent"
                                    />
                                </label>
                                <button type="button" className="text-text-muted hover:text-status-error text-sm px-1 pb-0.5" onClick={() => patch({ states: model.states.filter((_, si) => si !== i) })}>×</button>
                            </div>
                            <div className="flex items-center gap-3 text-[10px] text-text-secondary flex-wrap">
                                <label className="flex items-center gap-1">
                                    <input type="radio" name="initial" checked={!!s.initial} onChange={() => patch({ states: model.states.map((x, xi) => ({ ...x, initial: xi === i })) })} className="accent-[var(--accent-primary)]" />
                                    initial
                                </label>
                                <label className="flex items-center gap-1">
                                    <input type="checkbox" checked={!!s.modal} onChange={e => updateState(i, { modal: e.target.checked || undefined })} className="accent-[var(--accent-primary)]" />
                                    modal
                                </label>
                                <label className="flex items-center gap-1">
                                    status
                                    <select
                                        value={s.status ?? ''}
                                        onChange={e => updateState(i, { status: (e.target.value || undefined) as any })}
                                        className="bg-bg-secondary text-text-primary rounded border border-border-default px-1 py-0.5"
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
                    <span className="text-text-secondary text-[10px] uppercase tracking-widest font-semibold">Transitions</span>
                    <button
                        type="button"
                        className="text-[10px] text-text-secondary hover:text-text-primary px-1.5 py-0.5 rounded border border-border-default hover:bg-bg-glass-hover"
                        onClick={() => patch({ transitions: [...model.transitions, { from: stateIds[0] ?? '', to: stateIds[0] ?? '' }] })}
                    >+ transition</button>
                </div>
                <div className="space-y-1.5">
                    {model.transitions.map((t, i) => {
                        return (
                            <div key={i} className="border border-border-default/60 rounded bg-surface-secondary p-2 space-y-1.5">
                                <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-[10px] text-text-muted">from</span>
                                    <MultiStateSelect value={t.from} states={stateIds} onChange={from => updateTransition(i, { from })} />
                                    <span className="text-[10px] text-text-muted">→</span>
                                    <select
                                        value={t.to}
                                        onChange={e => updateTransition(i, { to: e.target.value })}
                                        className="bg-bg-secondary text-status-online font-mono text-[10px] rounded border border-border-default px-1 py-0.5"
                                    >
                                        {stateIds.map(s => <option key={s} value={s}>{s}</option>)}
                                    </select>
                                    <span className="text-[10px] text-text-muted ml-1">label</span>
                                    <input
                                        value={t.label ?? ''}
                                        onChange={e => updateTransition(i, { label: e.target.value || undefined })}
                                        placeholder="debug name only (optional)"
                                        title="Display name shown in the debug history/transition table. Does not affect behaviour."
                                        className="flex-1 min-w-[120px] bg-bg-secondary text-text-secondary text-[10px] rounded border border-border-default px-1.5 py-0.5 outline-none focus:border-accent"
                                    />
                                    <button type="button" className="text-text-muted hover:text-status-error text-sm px-1" onClick={() => patch({ transitions: model.transitions.filter((_, ti) => ti !== i) })}>×</button>
                                </div>
                                <div className="flex items-center gap-3">
                                    <NumField label="min_hold_ms" value={t.min_hold_ms ?? 0} onChange={v => updateTransition(i, { min_hold_ms: v || undefined })} />
                                    <NumField label="priority" value={t.priority ?? 0} onChange={v => updateTransition(i, { priority: v || undefined })} />
                                </div>
                                <div>
                                    <div className="flex items-center gap-2 mb-1">
                                        <span className="text-[10px] text-text-muted">when</span>
                                        {!t.when && (
                                            <button
                                                type="button"
                                                className="text-[10px] text-text-secondary hover:text-text-primary px-1.5 py-0.5 rounded border border-border-default hover:bg-bg-glass-hover"
                                                onClick={() => updateTransition(i, { when: { section: sectionIds[0], matches: '' } })}
                                            >+ guard condition</button>
                                        )}
                                        {t.when && (
                                            <button type="button" className="text-[10px] text-text-muted hover:text-status-error" onClick={() => updateTransition(i, { when: undefined })}>remove guard</button>
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
                    className={`font-mono text-[10px] px-1 py-0.5 rounded border ${(isWildcard || selected.has(s)) ? 'text-accent-primary bg-accent-primary/20 border-accent' : 'text-text-muted border-border-default hover:border-border-default'}`}
                >{s}</button>
            ))}
        </div>
    )
}
