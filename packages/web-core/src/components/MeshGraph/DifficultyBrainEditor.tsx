/**
 * Difficulty → brain preset editor.
 *
 * Each task difficulty (easy / medium / difficult / freeform) maps to a brain
 * preset — provider / model / thinking level — that the mesh applies when the
 * coordinator enqueues a task with that difficulty. The point is token economy:
 * easy work on a cheap model at low reasoning effort, hard work on a strong model
 * at high effort. Sibling of the MAGI kind-panel editor; talks to the same
 * sendDaemonCommand seam (difficulty_brains_get / difficulty_brains_set).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTheme } from '../../hooks/useTheme'
import { getMeshGraphTheme, type MeshGraphTheme } from './meshGraphTheme'

const DIFFICULTIES: { key: string; label: string; hint: string }[] = [
    { key: 'easy', label: 'Easy', hint: 'trivial fixes, renames, docs — save tokens' },
    { key: 'medium', label: 'Medium', hint: 'ordinary feature / bugfix work' },
    { key: 'difficult', label: 'Difficult', hint: 'architecture, tricky debugging, hard reasoning' },
    { key: 'freeform', label: 'Freeform', hint: 'no fixed shape' },
]

const THINKING_LEVELS = ['', 'low', 'medium', 'high'] as const

const FALLBACK_PROVIDERS = ['claude-cli', 'codex-cli', 'gemini-cli', 'hermes-cli', 'antigravity-cli']

interface BrainSlotDraft { provider: string; model: string; thinkingLevel: string }

function emptySlot(): BrainSlotDraft { return { provider: '', model: '', thinkingLevel: '' } }

interface Props {
    daemonId?: string | null
    sendDaemonCommand?: ((id: string, type: string, data?: Record<string, unknown>) => Promise<any>) | null
    /** Provider types detected across the mesh, offered in the provider dropdown. */
    providerOptions?: string[]
}

export default function DifficultyBrainEditor({ daemonId, sendDaemonCommand, providerOptions }: Props) {
    const { theme } = useTheme()
    const meshTheme: MeshGraphTheme = useMemo(() => getMeshGraphTheme(theme), [theme])

    const [drafts, setDrafts] = useState<Record<string, BrainSlotDraft>>({})
    const [saved, setSaved] = useState<Record<string, BrainSlotDraft>>({})
    const [loading, setLoading] = useState(false)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const canCommand = !!daemonId && !!sendDaemonCommand
    const unwrap = (raw: any) => (raw && typeof raw === 'object' && 'result' in raw ? raw.result : raw)

    const providers = useMemo(() => {
        const live = (providerOptions || []).filter(Boolean)
        return [...new Set([...live, ...FALLBACK_PROVIDERS])].sort()
    }, [providerOptions])

    const load = useCallback(async () => {
        if (!daemonId || !sendDaemonCommand) return
        setLoading(true); setError(null)
        try {
            const result = unwrap(await sendDaemonCommand(daemonId, 'difficulty_brains_get', {}))
            if (result?.success === false) throw new Error(result.error || 'Failed to load brain presets')
            const map = (result?.difficultyBrains && typeof result.difficultyBrains === 'object') ? result.difficultyBrains : {}
            const next: Record<string, BrainSlotDraft> = {}
            for (const { key } of DIFFICULTIES) {
                const s = map[key] || {}
                next[key] = { provider: s.provider || '', model: s.model || '', thinkingLevel: s.thinkingLevel || '' }
            }
            setDrafts(next); setSaved(JSON.parse(JSON.stringify(next)))
        } catch (e: any) {
            setError(e?.message || 'Failed to load brain presets')
        } finally { setLoading(false) }
    }, [daemonId, sendDaemonCommand])

    useEffect(() => { void load() }, [load])

    const dirty = useMemo(() => JSON.stringify(drafts) !== JSON.stringify(saved), [drafts, saved])

    const update = (key: string, patch: Partial<BrainSlotDraft>) => {
        setDrafts(d => ({ ...d, [key]: { ...(d[key] || emptySlot()), ...patch } }))
    }

    const save = useCallback(async () => {
        if (!daemonId || !sendDaemonCommand) return
        // Build the map, dropping fully-empty slots (the daemon normalizes too).
        const difficultyBrains: Record<string, any> = {}
        for (const { key } of DIFFICULTIES) {
            const s = drafts[key] || emptySlot()
            const slot: Record<string, string> = {}
            if (s.provider.trim()) slot.provider = s.provider.trim()
            if (s.model.trim()) slot.model = s.model.trim()
            if (s.thinkingLevel.trim()) slot.thinkingLevel = s.thinkingLevel.trim()
            if (Object.keys(slot).length) difficultyBrains[key] = slot
        }
        setSaving(true); setError(null)
        try {
            const result = unwrap(await sendDaemonCommand(daemonId, 'difficulty_brains_set', { difficultyBrains }))
            if (result?.success === false) throw new Error(result.error || 'Failed to save brain presets')
            await load()
        } catch (e: any) {
            setError(e?.message || 'Failed to save brain presets')
        } finally { setSaving(false) }
    }, [daemonId, sendDaemonCommand, drafts, load])

    const inputClass = `w-full rounded-lg border px-2.5 py-1.5 text-xs ${meshTheme.isDark ? 'border-white/10 bg-slate-950/40 text-slate-100 placeholder:text-slate-500' : 'border-slate-300 bg-white text-slate-900 placeholder:text-slate-400'}`
    const labelClass = `text-[9px] uppercase tracking-wide ${meshTheme.textSecondary}`

    return (
        <div className="flex flex-col gap-3 p-1">
            <p className={`text-[12px] ${meshTheme.textSecondary}`}>
                Map each task difficulty to a brain. The coordinator classifies a task's difficulty; easy work then runs on a cheaper model at low effort, hard work on a stronger model at high effort. Leave a field blank to keep the routed default.
            </p>

            {!canCommand && (
                <div className={`rounded-xl border p-3 text-[12px] ${meshTheme.textSecondary} ${meshTheme.isDark ? 'border-white/10' : 'border-slate-200'}`}>
                    Connect to a coordinator daemon to edit brain presets.
                </div>
            )}
            {error && <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-300">{error}</div>}

            <div className="flex flex-col gap-2">
                {DIFFICULTIES.map(({ key, label, hint }) => {
                    const s = drafts[key] || emptySlot()
                    return (
                        <div key={key} className={`${meshTheme.cardClass} rounded-2xl p-4 flex flex-col gap-2`}>
                            <div className="flex flex-wrap items-baseline gap-2">
                                <span className={`text-[13px] font-semibold ${meshTheme.textPrimary}`}>{label}</span>
                                <span className={`text-[11px] ${meshTheme.textMuted}`}>{hint}</span>
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                                <label className="flex flex-col gap-1">
                                    <span className={labelClass}>Provider</span>
                                    <select className={inputClass} value={s.provider} onChange={e => update(key, { provider: e.target.value })}>
                                        <option value="">(routed default)</option>
                                        {providers.map(p => <option key={p} value={p}>{p}</option>)}
                                        {s.provider && !providers.includes(s.provider) && <option value={s.provider}>{s.provider}</option>}
                                    </select>
                                </label>
                                <label className="flex flex-col gap-1">
                                    <span className={labelClass}>Model</span>
                                    <input className={inputClass} value={s.model} placeholder="e.g. haiku, sonnet, opus"
                                        onChange={e => update(key, { model: e.target.value })} />
                                </label>
                                <label className="flex flex-col gap-1">
                                    <span className={labelClass}>Thinking</span>
                                    <select className={inputClass} value={s.thinkingLevel} onChange={e => update(key, { thinkingLevel: e.target.value })}>
                                        {THINKING_LEVELS.map(l => <option key={l || 'default'} value={l}>{l || '(default)'}</option>)}
                                    </select>
                                </label>
                            </div>
                        </div>
                    )
                })}
            </div>

            <div className="flex items-center gap-2">
                <button type="button" className="btn btn-primary btn-sm" onClick={() => void save()} disabled={saving || loading || !canCommand || !dirty}>
                    {saving ? 'Saving…' : 'Save presets'}
                </button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()} disabled={loading || saving || !canCommand}>
                    {loading ? 'Loading…' : 'Reset'}
                </button>
            </div>
        </div>
    )
}
